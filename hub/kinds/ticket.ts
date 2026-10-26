// Ticket kind — Room-scoped work items. queued → claimed → in_progress → in_review → done, plus
// in_review → in_progress (rework) and cancelled. High-blast-radius `done` needs the human's Allow
// on a `ticket:done` permission request that this kind creates and links in one transaction.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type {
  AgentCtx,
  Decision,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
  StateMachineDecl,
  TxHandle,
  VerbDecl,
} from "../core/types";
import { pausedRefusal } from "../core/auth";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { IMAGE_URL_RE, imageUrlToPath } from "../core/attachments";
import { insertEvent } from "../core/events";
import { ts, validName, validRoomLabel } from "../core/ids";
import { validateBlockedBy } from "./ticket-blockers";
import { STAGE_ROLES, type StageRole } from "../core/ledger";
import { createPermissionWithSideEffect, dismissPendingPermission } from "./permission";
import type { StageHooks } from "./stage";

// ---------- Types ----------

export type TicketStatus = "draft" | "queued" | "claimed" | "in_progress" | "in_review" | "done" | "cancelled";
export type BlastRadius = "low" | "high";
export type TicketPriority = "highest" | "high" | "medium" | "low" | "lowest";

// The table keeps an INTEGER rank so `ORDER BY priority DESC` sorts; the API speaks names only.
const PRIORITY_RANK: Record<TicketPriority, number> = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1 };
const PRIORITY_BY_RANK: Record<number, TicketPriority> = { 5: "highest", 4: "high", 3: "medium", 2: "low", 1: "lowest" };
/** A stored rank outside 1–5 (old rows, the old default 0) reads as medium. */
const priorityName = (rank: unknown): TicketPriority => PRIORITY_BY_RANK[Number(rank)] ?? "medium";
/** SQL twin of priorityName(): a stored rank outside 1–5 sorts as medium (3), not raw. Takes the column expression. */
const rankSql = (col: string) => `CASE WHEN ${col} BETWEEN 1 AND 5 THEN ${col} ELSE 3 END`;
const isPriority = (v: unknown): v is TicketPriority =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, v);

const TICKET_TERMINAL: ReadonlySet<TicketStatus> = new Set(["done", "cancelled"]);
const TARGET_STATUSES = new Set<string>(["draft", "queued", "in_progress", "in_review", "done", "cancelled"]);
/** The columns a ticket may be created in. */
const CREATE_STATUSES = new Set<string>(["draft", "queued", "in_progress", "in_review", "done"]);

export type TicketSnapshot = {
  id: string;
  room: string;
  title: string;
  acceptance_criteria: string;
  blast_radius: BlastRadius;
  priority: TicketPriority;
  creator: string;
  assignee: string | null;
  approval_request_id: string | null;
  external_ref: string | null;
  /** Groups the tickets of one request; null when ungrouped. */
  request_id: string | null;
  /** The stage role that picks this ticket's first stage; null when no session is launched for it. */
  role: StageRole | null;
  status: TicketStatus;
  created_at_ms: number;
  updated_at_ms: number;
  /** When a done or cancelled ticket was archived; null while it is not. A flag, not a status. */
  archived_at_ms: number | null;
  version: number;
};

const TICKET_ID_RE = /^t_[0-9a-f]{16}$/;
const TICKET_TITLE_MAX_CHARS = 200;
const TICKET_CRITERIA_MAX_CHARS = 4_000;
const TICKET_REF_MAX_CHARS = 200;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const isStageRole = (v: unknown): v is StageRole => typeof v === "string" && (STAGE_ROLES as readonly string[]).includes(v);
const TICKET_BODY_MAX = 16_384;
const TICKET_NOTE_MAX_BYTES = 4_096;
// A 4 KiB note whose every byte is JSON-escaped (control characters) is 24 KiB: leave room.
const TICKET_NOTE_BODY_MAX = 32_768;
const TICKET_ATTACHMENT_NAME_MAX_CHARS = 200;
const TICKET_LIST_LIMIT = 500;
const BRIEFING_TICKET_LIMIT = 20;
const BRIEFING_CRITERIA_CHARS = 300;
const APPROVAL_TOOL_NAME = "ticket:done";
const APPROVAL_BLOCK_MESSAGE = "high-blast-radius ticket needs the human's approval";
// Claude mints request ids from a-z without 'l'. Ticket approvals use the same letters in UPPER case:
// PERMISSION_ID_RE is case-insensitive so every route accepts them, and SQLite compares ids
// case-sensitively, so a ticket approval id can never equal an id Claude mints.
const PERMISSION_ID_ALPHABET = "ABCDEFGHIJKMNOPQRSTUVWXYZ";

function mintTicketId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "t_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

function mintPermissionId(): string {
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => PERMISSION_ID_ALPHABET[b % PERMISSION_ID_ALPHABET.length]).join("");
}

// ---------- StateMachine declaration ----------

const ticketDecl: StateMachineDecl<TicketSnapshot> = {
  kind: "ticket",
  table: "tickets",
  columns: {
    id: "TEXT",
    room: "TEXT",
    title: "TEXT",
    acceptance_criteria: "TEXT",
    blast_radius: "TEXT",
    priority: "INTEGER",
    creator: "TEXT",
    assignee: "TEXT_NULL",
    approval_request_id: "TEXT_NULL",
    external_ref: "TEXT_NULL",
    request_id: "TEXT_NULL",
    role: "TEXT_NULL",
    status: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    archived_at_ms: "INTEGER_NULL",
  },
  forColumn: "assignee",
  terminalStatuses: TICKET_TERMINAL as ReadonlySet<string>,
  rowToSnapshot: (row) => ({
    id: row.id as string,
    room: row.room as string,
    title: row.title as string,
    acceptance_criteria: row.acceptance_criteria as string,
    blast_radius: row.blast_radius as BlastRadius,
    priority: priorityName(row.priority),
    creator: row.creator as string,
    assignee: row.assignee == null ? null : (row.assignee as string),
    approval_request_id: row.approval_request_id == null ? null : (row.approval_request_id as string),
    external_ref: row.external_ref == null ? null : (row.external_ref as string),
    request_id: row.request_id == null ? null : (row.request_id as string),
    role: isStageRole(row.role) ? row.role : null,
    status: row.status as TicketStatus,
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
    archived_at_ms: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(snap)) {
      if (k === "version") continue;
      out[k] = (snap as Record<string, unknown>)[k];
    }
    if (snap.priority !== undefined) out.priority = PRIORITY_RANK[snap.priority];
    return out;
  },
};

// ---------- Entry projection ----------

/** A ticket's blocker ids and the ones still open (status other than done: the claim gate's rule). */
export function blockerFields(db: Database, ticketId: string): { blocked_by: string[]; open_blockers: string[] } {
  const rows = db
    .query<{ blocker_id: string; status: string | null }, [string]>(
      "SELECT b.blocker_id, t.status FROM ticket_blockers b LEFT JOIN tickets t ON t.id = b.blocker_id WHERE b.ticket_id = ? ORDER BY b.rowid",
    )
    .all(ticketId);
  return { blocked_by: rows.map((r) => r.blocker_id), open_blockers: rows.filter((r) => r.status !== "done").map((r) => r.blocker_id) };
}

export function ticketEntry(
  db: Database,
  rawSnapshot: TicketSnapshot,
  eventKind: "ticket.new" | "ticket.update" | "ticket.assigned" | "ticket.archived" | "ticket.promoted",
  actor: string,
  replay = false,
  lead?: string | null,
  extra?: Record<string, unknown>,
): Entry {
  // The blocker arrays are derived (ticket_blockers), not stored on the ticket: read them for every broadcast.
  const snapshot = { ...rawSnapshot, ...blockerFields(db, rawSnapshot.id) };
  return {
    from: actor,   // who did it; the assignee is in the snapshot
    to: "all",
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    ticket_id: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
    // A new ticket nobody owns goes to the room lead for triage; the bridge wakes that agent.
    // A draft wakes no one, the lead included.
    ...(lead !== undefined && snapshot.assignee === null && snapshot.status !== "draft" ? { lead } : {}),
    ...(extra ?? {}),
  };
}

// ---------- Helpers ----------

/** Whitespace and control characters become one space: user text in the Briefing must stay on its own line. */
const oneLine = (text: string): string => text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();

const isHuman = (actor: string, cap: HubCapabilities): boolean => actor === cap.config.humanName;

/**
 * A note's text after trimming, or why it is refused. "" means no note. A note is the audit trail of how
 * a ticket was implemented and tested: it is capped (UTF-8 bytes) and never replaces a chat message.
 */
function noteText(raw: unknown): { text: string } | { error: string } {
  if (raw === undefined || raw === null) return { text: "" };
  if (typeof raw !== "string") return { error: "note must be a string" };
  const text = raw.trim();
  if (new TextEncoder().encode(text).length > TICKET_NOTE_MAX_BYTES) {
    return { error: `note too long (max ${TICKET_NOTE_MAX_BYTES} bytes)` };
  }
  return { text };
}

const noteCount = (cap: HubCapabilities, id: string): number =>
  cap.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?").get(id)!.n;

/** The room's lead: a stored name that is still a registered agent of that room, else null. */
function roomLead(cap: HubCapabilities, room: string): string | null {
  const row = cap.db.query<{ agent: string }, [string]>("SELECT agent FROM ticket_room_lead WHERE room = ?").get(room);
  if (!row) return null;
  const a = cap.agents.get(row.agent);
  return a && !a.permanent && a.room === room ? row.agent : null;
}

/** The human is in every Room; an agent only in its own. */
function inRoom(actor: string, room: string, cap: HubCapabilities): boolean {
  return isHuman(actor, cap) || cap.agents.get(actor)?.room === room;
}

/** Why `name` cannot be the assignee of a ticket in `room`, or null. The human is not a valid assignee. */
function assigneeProblem(name: string, room: string, cap: HubCapabilities): { httpStatus: number; message: string } | null {
  if (isHuman(name, cap)) return { httpStatus: 400, message: "the human is not a valid assignee" };
  const a = cap.agents.get(name);
  if (!a || a.permanent) return { httpStatus: 400, message: `unknown assignee: ${name}` };
  if (a.room !== room) return { httpStatus: 403, message: "assignee is in another room" };
  return null;
}

const forbidden = (message: string): Decision<TicketSnapshot> => ({ kind: "conflict", httpStatus: 403, message });
const conflict = (message: string): Decision<TicketSnapshot> => ({ kind: "conflict", httpStatus: 409, message });

// ---------- Verbs ----------

/** Replaces a ticket's blocker rows with the list decide() validated (null, undefined or [] clear them). */
function writeBlockers(tx: TxHandle, ticketId: string, value: unknown): void {
  tx.run("DELETE FROM ticket_blockers WHERE ticket_id = ?", [ticketId]);
  if (!Array.isArray(value)) return;
  for (const blocker of value) tx.run("INSERT INTO ticket_blockers (ticket_id, blocker_id) VALUES (?, ?)", [ticketId, blocker]);
}

type CreateInput = {
  id: string;
  room: string;
  title: string;
  acceptance_criteria: string;
  blast_radius: BlastRadius;
  priority: TicketPriority;
  external_ref: string | null;
  request_id: string | null;
  role: StageRole | null;
  /** Raw `blocked_by` from the body: undefined = none, null or [] = none, validated in decide(). */
  blocked_by?: unknown;
  assignee: string | null;
  status: "draft" | "queued" | "in_progress" | "in_review" | "done";
};

const createTicketVerb: VerbDecl<TicketSnapshot, CreateInput> = {
  decide(prior, payload, actor, cap): Decision<TicketSnapshot> {
    if (prior) return conflict("ticket id collision");
    // A ticket created as done skips the whole workflow, so only the human may do it.
    if (payload.status === "done" && !isHuman(actor, cap)) return forbidden("only the human may create a done ticket");
    const blockers = validateBlockedBy(cap.db, payload.room, null, payload.blocked_by);
    if (blockers.error !== undefined) return { kind: "conflict", httpStatus: 400, message: blockers.error };
    const now = Date.now();
    const initial: TicketSnapshot = {
      id: payload.id,
      room: payload.room,
      title: payload.title,
      acceptance_criteria: payload.acceptance_criteria,
      blast_radius: payload.blast_radius,
      priority: payload.priority,
      creator: actor,
      assignee: payload.assignee,
      approval_request_id: null,
      external_ref: payload.external_ref,
      request_id: payload.request_id,
      role: payload.role,
      status: payload.status,
      created_at_ms: now,
      updated_at_ms: now,
      archived_at_ms: null,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "ticket.created",
      payload: (post) => ({
        room: post.room,
        title: post.title,
        blast_radius: post.blast_radius,
        priority: post.priority,
        external_ref: post.external_ref,
        request_id: post.request_id,
        role: post.role,
        assignee: post.assignee,
        status: post.status,
      }),
      entry: (post) => ticketEntry(cap.db, post, "ticket.new", actor, false, roomLead(cap, post.room)),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

const claimTicketVerb: VerbDecl<TicketSnapshot, Record<string, never>> = {
  decide(prior, _payload, actor, cap): Decision<TicketSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (!inRoom(actor, prior.room, cap)) return forbidden("claim outside the ticket's room");
    if (prior.status === "claimed" && prior.assignee === actor) return { kind: "idempotent" };
    if (prior.status === "draft") return conflict("ticket is draft: it cannot be claimed");
    if (prior.status !== "queued") {
      const who = prior.assignee ? ` by ${prior.assignee}` : "";
      return conflict(`ticket already ${prior.status}${who}`);
    }
    // Assigned while queued: only the assignee claims it (the human reassigns with the assign verb).
    if (prior.assignee !== null && prior.assignee !== actor) return conflict(`assigned to ${prior.assignee}`);
    // A blocker that is not done keeps the ticket unclaimable. A cancelled blocker still blocks (the human or the
    // lead removes it from the list). The human is not gated. Read here, outside the write transaction: the hub is
    // the single writer (design decision 3).
    if (!isHuman(actor, cap)) {
      const open = cap.db
        .query<{ id: string; status: string }, [string]>(
          "SELECT t.id, t.status FROM ticket_blockers b JOIN tickets t ON t.id = b.blocker_id WHERE b.ticket_id = ? AND t.status != 'done' ORDER BY b.rowid LIMIT 1",
        )
        .get(prior.id);
      if (open) return conflict(`blocked by ${open.id} (${open.status})`);
    }
    return {
      kind: "transition",
      next: { status: "claimed", assignee: actor, updated_at_ms: Date.now() } as Partial<TicketSnapshot>,
      eventKind: "ticket.claimed",
      payload: () => ({ assignee: actor }),
      entry: (post) => ticketEntry(cap.db, post, "ticket.update", actor),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type AssignInput = { assignee: string | null }; // null unassigns, and only while the ticket is draft or queued

const assignTicketVerb: VerbDecl<TicketSnapshot, AssignInput> = {
  decide(prior, payload, actor, cap): Decision<TicketSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (!inRoom(actor, prior.room, cap)) return forbidden("ticket is in another room");
    if (!isHuman(actor, cap) && actor !== prior.creator && actor !== roomLead(cap, prior.room)) {
      return forbidden("only the human, the creator or the room lead may assign");
    }
    if (TICKET_TERMINAL.has(prior.status)) return conflict(`ticket already ${prior.status}`);
    if (payload.assignee === null) {
      if (prior.status !== "queued" && prior.status !== "draft") return conflict(`cannot unassign a ${prior.status} ticket`);
    } else {
      const problem = assigneeProblem(payload.assignee, prior.room, cap);
      if (problem) return { kind: "conflict", httpStatus: problem.httpStatus, message: problem.message };
    }
    if (prior.assignee === payload.assignee) return { kind: "idempotent" };
    const next: Partial<TicketSnapshot> = { assignee: payload.assignee, updated_at_ms: Date.now() };
    // An approval was asked by the previous assignee: it does not carry over to the new one.
    if (prior.approval_request_id) next.approval_request_id = null;
    return {
      kind: "transition",
      next,
      eventKind: "ticket.assigned",
      payload: () => ({ from: prior.assignee, to: payload.assignee }),
      // An unassigned ticket is back in triage, like a new one: the entry names the lead (the bridge wakes it).
      entry: (post) => ticketEntry(cap.db, post, "ticket.assigned", actor, false, roomLead(cap, post.room)),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

// ---------- Ownership by the hub (stage-sessions 2.5) ----------

/** The actor the hub uses for its own writes. validName() refuses it (reserved), so no HTTP route can claim it. */
export const SYSTEM_ACTOR = "system";

export type SystemAssign = { snapshot: TicketSnapshot; entry: Entry } | null;

/**
 * Sets a ticket's assignee to a session name with actor `system`: one `ticket.assigned` event and one row update.
 * It does NOT open a transaction: the stage launch calls it inside its own (`stage.launching` + `ticket.assigned` are the
 * one transaction that writes two kinds), so both commit or roll back together. A ticket that does not exist, or one that
 * is finished, throws and rolls the launch back. An unchanged assignee writes nothing (returns null).
 * The returned entry must be emitted by the caller after the commit. It is context for everyone: the bridge never wakes
 * on an entry from `system` (the new session's first message already carries the ticket).
 */
export function assignBySystemInTx(db: Database, ticketId: string, assignee: string): SystemAssign {
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!row) throw new Error(`launch: no such ticket ${ticketId}`);
  const prior = ticketDecl.rowToSnapshot(row);
  if (TICKET_TERMINAL.has(prior.status)) throw new Error(`launch: ticket ${ticketId} is already ${prior.status}`);
  if (prior.assignee === assignee) return null;
  const now = Date.now();
  const seq = insertEvent(db, ticketId, "ticket.assigned", SYSTEM_ACTOR, { from: prior.assignee, to: assignee }, now);
  // An approval was asked by the previous assignee: it does not carry over (same rule as the assign verb).
  db.run(
    "UPDATE tickets SET assignee = ?, updated_at_ms = ?, version = ?, approval_request_id = NULL WHERE id = ?",
    [assignee, now, seq, ticketId],
  );
  const snapshot: TicketSnapshot = { ...prior, assignee, updated_at_ms: now, approval_request_id: null, version: seq };
  return { snapshot, entry: ticketEntry(db, snapshot, "ticket.assigned", SYSTEM_ACTOR, false, null) };
}

export type SystemQueue = { snapshot: TicketSnapshot; entry: Entry } | null;

/**
 * Moves a `draft` ticket to `queued` with actor `system`: one `ticket.queued` event and one row update, like the verb
 * does for the human or the room lead. It does NOT open a transaction: the spec-review PASS calls it inside its own
 * (`stage.passed` + one `ticket.queued` per scope ticket commit together). A ticket that is not `draft` is left alone
 * (returns null), and so is one whose request is not `requestId` (when given); a ticket that does not exist throws and rolls the PASS back. The caller emits the entry after the commit.
 */
export function queueBySystemInTx(db: Database, cap: HubCapabilities, ticketId: string, requestId?: string | null): SystemQueue {
  return queueDraftInTx(db, cap, ticketId, SYSTEM_ACTOR, requestId);
}

/** The body of queueBySystemInTx for any actor (the human's request approval uses it with the human name). Same rules. */
export function queueDraftInTx(db: Database, cap: HubCapabilities, ticketId: string, actor: string, requestId?: string | null): SystemQueue {
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!row) throw new Error(`queue: no such ticket ${ticketId}`);
  const prior = ticketDecl.rowToSnapshot(row);
  if (prior.status !== "draft") return null;
  // A ticket that left the request after the scope was set was not reviewed with it: leave it alone.
  if (requestId !== undefined && prior.request_id !== requestId) return null;
  const now = Date.now();
  const seq = insertEvent(db, ticketId, "ticket.queued", actor, { from: "draft", to: "queued" }, now);
  db.run("UPDATE tickets SET status = 'queued', updated_at_ms = ?, version = ? WHERE id = ?", [now, seq, ticketId]);
  const snapshot: TicketSnapshot = { ...prior, status: "queued", updated_at_ms: now, version: seq };
  // The same entry kind as the human's promotion: the bridge wakes the assignee, or the room lead for an unassigned ticket.
  return { snapshot, entry: ticketEntry(db, snapshot, "ticket.promoted", actor, false, roomLead(cap, snapshot.room), { by: actor }) };
}

export type SystemClose = { snapshot: TicketSnapshot; entry: Entry } | null;

/**
 * The hub's move after the final PASS of a validator or reviewer stage, with actor `system`. Only an `in_review` ticket moves.
 * Low radius: `ticket.done`. High radius: `ticket.assigned` to the room lead (the hub never writes `done` on a high ticket);
 * no lead means no change. Like assignBySystemInTx it opens no transaction: it runs inside the transaction of `stage.passed`.
 * The caller emits the entry after the commit.
 */
export function closeReviewedBySystemInTx(db: Database, cap: HubCapabilities, ticketId: string): SystemClose {
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!row) throw new Error(`final pass: no such ticket ${ticketId}`);
  const prior = ticketDecl.rowToSnapshot(row);
  if (prior.status !== "in_review") return null;
  const now = Date.now();
  if (prior.blast_radius === "low") {
    const seq = insertEvent(db, ticketId, "ticket.done", SYSTEM_ACTOR, { from: "in_review", to: "done" }, now);
    db.run("UPDATE tickets SET status = 'done', updated_at_ms = ?, version = ? WHERE id = ?", [now, seq, ticketId]);
    const snapshot: TicketSnapshot = { ...prior, status: "done", updated_at_ms: now, version: seq };
    return { snapshot, entry: ticketEntry(db, snapshot, "ticket.update", SYSTEM_ACTOR) };
  }
  const lead = roomLead(cap, prior.room);
  if (!lead) {
    console.error(`[ticket] ${ticketId} is high radius and room ${prior.room} has no lead: it stays with ${prior.assignee} after the final PASS`);
    return null;
  }
  if (prior.assignee === lead) return null;
  const seq = insertEvent(db, ticketId, "ticket.assigned", SYSTEM_ACTOR, { from: prior.assignee, to: lead }, now);
  db.run("UPDATE tickets SET assignee = ?, updated_at_ms = ?, version = ?, approval_request_id = NULL WHERE id = ?", [lead, now, seq, ticketId]);
  const snapshot: TicketSnapshot = { ...prior, assignee: lead, updated_at_ms: now, approval_request_id: null, version: seq };
  return { snapshot, entry: ticketEntry(db, snapshot, "ticket.assigned", SYSTEM_ACTOR, false, null) };
}

type EditInput = { title?: string; acceptance_criteria?: string; blast_radius?: BlastRadius; blocked_by?: unknown; request_id?: string | null; role?: StageRole | null; priority?: TicketPriority; external_ref?: string | null };

// An open ticket's title and acceptance criteria: the human, the creator and the assignee. The blast radius is the
// human's alone, because it gates the done approval. New criteria or a lower radius void the approval that was asked.
const editTicketVerb: VerbDecl<TicketSnapshot, EditInput> = {
  decide(prior, payload, actor, cap): Decision<TicketSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (!inRoom(actor, prior.room, cap)) return forbidden("ticket is in another room");
    const human = isHuman(actor, cap);
    if (payload.blast_radius !== undefined && !human) return forbidden("only the human may change blast_radius");
    // The grouping fields (request_id, blocked_by, role) are edited by the human, the creator or the room lead, not the assignee.
    // The other fields keep their rule: the human, the creator or the assignee.
    const grouping = payload.request_id !== undefined || payload.blocked_by !== undefined || payload.role !== undefined;
    const other = payload.title !== undefined || payload.acceptance_criteria !== undefined || payload.blast_radius !== undefined
      || payload.priority !== undefined || payload.external_ref !== undefined;
    if (other && !human && actor !== prior.creator && actor !== prior.assignee) {
      return forbidden("only the human, the creator or the assignee may edit a ticket");
    }
    if (grouping && !human && actor !== prior.creator && actor !== roomLead(cap, prior.room)) {
      return forbidden("only the human, the creator or the room lead may edit request_id, blocked_by or role");
    }
    if (TICKET_TERMINAL.has(prior.status)) return conflict(`ticket already ${prior.status}`);
    // After the claim the grouping is frozen for agents: the human alone changes it.
    if (grouping && !human && prior.status !== "draft" && prior.status !== "queued") {
      return conflict(`request_id, blocked_by and role are frozen once a ticket is ${prior.status}`);
    }
    const changes: Partial<TicketSnapshot> = {};
    if (payload.title !== undefined && payload.title !== prior.title) changes.title = payload.title;
    if (payload.acceptance_criteria !== undefined && payload.acceptance_criteria !== prior.acceptance_criteria) {
      changes.acceptance_criteria = payload.acceptance_criteria;
    }
    if (payload.blast_radius !== undefined && payload.blast_radius !== prior.blast_radius) changes.blast_radius = payload.blast_radius;
    if (payload.priority !== undefined && payload.priority !== prior.priority) changes.priority = payload.priority;
    if (payload.external_ref !== undefined && payload.external_ref !== prior.external_ref) changes.external_ref = payload.external_ref;
    if (payload.request_id !== undefined && payload.request_id !== prior.request_id) changes.request_id = payload.request_id;
    if (payload.role !== undefined && payload.role !== prior.role) changes.role = payload.role;
    // The blocker list is replaced whole. It is not a snapshot field: it changes only when the set differs.
    let blockersChanged = false;
    if (payload.blocked_by !== undefined) {
      const v = validateBlockedBy(cap.db, prior.room, prior.id, payload.blocked_by);
      if (v.error !== undefined) return { kind: "conflict", httpStatus: 400, message: v.error };
      const stored = cap.db.query<{ blocker_id: string }, [string]>("SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ?").all(prior.id).map((r) => r.blocker_id);
      blockersChanged = stored.length !== v.ids!.length || v.ids!.some((id) => !stored.includes(id));
    }
    if (Object.keys(changes).length === 0 && !blockersChanged) return { kind: "idempotent" };
    const next: Partial<TicketSnapshot> = { ...changes, updated_at_ms: Date.now() };
    // Spec review passed a queued ticket as written: new criteria, role or blockers send it back to draft, in this same
    // transaction. A claimed, in_progress or in_review ticket keeps its status.
    const backToDraft = prior.status === "queued"
      && (changes.acceptance_criteria !== undefined || changes.role !== undefined || blockersChanged);
    if (backToDraft) next.status = "draft";
    // The human allowed the work as it was written: new criteria, or a lower radius, void that approval.
    if ((changes.acceptance_criteria !== undefined || changes.blast_radius === "low") && prior.approval_request_id) {
      next.approval_request_id = null;
    }
    return {
      kind: "transition",
      next,
      eventKind: "ticket.edited",
      payload: () => ({
        fields: [...Object.keys(changes), ...(blockersChanged ? ["blocked_by"] : [])],
        ...(changes.blast_radius ? { blast_radius: { from: prior.blast_radius, to: changes.blast_radius } } : {}),
        ...(backToDraft ? { status: { from: prior.status, to: "draft" } } : {}),
      }),
      entry: (post) => ticketEntry(cap.db, post, "ticket.update", actor),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type ArchiveInput = { archived: boolean };

// Archiving hides a finished ticket from the board's default view and from agents. It is a flag on the
// ticket, not a status: the status stays done or cancelled.
const archiveTicketVerb: VerbDecl<TicketSnapshot, ArchiveInput> = {
  decide(prior, payload, actor, cap): Decision<TicketSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (!inRoom(actor, prior.room, cap)) return forbidden("ticket is in another room");
    if (!isHuman(actor, cap) && actor !== roomLead(cap, prior.room)) {
      return forbidden("only the human or the room lead may archive");
    }
    if (!TICKET_TERMINAL.has(prior.status)) return conflict(`only a done or cancelled ticket can be archived, this one is ${prior.status}`);
    if ((prior.archived_at_ms !== null) === payload.archived) return { kind: "idempotent" };
    const now = Date.now();
    return {
      kind: "transition",
      next: { archived_at_ms: payload.archived ? now : null, updated_at_ms: now } as Partial<TicketSnapshot>,
      eventKind: "ticket.archived",
      payload: () => ({ archived: payload.archived }),
      entry: (post) => ticketEntry(cap.db, post, "ticket.archived", actor),
    };
  },
  // The board hears of it; agents never do (they do not see archived tickets, and this is no chat).
  scope: () => ({ kind: "ui-only-ambient" }),
};

// Legal sources per target; `cancelled` is reachable from any non-terminal status.
const LEGAL_FROM: Record<string, ReadonlySet<string>> = {
  in_progress: new Set(["claimed", "in_review"]),
  in_review: new Set(["in_progress"]),
  done: new Set(["in_review"]),
};

type TransitionInput = { to: TicketStatus; note?: string };

const transitionTicketVerb: VerbDecl<TicketSnapshot, TransitionInput> = {
  decide(prior, payload, actor, cap): Decision<TicketSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    const human = isHuman(actor, cap);
    if (!inRoom(actor, prior.room, cap)) return forbidden("ticket is in another room");
    const to = payload.to;
    const owns = prior.assignee !== null && actor === prior.assignee;
    // Intake moves (draft <-> queued) belong to the human and the room lead. Every other move into draft or queued is the human's.
    const intake = (prior.status === "draft" && to === "queued") || (prior.status === "queued" && to === "draft");
    const lead = actor === roomLead(cap, prior.room);
    // A repeated draft/queued move by the lead is an idempotent retry, not a refusal.
    const retry = lead && prior.status === to && (to === "queued" || to === "draft");
    const allowed = intake || retry ? human || lead : to === "cancelled" ? human || owns || actor === prior.creator : human || owns;
    if (!allowed) return forbidden(intake ? "only the human or the room lead may move a ticket between draft and queued" : to === "cancelled" ? "only the assignee, creator or human may cancel" : "only the assignee or human may move this ticket");
    if (prior.status === to) return { kind: "idempotent" };
    if (TICKET_TERMINAL.has(prior.status)) return conflict(`ticket already ${prior.status}`);
    // The human drags a ticket to any open column (the board's moves); an agent follows LEGAL_FROM.
    // Back to queued or to draft from a later status is the human's alone.
    if ((to === "queued" || to === "draft") && !intake && !human) return forbidden(`only the human may move a ticket back to ${to}`);
    // The lead may not queue a request that holds a high-blast-radius ticket: the human releases it. A ticket without
    // a label is checked alone. The count includes this ticket.
    if (intake && to === "queued" && !human) {
      const high =
        prior.request_id === null
          ? prior.blast_radius === "high"
          : cap.db
              .query<{ n: number }, [string, string]>(
                "SELECT COUNT(*) AS n FROM tickets WHERE room = ? AND request_id = ? AND blast_radius = 'high' AND status NOT IN ('done','cancelled')",
              )
              .get(prior.room, prior.request_id)!.n > 0;
      if (high) return forbidden("the request holds a high blast_radius ticket: only the human may queue it");
    }
    if (to !== "cancelled" && !human && !intake && !LEGAL_FROM[to]?.has(prior.status)) {
      return conflict(`cannot move ${prior.status} → ${to}`);
    }
    if (to === "done" && prior.blast_radius === "high" && !human) {
      const ptr = prior.approval_request_id;
      const perm = ptr
        ? cap.db
            .query<{ status: string; resolved_by: string | null }, [string]>(
              "SELECT status, resolved_by FROM permissions WHERE id = ?",
            )
            .get(ptr)
        : null;
      if (!(perm && perm.status === "allowed" && perm.resolved_by === cap.config.humanName)) {
        return conflict(APPROVAL_BLOCK_MESSAGE);
      }
    }
    // An agent hands a ticket in for review with a note on how it was built and tested (the audit trail).
    // The human may move without one.
    const note = payload.note ?? "";
    if (to === "in_review" && !human && !note) {
      return { kind: "conflict", httpStatus: 400, message: "a note is required to move a ticket to in_review: say how it was implemented and how it was tested" };
    }
    const next: Partial<TicketSnapshot> = { status: to, updated_at_ms: Date.now() };
    // Rework voids the approval: the human approved the work as it was. A move back to queued does too.
    if (prior.status === "in_review" && (to === "in_progress" || to === "queued")) next.approval_request_id = null;
    return {
      kind: "transition",
      next,
      eventKind: `ticket.${to}`,
      payload: () => ({ from: prior.status, to, ...(note ? { note } : {}) }),
      // The entry reaches the room's agents: it says THAT a note exists, not what it says.
      // A draft queued is a promotion: its own entry kind, so the bridge wakes the assignee or the lead once. `by`
      // lets the core skip the lead when the lead made the move.
      entry: (post) =>
        prior.status === "draft" && to === "queued"
          ? ticketEntry(cap.db, post, "ticket.promoted", actor, false, roomLead(cap, post.room), { by: actor })
          : ticketEntry(cap.db, post, "ticket.update", actor, false, undefined, note ? { notes_count: noteCount(cap, post.id) } : undefined),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

// ---------- Factory ----------

/** A body that is not a JSON object (`null`, array, number) reads as `{}`, so the field checks answer 400. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

// Only the approval-gate 409 carries `approval_request_id`; clients use the key to tell it from an ordinary state conflict.
function conflictResponse(e: LedgerConflict): Response {
  const snap = e.snapshot as TicketSnapshot | null;
  const body: Record<string, unknown> = { error: e.message };
  if (snap) body.snapshot = snap;
  if (snap && e.message === APPROVAL_BLOCK_MESSAGE) body.approval_request_id = snap.approval_request_id;
  return Response.json(body, { status: e.httpStatus });
}

export function createTicketKind(db: Database, stage?: Pick<StageHooks, "onTicketChanged">): KindModule {
  const entity = createLedgerEntity({ decl: ticketDecl, db });

  // A paused agent's writes are refused (423) unless the route is one a running tool call may need
  // (the ticket:done approval request).
  function actorOr400(by: unknown, cap: HubCapabilities, allowPaused = false): { name: string } | Response {
    const name = typeof by === "string" ? by.trim() : "";
    if (!validName(name)) return Response.json({ error: "invalid by" }, { status: 400 });
    if (!cap.agents.get(name)) return Response.json({ error: `unknown actor: ${name}` }, { status: 400 });
    if (!allowPaused && cap.agents.isPaused(name)) return pausedRefusal();
    return { name };
  }

  // Rework, cancel, a direct done and a reassignment leave the ticket's `ticket:done` request moot.
  // It would sit pending (and replay on every reconnect), so dismiss it: its own transaction, after
  // the ticket's (one event per transaction). A failure leaves a stale card, not a failed move.
  function retireStaleApproval(before: TicketSnapshot | null, after: TicketSnapshot, actor: string, cap: HubCapabilities): void {
    const stale = before?.approval_request_id;
    if (!stale || (after.status === "in_review" && after.approval_request_id === stale)) return;
    try {
      dismissPendingPermission(db, cap, stale, actor);
    } catch (e) {
      console.error(`[ticket] could not dismiss stale approval request ${stale}:`, e);
    }
  }

  const routes: RouteDef[] = [
    {
      method: "POST",
      path: "/tickets",
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap) => {
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        const by = a.name;

        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || title.length > TICKET_TITLE_MAX_CHARS) {
          return Response.json({ error: "invalid title" }, { status: 400 });
        }
        const criteria = typeof body.acceptance_criteria === "string" ? body.acceptance_criteria.trim() : "";
        if (!criteria || criteria.length > TICKET_CRITERIA_MAX_CHARS) {
          return Response.json({ error: "acceptance_criteria required" }, { status: 400 });
        }
        if (body.blast_radius !== "low" && body.blast_radius !== "high") {
          return Response.json({ error: "invalid blast_radius" }, { status: 400 });
        }
        const priority = body.priority === undefined || body.priority === null ? "medium" : body.priority;
        if (!isPriority(priority)) return Response.json({ error: "invalid priority" }, { status: 400 });
        let externalRef: string | null = null;
        if (body.external_ref !== undefined && body.external_ref !== null) {
          if (typeof body.external_ref !== "string" || body.external_ref.length > TICKET_REF_MAX_CHARS) {
            return Response.json({ error: "invalid external_ref" }, { status: 400 });
          }
          externalRef = body.external_ref;
        }
        let requestId: string | null = null;
        if (body.request_id !== undefined && body.request_id !== null) {
          if (typeof body.request_id !== "string" || !REQUEST_ID_RE.test(body.request_id)) {
            return Response.json({ error: "invalid request_id" }, { status: 400 });
          }
          requestId = body.request_id;
        }
        let role: StageRole | null = null;
        if (body.role !== undefined && body.role !== null) {
          if (!isStageRole(body.role)) return Response.json({ error: "invalid role" }, { status: 400 });
          role = body.role;
        }

        let room: string;
        if (isHuman(by, cap)) {
          const asked = typeof body.room === "string" ? body.room.trim() : "";
          if (!validRoomLabel(asked)) return Response.json({ error: "room required" }, { status: 400 });
          room = asked;
        } else {
          const own = cap.agents.get(by)?.room ?? null;
          if (own === null) return Response.json({ error: "actor has no room" }, { status: 400 });
          if (body.room !== undefined && body.room !== null && body.room !== own) {
            return Response.json({ error: "cross-room ticket not permitted" }, { status: 403 });
          }
          room = own;
        }

        let status: CreateInput["status"] = "queued";
        if (body.status !== undefined && body.status !== null) {
          if (typeof body.status !== "string" || !CREATE_STATUSES.has(body.status)) {
            return Response.json({ error: "invalid status" }, { status: 400 });
          }
          status = body.status as CreateInput["status"];
        }
        let assignee: string | null = null;
        if (body.assignee !== undefined && body.assignee !== null && body.assignee !== "") {
          if (typeof body.assignee !== "string") return Response.json({ error: "invalid assignee" }, { status: 400 });
          const problem = assigneeProblem(body.assignee, room, cap);
          if (problem) return Response.json({ error: problem.message }, { status: problem.httpStatus });
          assignee = body.assignee;
        }

        const id = mintTicketId();
        try {
          const r = entity.applyWithSideEffect(
            id,
            createTicketVerb,
            {
              id,
              room,
              title,
              acceptance_criteria: criteria,
              blast_radius: body.blast_radius,
              priority,
              external_ref: externalRef,
              request_id: requestId,
              role,
              blocked_by: body.blocked_by,
              assignee,
              status,
            },
            by,
            cap,
            ({ tx }) => writeBlockers(tx, id, body.blocked_by),
          );
          // An assignee's lines change, and so does the lead's list of unassigned tickets.
          if (assignee || roomLead(cap, room)) cap.briefing.refresh();
          // A ticket created as queued may be ready for a stage at once (a draft waits for its move to queued).
          if (r.snapshot.status === "queued") stage?.onTicketChanged(id, cap);
          return Response.json({ snapshot: r.snapshot }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/claim$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        try {
          const r = entity.apply(params.id, claimTicketVerb, {}, a.name, cap);
          if (r.emitted) cap.briefing.refresh();
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "GET",
      path: /^\/rooms\/([^/]+)\/lead$/,
      auth: "read",
      handler: (_req, cap, params) => {
        const room = decodeURIComponent(params.id);
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        return Response.json({ room, lead: roomLead(cap, room) });
      },
    },

    {
      method: "POST",
      path: /^\/rooms\/([^/]+)\/lead$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        const room = decodeURIComponent(params.id);
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap, true);
        if (a instanceof Response) return a;
        if (!isHuman(a.name, cap)) return Response.json({ error: "only the human may set the room lead" }, { status: 403 });
        // A name sets the lead, an explicit null clears it.
        const agent = body.agent;
        if (agent !== null && (typeof agent !== "string" || !agent.trim())) {
          return Response.json({ error: "agent required (a name, or null to clear)" }, { status: 400 });
        }
        if (agent !== null) {
          const problem = assigneeProblem(agent.trim(), room, cap);
          if (problem) return Response.json({ error: problem.message }, { status: problem.httpStatus });
        }
        const before = roomLead(cap, room);
        const next = agent === null ? null : agent.trim();
        if (before !== next) {
          // Same shape as every state change: the row and one event in one transaction.
          db.transaction(() => {
            if (next === null) db.run("DELETE FROM ticket_room_lead WHERE room = ?", [room]);
            else
              db.run(
                "INSERT INTO ticket_room_lead (room, agent, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(room) DO UPDATE SET agent = excluded.agent, updated_at_ms = excluded.updated_at_ms",
                [room, next, Date.now()],
              );
            insertEvent(db, `room:${room}`, "ticket.lead", a.name, { from: before, to: next }, Date.now());
          })();
          // The new lead gets the triage list, the old one loses it.
          cap.briefing.refresh();
          // The board shows the lead. Ambient and UI-only: not a ticket.* kind, so no agent receives it.
          cap.sse.emit(
            { kind: "room.lead", room, lead: next, from: "system", to: "all", text: `[room lead: ${next ?? "none"}]`, ts: ts(), image: null },
            { kind: "ui-only-ambient" },
          );
        }
        return Response.json({ room, lead: next, ...(before === next ? { idempotent: true } : {}) });
      },
    },

    {
      // Human approval of a request (spec-review-stage 3.3): queues every draft ticket of the request in the room.
      method: "POST",
      path: /^\/requests\/([^/]+)\/([^/]+)\/approve$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        // The dispatcher passes only the first capture group (the room); the request id comes from the path.
        const room = decodeURIComponent(params.id);
        const requestId = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        if (!REQUEST_ID_RE.test(requestId)) return Response.json({ error: "invalid request id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap, true);
        if (a instanceof Response) return a;
        if (!isHuman(a.name, cap)) return Response.json({ error: "only the human may approve a request" }, { status: 403 });
        const known = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM tickets WHERE request_id = ? AND room = ?").get(requestId, room)!.n;
        if (known === 0) return Response.json({ error: `no ticket in request ${requestId} in room ${room}` }, { status: 404 });
        const queuedNow: Array<NonNullable<SystemQueue>> = [];
        // One transaction: every draft ticket of the request gets its ticket.queued event and its row update, or none does.
        db.transaction(() => {
          const drafts = db
            .query<{ id: string }, [string, string]>("SELECT id FROM tickets WHERE request_id = ? AND room = ? AND status = 'draft' ORDER BY created_at_ms, id")
            .all(requestId, room);
          for (const { id } of drafts) {
            const q = queueDraftInTx(db, cap, id, a.name, requestId);
            if (q) queuedNow.push(q);
          }
        })();
        for (const q of queuedNow) cap.sse.emit(q.entry, { kind: "room", room });
        if (queuedNow.length) cap.briefing.refresh();
        // The evaluator runs after the commit, as for a draft the human queues by hand.
        for (const q of queuedNow) stage?.onTicketChanged(q.snapshot.id, cap);
        return Response.json({ room, request_id: requestId, queued: queuedNow.map((q) => q.snapshot.id), ...(queuedNow.length === 0 ? { idempotent: true } : {}) });
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/attachments$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        // The file must already be uploaded through /upload, which enforces the extension allowlist and the size
        // cap and stores it under /image/<id>.<ext>. Linking only refers to it: the URL shape, the extension
        // (the allowlist may have changed since the upload) and the file's presence are all checked.
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (!IMAGE_URL_RE.test(url)) return Response.json({ error: "url must be an uploaded file: /image/<id>.<ext>" }, { status: 400 });
        const ext = url.slice(url.lastIndexOf(".") + 1).toLowerCase();
        if (!cap.config.allowedExtensions.has(ext)) {
          return Response.json({ error: `file type .${ext} is not allowed` }, { status: 400 });
        }
        if (!existsSync(imageUrlToPath(url, cap.config.attachmentsDir))) {
          return Response.json({ error: "no such uploaded file" }, { status: 400 });
        }
        const name = typeof body.name === "string" ? oneLine(body.name) : "";
        if (!name || name.length > TICKET_ATTACHMENT_NAME_MAX_CHARS) return Response.json({ error: "invalid name" }, { status: 400 });
        const t = entity.load(params.id);
        if (!t) return Response.json({ error: "not found" }, { status: 404 });
        if (!inRoom(a.name, t.room, cap)) return Response.json({ error: "ticket is in another room" }, { status: 403 });
        if (!isHuman(a.name, cap) && a.name !== t.creator && a.name !== t.assignee) {
          return Response.json({ error: "only the human, the creator or the assignee may attach a file" }, { status: 403 });
        }
        const count = () => cap.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?").get(t.id)!.n;
        const existing = cap.db
          .query<{ id: number; author: string; name: string; url: string; created_at_ms: number }, [string, string]>(
            "SELECT id, author, name, url, created_at_ms FROM ticket_attachments WHERE ticket_id = ? AND url = ?",
          )
          .get(t.id, url);
        if (existing) return Response.json({ attachment: existing, attachments_count: count(), idempotent: true });
        // Append-only, like every state change: one event and the row in one transaction. The ticket itself
        // does not change, so its version stays.
        const at = Date.now();
        let seq = 0;
        db.transaction(() => {
          seq = insertEvent(db, t.id, "ticket.attached", a.name, { url, name }, at);
          db.run("INSERT INTO ticket_attachments (id, ticket_id, author, name, url, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)", [seq, t.id, a.name, name, url, at]);
        })();
        const attachment = { id: seq, author: a.name, name, url, created_at_ms: at };
        const total = count();
        // The board shows it live. Agents get no event: a file is no chat; they see the count in the list.
        cap.sse.emit(
          { kind: "ticket.attached", ticket_id: t.id, room: t.room, version: seq, attachments_count: total, attachment, from: a.name, to: "all", text: `[attachment on ${t.id}]`, ts: ts(), image: null },
          { kind: "ui-only-ambient" },
        );
        return Response.json({ attachment, attachments_count: total }, { status: 201 });
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/attachments\/(\d+)\/remove$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        const t = entity.load(params.id);
        if (!t) return Response.json({ error: "not found" }, { status: 404 });
        if (!inRoom(a.name, t.room, cap)) return Response.json({ error: "ticket is in another room" }, { status: 403 });
        // The dispatcher passes only the first capture group (the ticket id), so the attachment id comes from the path.
        const attId = Number(new URL(req.url).pathname.split("/")[4]);
        const row = cap.db
          .query<{ author: string }, [number, string]>("SELECT author FROM ticket_attachments WHERE id = ? AND ticket_id = ?")
          .get(attId, t.id);
        const count = () => cap.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?").get(t.id)!.n;
        const human = isHuman(a.name, cap);
        // The role check runs first, as in edit. An unknown id is 404 unless a ticket.detached event names it: that is a retry.
        // A removed row is gone: its author is the actor of the ticket.attached event (the row id is that event's seq).
        const author = row?.author ?? cap.db
          .query<{ actor: string }, [number, string]>("SELECT actor FROM events WHERE seq = ? AND entity_id = ? AND kind = 'ticket.attached'")
          .get(attId, t.id)?.actor ?? null;
        if (!human && a.name !== t.creator && a.name !== author) {
          return Response.json({ error: "only the human, the creator or the attachment's author may remove a file" }, { status: 403 });
        }
        if (!row) {
          const gone = cap.db
            .query<{ n: number }, [string, number]>(
              "SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND kind = 'ticket.detached' AND json_extract(payload_json, '$.attachment_id') = ?",
            )
            .get(t.id, attId)!.n;
          if (gone > 0) return Response.json({ attachments_count: count(), idempotent: true });
          return Response.json({ error: "no such attachment" }, { status: 404 });
        }
        if (TICKET_TERMINAL.has(t.status)) return Response.json({ error: `ticket already ${t.status}` }, { status: 409 });
        if (!human && t.status !== "draft" && t.status !== "queued") {
          return Response.json({ error: `a file can be removed only while the ticket is draft or queued, this one is ${t.status}` }, { status: 409 });
        }
        const at = Date.now();
        let seq = 0;
        db.transaction(() => {
          seq = insertEvent(db, t.id, "ticket.detached", a.name, { attachment_id: attId }, at);
          db.run("DELETE FROM ticket_attachments WHERE id = ? AND ticket_id = ?", [attId, t.id]);
        })();
        const total = count();
        cap.sse.emit(
          { kind: "ticket.detached", ticket_id: t.id, room: t.room, version: seq, attachments_count: total, attachment_id: attId, from: a.name, to: "all", text: `[attachment removed from ${t.id}]`, ts: ts(), image: null },
          { kind: "ui-only-ambient" },
        );
        return Response.json({ attachments_count: total });
      },
    },

    {
      method: "GET",
      path: /^\/tickets\/([^/]+)\/attachments$/,
      auth: "read",
      handler: (_req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        if (!entity.load(params.id)) return Response.json({ error: "not found" }, { status: 404 });
        const rows = cap.db
          .query<{ id: number; author: string; name: string; url: string; created_at_ms: number }, [string]>(
            "SELECT id, author, name, url, created_at_ms FROM ticket_attachments WHERE ticket_id = ? ORDER BY id ASC",
          )
          .all(params.id);
        // `path` is where an agent reads the file on this machine (the same rewrite chat attachments get).
        return Response.json(rows.map((r) => ({ ...r, path: imageUrlToPath(r.url, cap.config.attachmentsDir) })));
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/notes$/,
      auth: "mutating",
      bodyMax: TICKET_NOTE_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        const note = noteText(body.text);
        if ("error" in note) return Response.json({ error: note.error }, { status: 400 });
        if (!note.text) return Response.json({ error: "text required" }, { status: 400 });
        const t = entity.load(params.id);
        if (!t) return Response.json({ error: "not found" }, { status: 404 });
        if (!inRoom(a.name, t.room, cap)) return Response.json({ error: "ticket is in another room" }, { status: 403 });
        // The assignee or the human, at any time: a finished or archived ticket keeps its trail.
        if (!isHuman(a.name, cap) && a.name !== t.assignee) {
          return Response.json({ error: "only the assignee or the human may add a note" }, { status: 403 });
        }
        // Append-only, and like every state change: one event and the row, in one transaction. The note
        // does not change the ticket, so its version stays.
        const at = Date.now();
        let seq = 0;
        db.transaction(() => {
          seq = insertEvent(db, t.id, "ticket.noted", a.name, { text: note.text }, at);
          db.run("INSERT INTO ticket_notes (id, ticket_id, author, text, created_at_ms) VALUES (?, ?, ?, ?, ?)", [seq, t.id, a.name, note.text, at]);
        })();
        const added = { id: seq, author: a.name, text: note.text, created_at_ms: at };
        const count = noteCount(cap, t.id);
        // The board shows notes live; agents are not told (a note is an audit trail, not chat).
        cap.sse.emit(
          { kind: "ticket.noted", ticket_id: t.id, room: t.room, version: seq, notes_count: count, note: added, from: a.name, to: "all", text: `[note on ${t.id}]`, ts: ts(), image: null },
          { kind: "ui-only-ambient" },
        );
        return Response.json({ note: added, notes_count: count }, { status: 201 });
      },
    },

    {
      method: "GET",
      path: /^\/tickets\/([^/]+)\/notes$/,
      auth: "read",
      handler: (_req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        if (!entity.load(params.id)) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(
          cap.db
            .query<{ id: number; author: string; text: string; created_at_ms: number }, [string]>(
              "SELECT id, author, text, created_at_ms FROM ticket_notes WHERE ticket_id = ? ORDER BY id ASC",
            )
            .all(params.id),
        );
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/archive$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        if (typeof body.archived !== "boolean") return Response.json({ error: "archived must be a boolean" }, { status: 400 });
        try {
          const r = entity.apply(params.id, archiveTicketVerb, { archived: body.archived }, a.name, cap);
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/assign$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        // A name assigns, an explicit null unassigns (queued tickets only); anything else is a mistake.
        if (body.assignee !== null && (typeof body.assignee !== "string" || !body.assignee.trim())) {
          return Response.json({ error: "assignee required (a name, or null to unassign)" }, { status: 400 });
        }
        try {
          const before = entity.load(params.id);
          const r = entity.apply(params.id, assignTicketVerb, { assignee: body.assignee === null ? null : body.assignee.trim() }, a.name, cap);
          if (r.emitted) {
            cap.briefing.refresh();
            retireStaleApproval(before, r.snapshot, a.name, cap);
          }
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/edit$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        const input: EditInput = {};
        if (body.title !== undefined) {
          const title = typeof body.title === "string" ? body.title.trim() : "";
          if (!title || title.length > TICKET_TITLE_MAX_CHARS) return Response.json({ error: "invalid title" }, { status: 400 });
          input.title = title;
        }
        if (body.acceptance_criteria !== undefined) {
          const criteria = typeof body.acceptance_criteria === "string" ? body.acceptance_criteria.trim() : "";
          if (!criteria || criteria.length > TICKET_CRITERIA_MAX_CHARS) {
            return Response.json({ error: "invalid acceptance_criteria" }, { status: 400 });
          }
          input.acceptance_criteria = criteria;
        }
        if (body.blast_radius !== undefined) {
          if (body.blast_radius !== "low" && body.blast_radius !== "high") {
            return Response.json({ error: "invalid blast_radius" }, { status: 400 });
          }
          input.blast_radius = body.blast_radius;
        }
        if (body.priority !== undefined) {
          if (!isPriority(body.priority)) return Response.json({ error: "invalid priority" }, { status: 400 });
          input.priority = body.priority;
        }
        if (body.external_ref !== undefined) {
          if (body.external_ref !== null && (typeof body.external_ref !== "string" || body.external_ref.length > TICKET_REF_MAX_CHARS)) {
            return Response.json({ error: "invalid external_ref" }, { status: 400 });
          }
          input.external_ref = body.external_ref;
        }
        if (body.request_id !== undefined) {
          // A label sets it, an explicit null clears it.
          if (body.request_id !== null && (typeof body.request_id !== "string" || !REQUEST_ID_RE.test(body.request_id))) {
            return Response.json({ error: "invalid request_id" }, { status: 400 });
          }
          input.request_id = body.request_id;
        }
        if (body.role !== undefined) {
          // One of the six roles sets it, an explicit null clears it.
          if (body.role !== null && !isStageRole(body.role)) return Response.json({ error: "invalid role" }, { status: 400 });
          input.role = body.role;
        }
        if (body.blocked_by !== undefined) input.blocked_by = body.blocked_by;
        if (Object.keys(input).length === 0) {
          return Response.json({ error: "nothing to edit (title, acceptance_criteria, blast_radius, priority, external_ref, request_id, role or blocked_by)" }, { status: 400 });
        }
        try {
          const before = entity.load(params.id);
          const r = entity.applyWithSideEffect(params.id, editTicketVerb, input, a.name, cap, ({ tx }) =>
            input.blocked_by === undefined ? undefined : writeBlockers(tx, params.id, input.blocked_by));
          if (r.emitted) {
            cap.briefing.refresh();
            retireStaleApproval(before, r.snapshot, a.name, cap);
          }
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/transition$/,
      auth: "mutating",
      bodyMax: TICKET_NOTE_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap);
        if (a instanceof Response) return a;
        if (typeof body.to !== "string" || !TARGET_STATUSES.has(body.to)) {
          return Response.json({ error: "invalid to" }, { status: 400 });
        }
        const note = noteText(body.note);
        if ("error" in note) return Response.json({ error: note.error }, { status: 400 });
        try {
          const before = entity.load(params.id);
          const input = { to: body.to as TicketStatus, ...(note.text ? { note: note.text } : {}) };
          // The note is written in the move's own transaction, as a row keyed by the move's event seq.
          const r = note.text
            ? entity.applyWithSideEffect(params.id, transitionTicketVerb, input, a.name, cap, ({ tx, seq }) =>
                tx.run("INSERT INTO ticket_notes (id, ticket_id, author, text, created_at_ms) VALUES (?, ?, ?, ?, ?)", [seq, params.id, a.name, note.text, Date.now()]))
            : entity.apply(params.id, transitionTicketVerb, input, a.name, cap);
          if (r.emitted) {
            cap.briefing.refresh();
            retireStaleApproval(before, r.snapshot, a.name, cap);
            if (stage) {
              // Run the stage evaluator after the commit: a draft that became queued, and every ticket that was
              // waiting for this one when it became done. A cancelled ticket does not unblock anything.
              if (before?.status === "draft" && r.snapshot.status === "queued") stage.onTicketChanged(params.id, cap);
              if (r.snapshot.status === "done") {
                const waiting = db
                  .query<{ ticket_id: string }, [string]>("SELECT ticket_id FROM ticket_blockers WHERE blocker_id = ? ORDER BY rowid")
                  .all(params.id);
                for (const w of waiting) stage.onTicketChanged(w.ticket_id, cap);
              }
            }
          }
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) });
        } catch (e) {
          if (e instanceof LedgerConflict) return conflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/tickets\/([^/]+)\/approval$/,
      auth: "mutating",
      bodyMax: TICKET_BODY_MAX,
      handler: async (req, cap, params) => {
        if (!TICKET_ID_RE.test(params.id)) return Response.json({ error: "invalid ticket id" }, { status: 400 });
        const body = await readBody(req);
        const a = actorOr400(body.by, cap, true);
        if (a instanceof Response) return a;

        // ponytail: this check and the write below run with no await between them, so two calls cannot both
        // create a request. That relies on the hub's single JS thread; move the check into the transaction
        // if the hub ever serves requests in parallel.
        const t = entity.load(params.id);
        if (!t) return Response.json({ error: "not found" }, { status: 404 });
        if (!inRoom(a.name, t.room, cap)) {
          return Response.json({ error: "ticket is in another room" }, { status: 403 });
        }
        if (t.assignee === null || a.name !== t.assignee) {
          return Response.json({ error: "only the assignee may request approval" }, { status: 403 });
        }
        if (t.status !== "in_review" || t.blast_radius !== "high") {
          return Response.json(
            { error: "approval applies to a high-blast-radius ticket in in_review", snapshot: t },
            { status: 409 },
          );
        }
        if (t.approval_request_id) {
          const cur = db
            .query<{ status: string; resolved_by: string | null }, [string]>(
              "SELECT status, resolved_by FROM permissions WHERE id = ?",
            )
            .get(t.approval_request_id);
          if (cur?.status === "pending") {
            return Response.json({ request_id: t.approval_request_id, created: false, status: "pending" });
          }
          // The human allowed it between the blocked `done` and this call: keep that Allow. A new
          // request would discard it and ask the human twice. An Allow by an agent does not count.
          if (cur?.status === "allowed" && cur.resolved_by === cap.config.humanName) {
            return Response.json({ request_id: t.approval_request_id, created: false, status: "allowed" });
          }
        }
        let requestId = mintPermissionId();
        while (db.query("SELECT 1 FROM permissions WHERE id = ?").get(requestId)) requestId = mintPermissionId();
        const rid = requestId;
        try {
          createPermissionWithSideEffect(
            db,
            cap,
            {
              agent: a.name,
              request_id: rid,
              tool_name: APPROVAL_TOOL_NAME,
              description: `Approve completion of ticket ${t.id}: ${oneLine(t.title)}`,
              input_preview: JSON.stringify({ ticket_id: t.id }),
              room: t.room,
            },
            ({ tx }) => tx.run("UPDATE tickets SET approval_request_id = ? WHERE id = ?", [rid, t.id]),
          );
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
        return Response.json({ request_id: rid, created: true, status: "pending" });
      },
    },

    {
      method: "GET",
      path: "/tickets",
      auth: "read",
      handler: (req) => {
        const url = new URL(req.url);
        const room = (url.searchParams.get("room") ?? "").trim();
        if (!validRoomLabel(room)) return Response.json({ error: "room required" }, { status: 400 });
        const status = url.searchParams.get("status") ?? "open";
        if (status !== "open" && status !== "all") {
          return Response.json({ error: `invalid status: ${status}` }, { status: 400 });
        }
        // Archived tickets are hidden unless the caller asks (the board's "Show archived").
        const withArchived = url.searchParams.get("archived") === "1";
        // Filtered in SQL, inside the room, before the limit.
        const requestId = url.searchParams.get("request_id");
        if (requestId !== null && !REQUEST_ID_RE.test(requestId)) return Response.json({ error: "invalid request_id" }, { status: 400 });
        const rows = db
          .query<Record<string, unknown>, (string | number)[]>(
            `SELECT t.*, p.status AS p_status, p.resolved_by AS p_resolved_by, p.version AS p_version,
                    (SELECT COUNT(*) FROM ticket_notes n WHERE n.ticket_id = t.id) AS notes_count,
                    (SELECT COUNT(*) FROM ticket_attachments x WHERE x.ticket_id = t.id) AS attachments_count
               FROM tickets t LEFT JOIN permissions p ON p.id = t.approval_request_id
              WHERE t.room = ?${status === "open" ? " AND t.status NOT IN ('done','cancelled')" : ""}${withArchived ? "" : " AND t.archived_at_ms IS NULL"}${requestId === null ? "" : " AND t.request_id = ?"}
              ORDER BY ${rankSql("t.priority")} DESC, t.created_at_ms ASC LIMIT ?`,
          )
          .all(...(requestId === null ? [room] : [room, requestId]), TICKET_LIST_LIMIT);
        return Response.json(
          rows.map((row) => {
            const snap = ticketDecl.rowToSnapshot(row);
            const approval = snap.approval_request_id
              ? {
                  id: snap.approval_request_id,
                  status: (row.p_status as string | null) ?? null,
                  resolved_by: (row.p_resolved_by as string | null) ?? null,
                  version: (row.p_version as number | null) ?? null,
                }
              : null;
            return { ...snap, ...blockerFields(db, snap.id), approval, notes_count: Number(row.notes_count ?? 0), attachments_count: Number(row.attachments_count ?? 0) };
          }),
        );
      },
    },
  ];

  /**
   * The newest stage (any status) this agent is the session of, if any. A passed stage keeps its session on its own ticket until the close. Session names are used again (`tester-1`),
   * so an old ticket may still name the name as its assignee; the stage table says which ticket the session is for now.
   * No stage table (a ledger without the stage kind) or no stage row: null, the agent is an ordinary one.
   */
  function liveStageOf(cap: HubCapabilities, session: string): { ticket_id: string | null; review: string | null } | null {
    try {
      return (
        cap.db
          .query<{ ticket_id: string | null; review: string | null }, [string]>(
            "SELECT ticket_id, review FROM stage WHERE session = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(session) ?? null
      );
    } catch {
      return null;
    }
  }

  function briefingLines(agent: AgentCtx, cap: HubCapabilities): string[] {
    if (agent.room === null) return [];
    // A stage session works on one ticket: its briefing lists only that one (ss 6.5 gap B). A spec-review session has no
    // ticket and gets no list. The assignee of other tickets stays as a record; it is only not shown here.
    const live = liveStageOf(cap, agent.name);
    if (live && !live.ticket_id) return [];
    const rows = live
      ? cap.db
          .query<Record<string, unknown>, [string, string]>(`SELECT * FROM tickets WHERE id = ? AND room = ? AND status NOT IN ('done','cancelled')`)
          .all(live.ticket_id!, agent.room)
      : cap.db
          .query<Record<string, unknown>, [string, string, number]>(
            `SELECT * FROM tickets WHERE assignee = ? AND room = ? AND status NOT IN ('done','cancelled')
              ORDER BY ${rankSql("priority")} DESC, created_at_ms ASC LIMIT ?`,
          )
          .all(agent.name, agent.room, BRIEFING_TICKET_LIMIT);
    const describe = (heading: string, list: Record<string, unknown>[]): string[] => {
      const out = [heading];
      for (const row of list) {
        const t = ticketDecl.rowToSnapshot(row);
        const criteria = oneLine(t.acceptance_criteria).slice(0, BRIEFING_CRITERIA_CHARS);
        const request = t.request_id ? ` request ${t.request_id}` : "";
        out.push(`- ${t.id} [${t.status}] (${t.blast_radius} radius, priority ${t.priority}${request ? "," + request : ""}) ${oneLine(t.title)}`);
        out.push(`  Done when: ${criteria}`);
        const open = cap.db
          .query<{ id: string; status: string }, [string]>(
            "SELECT b.blocker_id AS id, COALESCE(t.status, 'missing') AS status FROM ticket_blockers b LEFT JOIN tickets t ON t.id = b.blocker_id WHERE b.ticket_id = ? AND COALESCE(t.status, '') != 'done' ORDER BY b.rowid",
          )
          .all(t.id);
        if (open.length) out.push(`  Blocked by: ${open.map((b) => `${b.id} (${b.status})`).join(", ")}`);
      }
      return out;
    };
    const lines = rows.length ? describe("Your open tickets:", rows) : [];
    // The room lead also sees the open tickets nobody owns yet: triaging them is its job.
    if (!live && roomLead(cap, agent.room) === agent.name) {
      const unassigned = cap.db
        .query<Record<string, unknown>, [string, number]>(
          `SELECT * FROM tickets WHERE room = ? AND assignee IS NULL AND status NOT IN ('done','cancelled')
            ORDER BY ${rankSql("priority")} DESC, created_at_ms ASC LIMIT ?`,
        )
        .all(agent.room, BRIEFING_TICKET_LIMIT);
      if (unassigned.length) {
        const block = describe("Unassigned tickets to triage:", unassigned);
        block.splice(1, 0, "Triage each with assign_ticket (assignee = an agent of your room; null puts it back).");
        lines.push(...block);
      }
    }
    return lines;
  }

  return {
    kind: "ticket",
    migrate: (d: Database) => {
      entity.migrate(d);
      // A ledger made before archiving has the table without the column: add it.
      if (!d.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some((c) => c.name === "archived_at_ms")) {
        d.exec(`ALTER TABLE "tickets" ADD COLUMN "archived_at_ms" INTEGER`);
      }
      if (!d.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some((c) => c.name === "request_id")) {
        d.exec(`ALTER TABLE "tickets" ADD COLUMN "request_id" TEXT`);
      }
      // stage-sessions: the role that picks a ticket's first stage. Existing tickets keep NULL.
      if (!d.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some((c) => c.name === "role")) {
        d.exec(`ALTER TABLE "tickets" ADD COLUMN "role" TEXT`);
      }
      d.exec(`CREATE INDEX IF NOT EXISTS "idx_tickets_room_status" ON "tickets" ("room", "status")`);
      // Blocker links: a ticket cannot be claimed while a blocker is not done.
      d.exec(`CREATE TABLE IF NOT EXISTS "ticket_blockers" ("ticket_id" TEXT NOT NULL, "blocker_id" TEXT NOT NULL, PRIMARY KEY ("ticket_id", "blocker_id"))`);
      d.exec(`CREATE INDEX IF NOT EXISTS "idx_ticket_blockers_blocker" ON "ticket_blockers" ("blocker_id")`);
      // The room lead (a room setting kept with the tickets): one agent per room, set by the human.
      // Append-only notes: the audit trail of how a ticket was built and tested. The id is the seq of the
      // note's event, so a note and its event always match.
      d.exec(`CREATE TABLE IF NOT EXISTS "ticket_notes" ("id" INTEGER PRIMARY KEY, "ticket_id" TEXT NOT NULL, "author" TEXT NOT NULL, "text" TEXT NOT NULL, "created_at_ms" INTEGER NOT NULL)`);
      d.exec(`CREATE INDEX IF NOT EXISTS "idx_ticket_notes_ticket" ON "ticket_notes" ("ticket_id", "id")`);
      // Append-only links to files uploaded through /upload (the id is the seq of the link's event). A file is
      // linked to a ticket once.
      d.exec(`CREATE TABLE IF NOT EXISTS "ticket_attachments" ("id" INTEGER PRIMARY KEY, "ticket_id" TEXT NOT NULL, "author" TEXT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "created_at_ms" INTEGER NOT NULL)`);
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_ticket_attachments_ticket_url" ON "ticket_attachments" ("ticket_id", "url")`);
      d.exec(`CREATE TABLE IF NOT EXISTS "ticket_room_lead" ("room" TEXT PRIMARY KEY, "agent" TEXT NOT NULL, "updated_at_ms" INTEGER NOT NULL)`);
    },
    routes: withLedgerRequired(routes),
    pendingFor: () => [],
    toolNames: ["create_ticket", "claim_ticket", "transition_ticket", "list_tickets", "assign_ticket", "edit_ticket", "attach_ticket_file"],
    briefingLines,
  };
}
