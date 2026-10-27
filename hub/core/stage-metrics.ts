// Stage metrics (context-pack 5.1): what a stage session cost at its start. Read once when an attempt ends.
// The Claude transcript is `~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<session>.jsonl`.
// Nothing here changes a stage: the caller catches every throw and logs one line.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

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

/** Bytes read from the head of a candidate file to find its first entry time and first user message. */
const HEAD_BYTES = 256 * 1024;
/** A tool call that changes a file ends "before the first action"; so does the result handoff. */
const ACTION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const isResultTool = (name: string) => name === "send_handoff" || name.endsWith("__send_handoff");

export const claudeProjectsDir = (): string => process.env.CUBILOT_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");

export const claudeProjectFolder = (cwd: string, root = claudeProjectsDir()): string => join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));

export const tokensEst = (bytes: number): number => Math.ceil(bytes / 4);

type Head = { ts: number; firstUser: string };

function readHead(file: string): Head | null {
  const fd = openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    text = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
  let ts: number | null = null;
  for (const line of text.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // an empty line, or the cut end of the buffer
    }
    if (ts === null && typeof d?.timestamp === "string") {
      const t = Date.parse(d.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
    if (d?.type === "user" && !d.isMeta) {
      const c = d.message?.content;
      const s = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
      return ts === null ? null : { ts, firstUser: s };
    }
  }
  return null;
}

/**
 * The transcript of one attempt: of the files in `folder` whose first entry time is in [from, to), the earliest whose first
 * user message contains the stage id. A missing folder is no transcript (null); any other read error throws.
 */
export function selectTranscript(folder: string, stageId: string, from: number, to: number | null): string | null {
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith(".jsonl"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let best: { file: string; ts: number } | null = null;
  for (const n of names) {
    const file = join(folder, n);
    const h = readHead(file);
    if (!h || h.ts < from || (to !== null && h.ts >= to) || !h.firstUser.includes(stageId)) continue;
    if (!best || h.ts < best.ts) best = { file, ts: h.ts };
  }
  return best?.file ?? null;
}

const sum = (u: any): number =>
  ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce((a, k) => a + (Number(u?.[k]) || 0), 0);

/**
 * The three numbers of design.md:46 from one transcript. Returns null when no assistant line has `message.usage`.
 * A request can span several lines with one `message.id`: the last line of an id holds its final usage.
 */
export function readUsage(file: string): Usage | null {
  const order: string[] = [];
  const usage = new Map<string, any>();
  let actionAt: string | null = null;
  let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d?.message;
    if (d?.type !== "assistant" || !m?.usage) continue;
    const id = typeof m.id === "string" ? m.id : `#${n++}`;
    if (!usage.has(id)) order.push(id);
    usage.set(id, m.usage);
    if (actionAt === null && Array.isArray(m.content) && m.content.some((c: any) => c?.type === "tool_use" && typeof c.name === "string" && (ACTION_TOOLS.has(c.name) || isResultTool(c.name)))) actionAt = id;
  }
  if (!order.length) return null;
  const first = usage.get(order[0]);
  const upto = actionAt === null ? order.length : order.indexOf(actionAt) + 1;
  return {
    prompt_tokens_first: (Number(first.input_tokens) || 0) + (Number(first.cache_creation_input_tokens) || 0) + (Number(first.cache_read_input_tokens) || 0),
    cache_read_tokens: Number(first.cache_read_input_tokens) || 0,
    tokens_before_action: order.slice(0, upto).reduce((a, id) => a + sum(usage.get(id)), 0),
  };
}

/** The `stage.launching` events of a stage, oldest first. The Nth is attempt N; its window ends at the (N+1)th. */
export function launchTimes(db: Database, stageId: string): number[] {
  return db
    .query<{ at_ms: number }, [string]>("SELECT at_ms FROM events WHERE entity_id = ? AND kind = 'stage.launching' ORDER BY seq")
    .all(stageId)
    .map((r) => r.at_ms);
}

export type Launched = { role: string; harness: string; cwd: string | null; bytes: number };

/**
 * One row per attempt of an ended stage. `launched` is what the hub remembered of each launch (attempt number to its first
 * message size, harness and cwd). An attempt the hub did not see launch gets no row. A pi attempt is `source = 'none'` (5.3).
 * Every attempt logs at most one line through `log`; a write failure of one attempt does not stop the next.
 */
export function recordStageMetrics(
  db: Database,
  stageId: string,
  createdSeq: number,
  launched: Map<number, Launched>,
  log: (line: string) => void,
  projectsRoot = claudeProjectsDir(),
): void {
  let times: number[];
  try {
    times = launchTimes(db, stageId);
  } catch (e) {
    log(`[stage-metrics] ${stageId}: reading the launch events failed: ${(e as Error).message}`);
    return;
  }
  times.forEach((from, i) => {
    const attempt = i + 1;
    const l = launched.get(attempt);
    if (!l) return;
    let usage: Usage | null = null;
    let why: string | null = null;
    if (l.harness === "pi") {
      why = null; // task 5.3: pi usage is not read in this change
    } else if (!l.cwd) {
      why = "no worktree cwd";
    } else {
      try {
        const file = selectTranscript(claudeProjectFolder(l.cwd, projectsRoot), stageId, from, times[i + 1] ?? null);
        if (!file) why = "no transcript matched";
        else {
          usage = readUsage(file);
          if (!usage) why = "the transcript has no usage";
        }
      } catch (e) {
        why = `reading the transcript failed: ${(e as Error).message}`;
      }
    }
    try {
      db.run(
        `INSERT OR IGNORE INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, prompt_tokens_first, cache_read_tokens, tokens_before_action, source, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stageId, attempt, l.role, l.bytes, tokensEst(l.bytes), usage?.prompt_tokens_first ?? null, usage?.cache_read_tokens ?? null, usage?.tokens_before_action ?? null, usage ? "claude" : "none", createdSeq],
      );
      if (why) log(`[stage-metrics] ${stageId} attempt ${attempt}: ${why}; stored as source none`);
    } catch (e) {
      log(`[stage-metrics] ${stageId} attempt ${attempt}: writing the row failed: ${(e as Error).message}`);
    }
  });
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
