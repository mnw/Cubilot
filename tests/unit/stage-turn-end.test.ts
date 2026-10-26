// Turn end, reminder and close of a stage session (stage-sessions 5.2, brief test 5).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, RouteDef, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (status = "in_progress", request = "req-1") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, status, request],
    );
    return id;
  };
  const running = (role: string, session: string, ticketId: string) => {
    const s = rt.api.create({ ticket_id: ticketId, role }, "system", cap);
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    return s.id;
  };
  const route = rt.module.routes.find((r: RouteDef) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  const turnEnd = async (stageId: string, agent: unknown) => {
    const res = await route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent }) }), cap, { id: stageId });
    return { status: res.status, json: (await res.json()) as { action?: string } };
  };
  const reminders = () => emitted.filter((x) => x.e.kind === "stage.reminder");
  return { db, rt, cap, emitted, ticket, running, turnEnd, reminders };
}

// The turn-end route of a stage: (stage id, session) -> response.
const route = (e: ReturnType<typeof makeEnv>) => (stageId: string, agent: string) => e.turnEnd(stageId, agent);

describe("turn end", () => {
  test("the first end without a result sends one reminder to that session, the stage stays running; a later one sends none", async () => {
    const e = makeEnv();
    const s = e.running("worker", "worker-1", e.ticket());
    expect((await e.turnEnd(s, "worker-1")).json.action).toBe("reminder");
    expect(e.reminders()).toHaveLength(1);
    expect(e.reminders()[0].s).toEqual({ kind: "to-agents", agents: ["worker-1"] });
    expect(e.reminders()[0].e.to).toBe("worker-1");
    expect(e.rt.api.load(s)!.status).toBe("running");
    expect((await e.turnEnd(s, "worker-1")).json.action).toBe("stop"); // a second end without a result: the attempt ends (5.3)
    expect(e.reminders()).toHaveLength(1);
    expect(e.rt.api.load(s)).toMatchObject({ status: "retrying", attempt: 2 - 1 }); // it relaunches when the close is acked (5.3c)
  });

  test("a valid result passes the stage; the close is queued at the next end of turn, once", async () => {
    const e = makeEnv();
    const s = e.running("worker", "worker-1", e.ticket());
    e.rt.hooks.onResult("worker-1", { stage_id: s }, e.cap);
    expect(e.rt.api.load(s)).toMatchObject({ status: "passed", verdict: null });
    expect(e.rt.queue.pendingCloses()).toEqual([]); // the session finishes its turn first
    expect((await e.turnEnd(s, "worker-1")).json.action).toBe("close");
    expect(e.rt.queue.pendingCloses()).toEqual(["worker-1"]);
    expect((await e.turnEnd(s, "worker-1")).json.action).toBe("none");
    expect(e.reminders()).toHaveLength(0);
  });

  test("a review result keeps its verdict on the stage", () => {
    const e = makeEnv();
    const s = e.running("validator", "validator-1", e.ticket());
    e.rt.hooks.onResult("validator-1", { stage_id: s, verdict: "FAIL", findings: [] }, e.cap);
    expect(e.rt.api.load(s)).toMatchObject({ status: "passed", verdict: "FAIL" });
  });

  test("a passed stage keeps its role slot and its session name until its close is acked", async () => {
    const e = makeEnv();
    const s = e.running("worker", "worker-1", e.ticket());
    // A second worker stage waits for a slot; the pass frees the slot (limit 1 in this room).
    e.db.run("INSERT INTO room_settings (room, role_limits, updated_at) VALUES ('r1', ?, 1) ON CONFLICT(room) DO UPDATE SET role_limits = excluded.role_limits", [
      JSON.stringify({ worker: 1, tester: 1, validator: 1, reviewer: 1, editor: 1, writer: 1 }),
    ]);
    const t2 = e.ticket("queued");
    const q = e.rt.api.create({ ticket_id: t2, role: "worker" }, "system", e.cap);
    e.rt.hooks.onResult("worker-1", { stage_id: s }, e.cap);
    expect(e.rt.api.load(q.id)!.status).toBe("queued"); // the passed session is still open: its slot is held
    const sent: LaunchRequest[] = [];
    e.rt.queue.attach((r) => sent.push(r), new AbortController().signal, e.cap);
    expect((await e.turnEnd(s, "worker-1")).json.action).toBe("close");
    expect(e.rt.api.load(q.id)!.status).toBe("queued"); // close queued, not acked
    expect(e.rt.queue.ack(sent.find((r) => r.kind === "close")!.id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.rt.api.load(q.id)).toMatchObject({ status: "launching", session: "worker-1" }); // slot and name free again
  });

  test("a spec PASS result runs passSpecStage once and queues the scope tickets; a spec FAIL passes the stage with verdict FAIL and moves no ticket", () => {
    const e = makeEnv();
    const a = e.ticket("draft");
    const mk = (session: string) => {
      const sp = e.rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", e.cap, (ctx) =>
        ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, a]),
      );
      e.rt.api.move(sp.id, { to: "launching", session }, "system", e.cap);
      e.rt.api.move(sp.id, { to: "running" }, "system", e.cap);
      return sp.id;
    };
    const fail = mk("validator-1");
    e.rt.hooks.onResult("validator-1", { stage_id: fail, verdict: "FAIL" }, e.cap);
    expect(e.rt.api.load(fail)).toMatchObject({ status: "passed", verdict: "FAIL" });
    expect(e.db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(a)!.status).toBe("draft");
    expect(e.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'ticket.queued'").get()!.n).toBe(0);

    const pass = mk("validator-2");
    e.rt.hooks.onResult("validator-2", { stage_id: pass, verdict: "PASS" }, e.cap);
    e.rt.hooks.onResult("validator-2", { stage_id: pass, verdict: "PASS" }, e.cap); // no running stage any more: nothing
    expect(e.rt.api.load(pass)).toMatchObject({ status: "passed", verdict: "PASS" });
    expect(e.db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(a)!.status).toBe("queued");
    expect(e.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'ticket.queued'").get()!.n).toBe(1);
  });

  test("a spec stage that is retrying still counts as the live spec stage of its request: a second one stays queued until the first ends", async () => {
    const e = makeEnv();
    const a = e.ticket("draft");
    // two validators may run in the room, so only the one-live-spec rule can hold the second stage back
    e.db.run("INSERT INTO room_settings (room, role_limits, updated_at) VALUES ('r1', ?, 1) ON CONFLICT(room) DO UPDATE SET role_limits = excluded.role_limits", [
      JSON.stringify({ worker: 1, tester: 1, validator: 2, reviewer: 1, editor: 1, writer: 1 }),
    ]);
    const mk = () =>
      e.rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", e.cap, (ctx) =>
        ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, a]),
      );
    const one = mk();
    const sent: LaunchRequest[] = [];
    e.rt.queue.attach((r) => sent.push(r), new AbortController().signal, e.cap);
    e.rt.api.move(one.id, { to: "launching", session: "validator-1" }, "system", e.cap);
    e.rt.api.move(one.id, { to: "running" }, "system", e.cap);
    const two = mk();
    const spec = route(e);
    await spec(one.id, "validator-1");
    await spec(one.id, "validator-1"); // a stop: retrying, close queued and not acked
    expect(e.rt.api.load(one.id)!.status).toBe("retrying");
    expect(e.rt.enqueueLaunch({ stage_id: two.id, session: "validator-2", room: "r1", harness: "claude", cwd: null, prompt: "x" }, e.cap)).toMatchObject({ ok: false });
    expect(e.rt.api.load(two.id)!.status).toBe("queued");
    // the first stage ends: the close is acked and the relaunch of stage one goes first; after it fails for good the second starts
    const close = sent.find((r) => r.kind === "close")!;
    e.rt.queue.ack(close.id, { result: "spawned" }, e.cap);
    expect(e.rt.api.load(one.id)!.status).toBe("launching");
    expect(e.rt.api.load(two.id)!.status).toBe("queued");
    // stage one runs again and passes; its close is acked: the second stage starts
    const relaunch = sent.filter((r) => r.kind === "launch").at(-1)!;
    expect(e.rt.queue.ack(relaunch.id, { result: "spawned" }, e.cap).status).toBe("ok");
    const session = (relaunch as { session: string }).session;
    e.rt.hooks.onResult(session, { stage_id: one.id, verdict: "PASS" }, e.cap);
    // a passed stage is not live any more (spec: launching, running or retrying): the second one starts
    expect(e.rt.api.load(one.id)!.status).toBe("passed");
    expect(e.rt.api.load(two.id)!.status).toBe("launching");
  });

  test("completedStage: a copied stage id names the sender's own running stage; a failed stage never says its result is recorded", () => {
    const e = makeEnv();
    const done = e.running("worker", "worker-1", e.ticket());
    e.rt.hooks.onResult("worker-1", { stage_id: done }, e.cap); // passed
    const own = e.running("tester", "tester-1", e.ticket());
    // tester-1 copies the stage id of the worker's stage
    const copied = e.rt.hooks.completedStage("tester-1", { stage_id: done });
    expect(copied).toBe(`stage ${done} is already passed. Your running stage is ${own}. Send your result with that stage_id.`);
    // a session with no running stage gets the short text
    expect(e.rt.hooks.completedStage("worker-1", { stage_id: done })).toBe(`stage ${done} is already passed; it takes no more results`);
    // a stage that failed (no result) must not claim a recorded result
    const failing = e.running("worker", "worker-2", e.ticket());
    e.rt.api.move(failing, { to: "retrying", reason: "x" }, "system", e.cap);
    e.rt.api.move(failing, { to: "failed" }, "system", e.cap);
    const msg = e.rt.hooks.completedStage("tester-1", { stage_id: failing })!;
    expect(msg).toContain(`stage ${failing} is already failed`);
    expect(msg).not.toContain("result is recorded");
    // no stage_id, an unknown id, a running stage: no refusal
    expect(e.rt.hooks.completedStage("tester-1", {})).toBeNull();
    expect(e.rt.hooks.completedStage("tester-1", { stage_id: "s_ffffffffffffffff" })).toBeNull();
    expect(e.rt.hooks.completedStage("tester-1", { stage_id: own })).toBeNull();
  });

  test("input checks: bad id 400, bad agent 400, unknown stage 404, another session 403", async () => {
    const e = makeEnv();
    const s = e.running("worker", "worker-1", e.ticket());
    expect((await e.turnEnd("nope", "worker-1")).status).toBe(400);
    expect((await e.turnEnd(s, 5)).status).toBe(400);
    expect((await e.turnEnd("s_0123456789abcdef", "worker-1")).status).toBe(404);
    expect((await e.turnEnd(s, "worker-2")).status).toBe(403);
    expect(e.reminders()).toHaveLength(0);
  });
});
