// Launch requests (4.1): delivery, ack, time-out, launch conditions, and "only the stage logic queues a launch".

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { giveProject } from "../helpers/repo";
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, type LaunchInput, type StageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const ACK_MS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(o: { retainMs?: number; db?: Database } = {}) {
  const db = o.db ?? new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt: StageRuntime = createStageRuntime(db, { ackMs: ACK_MS, retainMs: o.retainMs });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  const ac = new AbortController();
  const connect = () => rt.queue.attach((r) => sent.push(r), ac.signal, cap);
  let n = 0;
  const ticket = (status = "queued", room = "r1") => {
    giveProject(db, room);
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', 'low', 'medium', 'a', ?, 1, 1, 1)`,
      [id, room, status],
    );
    return id;
  };
  const stageFor = (ticket_id: string, role = "worker") => rt.api.create({ ticket_id, role }, "system", cap);
  const input = (stage_id: string, session = "worker-1", room = "r1"): LaunchInput => ({
    stage_id, session, room, harness: "claude", cwd: "/tmp/p", prompt: "first message",
  });
  return { db, rt, cap, sent, connect, ticket, stageFor, input, stop: () => { ac.abort(); rt.queue.dispose(); } };
}

describe("launch queue and ack", () => {
  test("a launch reaches the connected shell with the stage env; an ack moves the stage to running", () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    const r = e.rt.enqueueLaunch({ ...e.input(s.id), env: { CUBILOT_STAGE_ID: "forged", EXTRA: "1" } }, e.cap);
    expect(r.ok).toBe(true);
    expect(e.sent).toHaveLength(1);
    const req = e.sent[0] as Extract<LaunchRequest, { kind: "launch" }>;
    expect(req).toMatchObject({ kind: "launch", session: "worker-1", role: "worker", room: "r1", harness: "claude" });
    expect(req.env).toEqual({ EXTRA: "1", CHATBRIDGE_AGENT: "worker-1", CHATBRIDGE_ROOM: "r1", CUBILOT_STAGE_ID: s.id });
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
    expect(e.rt.queue.ack(req.id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.rt.api.load(s.id)!.status).toBe("running");
    expect(e.rt.queue.ack(req.id, { result: "spawned" }, e.cap).status).toBe("idempotent");
    expect(e.rt.queue.ack(req.id, { result: "error", error: "x" }, e.cap).status).toBe("conflict");
    expect(e.rt.queue.ack("l_0000000000000000", { result: "spawned" }, e.cap).status).toBe("unknown");
    e.stop();
  });

  test("no ack in time: attempt 1 ends and the stage is relaunched (5.3) as attempt 2; a late ack of the first request is refused", async () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    await sleep(ACK_MS * 1.5);
    const events = e.db.query<{ kind: string }, [string]>("SELECT kind FROM events WHERE entity_id = ? ORDER BY seq").all(s.id).map((r) => r.kind);
    expect(events).toContain("stage.retrying");
    expect(e.rt.api.load(s.id)).toMatchObject({ status: "launching", attempt: 2 });
    expect(e.sent.filter((r) => r.kind === "launch").length).toBeGreaterThanOrEqual(2);
    expect(e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap).status).toBe("conflict");
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
    e.stop();
  });

  test("an error ack ends the attempt too and relaunches it; attempt 2 ends in failed", async () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    e.rt.queue.ack(e.sent[0].id, { result: "error", error: "tmux failed" }, e.cap);
    expect(e.rt.api.load(s.id)).toMatchObject({ status: "launching", attempt: 2 }); // the relaunch is the free-slot start (5.3)
    await sleep(ACK_MS * 3);
    expect(e.rt.api.load(s.id)!.status).toBe("failed");
    e.stop();
  });

  test("with no shell connected the request waits and no timer runs; it is sent when the shell connects", async () => {
    const e = makeEnv();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    await sleep(ACK_MS * 3);
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
    expect(e.rt.queue.size()).toEqual({ undelivered: 1, awaitingAck: 0, retained: 0 });
    e.connect();
    expect(e.sent).toHaveLength(1);
    expect(e.rt.queue.size()).toEqual({ undelivered: 0, awaitingAck: 1, retained: 0 });
    e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap);
    expect(e.rt.api.load(s.id)!.status).toBe("running");
    e.stop();
  });

  test("a close request is delivered and needs no ack", async () => {
    const e = makeEnv();
    e.connect();
    e.rt.queue.push({ id: "l_00000000000000aa", kind: "close", session: "tester-1" });
    expect(e.sent).toEqual([{ id: "l_00000000000000aa", kind: "close", session: "tester-1" }]);
    await sleep(ACK_MS * 2);
    expect(e.rt.queue.size().awaitingAck).toBe(0);
    e.stop();
  });
});

describe("a failed stage change keeps the request pending (4.1 review)", () => {
  const failRunning = (db: Database) =>
    db.exec("CREATE TRIGGER fail_running BEFORE UPDATE ON stage WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const healRunning = (db: Database) => db.exec("DROP TRIGGER fail_running");

  test("when recording the ack fails, the ack returns an error, the request stays pending, and a second ack recovers", () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    failRunning(e.db);
    const r = e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap);
    expect(r.status).toBe("error");
    expect(e.rt.api.load(s.id)!.status).toBe("launching"); // nothing changed
    expect(e.rt.queue.size().awaitingAck).toBe(1); // still pending
    healRunning(e.db);
    expect(e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.rt.api.load(s.id)!.status).toBe("running");
    expect(e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap).status).toBe("idempotent");
    e.stop();
  });

  test("the ack route answers 500 for a failed record and 200 after recovery", async () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    const ack = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("ack"))!;
    const post = (body: unknown) =>
      ack.handler(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), e.cap, { id: e.sent[0].id }) as Promise<Response>;
    failRunning(e.db);
    expect((await post({ result: "spawned" })).status).toBe(500);
    healRunning(e.db);
    expect((await post({ result: "spawned" })).status).toBe(200);
    expect(e.rt.api.load(s.id)!.status).toBe("running");
    e.stop();
  });

  test("when the time-out handler fails, the request stays pending and the time-out is tried again", async () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    e.db.exec("CREATE TRIGGER fail_retrying BEFORE UPDATE ON stage WHEN NEW.status = 'retrying' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await sleep(ACK_MS * 2.5);
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
    expect(e.rt.queue.size().awaitingAck).toBe(1);
    e.db.exec("DROP TRIGGER fail_retrying");
    await sleep(ACK_MS * 2.5);
    expect(e.rt.api.load(s.id)!.attempt).toBe(2); // ended attempt 1 and relaunched (it may already be failed: it times out too)
    e.stop();
  });
});

describe("close requests (4.1 review)", () => {
  const closeReq = (n = "aa"): LaunchRequest => ({ id: `l_00000000000000${n}`, kind: "close", session: "tester-1" });

  test("a close delivered to a connection that drops before the ack is sent again to the next connection", () => {
    const e = makeEnv();
    const first: LaunchRequest[] = [];
    const ac1 = new AbortController();
    e.rt.queue.attach((r) => first.push(r), ac1.signal, e.cap);
    e.rt.queue.push(closeReq());
    expect(first).toHaveLength(1);
    ac1.abort(); // the shell disconnects with no ack
    const second: LaunchRequest[] = [];
    const ac2 = new AbortController();
    e.rt.queue.attach((r) => second.push(r), ac2.signal, e.cap);
    expect(second).toEqual([closeReq()]);
    // acked: not sent again
    expect(e.rt.queue.ack(closeReq().id, { result: "spawned" }, e.cap).status).toBe("ok");
    const third: LaunchRequest[] = [];
    e.rt.queue.attach((r) => third.push(r), new AbortController().signal, e.cap);
    expect(third).toEqual([]);
    ac2.abort();
    e.stop();
  });

  test("a launch delivered to a dropped connection is NOT sent again (it could start the session twice)", () => {
    const e = makeEnv();
    const first: LaunchRequest[] = [];
    const ac1 = new AbortController();
    e.rt.queue.attach((r) => first.push(r), ac1.signal, e.cap);
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    ac1.abort();
    const second: LaunchRequest[] = [];
    e.rt.queue.attach((r) => second.push(r), new AbortController().signal, e.cap);
    expect(second).toEqual([]);
    e.stop();
  });

  test("an unacked close is logged after the ack time and stays pending for the next connection", async () => {
    const e = makeEnv();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      e.connect();
      e.rt.queue.push(closeReq());
      await sleep(ACK_MS * 2.5);
    } finally {
      console.error = orig;
    }
    expect(errors.some((m) => /close tester-1 has no ack/.test(m))).toBe(true);
    expect(e.rt.queue.size().retained).toBe(0); // not finished
    e.stop();
  });

  test("an error ack keeps a close pending (it is sent again); only 'the session is absent' completes it", () => {
    const e = makeEnv();
    const first: LaunchRequest[] = [];
    const ac1 = new AbortController();
    e.rt.queue.attach((r) => first.push(r), ac1.signal, e.cap);
    e.rt.queue.push(closeReq());
    const orig = console.error;
    console.error = () => {};
    try {
      // a temporary failure: tmux was unavailable
      expect(e.rt.queue.ack(closeReq().id, { result: "error", error: "tmux unavailable" }, e.cap).status).toBe("pending");
      expect(e.rt.queue.pendingCloses()).toEqual(["tester-1"]);
      expect(e.rt.queue.size().retained).toBe(0);
      // it is sent again on the next connection
      ac1.abort();
      const second: LaunchRequest[] = [];
      const ac2 = new AbortController();
      e.rt.queue.attach((r) => second.push(r), ac2.signal, e.cap);
      expect(second).toEqual([closeReq()]);
      // a second temporary failure changes nothing
      expect(e.rt.queue.ack(closeReq().id, { result: "error", error: "tmux unavailable" }, e.cap).status).toBe("pending");
      // the shell says the session does not exist: nothing left to close
      expect(e.rt.queue.ack(closeReq().id, { result: "error", error: "no such session", absent: true }, e.cap).status).toBe("ok");
      expect(e.rt.queue.pendingCloses()).toEqual([]);
      expect(e.rt.queue.ack(closeReq().id, { result: "error", error: "x", absent: true }, e.cap).status).toBe("idempotent");
      ac2.abort();
    } finally {
      console.error = orig;
    }
    e.stop();
  });

  test("a close that finally succeeds after failures completes", () => {
    const e = makeEnv();
    e.connect();
    e.rt.queue.push(closeReq());
    const orig = console.error;
    console.error = () => {};
    try {
      expect(e.rt.queue.ack(closeReq().id, { result: "error", error: "busy" }, e.cap).status).toBe("pending");
    } finally {
      console.error = orig;
    }
    expect(e.rt.queue.ack(closeReq().id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.rt.queue.pendingCloses()).toEqual([]);
    e.stop();
  });

  test("the ack route reads absent: a boolean that goes with result error", async () => {
    const e = makeEnv();
    e.connect();
    e.rt.queue.push(closeReq());
    const ack = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("ack"))!;
    const post = async (body: unknown) =>
      (await ack.handler(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), e.cap, { id: closeReq().id })) as Response;
    expect((await post({ result: "spawned", absent: true })).status).toBe(400);
    expect((await post({ result: "error", error: "x", absent: "yes" })).status).toBe(400);
    const orig = console.error;
    console.error = () => {};
    try {
      const pending = await post({ result: "error", error: "tmux unavailable" });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({ ok: true, pending: true });
    } finally {
      console.error = orig;
    }
    expect((await post({ result: "error", error: "gone", absent: true })).status).toBe(200);
    expect(e.rt.queue.pendingCloses()).toEqual([]);
    e.stop();
  });
});

describe("a closed session name is not reused before its close is acked (4.1 review)", () => {
  const closeFor = (session: string, n: string): LaunchRequest => ({ id: `l_00000000000000${n}`, kind: "close", session });

  test("launch(worker-1), close(worker-1), launch(worker-1): the second launch is refused until the close is acked, so a resent close cannot kill the new session", () => {
    const e = makeEnv();
    e.connect();
    const a = e.stageFor(e.ticket());
    expect(e.rt.enqueueLaunch(e.input(a.id, "worker-1"), e.cap).ok).toBe(true);
    e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap);
    e.rt.queue.push(closeFor("worker-1", "c1")); // the hub asks to close worker-1; no ack yet

    const b = e.stageFor(e.ticket());
    const refused = e.rt.enqueueLaunch(e.input(b.id, "worker-1"), e.cap);
    expect(refused).toEqual({ ok: false, reason: "session name worker-1 is reserved until its close is acked" });
    expect(e.rt.api.load(b.id)!.status).toBe("queued"); // nothing changed
    expect(e.sent.filter((r) => r.kind === "launch")).toHaveLength(1);
    // a raw push of a launch with that name is refused too
    expect(() => e.rt.queue.push({ ...(e.sent[0] as any), id: "l_00000000000000f1" })).toThrow(/reserved/);

    // the close is acked: the name is free again, and a later reconnect sends no old close
    e.rt.queue.ack("l_00000000000000c1", { result: "spawned" }, e.cap);
    expect(e.rt.enqueueLaunch(e.input(b.id, "worker-1"), e.cap).ok).toBe(true);
    const resent: LaunchRequest[] = [];
    e.rt.queue.attach((r) => resent.push(r), new AbortController().signal, e.cap);
    expect(resent.filter((r) => r.kind === "close")).toEqual([]);
    e.stop();
  });

  test("the session-name helper skips a reserved name (role handoff path)", () => {
    const e = makeEnv();
    e.connect();
    // worker-1 was used and its stage is finished, but its close has no ack
    e.rt.queue.push(closeFor("worker-1", "c2"));
    const t = e.ticket();
    const made = e.rt.evaluateStages(t, e.cap, [{ role: "worker", seq: 1_000_000 }], { launch: true });
    expect(made).toHaveLength(1); // a worker role handoff
    expect(e.rt.api.load(made[0].id)).toMatchObject({ status: "launching", session: "worker-2" });
    e.stop();
  });
});

describe("finished requests do not stay in memory (4.1 review)", () => {
  test("a finished launch drops its prompt at once and is forgotten after retainMs", async () => {
    const e = makeEnv({ retainMs: 80 });
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch({ ...e.input(s.id), prompt: "x".repeat(200_000) }, e.cap);
    e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap);
    expect(e.rt.queue.size().retained).toBe(1);
    expect(e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap).status).toBe("idempotent"); // still known
    await sleep(160);
    expect(e.rt.queue.size().retained).toBe(0);
    expect(e.rt.queue.ack(e.sent[0].id, { result: "spawned" }, e.cap).status).toBe("unknown");
    e.stop();
  });

  test("a timed-out launch is forgotten after retainMs too", async () => {
    const e = makeEnv({ retainMs: 80 });
    e.connect();
    e.rt.enqueueLaunch(e.input(e.stageFor(e.ticket()).id), e.cap);
    await sleep(ACK_MS * 2 + 200); // the relaunch (5.3) times out too, and both are forgotten
    expect(e.rt.queue.size().retained).toBe(0);
    e.stop();
  });
});

describe("a hub restart settles launching stages (4.1 review)", () => {
  test("at start, a stage in launching counts as a launch with no ack: attempt 1 goes to retrying, attempt 2 to failed", () => {
    const db = new Database(":memory:");
    const first = makeEnv({ db });
    first.connect();
    const a = first.stageFor(first.ticket()); // launching, attempt 1
    first.rt.enqueueLaunch(first.input(a.id, "worker-1"), first.cap);
    const b = first.stageFor(first.ticket()); // launching, attempt 2
    first.rt.enqueueLaunch(first.input(b.id, "worker-2"), first.cap);
    first.rt.queue.ack(first.sent[1].id, { result: "error", error: "x" }, first.cap); // b -> retrying
    first.rt.enqueueLaunch(first.input(b.id, "worker-3"), first.cap); // b -> launching, attempt 2
    const c = first.stageFor(first.ticket(), "tester"); // running: not touched (another role, so the worker limit does not stop it)
    first.rt.enqueueLaunch(first.input(c.id, "tester-1"), first.cap);
    first.rt.queue.ack(first.sent[3].id, { result: "spawned" }, first.cap);
    const d = first.stageFor(first.ticket()); // queued: not touched
    first.stop(); // "the hub dies": the in-memory queue is gone

    const second = makeEnv({ db }); // the restarted hub: same ledger, new runtime
    const before = (id: string) => second.rt.api.load(id)!.status;
    expect([before(a.id), before(b.id), before(c.id), before(d.id)]).toEqual(["launching", "launching", "running", "queued"]);
    second.rt.module.start!(second.cap);
    expect(second.rt.api.load(a.id)).toMatchObject({ status: "launching", attempt: 2 }); // retrying, then relaunched at once (5.3)
    expect(second.rt.api.load(b.id)).toMatchObject({ status: "failed", attempt: 2 });
    expect(before(c.id)).toBe("running");
    expect(before(d.id)).toBe("launching"); // the settled stages freed worker slots: the queue (3.2) starts d
    // the events record it as a normal change
    expect(db.query("SELECT kind FROM events WHERE entity_id = ? ORDER BY seq DESC LIMIT 1").get(a.id)).toEqual({ kind: "stage.launching" });
    // a second restart settles the relaunch of a the same way: attempt 2 has no ack, so it fails for good
    second.rt.module.start!(second.cap);
    expect(before(a.id)).toBe("failed");
    second.stop();
  });
});

describe("stream and ack routes", () => {
  test("a launch is written to the SSE stream; the ack route moves the stage; a dropped shell does not lose the request", async () => {
    const e = makeEnv();
    const route = (method: string, re: string) => e.rt.module.routes.find((r) => r.method === method && String(r.path).includes(re))!;
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap); // no shell yet: waits

    const ac = new AbortController();
    const res = (await route("GET", "stream").handler(new Request("http://x/launches/stream", { signal: ac.signal }), e.cap, {})) as Response;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let frame: { id: string; kind: string; stage_id: string } | null = null;
    while (!frame) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const line = buf.split("\n").find((l) => l.startsWith("data: "));
      if (line) frame = JSON.parse(line.slice(6));
    }
    expect(frame).toMatchObject({ kind: "launch", stage_id: s.id });

    const ack = route("POST", "ack");
    const post = (body: unknown) =>
      ack.handler(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), e.cap, { id: frame!.id }) as Promise<Response>;
    expect((await post({ result: "spawned" })).status).toBe(200);
    expect(e.rt.api.load(s.id)!.status).toBe("running");
    expect((await post({ result: "spawned" })).status).toBe(200); // idempotent
    expect((await post({ result: "error", error: "late" })).status).toBe(409);
    // the body must be a JSON object
    for (const bad of [null, [], "x", 5, true]) {
      const r = (await ack.handler(new Request("http://x", { method: "POST", body: JSON.stringify(bad) }), e.cap, { id: frame!.id })) as Response;
      expect(r.status).toBe(400);
    }
    const garbage = (await ack.handler(new Request("http://x", { method: "POST", body: "not json" }), e.cap, { id: frame!.id })) as Response;
    expect(garbage.status).toBe(400);
    ac.abort();
    try { await reader.cancel(); } catch { /* closed */ }
    e.stop();
  });
});

describe("launch conditions (checked on every enqueueLaunch)", () => {
  const refused = (e: ReturnType<typeof makeEnv>, stageId: string, why: RegExp, room = "r1") => {
    const before = e.rt.queue.size();
    const r = e.rt.enqueueLaunch(e.input(stageId, "worker-9", room), e.cap);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(why);
    expect(e.sent).toHaveLength(0);
    expect(e.rt.queue.size()).toEqual(before);
    expect(e.rt.api.load(stageId)!.status).toBe("queued");
    expect(e.db.query("SELECT COUNT(*) AS n FROM events WHERE entity_id = ?").get(stageId)).toEqual({ n: 1 }); // stage.queued only
  };

  test.each(["draft", "done", "cancelled"])("a %s ticket queues no launch", (status) => {
    const e = makeEnv();
    e.connect();
    refused(e, e.stageFor(e.ticket(status)).id, new RegExp(`ticket is ${status}`));
    e.stop();
  });

  test("an open blocker queues no launch; a done blocker does not stop it", () => {
    const e = makeEnv();
    e.connect();
    const blocker = e.ticket("in_progress");
    const t = e.ticket();
    e.db.run("INSERT INTO ticket_blockers (ticket_id, blocker_id) VALUES (?, ?)", [t, blocker]);
    const s = e.stageFor(t);
    refused(e, s.id, /blocked by/);
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [blocker]);
    expect(e.rt.enqueueLaunch(e.input(s.id), e.cap).ok).toBe(true);
    e.stop();
  });

  test("a role at its limit in the room queues no launch; the limit is per room", () => {
    const e = makeEnv();
    e.connect();
    setRoomSettings(e.db, "r1", { role_limits: { worker: 1 } });
    const first = e.stageFor(e.ticket());
    expect(e.rt.enqueueLaunch(e.input(first.id), e.cap).ok).toBe(true);
    e.sent.length = 0;
    refused(e, e.stageFor(e.ticket()).id, /at its limit \(1\) in room r1/);
    // another room has its own count (default limit 2)
    const other = e.stageFor(e.ticket("queued", "r2"));
    expect(e.rt.enqueueLaunch(e.input(other.id, "worker-2", "r2"), e.cap).ok).toBe(true);
    // a limit of 0 blocks every launch of the role
    setRoomSettings(e.db, "r3", { role_limits: { worker: 0 } });
    e.sent.length = 0;
    refused(e, e.stageFor(e.ticket("queued", "r3")).id, /at its limit \(0\) in room r3/, "r3");
    e.stop();
  });

  test("a stage that is not queued or retrying cannot be launched", () => {
    const e = makeEnv();
    e.connect();
    const s = e.stageFor(e.ticket());
    e.rt.enqueueLaunch(e.input(s.id), e.cap);
    const again = e.rt.enqueueLaunch(e.input(s.id), e.cap);
    expect(again).toEqual({ ok: false, reason: "stage is launching" });
    expect(e.sent).toHaveLength(1);
    e.stop();
  });
});

describe("only the stage logic queues launches", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const hubFiles = files(join(import.meta.dir, "../../hub"));
  const rel = (p: string) => p.slice(p.indexOf("hub/"));

  test("enqueueLaunch is named only in hub/kinds/stage.ts", () => {
    const users = hubFiles.filter((p) => /enqueueLaunch/.test(readFileSync(p, "utf8"))).map(rel);
    expect(users).toEqual(["hub/kinds/stage.ts"]);
  });

  test("the launch queue is imported only by hub/kinds/stage.ts", () => {
    const users = hubFiles
      .filter((p) => !p.endsWith("hub/core/launch-queue.ts"))
      .filter((p) => /launch-queue/.test(readFileSync(p, "utf8")))
      .map(rel);
    expect(users).toEqual(["hub/kinds/stage.ts"]);
  });

  test("inside stage.ts, enqueueLaunch is called only from evaluateStages and drainQueue (the retry path, 5.3, adds a caller)", () => {
    const src = readFileSync(join(import.meta.dir, "../../hub/kinds/stage.ts"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
    const calls = code.map((l, i) => ({ l, i })).filter(({ l }) => /\benqueueLaunch\(/.test(l) && !/function enqueueLaunch\(/.test(l) && !/^\s*enqueueLaunch\(input/.test(l));
    expect(calls).toHaveLength(2);
    const start = code.findIndex((l) => /function evaluateStages\(/.test(l));
    const drain = code.findIndex((l, i) => i > start && /function drainQueue\(/.test(l));
    const end = code.findIndex((l, i) => i > start && /^  function enqueueLaunch\(/.test(l));
    expect(calls[0].i).toBeGreaterThan(start);
    expect(calls[0].i).toBeLessThan(drain);
    expect(calls[1].i).toBeGreaterThan(drain);
    expect(calls[1].i).toBeLessThan(end);
  });

  test("inside stage.ts, a launch is queued only from enqueueLaunch (the other pushes are closes: 5.2, 5.3)", () => {
    const src = readFileSync(join(import.meta.dir, "../../hub/kinds/stage.ts"), "utf8");
    const pushes = [...src.matchAll(/queue\.push\(/g)].length;
    expect(pushes).toBe(5);
    expect([...src.matchAll(/queue\.push\(\{[^}]*kind: "close"/g)]).toHaveLength(4); // turn end (5.2), stop (5.3), lost turn end and start sweep (5.3b)
    const fn = src.slice(src.indexOf("function enqueueLaunch("), src.indexOf("function passSpecStage("));
    expect(fn).toContain("queue.push(req)");
  });
});
