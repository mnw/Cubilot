// The flow of a room (Part 18, "flow measure route"): slot use, tickets ready now, ticket-hours by wait reason, review
// FAIL rate and done tickets with no merge on staging. Read only. Computed from the ledger and git on each call: no model,
// no stored state.

import type { Database } from "bun:sqlite";
import { DEFAULT_ROLE_LIMITS, getRoomSettings, STAGE_ROLES, type StageRole } from "./ledger";
import { STAGE_ROOM_SQL } from "../kinds/stage";
import { git, openBlockerIds } from "../kinds/ticket-blockers";

const HOUR_MS = 3_600_000;
const TICKET_STATUSES = new Set(["draft", "queued", "claimed", "in_progress", "in_review", "done", "cancelled"]);
const LIVE_STAGE = "('queued', 'launching', 'running', 'retrying')";
const TICKET_ID_RE = /t_[0-9a-f]{16}/g;

const hours = (ms: number): number => Math.round((ms / HOUR_MS) * 100) / 100;
const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const overlap = (a: number, b: number, since: number, until: number): number => Math.max(0, Math.min(b, until) - Math.max(a, since));

type Ev = { entity_id: string; kind: string; at_ms: number; payload_json: string };
type Merges = { ok: boolean; merged: Map<string, number>; nonMerge: Set<string> };

/** Ticket ids named by the commits of staging. `merged` maps a ticket to the time of its newest merge commit (ms). */
function stagingCommits(project: string | null | undefined): Merges {
  const out: Merges = { ok: false, merged: new Map(), nonMerge: new Set() };
  if (!project) return out;
  const fmt = "--format=%x01%ct%x00%B";
  const read = (flag: string): string | null => {
    const r = git(project, ["log", "staging", flag, fmt]);
    return r.code === 0 ? r.out : null;
  };
  const merges = read("--merges");
  const plain = read("--no-merges");
  if (merges === null || plain === null) return out;
  for (const rec of merges.split("\x01")) {
    const [ct, msg = ""] = rec.split("\x00");
    for (const id of new Set(msg.match(TICKET_ID_RE) ?? [])) {
      const at = Number(ct) * 1000;
      if (!(out.merged.get(id)! >= at)) out.merged.set(id, at);
    }
  }
  for (const rec of plain.split("\x01")) for (const id of rec.match(TICKET_ID_RE) ?? []) out.nonMerge.add(id);
  out.ok = true;
  return out;
}

type Run = { role: string; from: number; to: number };

/** Time inside [from, to) in which at least `limit` runs of `role` overlap: every slot of the role is in use. */
function fullMs(runs: Run[], role: string, limit: number, from: number, to: number): number {
  if (to <= from) return 0;
  const marks: Array<[number, number]> = [];
  for (const r of runs) {
    if (r.role !== role) continue;
    const a = Math.max(r.from, from);
    const b = Math.min(r.to, to);
    if (b > a) marks.push([a, 1], [b, -1]);
  }
  marks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let count = 0;
  let last = from;
  let total = 0;
  for (const [at, d] of marks) {
    if (count >= limit) total += at - last;
    count += d;
    last = at;
  }
  if (count >= limit) total += to - last;
  return total;
}

type Segment = { status: string; from: number; to: number };

/** The status of a ticket over time, from its events. The last segment runs to `end`. */
function segments(evs: Ev[], end: number): Segment[] {
  const out: Segment[] = [];
  let status: string | null = null;
  let from = 0;
  for (const e of evs) {
    let next: string | null = null;
    if (e.kind === "ticket.created") next = (JSON.parse(e.payload_json) as { status?: string }).status ?? "queued";
    else if (e.kind.startsWith("ticket.") && TICKET_STATUSES.has(e.kind.slice(7))) next = e.kind.slice(7);
    if (next === null || next === status) continue;
    if (status !== null) out.push({ status, from, to: e.at_ms });
    status = next;
    from = e.at_ms;
  }
  if (status !== null) out.push({ status, from, to: Math.max(end, from) });
  return out;
}

export type FlowReport = ReturnType<typeof flowReport>;

export function flowReport(db: Database, room: string, since: number, until: number, now: number = Date.now()) {
  const settings = getRoomSettings(db, room);
  const project = settings?.project_folder;
  const limits = settings?.role_limits ?? DEFAULT_ROLE_LIMITS;
  const end = Math.min(until, now);

  // 1. Slot use per role: run time of the stage attempts, clipped to the window.
  const stageEvents = db
    .query<Ev & { role: string }, [string]>(
      `SELECT e.entity_id, e.kind, e.at_ms, e.payload_json, s.role FROM events e JOIN stage s ON s.id = e.entity_id
        WHERE e.kind IN ('stage.launching', 'stage.retrying', 'stage.passed', 'stage.failed', 'stage.cancelled')
          AND ${STAGE_ROOM_SQL} = ?1 ORDER BY e.seq`,
    )
    .all(room);
  const runMs: Record<string, number> = Object.fromEntries(STAGE_ROLES.map((r) => [r, 0]));
  const openSince = new Map<string, { role: string; at: number }>();
  const runs: Run[] = [];
  for (const e of stageEvents) {
    if (e.kind === "stage.launching") openSince.set(e.entity_id, { role: e.role, at: e.at_ms });
    else {
      const o = openSince.get(e.entity_id);
      if (o) {
        runMs[o.role] += overlap(o.at, e.at_ms, since, until);
        runs.push({ role: o.role, from: o.at, to: e.at_ms });
      }
      openSince.delete(e.entity_id);
    }
  }
  for (const o of openSince.values()) {
    runMs[o.role] += overlap(o.at, end, since, until);
    runs.push({ role: o.role, from: o.at, to: Math.max(end, o.at) });
  }
  const windowMs = until - since;
  const slot_use = Object.fromEntries(
    STAGE_ROLES.map((role: StageRole) => {
      const limit = limits[role];
      return [role, { run_hours: hours(runMs[role]), limit, slot_hours: hours(limit * windowMs), percent: percent(runMs[role], limit * windowMs) }];
    }),
  );

  // 2. Tickets ready now.
  const ready_tickets = db
    .query<{ id: string; title: string }, [string]>(
      `SELECT t.id, t.title FROM tickets t WHERE t.room = ?1 AND t.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM stage s WHERE s.ticket_id = t.id AND s.status IN ${LIVE_STAGE})
        ORDER BY t.created_at_ms, t.id`,
    )
    .all(room)
    .filter((t) => openBlockerIds(db, t.id, { now, fresh: true }).length === 0);

  // 3. Ticket-hours by one wait reason each.
  const git_ = stagingCommits(project);
  const tickets = db.query<{ id: string; request_id: string | null; blast_radius: string; status: string }, [string]>("SELECT id, request_id, blast_radius, status FROM tickets WHERE room = ?").all(room);
  const ticketEvents = new Map<string, Ev[]>();
  for (const e of db
    .query<Ev, [string]>(
      "SELECT e.entity_id, e.kind, e.at_ms, e.payload_json FROM events e JOIN tickets t ON t.id = e.entity_id WHERE t.room = ? AND e.kind LIKE 'ticket.%' ORDER BY e.seq",
    )
    .all(room)) {
    const list = ticketEvents.get(e.entity_id) ?? [];
    list.push(e);
    ticketEvents.set(e.entity_id, list);
  }
  const doneAt = new Map<string, number>();
  for (const [id, evs] of ticketEvents) for (const e of evs) if (e.kind === "ticket.done") doneAt.set(id, e.at_ms);
    // Only a non-terminal high ticket holds a request for the human (the rule of WAITING_FOR_APPROVAL_SQL).
  const roomHasHigh = new Set(tickets.filter((t) => t.blast_radius === "high" && t.status !== "done" && t.status !== "cancelled").map((t) => t.request_id));
  // The first spec PASS that covered a ticket: from then a draft ticket of a request with a high ticket waits for the human.
  const specPassAt = new Map<string, number>();
  for (const r of db
    .query<{ ticket_id: string; at_ms: number }, [string]>(
      `SELECT sc.ticket_id, MIN(e.at_ms) AS at_ms FROM stage s JOIN stage_scope sc ON sc.stage_id = s.id
         JOIN events e ON e.entity_id = s.id AND e.kind = 'stage.passed'
        WHERE s.review = 'spec' AND s.verdict = 'PASS' AND ${STAGE_ROOM_SQL} = ? GROUP BY sc.ticket_id`,
    )
    .all(room)) specPassAt.set(r.ticket_id, r.at_ms);

  const wait = { draft: 0, waiting_approval: 0, blocked: 0, no_slot: 0 };
  for (const t of tickets) {
    const segs = segments(ticketEvents.get(t.id) ?? [], end);
    const blockers = db.query<{ blocker_id: string }, [string]>("SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ?").all(t.id).map((b) => b.blocker_id);
    const stillOpen = new Set(blockers.length > 0 ? openBlockerIds(db, t.id, { now, fresh: true }) : []);
    // Time at which the last blocker cleared. Infinity while one is open. A blocker cleared by merge is dated by its merge commit.
    let clearedAt = 0;
    for (const b of blockers) {
      const merge = git_.merged.get(b);
      const at = stillOpen.has(b) ? Infinity : Math.min(doneAt.get(b) ?? now, merge ?? now);
      clearedAt = Math.max(clearedAt, at);
    }
    for (const s of segs) {
      if (s.status === "draft") {
        const waitFrom = t.request_id && roomHasHigh.has(t.request_id) ? (specPassAt.get(t.id) ?? Infinity) : Infinity;
        const cut = Math.min(Math.max(s.from, waitFrom), s.to);
        wait.draft += overlap(s.from, cut, since, until);
        wait.waiting_approval += overlap(cut, s.to, since, until);
      } else if (s.status === "queued") {
        const cut = Math.min(Math.max(s.from, clearedAt), s.to);
        wait.blocked += overlap(s.from, cut, since, until);
        // A ticket with no uncleared blocker waits for a slot only while every worker slot is in use.
        wait.no_slot += fullMs(runs, "worker", limits.worker, Math.max(cut, since), Math.min(s.to, until));
      }
    }
  }
  const wait_hours = Object.fromEntries(Object.entries(wait).map(([k, v]) => [k, hours(v)]));

  // 4. Review verdicts that ended in the window.
  const reviews: Record<string, { pass: number; fail: number; fail_percent: number }> = {
    spec: { pass: 0, fail: 0, fail_percent: 0 },
    validator: { pass: 0, fail: 0, fail_percent: 0 },
    reviewer: { pass: 0, fail: 0, fail_percent: 0 },
  };
  for (const r of db
    .query<{ role: string; review: string | null; verdict: string }, [string, number, number]>(
      `SELECT s.role, s.review, s.verdict FROM stage s
         JOIN events e ON e.entity_id = s.id AND e.kind = 'stage.passed'
        WHERE s.verdict IN ('PASS', 'FAIL') AND s.role IN ('validator', 'reviewer') AND ${STAGE_ROOM_SQL} = ?1
          AND e.at_ms >= ?2 AND e.at_ms < ?3`,
    )
    .all(room, since, until)) {
    const bucket = reviews[r.review === "spec" ? "spec" : r.role];
    if (r.verdict === "PASS") bucket.pass++;
    else bucket.fail++;
  }
  for (const b of Object.values(reviews)) b.fail_percent = percent(b.fail, b.pass + b.fail);

  // 5. Done tickets with no merge commit on staging.
  const done_without_merge = git_.ok
    ? db
        .query<{ id: string; title: string }, [string]>("SELECT id, title FROM tickets WHERE room = ? AND status = 'done' ORDER BY created_at_ms, id")
        .all(room)
        .filter((t) => !git_.merged.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, named_by_non_merge_commit: git_.nonMerge.has(t.id) }))
    : null;

  return {
    room,
    since,
    until,
    window_hours: hours(windowMs),
    limits: "current" as const,
    slot_use,
    ready_tickets,
    wait_hours,
    reviews,
    staging: git_.ok ? ("ok" as const) : ("unavailable" as const),
    done_without_merge,
  };
}
