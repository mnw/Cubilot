// Stage transitions (2.2): each move writes one event and one row update in one transaction.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { createStageApi, createStageKind, type StageApi } from "../../hub/kinds/stage";
import { LedgerConflict, type Entry, type HubCapabilities, type Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createStageKind(db).migrate(db);
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = { db, sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) } } as unknown as HubCapabilities;
  const api: StageApi = createStageApi(db);
  const events = (id: string) =>
    db.query<{ kind: string; actor: string }, [string]>("SELECT kind, actor FROM events WHERE entity_id = ? ORDER BY seq").all(id);
  const row = (id: string) => db.query<Record<string, unknown>, [string]>("SELECT * FROM stage WHERE id = ?").get(id)!;
  return { db, cap, api, emitted, events, row };
}

const ticketStage = { ticket_id: "t_1", role: "worker" };

describe("stage transitions", () => {
  test("every state writes exactly one event and updates the row", () => {
    const { cap, api, events, row } = makeEnv();
    const s = api.create(ticketStage, "system", cap);
    expect(s.status).toBe("queued");
    expect(events(s.id).map((e) => e.kind)).toEqual(["stage.queued"]);

    api.move(s.id, { to: "launching", session: "worker-1", slot_seq: 1 }, "system", cap);
    expect(row(s.id).status).toBe("launching");
    expect(row(s.id).session).toBe("worker-1");
    api.move(s.id, { to: "running" }, "system", cap);
    api.move(s.id, { to: "retrying" }, "system", cap);
    api.move(s.id, { to: "launching", session: "worker-2" }, "system", cap);
    expect(row(s.id).attempt).toBe(2);
    api.move(s.id, { to: "running" }, "system", cap);
    api.move(s.id, { to: "passed", verdict: "PASS" }, "system", cap);

    expect(events(s.id).map((e) => e.kind)).toEqual([
      "stage.queued", "stage.launching", "stage.running", "stage.retrying", "stage.launching", "stage.running", "stage.passed",
    ]);
    expect(row(s.id).verdict).toBe("PASS");
    const last = row(s.id);
    expect(last.created_seq).toBeGreaterThan(0);
    expect(last.updated_seq).toBe(last.version as number);
  });

  test("failed is reachable from launching without an attempt (no project folder)", () => {
    const { cap, api, events } = makeEnv();
    const s = api.create(ticketStage, "system", cap);
    api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap);
    const f = api.move(s.id, { to: "failed" }, "system", cap);
    expect(f.attempt).toBe(1);
    expect(events(s.id).at(-1)!.kind).toBe("stage.failed");
  });

  test("a failing side effect leaves no event and no row change", () => {
    const { cap, api, events, row, db } = makeEnv();
    const s = api.create(ticketStage, "system", cap);
    const before = { events: events(s.id).length, row: row(s.id), seqs: db.query("SELECT COUNT(*) AS n FROM events").get() };
    expect(() =>
      api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(events(s.id).length).toBe(before.events);
    expect(row(s.id)).toEqual(before.row);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.seqs);

    // a failing side effect on create leaves nothing behind either
    expect(() => api.create(ticketStage, "system", cap, () => { throw new Error("boom2"); })).toThrow("boom2");
    expect(db.query("SELECT COUNT(*) AS n FROM stage").get()).toEqual({ n: 1 });
  });

  test("a side effect that writes shares the transaction: its write rolls back with the stage", () => {
    const { cap, api, db } = makeEnv();
    db.exec("CREATE TABLE probe (x TEXT)");
    const s = api.create(ticketStage, "system", cap);
    expect(() =>
      api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap, ({ tx }) => {
        tx.run("INSERT INTO probe VALUES ('a')");
        throw new Error("boom");
      }),
    ).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 0 });
    api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap, ({ tx }) => tx.run("INSERT INTO probe VALUES ('b')"));
    expect(db.query("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 1 });
  });

  test("refused moves write nothing", () => {
    const { cap, api, events } = makeEnv();
    const s = api.create(ticketStage, "system", cap);
    const refuse = (fn: () => unknown, status: number) => {
      try { fn(); } catch (e) { expect(e).toBeInstanceOf(LedgerConflict); expect((e as LedgerConflict).httpStatus).toBe(status); return; }
      throw new Error("expected a refusal");
    };
    refuse(() => api.move(s.id, { to: "running" }, "system", cap), 409); // queued → running
    refuse(() => api.move(s.id, { to: "launching" }, "system", cap), 400); // no session
    refuse(() => api.move("s_0000000000000000", { to: "launching", session: "w-1" }, "system", cap), 404);
    refuse(() => api.create({ role: "worker" }, "system", cap), 400); // ticket stage without ticket_id
    refuse(() => api.create({ role: "validator", review: "spec" }, "system", cap), 400); // spec stage without request_id
    expect(events(s.id).map((e) => e.kind)).toEqual(["stage.queued"]);
  });

  test("a terminal stage takes no move; the same terminal move is idempotent; attempt 2 is the last", () => {
    const { cap, api, events } = makeEnv();
    const s = api.create(ticketStage, "system", cap);
    api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap);
    api.move(s.id, { to: "running" }, "system", cap);
    api.move(s.id, { to: "passed" }, "system", cap);
    const n = events(s.id).length;
    expect(api.move(s.id, { to: "passed" }, "system", cap).status).toBe("passed");
    expect(events(s.id).length).toBe(n); // idempotent: no new event
    expect(() => api.move(s.id, { to: "running" }, "system", cap)).toThrow(LedgerConflict);

    const t = api.create(ticketStage, "system", cap);
    api.move(t.id, { to: "launching", session: "worker-1" }, "system", cap);
    api.move(t.id, { to: "retrying" }, "system", cap);
    api.move(t.id, { to: "launching", session: "worker-2" }, "system", cap);
    api.move(t.id, { to: "retrying" }, "system", cap);
    expect(() => api.move(t.id, { to: "launching", session: "worker-3" }, "system", cap)).toThrow(LedgerConflict);
    expect(api.move(t.id, { to: "failed" }, "system", cap).status).toBe("failed");
  });

  test("a spec-review stage has no ticket_id", () => {
    const { cap, api, row } = makeEnv();
    const s = api.create({ role: "validator", review: "spec", request_id: "r1" }, "system", cap);
    expect(row(s.id).ticket_id).toBeNull();
    expect(row(s.id).review).toBe("spec");
  });
});
