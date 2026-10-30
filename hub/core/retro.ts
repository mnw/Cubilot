// The evidence file of a retrospective (Part 21, group 3): one week of one room, built from the ledger. Read only: no model,
// no write, no wall-clock time other than the window. Keys and lists are in a fixed order, so one ledger and one window give
// the same bytes (JSON.stringify of the result).

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flowReport } from "./flow";
import { STAGE_ROOM_SQL } from "../kinds/stage";

/** A done improvement stays in the file for this many windows after it became done. */
export const IMPROVEMENT_WINDOWS = 4;

const CAUSE_REQUEST_RE = /^r-\d{4}-\d{2}-\d{2}-cause-[a-z0-9][a-z0-9-]*$/;
const RETRO_REQUEST_RE = /^r-\d{4}-\d{2}-\d{2}-retro$/;
const REVERT_TITLE_RE = /^Revert (t_[0-9a-f]{16}):/;
const MEASURE_RE = /^Target measure: (\S+) from (\S+) to (\S+) \(retrospective (s_[0-9a-f]{16})\)\s*$/;
const REVIEW_KINDS = ["spec", "validator", "reviewer"] as const;

export type Measure = { name: string; before: number; target: number; stage_id: string };

/** The `Target measure:` line of the criteria (design decision 5). The last such line counts; null when it does not parse. */
export function parseMeasure(criteria: string): Measure | null {
  const lines = criteria.split("\n").filter((l) => l.startsWith("Target measure:"));
  const m = MEASURE_RE.exec(lines[lines.length - 1] ?? "");
  if (!m) return null;
  const before = Number(m[2]);
  const target = Number(m[3]);
  if (!Number.isFinite(before) || !Number.isFinite(target)) return null;
  return { name: m[1], before, target, stage_id: m[4] };
}

const json = (text: string | null): Record<string, unknown> => {
  try {
    const v = JSON.parse(text ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const ROOM_ENTITIES_SQL = `SELECT id FROM tickets WHERE room = ?1 UNION SELECT id FROM requests WHERE room = ?1
  UNION SELECT id FROM decisions WHERE room = ?1 UNION SELECT id FROM checkpoints WHERE room = ?1
  UNION SELECT id FROM permissions WHERE room = ?1`;

function stagesSection(db: Database, room: string, since: number, until: number) {
  const rows = db
    .query<
      { id: string; role: string; review: string | null; ticket_id: string | null; verdict: string | null; attempt: number; first_at: number; start_at: number | null; end_at: number | null; tokens: number | null },
      [string, number, number]
    >(
      `SELECT s.id, s.role, s.review, s.ticket_id, s.verdict, s.attempt,
              (SELECT MIN(e.at_ms) FROM events e WHERE e.entity_id = s.id) AS first_at,
              (SELECT MIN(e.at_ms) FROM events e WHERE e.entity_id = s.id AND e.kind = 'stage.launching' AND e.at_ms < ?3) AS start_at,
              (SELECT MAX(e.at_ms) FROM events e WHERE e.entity_id = s.id AND e.kind IN ('stage.passed', 'stage.failed', 'stage.cancelled') AND e.at_ms < ?3) AS end_at,
              (SELECT SUM(m.prompt_tokens_first) FROM stage_metrics m WHERE m.stage_id = s.id) AS tokens
         FROM stage s WHERE ${STAGE_ROOM_SQL} = ?1
          AND (SELECT MIN(e.at_ms) FROM events e WHERE e.entity_id = s.id) >= ?2
          AND (SELECT MIN(e.at_ms) FROM events e WHERE e.entity_id = s.id) < ?3
        ORDER BY first_at, s.id`,
    )
    .all(room, since, until);
  return rows.map((r) => ({
    stage_id: r.id,
    role: r.role,
    review: r.review,
    ticket_id: r.ticket_id,
    duration_ms: r.start_at !== null && r.end_at !== null && r.end_at >= r.start_at ? r.end_at - r.start_at : null,
    // The ledger holds no turn count for a session: null, not a guess.
    turns: null as number | null,
    tokens: r.tokens,
    attempts: r.attempt,
    // A result after the window is not part of the window.
    verdict: r.end_at !== null ? (r.verdict ?? "no result") : "no result",
  }));
}

function findingsSection(db: Database, room: string, since: number, until: number) {
  const by_kind = Object.fromEntries(REVIEW_KINDS.map((k) => [k, { fail_results: 0, findings: 0, blocking: 0 }]));
  const results = db
    .query<{ review: string | null; role: string; context_json: string | null }, [string, number, number]>(
      `SELECT s.review, s.role, h.context_json FROM handoffs h JOIN stage s ON s.id = json_extract(h.context_json, '$.stage_id')
        WHERE json_extract(h.context_json, '$.verdict') = 'FAIL' AND ${STAGE_ROOM_SQL} = ?1 AND h.created_at_ms >= ?2 AND h.created_at_ms < ?3
        ORDER BY h.created_at_ms, h.id`,
    )
    .all(room, since, until);
  for (const r of results) {
    const bucket = by_kind[r.review === "spec" ? "spec" : r.role];
    if (!bucket) continue;
    bucket.fail_results++;
    const list = json(r.context_json).findings;
    for (const f of Array.isArray(list) ? list : []) {
      bucket.findings++;
      if ((f as { severity?: unknown })?.severity === "blocking") bucket.blocking++;
    }
  }
  const second_fail_tickets = db
    .query<{ ticket_id: string; title: string; fails: number }, [string, number, number]>(
      `SELECT s.ticket_id, t.title, COUNT(*) AS fails FROM stage s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.verdict = 'FAIL' AND s.ticket_id IS NOT NULL AND t.room = ?1
          AND EXISTS (SELECT 1 FROM events x WHERE x.entity_id = s.id AND x.kind = 'stage.passed' AND x.at_ms < ?3)
        GROUP BY s.ticket_id HAVING COUNT(*) >= 2
           AND EXISTS (SELECT 1 FROM stage f JOIN events e ON e.entity_id = f.id AND e.kind = 'stage.passed'
                        WHERE f.ticket_id = s.ticket_id AND f.verdict = 'FAIL' AND e.at_ms >= ?2 AND e.at_ms < ?3)
        ORDER BY MIN(s.created_seq), s.ticket_id`,
    )
    .all(room, since, until);
  return { by_kind, second_fail_tickets };
}

function humanSection(db: Database, room: string, since: number, until: number, human: string) {
  return db
    .query<{ record_id: string; kind: string; at_ms: number; prev_at: number | null; payload_json: string }, [string, number, number, string]>(
      `SELECT e.entity_id AS record_id, e.kind, e.at_ms, e.payload_json,
              (SELECT p.at_ms FROM events p WHERE p.entity_id = e.entity_id AND p.seq < e.seq ORDER BY p.seq DESC LIMIT 1) AS prev_at
         FROM events e WHERE e.actor = ?4 AND e.at_ms >= ?2 AND e.at_ms < ?3 AND e.entity_id IN (${ROOM_ENTITIES_SQL})
        ORDER BY e.seq`,
    )
    .all(room, since, until, human)
    .map((e) => {
      const reason = json(e.payload_json).reason;
      return {
        record_id: e.record_id,
        kind: e.kind,
        wait_ms: e.prev_at === null ? null : e.at_ms - e.prev_at,
        reason: typeof reason === "string" ? reason : null,
      };
    });
}

function causesSection(db: Database, room: string, since: number, until: number) {
  return db
    .query<{ id: string; title: string; status: string; request_id: string }, [string, number, number]>(
      `SELECT id, title, status, request_id FROM tickets WHERE room = ?1 AND created_at_ms >= ?2 AND created_at_ms < ?3
          AND request_id GLOB 'r-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-cause-*' ORDER BY created_at_ms, id`,
    )
    .all(room, since, until)
    .filter((t) => CAUSE_REQUEST_RE.test(t.request_id))
    .map((t) => ({ ticket_id: t.id, title: t.title, status: t.status, request_id: t.request_id }));
}

function reportsSection(db: Database, room: string, since: number, until: number) {
  const lead = db.query<{ agent: string }, [string]>("SELECT agent FROM ticket_room_lead WHERE room = ?").get(room)?.agent ?? "Orchestrator";
  return db
    .query<{ id: string; trigger: string; note: string }, [string, string, number, number]>(
      `SELECT id, trigger, note FROM checkpoints WHERE room = ?1 AND agent = ?2 AND note IS NOT NULL
          AND started_at_ms >= ?3 AND started_at_ms < ?4 ORDER BY started_at_ms, id`,
    )
    .all(room, lead, since, until)
    .map((c) => ({ checkpoint_id: c.id, agent: lead, trigger: c.trigger, note: c.note }));
}

function improvementsSection(db: Database, room: string, since: number, until: number) {
  const tickets = db
    .query<{ id: string; title: string; status: string; request_id: string; acceptance_criteria: string; done_at: number | null }, [string, number]>(
      `SELECT t.id, t.title, t.status, t.request_id, t.acceptance_criteria,
              (SELECT MAX(e.at_ms) FROM events e WHERE e.entity_id = t.id AND e.kind = 'ticket.done') AS done_at
         FROM tickets t WHERE t.room = ?1 AND t.created_at_ms < ?2 AND t.request_id GLOB 'r-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-retro'
        ORDER BY t.created_at_ms, t.id`,
    )
    .all(room, until)
    .filter((t) => RETRO_REQUEST_RE.test(t.request_id));
  const reverted = new Set<string>();
  for (const t of tickets) {
    const m = REVERT_TITLE_RE.exec(t.title);
    if (m && t.status === "done") reverted.add(m[1]);
  }
  const windowMs = until - since;
  return tickets
    .filter((t) => !REVERT_TITLE_RE.test(t.title))
    .filter((t) => t.status !== "done" || (!reverted.has(t.id) && t.done_at !== null && t.done_at > until - IMPROVEMENT_WINDOWS * windowMs))
    .map((t) => {
      const m = parseMeasure(t.acceptance_criteria);
      return {
        ticket_id: t.id,
        title: t.title,
        status: t.status,
        request_id: t.request_id,
        measure: m ? { name: m.name, before: m.before, target: m.target } : null,
      };
    });
}

/**
 * The evidence of `room` for [since, until) in ms. `human` is the actor name of the human (default: the hub's CUBILOT_HUMAN_NAME, else "human"). The result is plain data in a fixed
 * order; JSON.stringify gives the same bytes for the same ledger.
 */
export function buildEvidence(db: Database, room: string, since: number, until: number, human = process.env.CUBILOT_HUMAN_NAME?.trim() || "human") {
  return {
    room,
    since,
    until,
    // `now` is the end of the window: the flow report reads no clock.
    flow: flowReport(db, room, since, until, until),
    stages: stagesSection(db, room, since, until),
    findings: findingsSection(db, room, since, until),
    human: humanSection(db, room, since, until, human),
    causes: causesSection(db, room, since, until),
    reports: reportsSection(db, room, since, until),
    improvements: improvementsSection(db, room, since, until),
  };
}

export type Evidence = ReturnType<typeof buildEvidence>;

// The weekly schedule (Part 21 group 4). Pure: the week and its window come from the clock value and the hub's local time zone. No model.

export type RetroWeek = { week: string; since: number; until: number };

const WEEK_LABEL_RE = /^(\d{4})-W(\d{2})$/;

/** `YYYY-Www` of the ISO week that has this Monday. */
function isoWeekLabel(monday: Date): string {
  const thursday = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The week of a Monday 06:00 local: `until` is that Monday 06:00, `since` is the Monday 06:00 before it. */
function weekOfMonday(monday: Date): RetroWeek {
  const at = (back: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - back, 6, 0, 0, 0).getTime();
  return { week: isoWeekLabel(monday), since: at(7), until: at(0) };
}

/** The retrospective week that `now` belongs to, or null before that ISO week's Monday 06:00 local (nothing is built yet). */
export function retroWeekAt(now: number): RetroWeek | null {
  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), 6, 0, 0, 0);
  return now < monday.getTime() ? null : weekOfMonday(monday);
}

/** The window of a `YYYY-Www` label, or null when it does not parse. */
export function retroWeekWindow(label: string): RetroWeek | null {
  const m = WEEK_LABEL_RE.exec(label);
  if (!m) return null;
  const year = Number(m[1]);
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + 7 * (Number(m[2]) - 1), 6, 0, 0, 0);
  const w = weekOfMonday(monday);
  return w.week === label ? w : null;
}

/** The rooms with at least one ticket event in [since, until), in name order. */
export function roomsWithTicketEvents(db: Database, since: number, until: number): string[] {
  return db
    .query<{ room: string }, [number, number]>(
      `SELECT DISTINCT t.room AS room FROM events e JOIN tickets t ON t.id = e.entity_id
        WHERE e.kind LIKE 'ticket.%' AND e.at_ms >= ?1 AND e.at_ms < ?2 ORDER BY t.room`,
    )
    .all(since, until)
    .map((r) => r.room);
}

/** `<dir of the ledger>/retro/<room>/<iso-week>.json`. A valid room label has no path separator, so it is the segment itself; only `.` and `..` become `%2E` forms (`%` is not a valid label character, so no two rooms collide). */
export function evidencePath(ledgerDb: string, room: string, week: string): string {
  return join(dirname(ledgerDb), "retro", room.replace(/^\.{1,2}$/, (d) => d.replace(/\./g, "%2E")), `${week}.json`);
}

/** Writes the evidence file of a room and week (replacing an older one) and returns its text. */
export function writeEvidenceFile(db: Database, ledgerDb: string, room: string, w: RetroWeek): { path: string; text: string } {
  const path = evidencePath(ledgerDb, room, w.week);
  const text = JSON.stringify(buildEvidence(db, room, w.since, w.until), null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

/** The proposal titles of the newest earlier passed retrospective of the room; [] when there is none or its result has no proposals. */
export function previousProposalTitles(db: Database, room: string, week: string): string[] {
  const prev = db
    .query<{ id: string }, [string, string]>(
      `SELECT s.id FROM stage s WHERE s.review = 'retro' AND s.room = ?1 AND s.retro_week < ?2 AND s.status = 'passed'
        ORDER BY s.retro_week DESC, s.created_seq DESC`,
    )
    .all(room, week);
  for (const { id } of prev.slice(0, 1)) {
    const rows = db
      .query<{ context_json: string | null }, [string]>(
        "SELECT context_json FROM handoffs WHERE json_extract(context_json, '$.stage_id') = ? ORDER BY created_at_ms DESC, id DESC",
      )
      .all(id);
    for (const r of rows) {
      const list = json(r.context_json).proposals;
      if (!Array.isArray(list)) continue;
      return list.map((p) => (p as { title?: unknown })?.title).filter((t): t is string => typeof t === "string");
    }
  }
  return [];
}
