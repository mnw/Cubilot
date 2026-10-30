// When a checkpoint of the room lead is due and when it is safe (human-touchpoints-checkpoint decision 12, rule R4).
// Everything is derived from the ledger tables and the context file at each call; nothing is stored.

import type { Database } from "bun:sqlite";
import { readConfig, isMap } from "./config-file";
import { heldForApprove } from "../kinds/request";

export const DEFAULT_CONTEXT_PCT = 60;

/** `checkpoint.context_pct` of config.yml; a bad value gives the default and one log line. */
export function contextPctLimit(): number {
  const doc = readConfig("checkpoint", "checkpoint");
  if (!("checkpoint" in doc)) return DEFAULT_CONTEXT_PCT;
  const block = doc.checkpoint;
  const v = isMap(block) ? block.context_pct : undefined;
  if (v === undefined) return DEFAULT_CONTEXT_PCT;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100) {
    console.log("[checkpoint] checkpoint.context_pct must be a number from 1 to 100, default 60");
    return DEFAULT_CONTEXT_PCT;
  }
  return v;
}

/**
 * The done time of a request, or null when it is not done. Done: the request has a ticket, each ticket is `done` or
 * `cancelled`, and at least one is `done`. The done time is the `at_ms` of the newest newest `ticket.done` / `ticket.cancelled`
 * event of its tickets by `events.seq` (not by wall-clock time), which is the event that made the predicate true. A ticket added later is not terminal, so the
 * request is not done until that ticket ends; its event then gives a new, later done time.
 */
export function requestDoneAt(db: Database, room: string, requestId: string): number | null {
  const row = db
    .query<{ open: number; done: number; at: number | null }, [string, string]>(
      `SELECT SUM(t.status NOT IN ('done', 'cancelled')) AS open,
              SUM(t.status = 'done') AS done,
              (SELECT e.at_ms FROM events e
                WHERE e.kind IN ('ticket.done', 'ticket.cancelled')
                  AND e.entity_id IN (SELECT id FROM tickets WHERE room = ?1 AND request_id = ?2)
                ORDER BY e.seq DESC LIMIT 1) AS at
         FROM tickets t WHERE t.room = ?1 AND t.request_id = ?2`,
    )
    .get(room, requestId);
  if (!row || row.open !== 0 || !row.done) return null;
  return row.at;
}

/** The newest done time over all requests of the room. */
export function newestRequestDoneAt(db: Database, room: string): number | null {
  const ids = db
    .query<{ request_id: string }, [string]>("SELECT DISTINCT request_id FROM tickets WHERE room = ? AND request_id IS NOT NULL")
    .all(room);
  let newest: number | null = null;
  for (const { request_id } of ids) {
    const at = requestDoneAt(db, room, request_id);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Not a safe point: a request with an open ticket is held for approval (`heldForApprove`: no Approve yet, or its scope changed after it), a decision is
 * `open` or `escalated` (waits for the human), or a spec or arbiter stage is live.
 */
export function unsafePoint(db: Database, room: string): string | null {
  const live = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM stage s
        WHERE s.review IN ('spec', 'arbiter') AND s.status IN ('queued', 'launching', 'running', 'retrying')
          AND (s.request_id IN (SELECT request_id FROM tickets WHERE room = ?1 AND request_id IS NOT NULL)
               OR s.id IN (SELECT sc.stage_id FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id WHERE t.room = ?1))`,
    )
    .get(room)!.n;
  if (live) return "a spec or arbiter stage is live";
  const decision = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM decisions WHERE room = ? AND status IN ('open', 'escalated')").get(room)!.n;
  if (decision) return "a decision is open";
  const open = db
    .query<{ request_id: string }, [string]>(
      "SELECT DISTINCT request_id FROM tickets WHERE room = ? AND request_id IS NOT NULL AND status NOT IN ('done', 'cancelled')",
    )
    .all(room);
  const waiting = open.some(({ request_id }) => heldForApprove(db, room, request_id));
  if (waiting) return "a request waits for approval";
  return null;
}

/**
 * Why a checkpoint is due for the lead of `room` now, or null. `newestStartMs` is the start of the lead's newest
 * checkpoint (null when it has none); `contextPct` is the context use of the lead (null when unknown).
 */
export function checkpointDueReason(
  db: Database,
  room: string,
  newestStartMs: number | null,
  contextPct: number | null,
): "request_done" | "context_full" | null {
  if (unsafePoint(db, room)) return null;
  const doneAt = newestRequestDoneAt(db, room);
  if (doneAt !== null && (newestStartMs === null || doneAt > newestStartMs)) return "request_done";
  if (contextPct !== null && contextPct >= contextPctLimit()) return "context_full";
  return null;
}
