// Part 21 group 3: buildEvidence reads one week of one room from the ledger. No model, no clock, same bytes twice.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { buildKinds } from "../../hub/kinds";
import { buildEvidence, parseMeasure } from "../../hub/core/retro";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const SINCE = 1_000 * DAY;
const UNTIL = SINCE + WEEK;
const tid = (n: number) => `t_${n.toString(16).padStart(16, "0")}`;
const sid = (n: number) => `s_${n.toString(16).padStart(16, "0")}`;
const line = (name: string, from: string, to: string, stage = sid(99)) => `Target measure: ${name} from ${from} to ${to} (retrospective ${stage})`;

function env() {
  const db = new Database(":memory:");
  migrateLedger(db);
  for (const k of buildKinds(db)) k.migrate?.(db);
  let seq = 0;
  const ticket = (n: number, o: { title?: string; request?: string | null; status?: string; at?: number; criteria?: string; room?: string } = {}) => {
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, ?, ?, 'low', 'medium', 'a', ?, ?, ?, ?, 1)`,
      [tid(n), o.room ?? "r1", o.title ?? `Ticket ${n}`, o.criteria ?? "c", o.status ?? "queued", o.request ?? null, o.at ?? SINCE + 1, o.at ?? SINCE + 1],
    );
    return tid(n);
  };
  const done = (id: string, at: number) => insertEvent(db, id, "ticket.done", "Orchestrator", {}, at);
  const stage = (n: number, o: { role?: string; ticket?: string | null; verdict?: string | null; attempt?: number; start?: number; end?: number; tokens?: number; review?: string | null }) => {
    const id = sid(n);
    const ticket = o.ticket === undefined ? null : o.ticket;
    db.run("INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 'passed', ?)", [
      id, ticket, ticket ? null : "req-spec", o.review ?? null, o.verdict ?? null, o.role ?? "worker", o.attempt ?? 1, ++seq,
    ]);
    const start = o.start ?? SINCE + 10;
    insertEvent(db, id, "stage.queued", "system", {}, start - 1);
    insertEvent(db, id, "stage.launching", "system", {}, start);
    if (o.end !== undefined) insertEvent(db, id, "stage.passed", "system", {}, o.end);
    if (o.tokens !== undefined) db.run("INSERT INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, prompt_tokens_first, source) VALUES (?, 1, ?, 1, 1, ?, 'claude')", [id, o.role ?? "worker", o.tokens]);
    return id;
  };
  return { db, ticket, done, stage };
}

const bytes = (e: ReturnType<typeof env>, room = "r1") => JSON.stringify(buildEvidence(e.db, room, SINCE, UNTIL));

describe("buildEvidence", () => {
  test("the sections come in a fixed order", () => {
    const e = env();
    expect(Object.keys(buildEvidence(e.db, "r1", SINCE, UNTIL))).toEqual(["room", "since", "until", "flow", "stages", "findings", "human", "causes", "reports", "improvements"]);
  });

  test("each section holds its input", () => {
    const e = env();
    const t1 = e.ticket(1, { title: "Plan A", request: "req-a" });
    const cause = e.ticket(2, { title: "Remove lock wait", request: "r-2026-11-04-cause-lock-wait", at: SINCE + 5 });
    e.ticket(3, { request: "r-2026-11-04-cause-old", at: SINCE - 5 });
    e.ticket(4, { request: "r-2026-11-04-cause-", at: SINCE + 6 });
    e.ticket(5, { request: "req-b", at: SINCE + 6 });
    e.ticket(6, { request: "r-2026-11-04-cause-x", at: SINCE + 7, room: "r2" });

    // stages: a passed stage with tokens, a stage with no result, a stage outside the window
    const s1 = e.stage(1, { ticket: t1, verdict: "PASS", start: SINCE + 100, end: SINCE + 600, tokens: 1234, attempt: 2 });
    const s2 = e.stage(2, { ticket: t1, role: "tester", start: SINCE + 700 });
    e.stage(3, { ticket: t1, start: UNTIL + 5, end: UNTIL + 9 });
    // findings: two FAIL results on t1 (two findings, one blocking), a spec FAIL
    const f1 = e.stage(4, { ticket: t1, role: "validator", verdict: "FAIL", start: SINCE + 800, end: SINCE + 900 });
    const f2 = e.stage(5, { ticket: t1, role: "validator", verdict: "FAIL", start: SINCE + 1000, end: SINCE + 1100 });
    const sp = e.stage(6, { ticket: null, role: "validator", review: "spec", verdict: "FAIL", start: SINCE + 1200, end: SINCE + 1300 });
    e.db.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [sp, t1]);
    db_handoff(e, "h_1", f1, "FAIL", [{ ticket_id: t1, severity: "blocking", text: "x" }, { ticket_id: t1, severity: "minor", text: "y" }], SINCE + 950);
    db_handoff(e, "h_2", f2, "FAIL", [{ ticket_id: t1, severity: "blocking", text: "z" }], SINCE + 1150);
    db_handoff(e, "h_3", sp, "FAIL", [{ ticket_id: t1, severity: "blocking", text: "w" }], SINCE + 1350);
    // reports: lead note in window, note of another agent, note outside the window
    for (const [id, agent, note, at] of [["c_1", "Orchestrator", "week note", SINCE + 50], ["c_2", "worker-1", "no", SINCE + 51], ["c_3", "Orchestrator", "old", SINCE - 1]] as const) {
      e.db.run(
        `INSERT INTO checkpoints (id, room, agent, trigger, status, note, note_asked, created_by, started_at_ms, version) VALUES (?, 'r1', ?, 'manual', 'done', ?, 1, 'human', ?, 1)`,
        [id, agent, note, at],
      );
    }
    // human: two events on one ticket (wait 1000 ms between), one with a reason, an agent event, and an event outside the window
    insertEvent(e.db, t1, "ticket.queued", "Orchestrator", {}, SINCE + 2000);
    insertEvent(e.db, t1, "ticket.edited", "human", { reason: "wrong radius" }, SINCE + 3000);
    insertEvent(e.db, t1, "ticket.cancelled", "human", {}, SINCE + 3500);
    insertEvent(e.db, t1, "ticket.edited", "human", {}, UNTIL + 1);

    const ev = buildEvidence(e.db, "r1", SINCE, UNTIL);
    expect(ev.flow.room).toBe("r1");
    expect(ev.flow.since).toBe(SINCE);
    expect(ev.stages.map((s) => s.stage_id)).toEqual([s1, s2, f1, f2, sp]);
    expect(ev.stages[0]).toEqual({ stage_id: s1, role: "worker", review: null, ticket_id: t1, duration_ms: 500, turns: null, tokens: 1234, attempts: 2, verdict: "PASS" });
    expect(ev.stages[1]).toMatchObject({ role: "tester", duration_ms: null, tokens: null, verdict: "no result" });
    expect(ev.findings.by_kind).toEqual({
      spec: { fail_results: 1, findings: 1, blocking: 1 },
      validator: { fail_results: 2, findings: 3, blocking: 2 },
      reviewer: { fail_results: 0, findings: 0, blocking: 0 },
    });
    expect(ev.findings.second_fail_tickets).toEqual([{ ticket_id: t1, title: "Plan A", fails: 2 }]);
    expect(ev.human).toEqual([
      { record_id: t1, kind: "ticket.edited", at_ms: SINCE + 3000, wait_ms: 1000, reason: "wrong radius" },
      { record_id: t1, kind: "ticket.cancelled", at_ms: SINCE + 3500, wait_ms: 500, reason: null },
    ]);
    expect(ev.causes).toEqual([{ ticket_id: cause, title: "Remove lock wait", status: "queued", request_id: "r-2026-11-04-cause-lock-wait" }]);
    expect(ev.reports).toEqual([{ checkpoint_id: "c_1", agent: "Orchestrator", trigger: "manual", at_ms: SINCE + 50, note: "week note" }]);
    expect(ev.improvements).toEqual([]);
  });

  test("an empty room gives empty lists", () => {
    const ev = buildEvidence(env().db, "none", SINCE, UNTIL);
    expect([ev.stages, ev.human, ev.causes, ev.reports, ev.improvements]).toEqual([[], [], [], [], []]);
    expect(ev.findings.second_fail_tickets).toEqual([]);
  });

  test("two builds of one ledger give the same bytes, and a later wall clock changes nothing", async () => {
    const e = env();
    const t = e.ticket(1, { request: "r-2026-10-28-retro", criteria: line("m", "3.2", "2") });
    e.stage(1, { ticket: t, start: SINCE + 5, end: SINCE + 50 });
    insertEvent(e.db, t, "ticket.edited", "human", { reason: "r" }, SINCE + 9);
    const first = bytes(e);
    await Bun.sleep(5);
    expect(bytes(e)).toBe(first);
  });

  test("builds read the ledger and write nothing", () => {
    const e = env();
    e.ticket(1, { request: "r-2026-10-28-retro", criteria: line("m", "1", "2") });
    const count = () => e.db.query<{ n: number }, []>("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM tickets) AS n").get()!.n;
    const before = count();
    bytes(e);
    expect(count()).toBe(before);
  });
});

function db_handoff(e: ReturnType<typeof env>, id: string, stageId: string, verdict: string, findings: unknown[], at: number) {
  e.db.run(
    "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'validator-1', 'Orchestrator', 'r', ?, 'accepted', ?, ?)",
    [id, JSON.stringify({ stage_id: stageId, verdict, findings }), at, at + 1000],
  );
}

describe("improvements", () => {
  test("week 2 lists a done week 1 ticket with its measure", () => {
    const e = env();
    const t = e.ticket(1, { request: "r-2026-10-28-retro", status: "done", at: SINCE - 3 * DAY, criteria: `Story\n${line("tester_hours_per_ticket", "3.2", "2")}` });
    e.done(t, SINCE - DAY);
    expect(buildEvidence(e.db, "r1", SINCE, UNTIL).improvements).toEqual([
      { ticket_id: t, title: "Ticket 1", status: "done", request_id: "r-2026-10-28-retro", measure: { name: "tester_hours_per_ticket", before: 3.2, target: 2 } },
    ]);
  });

  test("a not-done ticket is listed; a ticket of another request, another room or after the window is not", () => {
    const e = env();
    const open = e.ticket(1, { request: "r-2026-10-28-retro", status: "draft", at: SINCE - DAY, criteria: line("a", "1", "2") });
    e.ticket(2, { request: "req-x", at: SINCE - DAY, criteria: line("a", "1", "2") });
    e.ticket(3, { request: "r-2026-10-28-retro", room: "r2", at: SINCE - DAY, criteria: line("a", "1", "2") });
    e.ticket(4, { request: "r-2026-11-30-retro", at: UNTIL + 1, criteria: line("a", "1", "2") });
    expect(buildEvidence(e.db, "r1", SINCE, UNTIL).improvements.map((i) => i.ticket_id)).toEqual([open]);
  });

  test("a broken line gives measure null", () => {
    const e = env();
    for (const [n, c] of [[1, "no line"], [2, "Target measure: m from x to 2 (retrospective s_1)"], [3, "Target measure: m from 1 to two (retrospective " + sid(1) + ")"]] as const) {
      e.ticket(n, { request: "r-2026-10-28-retro", at: SINCE - n, criteria: c });
    }
    const ev = buildEvidence(e.db, "r1", SINCE, UNTIL);
    expect(ev.improvements.map((i) => i.measure)).toEqual([null, null, null]);
  });

  test("a done revert ticket removes its item; a draft revert does not; the revert is no item", () => {
    const e = env();
    const a = e.ticket(1, { request: "r-2026-10-28-retro", status: "done", at: SINCE - 5 * DAY, criteria: line("a", "1", "2") });
    const b = e.ticket(2, { request: "r-2026-10-28-retro", status: "done", at: SINCE - 5 * DAY, criteria: line("b", "1", "2") });
    e.done(a, SINCE - DAY);
    e.done(b, SINCE - DAY);
    e.ticket(3, { request: "r-2026-10-28-retro", status: "done", title: `Revert ${a}: Ticket 1`, at: SINCE - 4 * DAY, criteria: line("a", "2", "1") });
    e.ticket(4, { request: "r-2026-10-28-retro", status: "draft", title: `Revert ${b}: Ticket 2`, at: SINCE - 4 * DAY, criteria: line("b", "2", "1") });
    expect(buildEvidence(e.db, "r1", SINCE, UNTIL).improvements.map((i) => i.ticket_id)).toEqual([b]);
  });

  test("a done item drops out after 4 windows: listed in window 4, gone in window 5", () => {
    const e = env();
    const t = e.ticket(1, { request: "r-2026-10-28-retro", status: "done", at: SINCE - DAY, criteria: line("a", "1", "2") });
    e.done(t, SINCE + DAY); // done in window 1
    const at = (k: number) => buildEvidence(e.db, "r1", SINCE + (k - 1) * WEEK, SINCE + k * WEEK).improvements.map((i) => i.ticket_id);
    expect(at(2)).toEqual([t]);
    expect(at(4)).toEqual([t]);
    expect(at(5)).toEqual([]);
  });
});

describe("parseMeasure", () => {
  test("parses the last Target measure line", () => {
    expect(parseMeasure(`x\n${line("a", "1", "2")}\n${line("b", "0.5", "-3", sid(7))}`)).toEqual({ name: "b", before: 0.5, target: -3, stage_id: sid(7) });
  });
  test("rejects a missing stage or number", () => {
    expect(parseMeasure("Target measure: a from 1 to 2")).toBeNull();
    expect(parseMeasure("")).toBeNull();
  });
});
