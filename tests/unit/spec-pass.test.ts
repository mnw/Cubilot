// The PASS transaction of a spec-review stage (spec-review-stage 3.2, brief test 10).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { LedgerConflict, type Entry, type HubCapabilities, type Scope } from "../../hub/core/types";

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
  const ticket = (over: { status?: string; radius?: string; request?: string; role?: string | null } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', ?, 'medium', 'a', ?, ?, ?, 1, 1, 1)`,
      [id, over.radius ?? "low", over.status ?? "draft", over.role === undefined ? null : over.role, over.request ?? "req-1"],
    );
    return id;
  };
  const specStage = (scope: string[]) => {
    const s = rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    rt.api.move(s.id, { to: "launching", session: "validator-1" }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    return s.id;
  };
  const status = (id: string) => db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(id)!.status;
  const events = (kinds: string[]) =>
    db.query<{ entity_id: string; kind: string; actor: string }, []>(
      `SELECT entity_id, kind, actor FROM events WHERE kind IN (${kinds.map((k) => `'${k}'`).join(",")}) ORDER BY seq`,
    ).all();
  return { db, rt, cap, emitted, ticket, specStage, status, events };
}

describe("spec PASS", () => {
  test("a normal PASS: stage.passed with verdict PASS and one ticket.queued (actor system) per scope ticket, in one run", () => {
    const e = makeEnv();
    const a = e.ticket();
    const b = e.ticket();
    const s = e.specStage([a, b]);
    const r = e.rt.passSpecStage(s, e.cap);
    expect(r.queued).toEqual([a, b]);
    expect(r.waitingForApproval).toBe(false);
    expect(r.stage).toMatchObject({ status: "passed", verdict: "PASS" });
    expect([e.status(a), e.status(b)]).toEqual(["queued", "queued"]);
    expect(e.events(["stage.passed", "ticket.queued"])).toEqual([
      { entity_id: s, kind: "stage.passed", actor: "system" },
      { entity_id: a, kind: "ticket.queued", actor: "system" },
      { entity_id: b, kind: "ticket.queued", actor: "system" },
    ]);
    // the room hears about each promoted ticket
    expect(e.emitted.filter((x) => x.e.kind === "ticket.promoted").map((x) => x.s)).toEqual([{ kind: "room", room: "r1" }, { kind: "room", room: "r1" }]);
  });

  test("a request with a non-terminal high ticket: only stage.passed is written, the tickets stay draft", () => {
    const e = makeEnv();
    const a = e.ticket();
    const hi = e.ticket({ radius: "high" });
    const s = e.specStage([a]); // the high ticket is outside the scope; the request still holds it
    const r = e.rt.passSpecStage(s, e.cap);
    expect(r.queued).toEqual([]);
    expect(r.waitingForApproval).toBe(true);
    expect([e.status(a), e.status(hi)]).toEqual(["draft", "draft"]);
    expect(e.events(["stage.passed", "ticket.queued"])).toEqual([{ entity_id: s, kind: "stage.passed", actor: "system" }]);
  });

  test("a done high ticket does not hold the request", () => {
    const e = makeEnv();
    e.ticket({ radius: "high", status: "done" });
    const a = e.ticket();
    expect(e.rt.passSpecStage(e.specStage([a]), e.cap).queued).toEqual([a]);
  });

  test("a draft ticket outside the scope, and a draft of another request, stay draft", () => {
    const e = makeEnv();
    const a = e.ticket();
    const outside = e.ticket();
    const other = e.ticket({ request: "req-2" });
    e.rt.passSpecStage(e.specStage([a]), e.cap);
    expect([e.status(a), e.status(outside), e.status(other)]).toEqual(["queued", "draft", "draft"]);
  });

  test("a scope ticket that left the request is not promoted (Validator finding): the high rule still holds for the request", () => {
    const e = makeEnv();
    const hi = e.ticket({ radius: "high" });
    const plain = e.ticket();
    const s = e.specStage([hi, plain]);
    e.db.run("UPDATE tickets SET request_id = 'req-2' WHERE id = ?", [hi]);
    const r = e.rt.passSpecStage(s, e.cap);
    expect(r.queued).toEqual([plain]); // no high ticket is left in req-1
    expect(e.status(hi)).toBe("draft");
    // with a high ticket that stays in the request, nothing moves, and a moved ticket stays put too
    const e2 = makeEnv();
    const hi2 = e2.ticket({ radius: "high" });
    const moved = e2.ticket({ radius: "high" });
    const s2 = e2.specStage([hi2, moved]);
    e2.db.run("UPDATE tickets SET request_id = 'req-2' WHERE id = ?", [moved]);
    const r2 = e2.rt.passSpecStage(s2, e2.cap);
    expect(r2.queued).toEqual([]);
    expect(r2.waitingForApproval).toBe(true);
    expect([e2.status(hi2), e2.status(moved)]).toEqual(["draft", "draft"]);
  });

  test("a scope ticket that is no longer draft is skipped", () => {
    const e = makeEnv();
    const a = e.ticket();
    const b = e.ticket({ status: "queued" });
    const r = e.rt.passSpecStage(e.specStage([a, b]), e.cap);
    expect(r.queued).toEqual([a]);
    expect(e.events(["ticket.queued"]).map((x) => x.entity_id)).toEqual([a]);
  });

  test("a forced failure in the middle leaves no event and no ticket change", () => {
    const e = makeEnv();
    const a = e.ticket();
    const b = e.ticket();
    const s = e.specStage([a, b]);
    e.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON tickets WHEN NEW.id = '${b}' BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    const events0 = e.db.query("SELECT COUNT(*) AS n FROM events").get();
    expect(() => e.rt.passSpecStage(s, e.cap)).toThrow();
    expect(e.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(events0);
    expect([e.status(a), e.status(b)]).toEqual(["draft", "draft"]);
    expect(e.rt.api.load(s)?.status).toBe("running");
    expect(e.emitted.filter((x) => x.e.kind === "ticket.promoted")).toEqual([]);
  });

  test("a stage that is not a running spec stage is refused", () => {
    const e = makeEnv();
    const a = e.ticket();
    const s = e.specStage([a]);
    e.rt.passSpecStage(s, e.cap);
    expect(() => e.rt.passSpecStage(s, e.cap)).toThrow(LedgerConflict); // already passed
    const ticketStage = e.rt.api.create({ ticket_id: e.ticket({ status: "queued" }), role: "worker" }, "system", e.cap);
    expect(() => e.rt.passSpecStage(ticketStage.id, e.cap)).toThrow(LedgerConflict);
    expect(() => e.rt.passSpecStage("s_0000000000000000", e.cap)).toThrow(LedgerConflict);
  });

  test("the queued tickets get their stages: a worker ticket starts a worker launch (brief test 9 turned around)", () => {
    const e = makeEnv();
    const a = e.ticket({ role: "worker" });
    expect(e.db.query("SELECT COUNT(*) AS n FROM stage WHERE role = 'worker'").get()).toEqual({ n: 0 });
    e.rt.passSpecStage(e.specStage([a]), e.cap);
    expect(e.db.query("SELECT status, session FROM stage WHERE ticket_id = ?").get(a)).toEqual({ status: "launching", session: "worker-1" });
  });
});
