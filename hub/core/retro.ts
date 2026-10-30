// The evidence file of a retrospective (Part 21, group 3): one week of one room, built from the ledger. Read only: no model,
// no write, no wall-clock time other than the window. Keys and lists are in a fixed order, so one ledger and one window give
// the same bytes (JSON.stringify of the result).

import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** `<dir of the ledger>/retro/<room>/<iso-week>.json`. A valid room label has no path separator. Each uppercase letter becomes `%` plus the lowercase letter, and `.` and `..` become `%2E` forms. `%` is not a valid label character, so no two rooms collide, also on a case-insensitive filesystem. */
export function evidencePath(ledgerDb: string, room: string, week: string): string {
  return join(dirname(ledgerDb), "retro", room.replace(/^\.{1,2}$/, (d) => d.replace(/\./g, "%2E")).replace(/[A-Z]/g, (c) => `%${c.toLowerCase()}`), `${week}.json`);
}

/** Writes the evidence file of a room and week (replacing an older one) and returns its text. */
export function writeEvidenceFile(db: Database, ledgerDb: string, room: string, w: RetroWeek): { path: string; text: string } {
  const path = evidencePath(ledgerDb, room, w.week);
  const text = JSON.stringify(buildEvidence(db, room, w.since, w.until), null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

/** Ids of the `done` items of the `improvements` section of the saved evidence file; [] when the file is missing or does not parse. */
export function savedDoneImprovements(ledgerDb: string, room: string, week: string): string[] {
  try {
    const list = JSON.parse(readFileSync(evidencePath(ledgerDb, room, week), "utf8"))?.improvements;
    if (!Array.isArray(list)) return [];
    return list.filter((i) => i?.status === "done" && typeof i.ticket_id === "string").map((i) => i.ticket_id);
  } catch {
    return [];
  }
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

// The result check (Part 21 group 5). Pure: the caller gives the done improvements and a reader for a file line at the stage commit.

const EVIDENCE_SECTIONS = ["flow", "stages", "findings", "human", "causes", "reports", "improvements"];
const PROPOSAL_KINDS = ["code-check", "script", "role-file", "setting"];
const MAX_PROPOSALS = 3;
const REMOVAL_RE = /\b(remove|removes|removed|removing|drop|drops|dropped|dropping|skip|skips|skipped|skipping|bypass|bypasses|bypassed|bypassing|disable|disables|disabled|disabling|auto-approve|without)\b/i;
const GATE_RE = /\b(approve|allow|human|main|security|delivery|undone|irreversible)\b/i;
const ROLE_FILE_RE = /^(factory\/(?:[^/:]+\/)*[^/:]+\.md):([1-9]\d*)$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** True when one sentence of `text` holds a removal word and a gate word (design decision 2). */
export function removesHumanGate(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/).some((s) => REMOVAL_RE.test(s) && GATE_RE.test(s));
}

export type RetroResultEnv = {
  /** Ids of the `done` items of the `improvements` section of the evidence file of the stage. */
  doneImprovements: string[];
  /** The text of line `line` (1-based) of `path` at the commit of the stage worktree; null when it does not exist. */
  readLine: (path: string, line: number) => string | null;
};

/** The errors of a retrospective result context; [] when it is valid. */
export function checkRetroResult(c: Record<string, unknown>, env: RetroResultEnv): string[] {
  const errors: string[] = [];
  const proposals = c.proposals;
  if (!Array.isArray(proposals)) errors.push("context.proposals must be a list (may be empty)");
  else {
    if (proposals.length > MAX_PROPOSALS) errors.push("at most 3 proposals");
    proposals.forEach((p, i) => {
      const at = `context.proposals[${i}]`;
      if (!isObj(p)) return void errors.push(`${at} must be an object`);
      for (const k of ["title", "problem", "change", "risk"]) if (!str(p[k])) errors.push(`${at}.${k} must be a non-empty string`);
      if (typeof p.kind !== "string" || !PROPOSAL_KINDS.includes(p.kind)) errors.push(`${at}.kind must be one of ${PROPOSAL_KINDS.join(", ")}`);
      if (!Array.isArray(p.files) || !p.files.every(str)) errors.push(`${at}.files must be a list of strings`);
      const m = p.measure;
      if (!isObj(m) || !str(m.name) || typeof m.now !== "number" || !Number.isFinite(m.now) || typeof m.target !== "number" || !Number.isFinite(m.target)) {
        errors.push(`${at}.measure must be {name, now, target} with numbers`);
      }
      if (!Array.isArray(p.evidence) || p.evidence.length === 0) errors.push(`${at}.evidence needs at least one item`);
      else {
        p.evidence.forEach((e, j) => {
          const ok = typeof e === "string" && EVIDENCE_SECTIONS.some((s) => e.startsWith(`${s}:`)) && /\d/.test(e);
          if (!ok) errors.push(`${at}.evidence[${j}] must start with a section name of the evidence file (${EVIDENCE_SECTIONS.join(", ")}) plus ":" and hold a number`);
        });
      }
      if ([p.title, p.change].some((t) => typeof t === "string" && removesHumanGate(t))) errors.push("a proposal cannot remove a human gate");
      if (p.kind === "role-file") {
        const file = Array.isArray(p.files) && p.files.length === 1 ? ROLE_FILE_RE.exec(String(p.files[0])) : null;
        if (!file || file[1].split("/").includes("..")) errors.push(`${at}.files must hold one factory/**/*.md:<line>`);
        else if (typeof p.replaces !== "string") errors.push(`${at}.replaces is required for a role-file proposal`);
        else {
          const line = env.readLine(file[1], Number(file[2]));
          if (line === null) errors.push(`${at}.files names a line that does not exist at the stage commit`);
          else if (line.trim() !== p.replaces.trim()) errors.push(`${at}.replaces must equal the text of ${String((p.files as unknown[])[0])} at the stage commit`);
        }
      }
    });
  }
  if (!Array.isArray(c.lessons) || !c.lessons.every(str)) errors.push("context.lessons must be a list of non-empty strings (may be empty)");
  const verdicts = c.verdicts;
  const judged = new Set<string>();
  if (!Array.isArray(verdicts)) errors.push("context.verdicts must be a list (may be empty)");
  else {
    verdicts.forEach((v, i) => {
      const at = `context.verdicts[${i}]`;
      if (!isObj(v)) return void errors.push(`${at} must be an object`);
      if (!str(v.improvement)) errors.push(`${at}.improvement must be a ticket id`);
      else judged.add(v.improvement);
      if (!str(v.measure)) errors.push(`${at}.measure must be a non-empty string`);
      for (const k of ["before", "after"]) if (typeof v[k] !== "number" || !Number.isFinite(v[k] as number)) errors.push(`${at}.${k} must be a number`);
      if (v.verdict !== "keep" && v.verdict !== "revert") errors.push(`${at}.verdict must be keep or revert`);
      if (!str(v.note)) errors.push(`${at}.note must be a non-empty string`);
    });
    for (const id of env.doneImprovements) if (!judged.has(id)) errors.push(`context.verdicts has no verdict for improvement ${id}`);
  }
  return errors;
}

// The draft tickets of an accepted result (Part 21 group 6). Pure: the caller gives the titles of the judged tickets.

export type RetroDraft = { title: string; acceptance_criteria: string };

const TITLE_MAX = 200;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneWord = (text: string) => text.trim().replace(/\s+/g, "_");

/** `YYYY-MM-DD` of a time in the hub's local time zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One draft for each proposal, then one for each `revert` verdict. A `keep` verdict gives none. The context is already valid (checkRetroResult). */
export function retroDrafts(c: Record<string, unknown>, stageId: string, titleOf: (ticketId: string) => string | null): RetroDraft[] {
  const drafts: RetroDraft[] = [];
  for (const p of (Array.isArray(c.proposals) ? c.proposals : []) as Record<string, any>[]) {
    const m = p.measure;
    drafts.push({
      title: clip(`As the human, I want ${p.title}, so that ${m.name} moves from ${m.now} to ${m.target}`, TITLE_MAX),
      acceptance_criteria: [
        `Problem: ${p.problem}`,
        `Change: ${p.change}`,
        `Files: ${(p.files as string[]).join(", ")}`,
        `Target measure: ${oneWord(m.name)} from ${m.now} to ${m.target} (retrospective ${stageId})`,
      ].join("\n"),
    });
  }
  for (const v of (Array.isArray(c.verdicts) ? c.verdicts : []) as Record<string, any>[]) {
    if (v.verdict !== "revert") continue;
    const title = titleOf(v.improvement) ?? "";
    drafts.push({
      title: clip(`Revert ${v.improvement}: ${title}`, TITLE_MAX),
      acceptance_criteria: [
        `Undo the change of ticket ${v.improvement}${title ? ` (${title})` : ""}. Restore the state before it.`,
        `Reason: ${v.note}`,
        `Target measure: ${oneWord(v.measure)} from ${v.after} to ${v.before} (retrospective ${stageId})`,
      ].join("\n"),
    });
  }
  return drafts;
}
