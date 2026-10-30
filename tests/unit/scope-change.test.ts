// scopeChange and needsApprove (plan-approval, design decision 2): pure reads of the ledger.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createRequestKind, heldForApprove, needsApprove, scopeChange, type ApprovedScope } from "../../hub/kinds/request";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  createRequestKind(db).migrate(db);
  let n = 0;
  const request = (id: string, over: { origin?: string; features?: string[]; approved?: ApprovedScope | null } = {}) =>
    db.run(
      `INSERT INTO requests (id, room, request_id, origin, features, approved, status, created_by, created_at_ms, version)
       VALUES (?, 'r1', ?, ?, ?, ?, ?, 'test', 1, 1)`,
      [`rq_${id}`, id, over.origin ?? "human", JSON.stringify(over.features ?? []), over.approved ? JSON.stringify(over.approved) : null, over.approved ? "approved" : "open"],
    );
  const ticket = (requestId: string, over: { radius?: string; status?: string; room?: string } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', ?, 3, 'a', ?, ?, 1, 1, 1)`,
      [id, over.room ?? "r1", over.radius ?? "low", over.status ?? "draft", requestId],
    );
    return id;
  };
  return { db, request, ticket };
}

const none = { added: [], removed: [], raised: [], features: { added: [], removed: [] } };

describe("scopeChange", () => {
  test("Criteria edit: a criteria, title, blocked_by or priority edit is not a scope change", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }] } });
    e.db.run("UPDATE tickets SET acceptance_criteria = 'new text', title = 'new', priority = 5 WHERE id = ?", [t1]);
    e.db.run("INSERT INTO ticket_blockers (ticket_id, blocker_id) VALUES (?, 't_ffffffffffffffff')", [t1]);
    expect(scopeChange(e.db, "r1", "r-1")).toEqual({ changed: false, approved: true, ...none });
  });

  test("New ticket: a ticket that is not in the approved scope is added", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }] } });
    const t3 = e.ticket("r-1");
    expect(scopeChange(e.db, "r1", "r-1")).toMatchObject({ changed: true, added: [t3], removed: [], raised: [] });
  });

  test("a cancelled new ticket and a ticket of another room or request are not added", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }] } });
    e.ticket("r-1", { status: "cancelled" });
    e.ticket("r-1", { room: "r2" });
    e.ticket("r-2");
    expect(scopeChange(e.db, "r1", "r-1").changed).toBe(false);
  });

  test("Radius raised: an approved low ticket that is now high", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }] } });
    e.db.run("UPDATE tickets SET blast_radius = 'high' WHERE id = ?", [t1]);
    expect(scopeChange(e.db, "r1", "r-1")).toMatchObject({ changed: true, raised: [t1], added: [], removed: [] });
  });

  test("a lowered radius is not a scope change", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1", { radius: "high" });
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "high" }] } });
    e.db.run("UPDATE tickets SET blast_radius = 'low' WHERE id = ?", [t1]);
    expect(scopeChange(e.db, "r1", "r-1").changed).toBe(false);
  });

  test("Removed ticket: an approved ticket that is cancelled, or has another request_id", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    const t2 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }, { id: t2, radius: "low" }] } });
    e.db.run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", [t1]);
    expect(scopeChange(e.db, "r1", "r-1")).toMatchObject({ changed: true, removed: [t1] });
    e.db.run("UPDATE tickets SET request_id = 'r-9' WHERE id = ?", [t2]);
    expect(scopeChange(e.db, "r1", "r-1").removed.sort()).toEqual([t1, t2].sort());
  });

  test("Feature added: the lead adds a feature; the same strings in another order also differ", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { features: ["a", "b"], approved: { features: ["a", "b"], tickets: [{ id: t1, radius: "low" }] } });
    expect(scopeChange(e.db, "r1", "r-1").changed).toBe(false);
    e.db.run("UPDATE requests SET features = ? WHERE request_id = 'r-1'", [JSON.stringify(["a", "b", "c"])]);
    expect(scopeChange(e.db, "r1", "r-1")).toMatchObject({ changed: true, features: { added: ["c"], removed: [] } });
    e.db.run("UPDATE requests SET features = ? WHERE request_id = 'r-1'", [JSON.stringify(["b", "a"])]);
    expect(scopeChange(e.db, "r1", "r-1").changed).toBe(true);
  });

  test("a request without an Approve, or without a row, has no change", () => {
    const e = makeEnv();
    e.ticket("r-1");
    e.request("r-1");
    expect(scopeChange(e.db, "r1", "r-1")).toEqual({ changed: false, approved: false, ...none });
    expect(scopeChange(e.db, "r1", "r-none").approved).toBe(false);
  });
});

describe("needsApprove", () => {
  test("human low: yes", () => expect(needsApprove({ origin: "human", features: [], hasHighTicket: false })).toBe(true));
  test("factory low: no", () => expect(needsApprove({ origin: "factory", features: [], hasHighTicket: false })).toBe(false));
  test("factory high: yes", () => expect(needsApprove({ origin: "factory", features: [], hasHighTicket: true })).toBe(true));
  test("factory with a feature: yes", () => expect(needsApprove({ origin: "factory", features: ["x"], hasHighTicket: false })).toBe(true));
});

describe("heldForApprove", () => {
  test("a done or cancelled high ticket does not make a factory request need the Approve", () => {
    const e = makeEnv();
    e.request("f-1", { origin: "factory" });
    e.ticket("f-1", { radius: "high", status: "done" });
    e.ticket("f-1", { radius: "high", status: "cancelled" });
    expect(heldForApprove(e.db, "r1", "f-1")).toBe(false);
    e.ticket("f-1", { radius: "high" });
    expect(heldForApprove(e.db, "r1", "f-1")).toBe(true);
  });

  test("an approved request with no change is not held; a change holds it again", () => {
    const e = makeEnv();
    const t1 = e.ticket("r-1");
    e.request("r-1", { approved: { features: [], tickets: [{ id: t1, radius: "low" }] } });
    expect(heldForApprove(e.db, "r1", "r-1")).toBe(false);
    e.ticket("r-1");
    expect(heldForApprove(e.db, "r1", "r-1")).toBe(true);
  });
});
