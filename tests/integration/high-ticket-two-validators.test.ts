// L4: a PASS never closes a ticket. A high ticket needs two Validator PASSes on one commit. The lead moves it to done
// after the merge into staging, with no human Allow.
// In-process hub kinds, like tests/unit/stage-final-pass.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject, giveProjectHttp, projectRepo } from "../helpers/repo";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// C1 is on staging (merged). C2 is a commit that staging does not hold.
git("branch", "-f", "staging", "main");
const C1 = git("rev-parse", "main");
const C2 = git("commit-tree", `${C1}^{tree}`, "-p", C1, "-m", "unmerged");

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = {
    db,
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => {} },
    agents: {
      get: (n: string) => (n === "lead-1" ? { name: n, permanent: false, room: "r1" } : undefined),
      isPermanent: () => false,
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  // A fake shell: reads every request the hub queues.
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  let n = 0;
  /** An in_review ticket with a Tester handoff to the Validator on C1 and a running first Validator stage. */
  const ticket = (radius: "low" | "high", commit = C1) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', ?, 'medium', 'a', 'validator-1', 'in_review', 1, 1, 1)`,
      [id, radius],
    );
    if (radius === "high") {
      // The last Tester result of a high ticket holds a full suite with exit code 0.
      const ts = rt.api.create({ ticket_id: id, role: "tester" }, "system", cap);
      db.run("UPDATE stage SET status = 'passed', verdict = 'PASS', session = 'tester-1' WHERE id = ?", [ts.id]);
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'lead-1', 'result', ?, 'accepted', 1, 9999999999999)",
        [`h_t${n}`, JSON.stringify({ stage_id: ts.id, ticket_id: id, commit, full_suite: { command: "./scripts/test.sh", exit_code: 0, pass: 1, fail: 0, log_path: "/tmp/l.log" } })],
      );
    }
    db.run("INSERT OR REPLACE INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('r1', 'lead-1', 1)");
    const hid = `h_${n}`;
    db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
      [hid, JSON.stringify({ ticket_id: id, commit })],
    );
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'tester-1', '{}', 1)", [hid]);
    const first = rt.api.create({ ticket_id: id, role: "validator" }, "system", cap);
    db.run("UPDATE stage SET status = 'running', session = 'validator-1' WHERE id = ?", [first.id]);
    return { id, first: first.id };
  };
  /** The lead's move to done, through the ticket route. Returns the status and the error text. */
  const tk = createTicketKind(db);
  const leadDone = async (id: string): Promise<{ status: number; error?: string }> => {
    const route = tk.routes.find((r) => r.method === "POST" && String(r.path).includes("transition"))!;
    const res = await route.handler(
      new Request("http://hub.test/tickets/x/transition", { method: "POST", body: JSON.stringify({ by: "lead-1", to: "done" }), headers: { "Content-Type": "application/json" } }),
      cap,
      { id },
    );
    return { status: res.status, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error };
  };
  const row = (id: string) => db.query<{ status: string; assignee: string | null }, [string]>("SELECT status, assignee FROM tickets WHERE id = ?").get(id)!;
  const validators = (id: string) =>
    db.query<{ id: string; status: string; verdict: string | null }, [string]>("SELECT id, status, verdict FROM stage WHERE ticket_id = ? AND role = 'validator' ORDER BY created_seq").all(id);
  const doneEvents = (id: string) => db.query<{ actor: string }, [string]>("SELECT actor FROM events WHERE entity_id = ? AND kind = 'ticket.done'").all(id);
  /** The hub's second Validator stage runs in another session. */
  const startSecond = (id: string) => {
    const second = validators(id)[1];
    db.run("UPDATE stage SET status = 'running', session = 'validator-2' WHERE id = ?", [second.id]);
    return second.id;
  };
  return { db, rt, cap, sent, ticket, leadDone, row, validators, doneEvents, startSecond };
}

describe("high ticket: two Validator PASSes", () => {
  test("first PASS starts a second validator", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    expect(e.row(t.id).status).toBe("in_review");
    expect(e.doneEvents(t.id)).toHaveLength(0);
    const v = e.validators(t.id);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ status: "passed", verdict: "PASS" });
    expect(v[1].status).not.toBe("passed");
    // another session name than the first Validator
    const second = e.db.query<{ session: string | null }, [string]>("SELECT session FROM stage WHERE id = ?").get(v[1].id)!.session;
    if (second) expect(second).not.toBe("validator-1");
  });

  test("second validator gets another session name after the first session closes", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const turnEnd = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("turn-end"))!;
    await turnEnd.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: "validator-1" }) }), e.cap, { id: t.first });
    for (const r of e.sent) if (r.kind === "close") e.rt.queue.ack(r.id, { result: "spawned" }, e.cap);
    const second = e.validators(t.id)[1];
    const launch = [...e.sent].reverse().find((r) => r.kind === "launch" && r.stage_id === second.id) as { session: string } | undefined;
    expect(launch).toBeDefined();
    expect(launch!.session).not.toBe("validator-1");
  });

  test("second PASS keeps in_review and hands the ticket to the lead", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    expect(e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C1 }, e.cap)).toEqual([]);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("a later Validator handoff does not change the commit of the second PASS", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    // A later handoff on C2 arrives while the first stage runs.
    e.db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES ('h_late', 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
      [JSON.stringify({ ticket_id: t.id, commit: C2 })],
    );
    e.db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES ('h_late', 'handoff.created', 'tester-1', '{}', 1)");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    const bad = e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C2 }, e.cap);
    expect(bad!.join(" ")).toContain(C1);
    expect(e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C1 }, e.cap)).toEqual([]);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
    expect((await e.leadDone(t.id)).status).toBe(200);
  });
});

describe("L4: PASS leaves in_review, the lead closes after the merge", () => {
  const pass = (e: ReturnType<typeof makeEnv>, t: { first: string }) => e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
  const passSecond = (e: ReturnType<typeof makeEnv>, id: string) => {
    const second = e.startSecond(id);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
  };

  test("low PASS leaves in_review", () => {
    const e = makeEnv();
    const t = e.ticket("low");
    pass(e, t);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect(e.validators(t.id)).toHaveLength(1);
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("low done after merge", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    pass(e, t);
    expect((await e.leadDone(t.id)).status).toBe(200);
    expect(e.row(t.id).status).toBe("done");
  });

  test("low done before merge 409", async () => {
    const e = makeEnv();
    const t = e.ticket("low", C2);
    pass(e, t);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("merged into staging");
    expect(e.row(t.id).status).toBe("in_review");
  });

  test("low done with no PASS 409", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    e.db.run("UPDATE tickets SET assignee = 'lead-1' WHERE id = ?", [t.id]);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("Validator PASS");
  });

  test("high done with one PASS 409", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    pass(e, t);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("second Validator PASS");
  });

  test("high done with two PASSes on the merged commit, no Allow", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    pass(e, t);
    passSecond(e, t.id);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect((await e.leadDone(t.id)).status).toBe(200);
    expect(e.row(t.id).status).toBe("done");
  });

  test("high done with two PASSes before the merge 409", async () => {
    const e = makeEnv();
    const t = e.ticket("high", C2);
    pass(e, t);
    passSecond(e, t.id);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("merged into staging");
  });
});

// The same three cases through the real hub: the Validator result goes in over POST /handoffs, as the route checks it.
describe("high ticket through POST /handoffs", () => {
  const ROOM = "l4h";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let hub: HubHandle;
  let stream: ReturnType<typeof openSSE>;
  const launches: any[] = [];
  const open: Array<{ close: () => void }> = [];
  type Stage = { id: string; role: string; status: string; verdict: string | null; session: string | null };

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
    open.push(await registerAgent(hub, "l4h-alice", { room: ROOM }));
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10, validator: 10, writer: 10 } }) });
    expect(put.status).toBe(200);
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const ledger = <T>(fn: (db: Database) => T): T => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return fn(db); } finally { db.close(); }
  };
  const stages = (id: string) => ledger((db) => db.query("SELECT id, role, status, verdict, session FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(id) as Stage[]);
  const stageRows = (id: string) => ledger((db) => db.query("SELECT * FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(id));
  const ticketStatus = (id: string) => ledger((db) => db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(id)!.status);
  const handoffsTo = (id: string, to: string) =>
    ledger((db) => db.query<{ id: string }, [string, string]>("SELECT id FROM handoffs WHERE to_agent = ? AND json_extract(context_json, '$.ticket_id') = ?").all(to, id));

  /** Acks the launch of a stage as spawned and connects its session: the stage is running. */
  const run = async (stageId: string) => {
    let req: any;
    for (let i = 0; i < 100 && !(req = launches.find((r) => r.kind === "launch" && r.stage_id === stageId)); i++) await sleep(50);
    expect(req).toBeDefined();
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, req.session, { room: ROOM }));
    return req.session as string;
  };
  /** Ends the turn of a session and acks its close, which frees its name and its slot for the next stage. */
  const closeSession = async (stageId: string, session: string) => {
    expect((await postJson(hub, `/stages/${stageId}/turn-end`, { agent: session })).status).toBeLessThan(300);
    let req: any;
    for (let i = 0; i < 100 && !(req = launches.find((r) => r.kind === "close" && r.session === session)); i++) await sleep(50);
    expect(req).toBeDefined();
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    await sleep(300);
  };
  const result = (from: string, stage: Stage, ticket: string, verdict: "PASS" | "FAIL", commit: string, to: Record<string, string>) =>
    postJson(hub, "/handoffs", {
      from, task: "result", ...to,
      context: { notes: "n", stage_id: stage.id, ticket_id: ticket, verdict, findings: verdict === "FAIL" ? [{ ticket_id: ticket, text: "x" }] : [], commit },
    });
  const toLead = { to: "l4h-alice" };
  const toWorker = { to_role: "worker" };

  /** A high ticket in_review with its first Validator stage running on C1. */
  const startFirst = async () => {
    const r = await postJson(hub, "/tickets", { by: "l4h-alice", title: "t", acceptance_criteria: "c", blast_radius: "high", role: null });
    expect(r.status).toBe(201);
    const id = (r.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "l4h-alice" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "l4h-alice", to: "in_progress" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "l4h-alice", to: "in_review", note: "built" })).status).toBe(200);
    expect((await postJson(hub, "/handoffs", { from: "l4h-alice", to_role: "tester", task: "test", context: { ticket_id: id, commit: C1 } })).status).toBe(201);
    await sleep(400);
    const ts = stages(id)[0];
    const tsession = await run(ts.id);
    const suite = { command: "./scripts/test.sh", exit_code: 0, pass: 1, fail: 0, log_path: "/tmp/l.log" };
    const tres = await postJson(hub, "/handoffs", { from: tsession, to: "l4h-alice", task: "result", context: { notes: "n", stage_id: ts.id, ticket_id: id, commit: C1, full_suite: suite } });
    expect(tres.status).toBe(201);
    await closeSession(ts.id, tsession);
    expect((await postJson(hub, "/handoffs", { from: "l4h-alice", to_role: "validator", task: "validate", context: { ticket_id: id, commit: C1 } })).status).toBe(201);
    await sleep(400);
    const first = stages(id).find((s) => s.role === "validator")!;
    return { id, first, session: await run(first.id) };
  };
  /** The first PASS on C1, the close of its session, and the second Validator stage running. */
  const startSecond = async () => {
    const t = await startFirst();
    expect((await result(t.session, t.first, t.id, "PASS", C1, toLead)).status).toBe(201);
    await closeSession(t.first.id, t.session);
    const second = stages(t.id).find((s) => s.role === "validator" && s.id !== t.first.id)!;
    expect(second).toBeDefined();
    return { ...t, second, secondSession: await run(second.id) };
  };
  /** The Worker stage and handoff that a Validator FAIL leaves: the ticket stays in_review and is not done. */
  const expectWorker = async (id: string) => {
    expect(handoffsTo(id, "role:worker")).toHaveLength(1);
    await sleep(400);
    expect(stages(id).filter((s) => s.role === "worker")).toHaveLength(1);
    expect(ticketStatus(id)).not.toBe("done");
  };

  test("FAIL in first goes to worker", async () => {
    const t = await startFirst();
    expect((await result(t.session, t.first, t.id, "FAIL", C1, toWorker)).status).toBe(201);
    await closeSession(t.first.id, t.session);
    await expectWorker(t.id);
    expect(stages(t.id).filter((s) => s.role === "validator")).toMatchObject([{ status: "passed", verdict: "FAIL" }]);
  });

  test("FAIL in second goes to worker", async () => {
    const t = await startSecond();
    expect((await result(t.secondSession, t.second, t.id, "FAIL", C1, toWorker)).status).toBe(201);
    await closeSession(t.second.id, t.secondSession);
    await expectWorker(t.id);
    expect(stages(t.id).filter((s) => s.role === "validator")).toMatchObject([{ verdict: "PASS" }, { verdict: "FAIL" }]);
  });

  test("second PASS on other commit refused", async () => {
    const t = await startSecond();
    const before = stageRows(t.id);
    const handoffsBefore = ledger((db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()!.n);
    const res = await result(t.secondSession, t.second, t.id, "PASS", C2, toLead);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain(C1);
    expect(ticketStatus(t.id)).toBe("in_review");
    expect(stageRows(t.id)).toEqual(before);
    expect(ledger((db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()!.n)).toBe(handoffsBefore);
  });
});
