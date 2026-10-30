// Delivery report (P6-08): what a request delivered, built from the ledger and git. No model, no stored state.
// git runs with fixed arguments and no shell, only on GET. A git failure reads as "no merge commit".

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRoomSettings } from "./ledger";
import { validatorPassHandoffs } from "../kinds/ticket";

const TERMINAL = new Set(["done", "cancelled"]);
const NO_MERGE = "no merge commit";
const NO_LOG = "no staging log";
const NO_DATA = "no data" as const;
const NO_STAGING = "no staging branch";
const SHA_RE = /^[0-9a-f]{40}$/;

type TicketRow = { id: string; title: string; status: string; blast_radius: "low" | "high"; acceptance_criteria: string; request_id: string };

export type TicketFail = { handoff_id: string; findings: { severity: string; text: string }[]; fix_commit: string | null };

export type DeliveryReport = {
  request_id: string;
  origin: string;
  features: string[];
  tickets: { id: string; title: string; status: string; merge_commit: string; fails: TicketFail[] }[];
  /** First ticket.claimed to last ticket.done of the done tickets, in ms. null when no ticket has both. */
  build_ms: number | null;
  /** Claude stage tokens (stage_metrics.tokens_before_action, source claude). A stage without Claude data adds "no data" for its ticket. */
  cost: { tokens: number; tickets: { ticket_id: string; tokens: number | typeof NO_DATA; no_data_stages: string[] }[] };
  /** The git command that merges staging into main at the staging head. */
  merge_command: string;
  criteria_edits: { ticket_id: string; seq: number; by: string; from: string; to: string }[];
  factory_requests: { request_id: string; tickets: { id: string; title: string; status: string }[] }[];
  known_limits: {
    follow_up_tickets: { id: string; title: string; status: string; request_id: string }[];
    open_suggestions: { ticket_id: string; handoff_id: string; text: string }[];
  };
  checks: {
    high_radius: { ticket_id: string; pass_handoffs: string[]; merge_message_incomplete: boolean }[];
    test_counts: { commit: string; pass: number | null; fail: number | null } | typeof NO_LOG;
    live_check: { ticket_id: string; steps: string } | null;
  };
};

export type DeliveryResult = { kind: "ok"; report: DeliveryReport } | { kind: "not_found" } | { kind: "open" };

const git = (project: string, args: string[]): string | null => {
  try {
    const r = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
};

/** The merge commits on staging in log order (newest first): sha and subject. */
function stagingMerges(project: string | null | undefined): { sha: string; subject: string }[] {
  if (!project) return [];
  const out = git(project, ["log", "refs/heads/staging", "--merges", "--format=%H%x00%s"]);
  if (!out) return [];
  return out.split("\n").flatMap((l) => {
    const [sha, subject] = l.split("\0");
    return sha && SHA_RE.test(sha) && subject !== undefined ? [{ sha, subject }] : [];
  });
}

/** The newest merge commit of a ticket: its subject starts `Merge ticket/<id>:`, the form of the merge-message route. */
const mergeOf = (merges: { sha: string; subject: string }[], ticketId: string) => merges.find((m) => m.subject.startsWith(`Merge ticket/${ticketId}:`)) ?? null;

export const stagingLogDir = (): string => process.env.CUBILOT_STAGING_LOG_DIR || join(homedir(), "Library", "Logs", "Cubilot", "staging-suite");

function testCounts(sha: string): { commit: string; pass: number | null; fail: number | null } | typeof NO_LOG {
  let text: string;
  try {
    text = readFileSync(join(stagingLogDir(), `${sha}.log`), "utf8");
  } catch {
    return NO_LOG;
  }
  const n = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return { commit: sha, pass: n(/^\s*(\d+) pass\s*$/m), fail: n(/^\s*(\d+) fail\s*$/m) };
}

const tickets = (db: Database, room: string, requestId: string) =>
  db
    .query<TicketRow, [string, string]>("SELECT id, title, status, blast_radius, acceptance_criteria, request_id FROM tickets WHERE room = ? AND request_id = ? ORDER BY id")
    .all(room, requestId);

/** True when each ticket is done or cancelled and at least one is done. */
const delivered = (rows: { status: string }[]) => rows.length > 0 && rows.every((t) => TERMINAL.has(t.status)) && rows.some((t) => t.status === "done");

export function buildDeliveryReport(db: Database, room: string, requestId: string): DeliveryResult {
  const req = db.query<{ id: string; origin: string; features: string | null }, [string, string]>("SELECT id, origin, features FROM requests WHERE room = ? AND request_id = ?").get(room, requestId);
  if (!req) return { kind: "not_found" };
  const own = tickets(db, room, requestId);
  if (!delivered(own)) return { kind: "open" };
  const project = getRoomSettings(db, room)?.project_folder;
  const merges = stagingMerges(project);

  const ticketList = own.map((t) => ({ id: t.id, title: t.title, status: t.status, merge_commit: mergeOf(merges, t.id)?.sha ?? NO_MERGE, fails: ticketFails(db, t.id) }));

  // Edits of the criteria after the newest Approve, oldest first. A request without an Approve has none.
  const approveSeq = db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE entity_id = ? AND kind = 'request.approved'").get(req.id)?.n ?? null;
  const criteriaEdits = approveSeq === null ? [] : criteriaEditsAfter(db, room, requestId, approveSeq);

  const children = db
    .query<{ request_id: string }, [string, string]>("SELECT request_id FROM requests WHERE room = ? AND parent_request_id = ? AND origin = 'factory' ORDER BY created_at_ms, id")
    .all(room, requestId);
  const factory = children.map((c) => ({
    request_id: c.request_id,
    tickets: tickets(db, room, c.request_id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
  }));
  const followUps = factory.flatMap((f) => f.tickets.filter((t) => !TERMINAL.has(t.status)).map((t) => ({ ...t, request_id: f.request_id })));

  // The suggestions of the newest Validator PASS results of the tickets that are done.
  const suggestions: DeliveryReport["known_limits"]["open_suggestions"] = [];
  const highRadius: DeliveryReport["checks"]["high_radius"] = [];
  for (const t of own) {
    if (t.status !== "done") continue;
    const passes = validatorPassHandoffs(db, t.id);
    const ids = passes.flatMap((p) => (p.handoff_id ? [p.handoff_id] : []));
    for (const p of passes) {
      if (!p.handoff_id) continue;
      const c = db.query<{ c: string | null }, [string]>("SELECT context_json AS c FROM handoffs WHERE id = ?").get(p.handoff_id)?.c;
      let list: unknown = [];
      try { list = (JSON.parse(c ?? "{}") as { suggestions?: unknown }).suggestions ?? []; } catch { /* no readable result */ }
      if (Array.isArray(list)) for (const s of list) if (typeof s === "string" && s.trim()) suggestions.push({ ticket_id: t.id, handoff_id: p.handoff_id, text: s });
    }
    if (t.blast_radius === "high") {
      const subject = mergeOf(merges, t.id)?.subject ?? "";
      highRadius.push({ ticket_id: t.id, pass_handoffs: ids, merge_message_incomplete: ids.length < 2 || !ids.every((id) => subject.includes(id)) });
    }
  }

  // The newest merge commit of the request: the first of the staging log that merges one of its tickets.
  const newest = merges.find((m) => own.some((t) => m.subject.startsWith(`Merge ticket/${t.id}:`)));
  const live = own.find((t) => t.title.includes("[human]"));

  return {
    kind: "ok",
    report: {
      request_id: requestId,
      origin: req.origin,
      features: req.features ? (JSON.parse(req.features) as string[]) : [],
      tickets: ticketList,
      build_ms: buildMs(db, own),
      cost: stageCost(db, own),
      merge_command: mergeCommand(project),
      criteria_edits: criteriaEdits,
      factory_requests: factory,
      known_limits: { follow_up_tickets: followUps, open_suggestions: suggestions },
      checks: {
        high_radius: highRadius,
        test_counts: newest ? testCounts(newest.sha) : NO_LOG,
        live_check: live ? { ticket_id: live.id, steps: live.acceptance_criteria } : null,
      },
    },
  };
}

/** The FAIL results of the Validator stages of a ticket, oldest first. The fix commit is the commit of the next tester hand-over after the FAIL. */
function ticketFails(db: Database, ticketId: string): TicketFail[] {
  const rows = db
    .query<{ id: string; rid: number; c: string | null }, [string]>(
      `SELECT h.id AS id, h.rowid AS rid, h.context_json AS c FROM stage s
         JOIN handoffs h ON h.id = (SELECT x.id FROM handoffs x WHERE x.from_agent = s.session AND json_extract(x.context_json, '$.stage_id') = s.id ORDER BY x.rowid DESC LIMIT 1)
        WHERE s.ticket_id = ?1 AND s.role = 'validator' AND s.review IS NULL AND s.verdict = 'FAIL' ORDER BY s.created_seq`,
    )
    .all(ticketId);
  return rows.map((r) => {
    let findings: unknown = [];
    try { findings = (JSON.parse(r.c ?? "{}") as { findings?: unknown }).findings ?? []; } catch { /* no readable result */ }
    const list = (Array.isArray(findings) ? findings : []).flatMap((f) => {
      const o = f as { severity?: unknown; text?: unknown } | null;
      return o && typeof o.severity === "string" && typeof o.text === "string" ? [{ severity: o.severity, text: o.text }] : [];
    });
    const next = db
      .query<{ c: string | null }, [string, number]>(
        "SELECT context_json AS c FROM handoffs WHERE to_agent = 'role:tester' AND json_extract(context_json, '$.ticket_id') = ?1 AND rowid > ?2 ORDER BY rowid LIMIT 1",
      )
      .get(ticketId, r.rid)?.c;
    let commit: unknown = null;
    try { commit = next ? (JSON.parse(next) as { commit?: unknown }).commit : null; } catch { /* no readable hand-over */ }
    return { handoff_id: r.id, findings: list, fix_commit: typeof commit === "string" ? commit : null };
  });
}

/** First claim to last done of the done tickets. */
function buildMs(db: Database, own: TicketRow[]): number | null {
  const ids = own.map((t) => t.id);
  if (ids.length === 0) return null;
  const marks = ids.map(() => "?").join(",");
  const first = db.query<{ t: number | null }, string[]>(`SELECT MIN(at_ms) AS t FROM events WHERE kind = 'ticket.claimed' AND entity_id IN (${marks})`).get(...ids)?.t ?? null;
  const done = own.filter((t) => t.status === "done").map((t) => t.id);
  if (first === null || done.length === 0) return null;
  const last = db.query<{ t: number | null }, string[]>(`SELECT MAX(at_ms) AS t FROM events WHERE kind = 'ticket.done' AND entity_id IN (${done.map(() => "?").join(",")})`).get(...done)?.t ?? null;
  return last === null ? null : Math.max(0, last - first);
}

/** The Claude tokens of the stages of each ticket. A stage with no Claude row or a Pi row adds "no data", never 0. */
function stageCost(db: Database, own: TicketRow[]): DeliveryReport["cost"] {
  let total = 0;
  const tickets = own.map((t) => {
    const stages = db.query<{ id: string }, [string]>("SELECT id FROM stage WHERE ticket_id = ? AND review IS NULL ORDER BY created_seq").all(t.id);
    let tokens = 0;
    let claude = 0;
    const noData: string[] = [];
    for (const s of stages) {
      const rows = db.query<{ source: string; t: number | null }, [string]>("SELECT source, tokens_before_action AS t FROM stage_metrics WHERE stage_id = ?").all(s.id);
      if (rows.length === 0) continue;
      for (const m of rows) {
        if (m.source === "claude" && m.t !== null) { tokens += m.t; claude++; }
        else if (!noData.includes(s.id)) noData.push(s.id);
      }
    }
    total += tokens;
    return { ticket_id: t.id, tokens: claude === 0 && noData.length > 0 ? NO_DATA : tokens, no_data_stages: noData };
  });
  return { tokens: total, tickets };
}

const mergeCommand = (project: string | null | undefined): string => {
  const head = project ? git(project, ["rev-parse", "refs/heads/staging"])?.trim() : null;
  return head && SHA_RE.test(head) ? `git checkout main && git merge --ff-only ${head}` : NO_STAGING;
};

function criteriaEditsAfter(db: Database, room: string, requestId: string, approveSeq: number): DeliveryReport["criteria_edits"] {
  return db
    .query<{ seq: number; entity_id: string; actor: string; payload_json: string }, [string, string, number]>(
      `SELECT e.seq, e.entity_id, e.actor, e.payload_json FROM events e
        WHERE e.kind = 'ticket.edited' AND e.seq > ?3 AND json_extract(e.payload_json, '$.acceptance_criteria') IS NOT NULL
          AND e.entity_id IN (SELECT id FROM tickets WHERE room = ?1 AND request_id = ?2) ORDER BY e.seq`,
    )
    .all(room, requestId, approveSeq)
    .map((e) => {
      const c = (JSON.parse(e.payload_json) as { acceptance_criteria: { from: string; to: string } }).acceptance_criteria;
      return { ticket_id: e.entity_id, seq: e.seq, by: e.actor, from: c.from, to: c.to };
    });
}

/** The ids of the tickets whose newest staging merge commit is an ancestor of main. Read-only git. */
export function ticketsMergedIntoMain(project: string | null | undefined, ticketIds: string[]): Set<string> {
  const out = new Set<string>();
  if (!project || ticketIds.length === 0) return out;
  const merges = stagingMerges(project);
  for (const id of ticketIds) {
    const m = mergeOf(merges, id);
    if (m && git(project, ["merge-base", "--is-ancestor", m.sha, "refs/heads/main"]) !== null) out.add(id);
  }
  return out;
}

/**
 * The delivered requests of a room with a merge commit on staging that is not on main yet: one Needs-you line each.
 * Two git reads for the whole room: the staging merges and `main..staging`.
 */
export function deliveriesNotInMain(db: Database, room: string): { request_id: string; unmerged_commits: string[] }[] {
  const project = getRoomSettings(db, room)?.project_folder;
  const merges = stagingMerges(project);
  if (merges.length === 0) return [];
  const ahead = git(project!, ["rev-list", "refs/heads/main..refs/heads/staging"]);
  if (ahead === null) return [];
  const notInMain = new Set(ahead.split("\n").filter(Boolean));
  if (notInMain.size === 0) return [];
  const rows = db
    .query<{ id: string; status: string; request_id: string }, [string]>("SELECT id, status, request_id FROM tickets WHERE room = ? AND request_id IS NOT NULL ORDER BY request_id, id")
    .all(room);
  const byRequest = new Map<string, typeof rows>();
  for (const r of rows) byRequest.set(r.request_id, [...(byRequest.get(r.request_id) ?? []), r]);
  const out: { request_id: string; unmerged_commits: string[] }[] = [];
  for (const [request_id, ts] of byRequest) {
    if (!delivered(ts)) continue;
    const shas = ts.flatMap((t) => mergeOf(merges, t.id)?.sha ?? []).filter((s) => notInMain.has(s));
    if (shas.length > 0) out.push({ request_id, unmerged_commits: shas });
  }
  return out;
}
