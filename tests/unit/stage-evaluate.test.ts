// evaluateStages (2.3): which stages a ticket is ready for.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, type RoleHandoff, type StageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv(roleHandoffs?: (t: string) => RoleHandoff[]) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt: StageRuntime = createStageRuntime(db, { ackMs: 60_000, roleHandoffs });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (over: { status?: string; role?: string | null; blockers?: string[] } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, over.status ?? "queued", over.role === undefined ? "worker" : over.role],
    );
    for (const b of over.blockers ?? []) db.run("INSERT INTO ticket_blockers (ticket_id, blocker_id) VALUES (?, ?)", [id, b]);
    return id;
  };
  const stages = (ticketId: string) =>
    db.query<{ role: string; status: string }, [string]>("SELECT role, status FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(ticketId);
  /** The seq a handoff created now would have: after every event so far. */
  const nextSeq = () => (db.query<{ m: number | null }, []>("SELECT MAX(seq) AS m FROM events").get()!.m ?? 0) + 1;
  /** Runs a stage to `passed` so the next evaluation sees a finished stage. */
  const pass = (stageId: string) => {
    rt.api.move(stageId, { to: "launching", session: "s-1" }, "system", cap);
    rt.api.move(stageId, { to: "running" }, "system", cap);
    rt.api.move(stageId, { to: "passed" }, "system", cap);
  };
  return { db, rt, cap, ticket, stages, nextSeq, pass };
}

describe("evaluateStages: ticket state", () => {
  test("a blocked ticket creates no stage; a done blocker does not block", () => {
    const e = makeEnv();
    const blocker = e.ticket({ status: "in_progress", role: null });
    const t = e.ticket({ blockers: [blocker] });
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]);
    expect(e.stages(t)).toEqual([]);
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [blocker]);
    expect(e.rt.evaluateStages(t, e.cap)).toHaveLength(1);
  });

  test.each(["draft", "done", "cancelled"])("a %s ticket creates no stage", (status) => {
    const e = makeEnv();
    const t = e.ticket({ status });
    expect(e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: e.nextSeq() }])).toEqual([]);
    expect(e.stages(t)).toEqual([]);
  });

  test("an unknown ticket creates nothing", () => {
    const e = makeEnv();
    expect(e.rt.evaluateStages("t_ffffffffffffffff", e.cap)).toEqual([]);
  });
});

describe("evaluateStages: the ticket role starts only the first stage", () => {
  test("a ticket with role worker and no handoff gets one queued worker stage and one stage.queued event", () => {
    const e = makeEnv();
    const t = e.ticket();
    const made = e.rt.evaluateStages(t, e.cap);
    expect(made.map((s) => [s.role, s.status, s.ticket_id])).toEqual([["worker", "queued", t]]);
    expect(e.db.query("SELECT kind FROM events WHERE entity_id = ?").all(made[0].id)).toEqual([{ kind: "stage.queued" }]);
  });

  test("a second call while the stage is queued creates none; neither while launching, running or retrying", () => {
    const e = makeEnv();
    const t = e.ticket();
    const [s] = e.rt.evaluateStages(t, e.cap);
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]);
    e.rt.api.move(s.id, { to: "launching", session: "worker-1" }, "system", e.cap);
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]);
    e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
    expect(e.rt.evaluateStages(t, e.cap, [{ role: "worker", seq: e.nextSeq() }])).toEqual([]); // a handoff while live
    e.rt.api.move(s.id, { to: "retrying" }, "system", e.cap);
    expect(e.rt.evaluateStages(t, e.cap, [{ role: "worker", seq: e.nextSeq() }])).toEqual([]); // retrying is live too
    expect(e.stages(t)).toHaveLength(1);
  });

  test("after the first stage passed, the ticket role starts nothing more", () => {
    const e = makeEnv();
    const t = e.ticket();
    e.pass(e.rt.evaluateStages(t, e.cap)[0].id);
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]);
    expect(e.stages(t)).toEqual([{ role: "worker", status: "passed" }]);
  });

  test("a ticket without a role and without a handoff creates nothing", () => {
    const e = makeEnv();
    expect(e.rt.evaluateStages(e.ticket({ role: null }), e.cap)).toEqual([]);
  });
});

describe("evaluateStages: role handoffs", () => {
  test("a tester handoff after a passed worker stage creates one tester stage", () => {
    const e = makeEnv();
    const t = e.ticket();
    e.pass(e.rt.evaluateStages(t, e.cap)[0].id);
    const made = e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: e.nextSeq() }]);
    expect(made.map((s) => s.role)).toEqual(["tester"]);
    expect(e.stages(t)).toEqual([{ role: "worker", status: "passed" }, { role: "tester", status: "queued" }]);
  });

  test("a tester handoff on a fresh ticket with role worker creates the worker stage and the tester stage", () => {
    const e = makeEnv();
    const t = e.ticket();
    const made = e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: e.nextSeq() }]);
    expect(made.map((s) => s.role).sort()).toEqual(["tester", "worker"]);
  });

  test("a new handoff after a passed tester stage creates one new tester stage; an old one does not", () => {
    const e = makeEnv();
    const t = e.ticket({ role: null });
    const first = e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: e.nextSeq() }]);
    expect(first).toHaveLength(1);
    const oldHandoff = { role: "tester", seq: 1 }; // older than the stage just created
    e.pass(first[0].id);
    expect(e.rt.evaluateStages(t, e.cap, [oldHandoff])).toEqual([]);
    const second = e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: e.nextSeq() }]);
    expect(second).toHaveLength(1);
    expect(e.stages(t).map((s) => s.role)).toEqual(["tester", "tester"]);
  });

  test("two handoffs of one role in one call create one stage", () => {
    const e = makeEnv();
    const t = e.ticket({ role: null });
    const s = e.nextSeq();
    expect(e.rt.evaluateStages(t, e.cap, [{ role: "tester", seq: s }, { role: "tester", seq: s + 1 }])).toHaveLength(1);
  });

  test("a handoff to an unknown role is ignored", () => {
    const e = makeEnv();
    const t = e.ticket({ role: null });
    expect(e.rt.evaluateStages(t, e.cap, [{ role: "chef", seq: e.nextSeq() }])).toEqual([]);
  });

  test("stored role handoffs (the roleHandoffs reader) count: a handoff that arrived while the ticket was blocked starts a stage later", () => {
    const stored: Record<string, RoleHandoff[]> = {};
    const e = makeEnv((t) => stored[t] ?? []);
    const blocker = e.ticket({ status: "in_progress", role: null });
    const t = e.ticket({ role: null, blockers: [blocker] });
    stored[t] = [{ role: "tester", seq: e.nextSeq() }];
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]); // blocked
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [blocker]);
    expect(e.rt.evaluateStages(t, e.cap).map((s) => s.role)).toEqual(["tester"]); // the blocker change re-evaluates
    expect(e.rt.evaluateStages(t, e.cap)).toEqual([]); // and the same handoff does not start a second stage
  });
});

describe("evaluateStages: a stage needs no launch", () => {
  test("evaluating creates queued stages only; nothing is launched", () => {
    const e = makeEnv();
    e.rt.evaluateStages(e.ticket(), e.cap);
    expect(e.rt.queue.size()).toEqual({ undelivered: 0, awaitingAck: 0, retained: 0 });
  });
});
