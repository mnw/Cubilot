// Validation for a ticket's `blocked_by` list. Runs in decide() under the single-writer assumption
// (design decision 3): nothing changes the ticket_blockers rows between this check and the write.

import type { Database } from "bun:sqlite";

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
