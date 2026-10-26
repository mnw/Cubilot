// spec-review-stage 4.2, brief test 11: the second spec FAIL since the last PASS tells the human, with the findings of that FAIL.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1", "r2");
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, config: { humanName: "human" }, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (request = "req-1", title = "Ticket", room = "r1") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, ?, 'c', 'low', 'medium', 'a', 'draft', ?, 1, 1, 1)`,
      [id, room, title, request],
    );
    return id;
  };
  let sessions = 0;
  /** One spec review of the request ends with this verdict; returns the findings it sent. */
  const review = (request: string, scope: string[], verdict: "PASS" | "FAIL", findings: Array<{ ticket_id: string; severity: string; text: string }> = []) => {
    const s = rt.api.create({ request_id: request, review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    const session = `validator-${++sessions}`;
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    rt.hooks.onResult(session, { stage_id: s.id, review: "spec", request_id: request, verdict, findings, suggestions: [], questions_for_human: [] }, cap);
  };
  const notices = () => emitted.filter((x) => x.s.kind === "ui-only" && x.e.from === "system");
  return { review, ticket, notices, emitted };
}

describe("second FAIL notice", () => {
  test("the first FAIL says nothing; the second is a ui-only system entry to the human with the findings of the second FAIL", () => {
    const e = makeEnv();
    const a = e.ticket("req-1", "Plan A");
    const b = e.ticket("req-1", "Plan B");
    e.review("req-1", [a, b], "FAIL", [{ ticket_id: a, severity: "blocking", text: "FIRST-ONLY finding" }]);
    expect(e.notices()).toHaveLength(0);
    e.review("req-1", [a, b], "FAIL", [
      { ticket_id: b, severity: "suggestion", text: "rename it" },
      { ticket_id: a, severity: "blocking", text: "no criteria" },
    ]);
    const n = e.notices();
    expect(n).toHaveLength(1);
    expect(n[0].s).toEqual({ kind: "ui-only" });
    expect(n[0].e).toMatchObject({ from: "system", to: "human", room: "r1" });
    const text = n[0].e.text;
    expect(text).toContain("req-1 failed 2 times");
    expect(text).toContain(`- [blocking] ${a} (Plan A): no criteria`);
    expect(text).toContain(`- [suggestion] ${b} (Plan B): rename it`);
    expect(text.indexOf("[blocking]")).toBeLessThan(text.indexOf("[suggestion]")); // blocking first
    expect(text).not.toContain("FIRST-ONLY");
  });

  test("a PASS in between resets the count: FAIL, PASS, FAIL says nothing; the next FAIL does", () => {
    const e = makeEnv();
    const a = e.ticket();
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "x" }]);
    e.review("req-1", [a], "PASS");
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "y" }]);
    expect(e.notices()).toHaveLength(0);
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "z" }]);
    expect(e.notices()).toHaveLength(1);
    expect(e.notices()[0].e.text).toContain("- [blocking]");
    expect(e.notices()[0].e.text).toContain(": z");
  });

  test("another request is counted alone; a third FAIL tells the human again with the count", () => {
    const e = makeEnv();
    const a = e.ticket("req-1");
    const o = e.ticket("req-2");
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "a1" }]);
    e.review("req-2", [o], "FAIL", [{ ticket_id: o, severity: "blocking", text: "o1" }]);
    expect(e.notices()).toHaveLength(0); // one FAIL each
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "a2" }]);
    e.review("req-1", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "a3" }]);
    const n = e.notices();
    expect(n).toHaveLength(2);
    expect(n[0].e.text).toContain("req-1 failed 2 times");
    expect(n[1].e.text).toContain("req-1 failed 3 times");
    expect(n.every((x) => !x.e.text.includes("req-2"))).toBe(true);
  });

  test("a FAIL with no findings still tells the human", () => {
    const e = makeEnv();
    const a = e.ticket();
    e.review("req-1", [a], "FAIL");
    e.review("req-1", [a], "FAIL");
    expect(e.notices()[0].e.text).toContain("(no findings listed)");
  });

  // The Validator's defect (4.3 review): the count was by request id alone, so another room's FAIL counted here.
  test("the same request id in two rooms is two requests: one FAIL in each room says nothing; a PASS in the other room resets nothing", () => {
    const e = makeEnv();
    const a = e.ticket("req-same", "A", "r1");
    const b = e.ticket("req-same", "B", "r2");
    e.review("req-same", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "a1" }]);
    e.review("req-same", [b], "FAIL", [{ ticket_id: b, severity: "blocking", text: "b1" }]);
    expect(e.notices()).toHaveLength(0); // before the fix: the second FAIL (room B) counted 2 and told the human
    e.review("req-same", [b], "PASS");
    e.review("req-same", [a], "FAIL", [{ ticket_id: a, severity: "blocking", text: "a2" }]);
    const n = e.notices();
    expect(n).toHaveLength(1); // room A's second FAIL: the PASS in room B did not reset room A
    expect(n[0].e).toMatchObject({ room: "r1" });
    expect(n[0].e.text).toContain("failed 2 times");
    expect(n[0].e.text).toContain("a2");
  });
});
