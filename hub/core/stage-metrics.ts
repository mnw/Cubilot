// Stage metrics (context-pack 5.1): what a stage session cost at its start. Read once when an attempt ends.
// The Claude transcript is `~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<session>.jsonl`.
// Nothing here changes a stage: the caller catches every throw and logs one line.

import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { HANDOFF_SECTION_MAX } from "./first-message";

export type MetricsRow = {
  stage_id: string;
  attempt: number;
  role: string;
  first_message_bytes: number;
  first_message_tokens_est: number;
  prompt_tokens_first: number | null;
  cache_read_tokens: number | null;
  tokens_before_action: number | null;
  source: "claude" | "none";
  created_seq: number;
};

export type Usage = { prompt_tokens_first: number; cache_read_tokens: number; tokens_before_action: number };

/** A candidate file is read from the start in chunks of this size, up to the first user message line. */
const CHUNK_BYTES = 4 * 1024;
/**
 * The most bytes (UTF-8) renderFirstMessage can produce, from the bound of each part (3 bytes per UTF-16 unit, the worst case):
 * - template: shipped factory/<role>/first-message.md is at most 448 bytes; no bound in code, so TEMPLATE_ALLOWANCE below is
 *   pinned by a test over the shipped files (tests/unit/stage-metrics.test.ts)
 * - title: TICKET_TITLE_MAX_CHARS = 200 (hub/kinds/ticket.ts:76) -> 600
 * - acceptance_criteria: TICKET_CRITERIA_MAX_CHARS = 4000 (hub/kinds/ticket.ts:77) -> 12000
 * - handoff section (from, task, context): HANDOFF_SECTION_MAX = 64 KiB (hub/core/first-message.ts:25), notice included
 * - reason note: the launch ack error is cut at 500 units (hub/kinds/stage.ts:1418) -> 1500, plus 200 for prefix and note text;
 *   every other reason is a fixed string
 * - ids, branch, recipient and worktree path: 1500 together (worktree <= 1024 = macOS PATH_MAX, recipient <= 64 chars x 3,
 *   ticket, stage and request ids, branch and blast radius under 150)
 */
const TEMPLATE_ALLOWANCE = 4 * 1024;
export const MAX_FIRST_MESSAGE_BYTES = TEMPLATE_ALLOWANCE + 600 + 12_000 + HANDOFF_SECTION_MAX + 1_700 + 1_500;
/** Hard cap per candidate: 2 x the largest renderable first message (human decision, msg 1505). A candidate whose first user message is not complete by then does not match (no error, no log line). */
export const HEAD_CAP_BYTES = 2 * MAX_FIRST_MESSAGE_BYTES;
/** A tool call that changes a file ends "before the first action"; so does the result handoff. */
const ACTION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const isResultTool = (name: string) => name === "send_handoff" || name.endsWith("__send_handoff");

export const claudeProjectsDir = (): string => process.env.CUBILOT_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");

export const claudeProjectFolder = (cwd: string, root = claudeProjectsDir()): string => join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));

export const tokensEst = (bytes: number): number => Math.ceil(bytes / 4);

type Head = { ts: number; firstUser: string };

function entry(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null; // an empty line
  }
}

/** Reads whole lines from the start of `file` in small chunks and stops at the first user message. `stats.bytes` counts the bytes read. */
async function readHead(file: string, stats?: { bytes: number }): Promise<Head | null> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let pending = "";
    let total = 0;
    let ts: number | null = null;
    while (total < HEAD_CAP_BYTES) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, HEAD_CAP_BYTES - total), total);
      if (!bytesRead) return null;
      total += bytesRead;
      if (stats) stats.bytes += bytesRead;
      pending += buf.subarray(0, bytesRead).toString("utf8");
      const cut = pending.lastIndexOf("\n");
      if (cut < 0) continue;
      const lines = pending.slice(0, cut).split("\n");
      pending = pending.slice(cut + 1);
      for (const l of lines) {
        const d = entry(l);
        if (ts === null && typeof d?.timestamp === "string") {
          const t = Date.parse(d.timestamp);
          if (!Number.isNaN(t)) ts = t;
        }
        if (d?.type === "user" && !d.isMeta) {
          const c = d.message?.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
          return ts === null ? null : { ts, firstUser: text };
        }
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * The transcript of one attempt: of the files in `folder` whose first entry time is in [from, to), the earliest whose first
 * user message contains the stage id. A missing folder is no transcript (null); any other read error throws.
 */
export async function selectTranscript(folder: string, stageId: string, from: number, to: number | null, stats?: { bytes: number }): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(folder)).filter((n) => n.endsWith(".jsonl"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let best: { file: string; ts: number } | null = null;
  for (const n of names) {
    const file = join(folder, n);
    const h = await readHead(file, stats);
    if (!h || h.ts < from || (to !== null && h.ts >= to) || !h.firstUser.includes(stageId)) continue;
    if (!best || h.ts < best.ts) best = { file, ts: h.ts };
  }
  return best?.file ?? null;
}

const TOKEN_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;
/** A usage object is readable only when every field the writer uses is a finite integer >= 0. */
const readable = (u: any): boolean => TOKEN_FIELDS.every((k) => Number.isInteger(u?.[k]) && u[k] >= 0);
const sum = (u: any): number => TOKEN_FIELDS.reduce((a, k) => a + u[k], 0);

/**
 * The three numbers of design.md:46 from one transcript. Returns null when no assistant line has `message.usage`, when a non-empty line is not valid JSON, or when
 * a usage object it counts is not readable (a missing, string, negative or non-integer field): never a 0 for a bad field.
 * A request can span several lines with one `message.id`: the last line of an id holds its final usage.
 */
export async function readUsage(file: string): Promise<Usage | null> {
  const order: string[] = [];
  const usage = new Map<string, any>();
  let actionAt: string | null = null;
  let n = 0;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return null; // a non-empty line that is not JSON (cut off): the usage is not readable (human msg 1587)
    }
    const m = d?.message;
    if (d?.type !== "assistant" || !m?.usage) continue;
    const id = typeof m.id === "string" ? m.id : `#${n++}`;
    if (!usage.has(id)) order.push(id);
    usage.set(id, m.usage);
    if (actionAt === null && Array.isArray(m.content) && m.content.some((c: any) => c?.type === "tool_use" && typeof c.name === "string" && (ACTION_TOOLS.has(c.name) || isResultTool(c.name)))) actionAt = id;
  }
  if (!order.length) return null;
  const upto = actionAt === null ? order.length : order.indexOf(actionAt) + 1;
  const counted = order.slice(0, upto).map((id) => usage.get(id));
  if (!counted.every(readable)) return null;
  const first = counted[0];
  return {
    prompt_tokens_first: first.input_tokens + first.cache_creation_input_tokens + first.cache_read_input_tokens,
    cache_read_tokens: first.cache_read_input_tokens,
    tokens_before_action: counted.reduce((a, u) => a + sum(u), 0),
  };
}

export type Launch = { role: string; harness: string; cwd: string | null; bytes: number };

/** The `stage.launching` events of a stage, oldest first. The Nth is attempt N; its window ends at the (N+1)th. */
export function launchEvents(db: Database, stageId: string): Array<{ seq: number; at_ms: number; launch: Launch | null }> {
  return db
    .query<{ seq: number; at_ms: number; payload_json: string }, [string]>("SELECT seq, at_ms, payload_json FROM events WHERE entity_id = ? AND kind = 'stage.launching' ORDER BY seq")
    .all(stageId)
    .map((r) => {
      let l: any = null;
      try {
        l = JSON.parse(r.payload_json)?.launch;
      } catch {
        // an unreadable payload is an event without launch metadata
      }
      const ok = l && typeof l.role === "string" && typeof l.harness === "string" && Number.isInteger(l.bytes) && l.bytes >= 0 && (l.cwd === null || typeof l.cwd === "string");
      return { seq: r.seq, at_ms: r.at_ms, launch: ok ? (l as Launch) : null };
    });
}

/**
 * The seq of the event that ends an attempt: the first stage.passed, stage.failed or stage.retrying after its launch event
 * and before the next launch event. Null when there is none.
 */
function attemptEndSeq(db: Database, stageId: string, launchSeq: number, nextLaunchSeq: number | null): number | null {
  return (
    db
      .query<{ n: number | null }, [string, number, number]>(
        "SELECT MIN(seq) AS n FROM events WHERE entity_id = ? AND kind IN ('stage.passed', 'stage.failed', 'stage.retrying') AND seq > ? AND seq < ?",
      )
      .get(stageId, launchSeq, nextLaunchSeq ?? Number.MAX_SAFE_INTEGER)?.n ?? null
  );
}

/**
 * One row per attempt of an ended stage. The launch metadata (harness, cwd, role, first message size) is read from the
 * payload of the attempt's `stage.launching` event, so a hub restart loses nothing. An event without it (written before
 * this change) gets no row and one log line.
 * A pi attempt is `source = 'none'` (5.3). Every attempt logs at most one line through `log`; a write failure of one
 * attempt does not stop the next.
 */
export async function recordStageMetrics(
  db: Database,
  stageId: string,
  createdSeq: number, // fallback only: each row stores the seq of its own attempt's terminal event
  log: (line: string) => void,
  projectsRoot = claudeProjectsDir(),
  repair = false,
): Promise<void> {
  let events: ReturnType<typeof launchEvents>;
  try {
    events = launchEvents(db, stageId);
  } catch (e) {
    log(`[stage-metrics] ${stageId}: reading the launch events failed: ${(e as Error).message}`);
    return;
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const attempt = i + 1;
    const l = ev.launch;
    // Start repair: only the attempts that lack a row and have launch metadata; the others are left alone and not logged.
    if (repair && (!l || db.query("SELECT 1 FROM stage_metrics WHERE stage_id = ? AND attempt = ?").get(stageId, attempt))) continue;
    if (!l) {
      log(`[stage-metrics] ${stageId} attempt ${attempt}: launched before stage metrics; no row`);
      continue;
    }
    let usage: Usage | null = null;
    let why: string | null = null;
    if (l.harness === "pi") {
      why = null; // task 5.3: pi usage is not read in this change
    } else if (!l.cwd) {
      why = "no worktree cwd";
    } else {
      try {
        const file = await selectTranscript(claudeProjectFolder(l.cwd, projectsRoot), stageId, ev.at_ms, events[i + 1]?.at_ms ?? null);
        if (!file) why = "no transcript matched";
        else {
          usage = await readUsage(file);
          if (!usage) why = "the transcript usage is not readable";
        }
      } catch (e) {
        why = `reading the transcript failed: ${(e as Error).message}`;
      }
    }
    const bytes = l.bytes;
    // created_seq: the seq of this attempt's own terminal event. `createdSeq` is the fallback for a ledger without one.
    let endSeq = createdSeq;
    try {
      endSeq = attemptEndSeq(db, stageId, ev.seq, events[i + 1]?.seq ?? null) ?? createdSeq;
    } catch {
      // keep the fallback; the insert below reports a failing ledger
    }
    try {
      db.run(
        `INSERT OR IGNORE INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, prompt_tokens_first, cache_read_tokens, tokens_before_action, source, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stageId, attempt, l.role, bytes, tokensEst(bytes), usage?.prompt_tokens_first ?? null, usage?.cache_read_tokens ?? null, usage?.tokens_before_action ?? null, usage ? "claude" : "none", endSeq],
      );
      if (why) log(`[stage-metrics] ${stageId} attempt ${attempt}: ${why}; stored as source none`);
    } catch (e) {
      log(`[stage-metrics] ${stageId} attempt ${attempt}: writing the row failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Ended stages (passed or failed) with at least one attempt that has launch metadata and no stage_metrics row, with the seq of
 * their last terminal event (what the deferred write stores as created_seq). Attempt N is the Nth `stage.launching` event.
 */
export function stagesMissingMetrics(db: Database): Array<{ id: string; seq: number }> {
  return db
    .query<{ id: string; seq: number }, []>(
      `SELECT s.id AS id, (SELECT MAX(t.seq) FROM events t WHERE t.entity_id = s.id AND t.kind IN ('stage.passed', 'stage.failed')) AS seq
       FROM stage s
       WHERE s.status IN ('passed', 'failed')
         AND EXISTS (
           SELECT 1 FROM (SELECT payload_json, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY seq) AS attempt
                          FROM events WHERE entity_id = s.id AND kind = 'stage.launching') e
           WHERE json_extract(e.payload_json, '$.launch') IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM stage_metrics m WHERE m.stage_id = s.id AND m.attempt = e.attempt))
       ORDER BY s.rowid`,
    )
    .all()
    .filter((r) => r.seq != null);
}

/** The stored rows of a room, grouped by role. `roomSql` selects the room of stage alias `s`. */
export function metricsByRole(db: Database, room: string, roomSql: string): Record<string, MetricsRow[]> {
  const rows = db
    .query<MetricsRow, [string]>(
      `SELECT m.* FROM stage_metrics m JOIN stage s ON s.id = m.stage_id WHERE ${roomSql} = ? ORDER BY m.created_seq, m.stage_id, m.attempt`,
    )
    .all(room);
  const out: Record<string, MetricsRow[]> = {};
  for (const r of rows) (out[r.role] ??= []).push(r);
  return out;
}
