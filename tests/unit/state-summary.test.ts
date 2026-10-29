import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildStateSummary, SUMMARY_MAX_CHARS } from "../../hub/core/state-summary";

function ledger(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tickets (id TEXT, room TEXT, request_id TEXT, title TEXT, status TEXT, blast_radius TEXT, created_at_ms INTEGER, acceptance_criteria TEXT);
    CREATE TABLE ticket_blockers (ticket_id TEXT, blocker_id TEXT);
    CREATE TABLE decisions (id TEXT, room TEXT, ticket_id TEXT, request_id TEXT, decider TEXT, reason TEXT, status TEXT, created_at_ms INTEGER, body TEXT);
    CREATE TABLE stage (id TEXT, ticket_id TEXT, request_id TEXT, role TEXT, status TEXT, session TEXT, created_seq INTEGER);
    CREATE TABLE stage_scope (stage_id TEXT, ticket_id TEXT);
  `);
  return db;
}
const hex = (n: number) => n.toString(16).padStart(16, "0");
const ticket = (db: Database, n: number, o: Partial<{ req: string; status: string; room: string; title: string }> = {}) =>
  db.run("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?)", [`t_${hex(n)}`, o.room ?? "r", o.req ?? "r-1", o.title ?? `Ticket ${n}`, o.status ?? "draft", "low", n, "SECRET criteria"]);

describe("state summary", () => {
  test("Large room", () => {
    const db = ledger();
    for (let i = 1; i <= 60; i++) ticket(db, i, { title: "T".repeat(200), req: `r-2026-10-28-request-number-${i}` });
    const text = buildStateSummary(db, "r");
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    const m = text.match(/\+(\d+) more: list_tickets/);
    expect(m).not.toBeNull();
    const shown = (text.match(/ t_[0-9a-f]{16} /g) ?? []).length;
    expect(shown + Number(m![1])).toBe(60);
    // cut from the end: the first ticket stays, the last goes
    expect(text).toContain(`t_${hex(1)}`);
    expect(text).not.toContain(`t_${hex(60)}`);
  });

  test("the five parts come in order", () => {
    const db = ledger();
    ticket(db, 1, { status: "in_progress" });
    db.run("INSERT INTO decisions VALUES ('d_a','r','t_x',NULL,'human','scope','open',1,NULL)");
    db.run("INSERT INTO stage VALUES ('s_a','t_x',NULL,'worker','running','worker-1',1)");
    const text = buildStateSummary(db, "r", "open point");
    const at = ["Open requests", "Decisions that wait", "escalations", "Stage sessions", "Last note of the Orchestrator", "Read more"].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("open point");
  });

  test("a live spec stage of another room stays out", () => {
    const db = ledger();
    ticket(db, 1, { room: "other" });
    ticket(db, 2, { room: "r" });
    db.run("INSERT INTO stage VALUES ('s_other',NULL,'r-1','validator','running','validator-secret',1)");
    db.run("INSERT INTO stage_scope VALUES ('s_other',?)", [`t_${hex(1)}`]);
    db.run("INSERT INTO stage VALUES ('s_mine',NULL,'r-1','validator','running','validator-mine',2)");
    db.run("INSERT INTO stage_scope VALUES ('s_mine',?)", [`t_${hex(2)}`]);
    const text = buildStateSummary(db, "r");
    expect(text).not.toContain("s_other");
    expect(text).not.toContain("validator-secret");
    expect(text).toContain("s_mine");
  });

  test("an escalated arbiter ruling shows in the escalations", () => {
    const db = ledger();
    db.run("INSERT INTO decisions VALUES ('d_arb','r',NULL,NULL,'arbiter','x','answered',1,NULL)");
    db.run("INSERT INTO decisions VALUES ('d_rec','r',NULL,NULL,'arbiter','x','applied',2,NULL)");
    const text = buildStateSummary(db, "r");
    expect(text.split("escalations")[1].split("Stage sessions")[0]).toContain("d_arb");
    expect(text.split("escalations")[1].split("Stage sessions")[0]).not.toContain("d_rec");
  });

  test("the same ledger gives the same text", () => {
    const db = ledger();
    for (let i = 1; i <= 5; i++) ticket(db, i);
    db.run("INSERT INTO ticket_blockers VALUES (?,?)", [`t_${hex(2)}`, `t_${hex(1)}`]);
    expect(buildStateSummary(db, "r")).toBe(buildStateSummary(db, "r"));
    expect(buildStateSummary(db, "r")).toContain(`blocked_by t_${hex(1)}`);
  });

  test("ids, statuses and titles only; other rooms and finished tickets stay out", () => {
    const db = ledger();
    ticket(db, 1);
    ticket(db, 2, { room: "other" });
    ticket(db, 3, { status: "done" });
    const text = buildStateSummary(db, "r");
    expect(text).not.toContain("SECRET");
    expect(text).toContain(`t_${hex(1)}`);
    expect(text).not.toContain(`t_${hex(2)}`);
    expect(text).not.toContain(`t_${hex(3)}`);
  });

  test("an empty room and a long note stay inside the limit", () => {
    const db = ledger();
    const text = buildStateSummary(db, "r", "word ".repeat(5000));
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(text).toContain("none");
  });

  test("escalations show the last 5, newest first", () => {
    const db = ledger();
    for (let i = 1; i <= 7; i++) db.run("INSERT INTO decisions VALUES (?,?,NULL,NULL,'human','scope','answered',?,NULL)", [`d_${i}`, "r", i]);
    const text = buildStateSummary(db, "r");
    const sec = text.slice(text.indexOf("escalations"), text.indexOf("Stage sessions"));
    expect(sec.indexOf("d_7")).toBeLessThan(sec.indexOf("d_3"));
    expect(sec).not.toContain("d_2 ");
  });
});
