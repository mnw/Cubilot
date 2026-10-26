// "Waiting for approval" query (spec-review-stage 3.4): PASS verdict, a scope ticket still draft, a non-terminal high ticket.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, waitingForApproval, WAITING_FOR_APPROVAL_SQL } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (over: { status?: string; radius?: string; request?: string; room?: string } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', ?, 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, over.room ?? "r1", over.radius ?? "low", over.status ?? "draft", over.request ?? "req-1"],
    );
    return id;
  };
  /** A spec stage with the given scope, moved to `passed` with the verdict (the PASS transaction is not used: 3.2 has its own tests). */
  const specStage = (scope: string[], verdict: "PASS" | "FAIL" | null = "PASS", request = "req-1") => {
    const s = rt.api.create({ request_id: request, review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    if (verdict) {
      rt.api.move(s.id, { to: "launching", session: `validator-${n}` }, "system", cap);
      rt.api.move(s.id, { to: "running" }, "system", cap);
      rt.api.move(s.id, { to: "passed", verdict }, "system", cap);
    }
    return s.id;
  };
  return { db, ticket, specStage };
}

describe("waiting for approval", () => {
  test("PASS, a scope ticket still draft and a high ticket in the request: waiting", () => {
    const e = makeEnv();
    const a = e.ticket();
    e.ticket({ radius: "high" });
    e.specStage([a]);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(true);
  });

  test("no PASS verdict: not waiting (FAIL, or a stage without a verdict)", () => {
    const e = makeEnv();
    const a = e.ticket();
    e.ticket({ radius: "high" });
    e.specStage([a], "FAIL");
    e.specStage([a], null);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(false);
  });

  test("every scope ticket already queued or beyond: not waiting", () => {
    const e = makeEnv();
    const a = e.ticket({ status: "queued" });
    e.ticket({ radius: "high" });
    e.specStage([a]);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(false);
  });

  test("no non-terminal high ticket in the request: not waiting (a done high ticket does not count)", () => {
    const e = makeEnv();
    const a = e.ticket();
    const hi = e.ticket({ radius: "high" });
    e.specStage([a]);
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [hi]);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(false);
    e.db.run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", [hi]);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(false);
  });

  test("another request, or another room, is not affected", () => {
    const e = makeEnv();
    const a = e.ticket();
    e.ticket({ radius: "high" });
    e.specStage([a]);
    expect(waitingForApproval(e.db, "r1", "req-2")).toBe(false);
    expect(waitingForApproval(e.db, "r2", "req-1")).toBe(false);
    // a high ticket of another request or room does not hold this one
    const e2 = makeEnv();
    const b = e2.ticket();
    e2.ticket({ radius: "high", request: "req-2" });
    e2.ticket({ radius: "high", room: "r2" });
    e2.specStage([b]);
    expect(waitingForApproval(e2.db, "r1", "req-1")).toBe(false);
  });

  test("a scope ticket that moved to another request does not make the request wait", () => {
    const e = makeEnv();
    const a = e.ticket({ request: "req-9" });
    e.ticket({ radius: "high" });
    e.specStage([a]);
    expect(waitingForApproval(e.db, "r1", "req-1")).toBe(false);
  });

  test("EXPLAIN QUERY PLAN uses idx_stage_request_review", () => {
    const e = makeEnv();
    const plan = e.db.query(`EXPLAIN QUERY PLAN ${WAITING_FOR_APPROVAL_SQL}`).all("req-1", "r1") as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" | ")).toContain("idx_stage_request_review");
  });
});
