// context-pack 1.4: earlier notes of a ticket: planning note, then spec-result notes, then stage result notes by created_seq.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, earlierNotes } from "../../hub/kinds/stage";

const T = "t_0000000000000001";

function makeEnv(planning: string | null = "plan") {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: () => {} }, briefing: { refresh: () => {} } } as never;
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, planning_note, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'in_progress', 'req-1', ?, 1, 1, 1)`,
    [T, planning],
  );
  let n = 0;
  const result = (stageId: string, notes: unknown) =>
    db.run(
      `INSERT INTO handoffs (id, from_agent, to_agent, task, status, context_json, room, created_at_ms, expires_at_ms)
       VALUES (?, 'x', 'y', 'result', 'pending', ?, 'r1', 1, 9999999999999)`,
      [`h_${++n}`.padEnd(18, "0"), JSON.stringify({ stage_id: stageId, notes })],
    );
  const stage = (role: string, notes?: unknown) => {
    const s = rt.api.create({ ticket_id: T, role: role as never }, "system", cap);
    if (notes !== undefined) result(s.id, notes);
    return s.id;
  };
  const spec = (notes: string) => {
    const s = rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", cap, (ctx) => {
      ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, T]);
    });
    result(s.id, notes);
    return s.id;
  };
  return { db, stage, spec, result };
}

describe("earlierNotes", () => {
  test("order: planning note, spec-result notes, then stage notes by created_seq", () => {
    const e = makeEnv();
    const w = e.stage("worker", "from worker");
    const sp = e.spec("spec facts");
    const t = e.stage("tester", "from tester");
    const got = earlierNotes(e.db, T);
    expect(got.map((x) => x.notes)).toEqual(["plan", "spec facts", "from worker", "from tester"]);
    expect(got.map((x) => x.source)).toEqual(["planning", "spec", "stage", "stage"]);
    expect(got[1]).toMatchObject({ stage_id: sp, role: "validator" });
    expect(got[2]).toMatchObject({ stage_id: w, role: "worker" });
    expect(got[3]).toMatchObject({ stage_id: t, role: "tester" });
  });

  test("stage notes follow created_seq, not the order the handoffs were written", () => {
    const e = makeEnv(null);
    const first = e.stage("worker");
    const second = e.stage("tester", "second");
    e.result(first, "first");
    expect(earlierNotes(e.db, T).map((x) => x.notes)).toEqual(["first", "second"]);
    expect(second).not.toBe(first);
  });

  test("a stage without a result, a result without notes and another ticket's notes add nothing", () => {
    const e = makeEnv(null);
    e.stage("worker");
    e.stage("tester", "");
    e.stage("validator", undefined);
    expect(earlierNotes(e.db, T)).toEqual([]);
    expect(earlierNotes(e.db, "t_ffffffffffffffff")).toEqual([]);
  });

  test("a ticket with no planning note and no results returns an empty list", () => {
    expect(earlierNotes(makeEnv(null).db, T)).toEqual([]);
  });
});
