// spec-review-stage 4.3: the requests of a room that need the human (spec review failed twice or more since the last PASS).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, needsYouRequests } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  giveProject(db, "r2");
  const cap = { db, config: { humanName: "human" }, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (request: string, title: string, room = "r1") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, ?, 'c', 'low', 'medium', 'a', 'draft', ?, 1, 1, 1)`,
      [id, room, title, request],
    );
    return id;
  };
  let sessions = 0;
  let h = 0;
  /** One spec review ends: the stage passes with the verdict and the result handoff is recorded, as the hub does. */
  const review = (request: string, scope: string[], verdict: "PASS" | "FAIL", findings: unknown[] = []) => {
    const s = rt.api.create({ request_id: request, review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    const session = `validator-${++sessions}`;
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    const hid = `h_${(++h).toString(16).padStart(16, "0")}`;
    const context = JSON.stringify({ stage_id: s.id, review: "spec", request_id: request, verdict, findings });
    db.run("INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms, room) VALUES (?, ?, 'Orchestrator', 'r', ?, 'pending', 1, 2, 'r1')", [hid, session, context]);
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms, room) VALUES (?, 'handoff.created', ?, '{}', 1, 'r1')", [hid, session]);
    rt.hooks.onResult(session, JSON.parse(context), cap);
  };
  /** A newer spec stage that is not ended: moved to the asked open status. */
  const openStage = (request: string, scope: string[], status: "queued" | "launching" | "running" | "retrying") => {
    const s = rt.api.create({ request_id: request, review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    if (status !== "queued") rt.api.move(s.id, { to: "launching", session: `validator-${++sessions}` }, "system", cap);
    if (status === "running" || status === "retrying") rt.api.move(s.id, { to: "running" }, "system", cap);
    if (status === "retrying") rt.api.move(s.id, { to: "retrying", reason: "x" }, "system", cap);
    return s.id;
  };
  /** An open stage ends with a verdict (as the hub does) or with no verdict (operational failed). */
  const endStage = (id: string, request: string, end: "PASS" | "FAIL" | "failed", findings: unknown[] = []) => {
    if (end === "failed") {
      rt.api.move(id, { to: "failed" }, "system", cap);
      return;
    }
    if (rt.api.load(id)!.status === "queued") rt.api.move(id, { to: "launching", session: `validator-${++sessions}` }, "system", cap);
    if (rt.api.load(id)!.status === "launching") rt.api.move(id, { to: "running" }, "system", cap);
    if (rt.api.load(id)!.status === "retrying") {
      rt.api.move(id, { to: "launching", session: `validator-${++sessions}` }, "system", cap);
      rt.api.move(id, { to: "running" }, "system", cap);
    }
    const session = rt.api.load(id)!.session!;
    const hid = `h_${(++h).toString(16).padStart(16, "0")}`;
    const context = JSON.stringify({ stage_id: id, review: "spec", request_id: request, verdict: end, findings });
    db.run("INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms, room) VALUES (?, ?, 'Orchestrator', 'r', ?, 'pending', 1, 2, 'r1')", [hid, session, context]);
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms, room) VALUES (?, 'handoff.created', ?, '{}', 1, 'r1')", [hid, session]);
    rt.hooks.onResult(session, JSON.parse(context), cap);
  };
  return { db, ticket, review, openStage, endStage };
}

describe("needsYouRequests", () => {
  test("one FAIL is not listed; the second lists the findings of the latest FAIL only, blocking first, with ticket titles", () => {
    const e = makeEnv();
    const a = e.ticket("req-1", "Plan A");
    const b = e.ticket("req-1", "Plan B");
    e.review("req-1", [a, b], "FAIL", [{ ticket_id: a, severity: "blocking", text: "FIRST-ONLY" }]);
    expect(needsYouRequests(e.db, "r1")).toEqual([]);
    e.review("req-1", [a, b], "FAIL", [
      { ticket_id: b, severity: "suggestion", text: "rename it" },
      { ticket_id: a, severity: "blocking", text: "no criteria" },
    ]);
    const r = needsYouRequests(e.db, "r1");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ request_id: "req-1", fail_count: 2 });
    expect(r[0].findings).toEqual([
      { ticket_id: a, title: "Plan A", severity: "blocking", text: "no criteria" },
      { ticket_id: b, title: "Plan B", severity: "suggestion", text: "rename it" },
    ]);
  });

  test("a PASS ends it; a later FAIL starts a new count; a third FAIL shows the newest findings with the count", () => {
    const e = makeEnv();
    const a = e.ticket("req-1", "Plan A");
    const f = (text: string) => [{ ticket_id: a, severity: "blocking", text }];
    e.review("req-1", [a], "FAIL", f("one"));
    e.review("req-1", [a], "FAIL", f("two"));
    expect(needsYouRequests(e.db, "r1")).toHaveLength(1);
    e.review("req-1", [a], "PASS");
    expect(needsYouRequests(e.db, "r1")).toEqual([]);
    e.review("req-1", [a], "FAIL", f("three"));
    expect(needsYouRequests(e.db, "r1")).toEqual([]);
    e.review("req-1", [a], "FAIL", f("four"));
    e.review("req-1", [a], "FAIL", f("five"));
    const r = needsYouRequests(e.db, "r1");
    expect(r[0].fail_count).toBe(3);
    expect(r[0].findings.map((x) => x.text)).toEqual(["five"]);
  });

  test("only the requests of the asked room are listed; two requests are listed apart", () => {
    const e = makeEnv();
    const a = e.ticket("req-1", "A", "r1");
    const o = e.ticket("req-2", "O", "r2");
    const a2 = e.ticket("req-3", "A3", "r1");
    for (const [req, t] of [["req-1", a], ["req-2", o], ["req-3", a2]] as const) {
      e.review(req, [t], "FAIL", [{ ticket_id: t, severity: "blocking", text: req }]);
      e.review(req, [t], "FAIL", [{ ticket_id: t, severity: "blocking", text: req }]);
    }
    expect(needsYouRequests(e.db, "r1").map((r) => r.request_id)).toEqual(["req-1", "req-3"]);
    expect(needsYouRequests(e.db, "r2").map((r) => r.request_id)).toEqual(["req-2"]);
    expect(needsYouRequests(e.db, "none")).toEqual([]);
  });

  // The Validator's defect: one request id used in two rooms. Every count, reset and finding is the room's own.
  describe("the same request id in two rooms", () => {
    const both = () => {
      const e = makeEnv();
      const a = e.ticket("req-same", "Plan in A", "r1");
      const b = e.ticket("req-same", "Plan in B", "r2");
      const f = (t: string, text: string) => [{ ticket_id: t, severity: "blocking", text }];
      return { e, a, b, f };
    };

    test("each room counts its own FAILs: one FAIL in each room lists nothing (the count is not 2)", () => {
      const { e, a, b, f } = both();
      e.review("req-same", [a], "FAIL", f(a, "A1"));
      e.review("req-same", [b], "FAIL", f(b, "B1"));
      expect(needsYouRequests(e.db, "r1")).toEqual([]);
      expect(needsYouRequests(e.db, "r2")).toEqual([]);
    });

    test("two FAILs in each room: each room lists its own count and its own latest findings, never the other room's", () => {
      const { e, a, b, f } = both();
      e.review("req-same", [a], "FAIL", f(a, "A1"));
      e.review("req-same", [b], "FAIL", f(b, "B1"));
      e.review("req-same", [a], "FAIL", f(a, "A2"));
      e.review("req-same", [b], "FAIL", f(b, "B2"));
      const ra = needsYouRequests(e.db, "r1");
      const rb = needsYouRequests(e.db, "r2");
      expect(ra).toHaveLength(1);
      expect(ra[0].fail_count).toBe(2); // not 4
      expect(ra[0].findings.map((x) => x.text)).toEqual(["A2"]);
      expect(rb[0].fail_count).toBe(2);
      expect(rb[0].findings.map((x) => x.text)).toEqual(["B2"]);
    });

    test("a PASS in room B does not clear room A", () => {
      const { e, a, b, f } = both();
      e.review("req-same", [a], "FAIL", f(a, "A1"));
      e.review("req-same", [a], "FAIL", f(a, "A2"));
      e.review("req-same", [b], "PASS");
      expect(needsYouRequests(e.db, "r1")).toHaveLength(1);
      expect(needsYouRequests(e.db, "r2")).toEqual([]);
    });

    test("the findings come from the latest FAIL stage of the room even when the other room failed later", () => {
      const { e, a, b, f } = both();
      e.review("req-same", [a], "FAIL", f(a, "A1"));
      e.review("req-same", [a], "FAIL", f(a, "A-LATEST"));
      e.review("req-same", [b], "FAIL", f(b, "B-NEWER"));
      e.review("req-same", [b], "FAIL", f(b, "B-NEWEST"));
      expect(needsYouRequests(e.db, "r1")[0].findings.map((x) => x.text)).toEqual(["A-LATEST"]);
    });
  });

  describe("a newer spec review of the request", () => {
    const f = (t: string, text: string) => [{ ticket_id: t, severity: "blocking", text }];
    const failed2 = () => {
      const e = makeEnv();
      const a = e.ticket("req-1", "Plan A");
      e.review("req-1", [a], "FAIL", f(a, "one"));
      e.review("req-1", [a], "FAIL", f(a, "two"));
      return { e, a };
    };

    test("2 FAILs show the row with today's fields", () => {
      const { e, a } = failed2();
      expect(needsYouRequests(e.db, "r1")).toEqual([
        { request_id: "req-1", fail_count: 2, findings: [{ ticket_id: a, title: "Plan A", severity: "blocking", text: "two" }] },
      ]);
    });

    for (const status of ["queued", "launching", "running", "retrying"] as const) {
      test(`a newer stage in ${status} hides the row`, () => {
        const { e, a } = failed2();
        e.openStage("req-1", [a], status);
        expect(needsYouRequests(e.db, "r1")).toEqual([]);
      });
    }

    test("newer stage FAILs: row back with fail_count 3 and its findings", () => {
      const { e, a } = failed2();
      const s = e.openStage("req-1", [a], "running");
      e.endStage(s, "req-1", "FAIL", f(a, "three"));
      const r = needsYouRequests(e.db, "r1");
      expect(r[0].fail_count).toBe(3);
      expect(r[0].findings.map((x) => x.text)).toEqual(["three"]);
    });

    test("newer stage PASSes: row gone", () => {
      const { e, a } = failed2();
      const s = e.openStage("req-1", [a], "running");
      e.endStage(s, "req-1", "PASS");
      expect(needsYouRequests(e.db, "r1")).toEqual([]);
    });

    test("newer stage ends operational failed: row back with fail_count 2 and the old findings", () => {
      const { e, a } = failed2();
      const s = e.openStage("req-1", [a], "running");
      e.endStage(s, "req-1", "failed");
      const r = needsYouRequests(e.db, "r1");
      expect(r[0].fail_count).toBe(2);
      expect(r[0].findings.map((x) => x.text)).toEqual(["two"]);
    });

    test("a newer stage of another request or another room does not hide the row", () => {
      const { e, a } = failed2();
      const o = e.ticket("req-9", "Other", "r1");
      const p = e.ticket("req-1", "Same id, other room", "r2");
      e.openStage("req-9", [o], "running");
      e.openStage("req-1", [p], "running");
      expect(needsYouRequests(e.db, "r1")).toHaveLength(1);
    });

    test("two newer stages, one FAILs, the other queued: hidden; then the second FAILs: fail_count 4", () => {
      const { e, a } = failed2();
      const s1 = e.openStage("req-1", [a], "running");
      const s2 = e.openStage("req-1", [a], "queued");
      e.endStage(s1, "req-1", "FAIL", f(a, "three"));
      expect(needsYouRequests(e.db, "r1")).toEqual([]);
      e.endStage(s2, "req-1", "FAIL", f(a, "four"));
      const r = needsYouRequests(e.db, "r1");
      expect(r[0].fail_count).toBe(4);
      expect(r[0].findings.map((x) => x.text)).toEqual(["four"]);
    });

    test("two newer stages, one FAILs, the other queued then operational failed: fail_count 3 with the first newer FAIL", () => {
      const { e, a } = failed2();
      const s1 = e.openStage("req-1", [a], "running");
      const s2 = e.openStage("req-1", [a], "queued");
      e.endStage(s1, "req-1", "FAIL", f(a, "three"));
      expect(needsYouRequests(e.db, "r1")).toEqual([]);
      e.endStage(s2, "req-1", "failed");
      const r = needsYouRequests(e.db, "r1");
      expect(r[0].fail_count).toBe(3);
      expect(r[0].findings.map((x) => x.text)).toEqual(["three"]);
    });

    test("two newer stages, one operational failed, the other queued: hidden", () => {
      const { e, a } = failed2();
      const s1 = e.openStage("req-1", [a], "running");
      e.openStage("req-1", [a], "queued");
      e.endStage(s1, "req-1", "failed");
      expect(needsYouRequests(e.db, "r1")).toEqual([]);
    });
  });
});
