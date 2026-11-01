// Validation for a ticket's `blocked_by` list. Runs in decide() under the single-writer assumption
// (design decision 3): nothing changes the ticket_blockers rows between this check and the write.

import type { Database } from "bun:sqlite";
import { getRoomSettings } from "../core/ledger";

export const BLOCKED_BY_MAX = 20;
const TICKET_ID_RE = /^t_[0-9a-f]{16}$/;

/** `ids` undefined = leave the stored blockers alone; [] = clear them. An `error` is a 400 message. */
export type BlockedByResult = { ids: string[] | undefined; error?: undefined } | { error: string };

/**
 * @param ticketId the ticket being edited, or null on create (a new ticket has no edges, so it cannot close a cycle)
 * @param value raw `blocked_by` from the request body: undefined = omitted, null or [] = clear
 */
export function validateBlockedBy(db: Database, room: string, ticketId: string | null, value: unknown): BlockedByResult {
  if (value === undefined) return { ids: undefined };
  if (value === null) return { ids: [] };
  if (!Array.isArray(value)) return { error: "blocked_by must be an array of ticket ids" };
  if (value.length > BLOCKED_BY_MAX) return { error: `blocked_by has more than ${BLOCKED_BY_MAX} ids` };

  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !TICKET_ID_RE.test(id)) return { error: `invalid blocker id: ${String(id)}` };
    if (id === ticketId) return { error: `ticket cannot block itself: ${id}` };
    if (seen.has(id)) return { error: `duplicate blocker id: ${id}` };
    seen.add(id);
    const row = db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(id);
    if (!row) return { error: `unknown blocker id: ${id}` };
    if (row.room !== room) return { error: `blocker is in another room: ${id}` };
  }

  // The new edges are ticketId -> each blocker. A cycle exists if any blocker already reaches ticketId.
  if (ticketId !== null) {
    const next = db.query<{ blocker_id: string }, [string]>("SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ?");
    const visited = new Set<string>();
    for (const root of seen) {
      const stack = [root];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const { blocker_id } of next.all(cur)) {
          if (blocker_id === ticketId) return { error: `blocker would create a cycle: ${root}` };
          stack.push(blocker_id);
        }
      }
    }
  }
  return { ids: [...seen] };
}

// ---------- One rule for an open blocker (L3) ----------
// A blocker is closed when it is `done`, or when the commit of its latest tester PASS result is an ancestor of the
// room project's `staging` branch. A cancelled blocker still blocks. Any git problem keeps the blocker open.

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 10_000;
/** The staging head is read again after this many ms (and at each scheduler pass, with `fresh`). */
export const STAGING_RECHECK_MS = 30_000;

const headCache = new Map<string, { at: number; head: string | null }>();
const ancestorCache = new Map<string, boolean>();

/** Runs git with a fixed argument list and no shell. Never throws. */
export function git(project: string, args: string[]): { code: number | null; out: string } {
  try {
    const r = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
    return { code: r.exitCode, out: r.stdout.toString().trim() };
  } catch {
    return { code: null, out: "" };
  }
}

function stagingHead(project: string, now: number, fresh: boolean): string | null {
  const hit = headCache.get(project);
  if (hit && !fresh && now - hit.at < STAGING_RECHECK_MS) return hit.head;
  const r = git(project, ["rev-parse", "--verify", "--quiet", "refs/heads/staging^{commit}"]);
  const head = r.code === 0 && FULL_SHA_RE.test(r.out) ? r.out : null;
  headCache.set(project, { at: now, head });
  return head;
}

/** The commit of the newest tester PASS result of a ticket, else null. */
function testerPassCommit(db: Database, ticketId: string): string | null {
  const row = db
    .query<{ c: string | null }, [string]>(
      `SELECT json_extract(h.context_json, '$.commit') AS c
         FROM handoffs h JOIN stage s ON s.id = json_extract(h.context_json, '$.stage_id') AND h.from_agent = s.session
        WHERE json_extract(h.context_json, '$.ticket_id') = ?1 AND s.role = 'tester' AND s.ticket_id = ?1
          AND s.status = 'passed' AND s.verdict = 'PASS' AND json_extract(h.context_json, '$.verdict') = 'PASS'
        ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) DESC LIMIT 1`,
    )
    .get(ticketId);
  return row?.c && FULL_SHA_RE.test(row.c) ? row.c : null;
}

function mergedIntoStaging(db: Database, blockerId: string, room: string, now: number, fresh: boolean): boolean {
  if (!TICKET_ID_RE.test(blockerId)) return false;
  const project = getRoomSettings(db, room)?.project_folder;
  if (!project) return false;
  const commit = testerPassCommit(db, blockerId);
  if (!commit) return false;
  const head = stagingHead(project, now, fresh);
  if (!head) return false;
  const key = `${project}\0${head}\0${commit}`;
  const cached = ancestorCache.get(key);
  if (cached !== undefined) return cached;
  const r = git(project, ["merge-base", "--is-ancestor", commit, head]);
  if (r.code !== 0 && r.code !== 1) return false; // a failed check is not cached and keeps the blocker open
  if (ancestorCache.size > 2000) ancestorCache.clear();
  ancestorCache.set(key, r.code === 0);
  return r.code === 0;
}

/** The ids of the blockers of a ticket that are still open, in list order. The one rule of the board, the claim gate and the auto-launch. */
export function openBlockerIds(db: Database, ticketId: string, opts: { now?: number; fresh?: boolean } = {}): string[] {
  const now = opts.now ?? Date.now();
  const rows = db
    .query<{ blocker_id: string; status: string | null; room: string | null }, [string]>(
      "SELECT b.blocker_id, t.status, t.room FROM ticket_blockers b LEFT JOIN tickets t ON t.id = b.blocker_id WHERE b.ticket_id = ? ORDER BY b.rowid",
    )
    .all(ticketId);
  return rows
    .filter((r) => {
      if (r.status === "done") return false;
      if (r.status === null || r.status === "cancelled" || r.room === null) return true;
      return !mergedIntoStaging(db, r.blocker_id, r.room, now, opts.fresh === true);
    })
    .map((r) => r.blocker_id);
}
