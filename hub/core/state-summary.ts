// State summary (human-touchpoints-checkpoint 14.1): the text a room lead gets after a checkpoint clear, built from the
// ledger with code only. No model call, no clock, no write: the same ledger gives the same text. Ids, statuses and
// titles only (no criteria, notes or decision bodies). Size limit: 2,000 tokens at 4 characters per token.

import type { Database } from "bun:sqlite";

export const SUMMARY_MAX_CHARS = 8_000;
const TITLE_MAX = 80;
const NOTE_MAX = 1_200; // 200 words at 6 characters; the checkpoint caps the note at 200 words before this
const ESCALATIONS_SHOWN = 5;

type Part = { title: string; items: string[]; more: string; empty: string };

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

type TicketRow = { id: string; request_id: string | null; title: string; status: string; blast_radius: string };

function requestsPart(db: Database, room: string): Part {
  const tickets = db
    .query<TicketRow, [string]>(
      `SELECT id, request_id, title, status, blast_radius FROM tickets
       WHERE room = ? AND status NOT IN ('done','cancelled')
       ORDER BY (request_id IS NULL), request_id, created_at_ms, id`,
    )
    .all(room);
  const open = new Set(tickets.map((t) => t.id));
  const blockers = new Map<string, string[]>();
  for (const b of db
    .query<{ ticket_id: string; blocker_id: string }, []>("SELECT ticket_id, blocker_id FROM ticket_blockers ORDER BY ticket_id, blocker_id")
    .all()) {
    if (!open.has(b.ticket_id) || !open.has(b.blocker_id)) continue;
    const list = blockers.get(b.ticket_id) ?? [];
    list.push(b.blocker_id);
    blockers.set(b.ticket_id, list);
  }
  const items: string[] = [];
  let lastRequest: string | null | undefined;
  for (const t of tickets) {
    // A request header rides with the first ticket line of the request, so a cut never leaves a bare header.
    const head = t.request_id !== lastRequest ? `${t.request_id ?? "(no request)"}\n` : "";
    lastRequest = t.request_id;
    const blocked = blockers.get(t.id);
    items.push(`${head}  ${t.id} ${t.status} ${t.blast_radius} "${clip(t.title, TITLE_MAX)}"${blocked ? ` blocked_by ${blocked.join(",")}` : ""}`);
  }
  return {
    title: "Open requests and tickets",
    items,
    more: "list_tickets",
    empty: "none",
  };
}

type DecisionRow = { id: string; status: string; reason: string | null; ticket_id: string | null; request_id: string | null; decider: string };

const decisionLine = (d: DecisionRow) =>
  `  ${d.id} ${d.status} ${d.decider}${d.reason ? ` ${d.reason}` : ""}${d.ticket_id ? ` ${d.ticket_id}` : ""}${d.request_id ? ` ${d.request_id}` : ""}`;

function waitingPart(db: Database, room: string): Part {
  const rows = db
    .query<DecisionRow, [string]>(
      `SELECT id, status, reason, ticket_id, request_id, decider FROM decisions
       WHERE room = ? AND status IN ('open','escalated','recorded') ORDER BY created_at_ms, id`,
    )
    .all(room);
  return { title: "Decisions that wait", items: rows.map(decisionLine), more: "GET /decisions?room=<room>", empty: "none" };
}

function escalationsPart(db: Database, room: string): Part {
  const rows = db
    .query<DecisionRow, [string, number]>(
      `SELECT id, status, reason, ticket_id, request_id, decider FROM decisions
       WHERE room = ? AND (decider = 'human' OR status IN ('escalated','answered')) ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
    .all(room, ESCALATIONS_SHOWN);
  return { title: `Last ${ESCALATIONS_SHOWN} escalations`, items: rows.map(decisionLine), more: "GET /decisions?room=<room>", empty: "none" };
}

type StageRow = { id: string; ticket_id: string | null; request_id: string | null; role: string; status: string; session: string | null };

function stagesPart(db: Database, room: string): Part {
  const rows = db
    .query<StageRow, [string]>(
      `SELECT s.id, s.ticket_id, s.request_id, s.role, s.status, s.session FROM stage s
       WHERE s.status IN ('launching','running','retrying') AND COALESCE(
         (SELECT room FROM tickets WHERE id = s.ticket_id),
         (SELECT t.room FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id WHERE sc.stage_id = s.id ORDER BY sc.ticket_id LIMIT 1)) = ?
       ORDER BY s.created_seq, s.id`,
    )
    .all(room);
  return {
    title: "Stage sessions that run",
    items: rows.map((s) => `  ${s.id} ${s.role} ${s.status} ${s.ticket_id ?? s.request_id ?? ""}${s.session ? ` ${s.session}` : ""}`),
    more: "GET /stages?status=running",
    empty: "none",
  };
}

function render(parts: Part[], keep: number[], note: string | null): string {
  const out: string[] = ["State summary"];
  parts.forEach((p, i) => {
    out.push("", `${i + 1}. ${p.title}`);
    if (p.items.length === 0) out.push(`  ${p.empty}`);
    for (const item of p.items.slice(0, keep[i])) out.push(item.startsWith("  ") || item.includes("\n") ? item : `  ${item}`);
    const cut = p.items.length - keep[i];
    if (cut > 0) out.push(`  +${cut} more: ${p.more}`);
  });
  out.push("", `5. Last note of the Orchestrator`, `  ${note ? note : "none"}`);
  out.push("", "Read more: list_tickets, GET /decisions?room=<room>, GET /stages, GET /handoffs/<id>");
  return out.join("\n");
}

/**
 * The state summary of `room`. `note` is the lead's last note (the checkpoint stores it, capped at 200 words); null when
 * there is none. When the text passes SUMMARY_MAX_CHARS, one item at a time is cut from the end of the longest list
 * (the later part wins a tie) and a "+N more: <command>" line names the cut.
 */
export function buildStateSummary(db: Database, room: string, note: string | null = null): string {
  const parts = [requestsPart(db, room), waitingPart(db, room), escalationsPart(db, room), stagesPart(db, room)];
  const text = note ? clip(note, NOTE_MAX) : null;
  const keep = parts.map((p) => p.items.length);
  let out = render(parts, keep, text);
  while (out.length > SUMMARY_MAX_CHARS) {
    let pick = -1;
    for (let i = 0; i < keep.length; i++) if (keep[i] > 0 && (pick < 0 || keep[i] >= keep[pick])) pick = i;
    if (pick < 0) return out.slice(0, SUMMARY_MAX_CHARS); // lists are empty; only a very long header could remain
    keep[pick]--;
    out = render(parts, keep, text);
  }
  return out;
}
