// Request kind — the plan label of tickets, with an origin, features and the scope of the newest Approve
// (plan-approval spec, design decisions 1 and 2). Status: `open` until the first Approve, then `approved`.

import type { Database } from "bun:sqlite";
import type { Decision, Entry, HubCapabilities, KindModule, RouteDef, StateMachineDecl, VerbDecl } from "../core/types";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { insertEvent } from "../core/events";
import { mintRequestRowId, ts, validName, validRoomLabel } from "../core/ids";
import { pausedRefusal } from "../core/auth";
import { roomLead } from "./ticket";
import { buildDeliveryReport, ticketsMergedIntoMain } from "../core/delivery-report";
import { requestListStatus } from "../core/request-status";
import { getRoomSettings } from "../core/ledger";

// ---------- Types ----------

export type RequestOrigin = "human" | "factory";
export type RequestStatus = "open" | "approved";
export type ScopeTicket = { id: string; radius: "low" | "high" };
/** The scope at the newest Approve: the features and each ticket that was not cancelled. */
export type ApprovedScope = { features: string[]; tickets: ScopeTicket[] };

export type RequestSnapshot = {
  id: string;
  room: string;
  request_id: string;
  origin: RequestOrigin;
  features: string[];
  parent_request_id: string | null;
  source: string | null;
  approved: ApprovedScope | null;
  status: RequestStatus;
  created_by: string;
  created_at_ms: number;
  version: number;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const FEATURES_MAX = 50;
const FEATURE_MAX_CHARS = 200;
const SOURCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

// ---------- Scope rules (pure over the ledger) ----------

export type ScopeChange = {
  /** True when an Approve exists and the ledger differs from it. */
  changed: boolean;
  approved: boolean;
  added: string[];
  removed: string[];
  raised: string[];
  features: { added: string[]; removed: string[] };
};

const EMPTY_CHANGE: ScopeChange = { changed: false, approved: false, added: [], removed: [], raised: [], features: { added: [], removed: [] } };

type TicketRow = { id: string; blast_radius: "low" | "high"; status: string; request_id: string | null };

function loadRequestRow(db: Database, room: string, requestId: string): RequestSnapshot | null {
  const row = db.query<Record<string, unknown>, [string, string]>("SELECT * FROM requests WHERE room = ? AND request_id = ?").get(room, requestId);
  return row ? requestDecl.rowToSnapshot(row) : null;
}

/** The ledger against the newest Approve of the request. A request without an Approve has no change. */
export function scopeChange(db: Database, room: string, requestId: string): ScopeChange {
  const req = loadRequestRow(db, room, requestId);
  if (!req || !req.approved) return { ...EMPTY_CHANGE, features: { added: [], removed: [] } };
  const approved = req.approved;
  const live = db
    .query<TicketRow, [string, string]>("SELECT id, blast_radius, status, request_id FROM tickets WHERE room = ? AND request_id = ?")
    .all(room, requestId)
    .filter((t) => t.status !== "cancelled");
  const approvedById = new Map(approved.tickets.map((t) => [t.id, t.radius]));
  const added = live.filter((t) => !approvedById.has(t.id)).map((t) => t.id).sort();
  const liveIds = new Set(live.map((t) => t.id));
  const removed = [...approvedById.keys()].filter((id) => !liveIds.has(id)).sort();
  const raised = live.filter((t) => approvedById.get(t.id) === "low" && t.blast_radius === "high").map((t) => t.id).sort();
  const sameFeatures = req.features.length === approved.features.length && req.features.every((f, i) => f === approved.features[i]);
  const features = sameFeatures
    ? { added: [], removed: [] }
    : { added: req.features.filter((f) => !approved.features.includes(f)), removed: approved.features.filter((f) => !req.features.includes(f)) };
  const changed = added.length > 0 || removed.length > 0 || raised.length > 0 || !sameFeatures;
  return { changed, approved: true, added, removed, raised, features };
}

export type RequestFacts = { origin: RequestOrigin; features: string[]; hasHighTicket: boolean };

/** A request needs the human's Approve: origin human, or origin factory with a live high ticket or any feature. */
export function needsApprove(request: RequestFacts): boolean {
  return request.origin === "human" || request.hasHighTicket || request.features.length > 0;
}

/** True when the room has a request with this label. */
export function requestExists(db: Database, room: string, requestId: string): boolean {
  return loadRequestRow(db, room, requestId) !== null;
}

export function requestFacts(db: Database, room: string, requestId: string): RequestFacts | null {
  const req = loadRequestRow(db, room, requestId);
  if (!req) return null;
  const hasHighTicket =
    db
      .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM tickets WHERE room = ? AND request_id = ? AND blast_radius = 'high' AND status NOT IN ('done','cancelled')")
      .get(room, requestId)!.n > 0;
  return { origin: req.origin, features: req.features, hasHighTicket };
}

/**
 * True when the request holds its tickets for the human: it needs an Approve and has none, or its scope changed after the
 * newest one. A ticket without a request, or a request without a row, is held only by the caller's own rule.
 */
export function heldForApprove(db: Database, room: string, requestId: string): boolean {
  const facts = requestFacts(db, room, requestId);
  if (!facts || !needsApprove(facts)) return false;
  const change = scopeChange(db, room, requestId);
  return !change.approved || change.changed;
}

/** The lead's intake check: the request needs an Approve and has none yet. A later scope change does not hold a ticket (Part 18 L1). */
export function needsFirstApprove(db: Database, room: string, requestId: string): boolean {
  const facts = requestFacts(db, room, requestId);
  return !!facts && needsApprove(facts) && !loadRequestRow(db, room, requestId)!.approved;
}

/** The scope that an Approve would write now. */
export function currentScope(db: Database, room: string, requestId: string): ApprovedScope | null {
  const req = loadRequestRow(db, room, requestId);
  if (!req) return null;
  const tickets = db
    .query<TicketRow, [string, string]>("SELECT id, blast_radius, status, request_id FROM tickets WHERE room = ? AND request_id = ? ORDER BY id")
    .all(room, requestId)
    .filter((t) => t.status !== "cancelled")
    .map((t) => ({ id: t.id, radius: t.blast_radius }));
  return { features: [...req.features], tickets };
}

// ---------- StateMachine declaration ----------

const requestDecl: StateMachineDecl<RequestSnapshot> = {
  kind: "request",
  table: "requests",
  columns: {
    id: "TEXT",
    room: "TEXT",
    request_id: "TEXT",
    origin: "TEXT",
    features: "JSON",
    parent_request_id: "TEXT_NULL",
    source: "TEXT_NULL",
    approved: "JSON",
    status: "TEXT",
    created_by: "TEXT",
    created_at_ms: "INTEGER",
  },
  terminalStatuses: new Set(),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    room: row.room as string,
    request_id: row.request_id as string,
    origin: row.origin as RequestOrigin,
    features: row.features == null ? [] : (JSON.parse(row.features as string) as string[]),
    parent_request_id: (row.parent_request_id as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    approved: row.approved == null ? null : (JSON.parse(row.approved as string) as ApprovedScope),
    status: row.status as RequestStatus,
    created_by: row.created_by as string,
    created_at_ms: Number(row.created_at_ms),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of ["id", "room", "request_id", "origin", "parent_request_id", "source", "status", "created_by", "created_at_ms"] as const) {
      if (snap[k] !== undefined) out[k] = snap[k];
    }
    if (snap.features !== undefined) out.features = JSON.stringify(snap.features);
    if (snap.approved !== undefined) out.approved = snap.approved === null ? null : JSON.stringify(snap.approved);
    return out;
  },
};

// ---------- Entry projection ----------

/** A UI-only signal: the board reads the request again. No agent gets it. */
export function requestEntry(snapshot: RequestSnapshot, eventKind: string, actor: string): Entry {
  return {
    from: actor,
    to: "all",
    text: `[request ${snapshot.request_id} ${snapshot.status}]`,
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    request_row_id: snapshot.id,
    version: snapshot.version,
    snapshot,
  };
}

// ---------- Verbs ----------

type CreateInput = {
  id: string;
  room: string;
  request_id: string;
  origin: RequestOrigin;
  features: string[];
  parent_request_id: string | null;
  source: string | null;
};

const createVerb: VerbDecl<RequestSnapshot, CreateInput> = {
  decide(prior, p, actor): Decision<RequestSnapshot> {
    if (prior) return { kind: "conflict", httpStatus: 409, message: `request ${p.request_id} already exists` };
    const initial: RequestSnapshot = {
      ...p,
      approved: null,
      status: "open",
      created_by: actor,
      created_at_ms: Date.now(),
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "request.created",
      payload: () => ({ actor, request_id: p.request_id, origin: p.origin, features: p.features, parent_request_id: p.parent_request_id, source: p.source }),
      entry: (post) => requestEntry(post, "request.created", actor),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type EditInput = { origin?: RequestOrigin; features?: string[] };

const editVerb: VerbDecl<RequestSnapshot, EditInput> = {
  decide(prior, p, actor, cap): Decision<RequestSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (p.origin !== undefined && actor !== cap.config.humanName) {
      return { kind: "conflict", httpStatus: 403, message: "only the human may change the origin" };
    }
    const next: Partial<RequestSnapshot> = {};
    if (p.origin !== undefined && p.origin !== prior.origin) next.origin = p.origin;
    if (p.features !== undefined && (p.features.length !== prior.features.length || p.features.some((f, i) => f !== prior.features[i]))) {
      next.features = p.features;
    }
    if (Object.keys(next).length === 0) return { kind: "idempotent" };
    return {
      kind: "transition",
      next,
      eventKind: "request.edited",
      payload: () => ({
        actor,
        ...(next.origin ? { origin: { from: prior.origin, to: next.origin } } : {}),
        ...(next.features ? { features: { from: prior.features, to: next.features } } : {}),
      }),
      entry: (post) => requestEntry(post, "request.edited", actor),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

type ApproveInput = { scope: ApprovedScope };

const approveVerb: VerbDecl<RequestSnapshot, ApproveInput> = {
  decide(prior, p, actor, cap): Decision<RequestSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (actor !== cap.config.humanName) return { kind: "conflict", httpStatus: 403, message: "only the human may approve a request" };
    // The same scope again writes nothing: a repeated Approve only queues the drafts that are left.
    if (prior.approved && JSON.stringify(prior.approved) === JSON.stringify(p.scope)) return { kind: "idempotent" };
    return {
      kind: "transition",
      next: { approved: p.scope, status: "approved" },
      eventKind: "request.approved",
      payload: () => ({ actor, scope: p.scope }),
      entry: (post) => requestEntry(post, "request.approved", actor),
    };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

// ---------- Factory ----------

export type RequestApi = {
  /** Hub-internal: create a request (arbiter follow-ups, migration-free callers). Throws LedgerConflict. */
  create(cap: HubCapabilities, input: Omit<CreateInput, "id">, actor: string): RequestSnapshot;
  /** The Approve of the human: writes request.approved in its own transaction. `emitted` is false for a repeat. */
  approve(cap: HubCapabilities, room: string, requestId: string, actor: string): { snapshot: RequestSnapshot; emitted: boolean };
  find(room: string, requestId: string): RequestSnapshot | null;
};
export type RequestKind = KindModule & { api: RequestApi };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);

function parseFeatures(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > FEATURES_MAX) return null;
  const out: string[] = [];
  for (const f of v) {
    const s = str(f, FEATURE_MAX_CHARS);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** The Approve of the human, in its own transaction. The caller queues the drafts after it. `emitted` is false for a repeat. */
export function approveRequest(db: Database, cap: HubCapabilities, room: string, requestId: string, actor: string): { snapshot: RequestSnapshot; emitted: boolean } {
  const req = loadRequestRow(db, room, requestId);
  if (!req) throw new LedgerConflict(404, `no request ${requestId} in room ${room}`, null);
  const r = createLedgerEntity({ decl: requestDecl, db }).apply(req.id, approveVerb, { scope: currentScope(db, room, requestId)! }, actor, cap);
  return { snapshot: r.snapshot, emitted: r.emitted };
}

/** The requests table and its unique index. The ticket kind calls it too: its create, edit and queue rules read the table. */
/** Creates a request with actor `system` (Part 21 group 6): one `request.created` event and one row insert. Throws LedgerConflict when it exists. */
export function createRequestBySystem(db: Database, cap: HubCapabilities, input: Omit<CreateInput, "id">): RequestSnapshot {
  const id = mintRequestRowId();
  return createLedgerEntity({ decl: requestDecl, db }).apply(id, createVerb, { id, ...input }, "system", cap).snapshot;
}

export function ensureRequestsTable(d: Database): void {
  createLedgerEntity({ decl: requestDecl, db: d }).migrate(d);
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_requests_room_request" ON "requests" ("room", "request_id")`);
}

export function createRequestKind(db: Database): RequestKind {
  const entity = createLedgerEntity({ decl: requestDecl, db });
  const find = (room: string, requestId: string): RequestSnapshot | null => loadRequestRow(db, room, requestId);

  const api: RequestApi = {
    create: (cap, input, actor) => {
      const id = mintRequestRowId();
      return entity.apply(id, createVerb, { id, ...input }, actor, cap).snapshot;
    },
    approve: (cap, room, requestId, actor) => approveRequest(db, cap, room, requestId, actor),
    find,
  };

  /** The room of a caller: the human names it in the body, an agent has its own. Null with a response when wrong. */
  function callerRoom(b: Record<string, unknown>, cap: HubCapabilities): { by: string; room: string; lead: boolean } | Response {
    const by = typeof b.by === "string" ? b.by.trim() : "";
    if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
    if (cap.agents.isPaused(by)) return pausedRefusal();
    if (by === cap.config.humanName) {
      const room = typeof b.room === "string" ? b.room.trim() : "";
      if (!validRoomLabel(room)) return Response.json({ error: "room required" }, { status: 400 });
      return { by, room, lead: true };
    }
    const agent = cap.agents.get(by);
    if (!agent || agent.room === null) return Response.json({ error: "actor has no room" }, { status: 400 });
    if (b.room !== undefined && b.room !== null && b.room !== agent.room) return Response.json({ error: "cross-room request not permitted" }, { status: 403 });
    return { by, room: agent.room, lead: roomLead(cap, agent.room) === by };
  }

  const routes: RouteDef[] = [
    {
      // The room lead or the human creates a request. Origin default `human`.
      method: "POST",
      path: "/requests",
      auth: "mutating",
      handler: async (req, cap) => {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const who = callerRoom(b, cap);
        if (who instanceof Response) return who;
        if (!who.lead) return Response.json({ error: "only the room lead or the human may create a request" }, { status: 403 });
        if (typeof b.request_id !== "string" || !REQUEST_ID_RE.test(b.request_id)) return Response.json({ error: "invalid request_id" }, { status: 400 });
        const origin = b.origin === undefined || b.origin === null ? "human" : b.origin;
        if (origin !== "human" && origin !== "factory") return Response.json({ error: "origin must be human or factory" }, { status: 400 });
        const features = b.features === undefined || b.features === null ? [] : parseFeatures(b.features);
        if (features === null) return Response.json({ error: `features must be a list of up to ${FEATURES_MAX} texts` }, { status: 400 });
        if (find(who.room, b.request_id)) return Response.json({ error: `request ${b.request_id} already exists in room ${who.room}` }, { status: 409 });
        let source: string | null = null;
        if (b.source !== undefined && b.source !== null) {
          source = typeof b.source === "string" && SOURCE_RE.test(b.source) ? b.source : null;
          if (source === null) return Response.json({ error: "invalid source" }, { status: 400 });
        }
        let parent: string | null = null;
        if (b.parent_request_id !== undefined && b.parent_request_id !== null) {
          parent = typeof b.parent_request_id === "string" && REQUEST_ID_RE.test(b.parent_request_id) ? b.parent_request_id : null;
          if (parent === null) return Response.json({ error: "invalid parent_request_id" }, { status: 400 });
          if (!find(who.room, parent)) return Response.json({ error: "unknown parent_request_id in this room" }, { status: 400 });
        }
        if (origin === "factory" && who.by !== cap.config.humanName) {
          if (source === null) return Response.json({ error: "a factory request names its source (a ticket, decision or stage of this room)" }, { status: 400 });
          const owner = sourceRoom(db, source);
          if (owner === null || owner.room !== who.room) return Response.json({ error: "source is not a record of this room" }, { status: 400 });
          if (owner.request_id && parent === null) return Response.json({ error: "the source belongs to a request: name parent_request_id" }, { status: 400 });
          if (owner.request_id && parent !== owner.request_id) return Response.json({ error: "parent_request_id must be the request of the source" }, { status: 400 });
        }
        try {
          const snapshot = api.create(cap, { room: who.room, request_id: b.request_id, origin, features, parent_request_id: parent, source }, who.by);
          return Response.json({ id: snapshot.id, snapshot }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      // Edit features (room lead or human) and origin (human only).
      method: "POST",
      path: /^\/requests\/([^/]+)\/([^/]+)\/edit$/,
      auth: "mutating",
      handler: async (req, cap) => {
        const parts = new URL(req.url).pathname.split("/");
        const room = decodeURIComponent(parts[2] ?? "");
        const requestId = decodeURIComponent(parts[3] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        if (!REQUEST_ID_RE.test(requestId)) return Response.json({ error: "invalid request id" }, { status: 400 });
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const by = typeof b.by === "string" ? b.by.trim() : "";
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (cap.agents.isPaused(by)) return pausedRefusal();
        const human = by === cap.config.humanName;
        if (!human && (cap.agents.get(by)?.room !== room || roomLead(cap, room) !== by)) {
          return Response.json({ error: "only the room lead or the human may edit a request" }, { status: 403 });
        }
        const input: EditInput = {};
        if (b.origin !== undefined) {
          if (b.origin !== "human" && b.origin !== "factory") return Response.json({ error: "origin must be human or factory" }, { status: 400 });
          input.origin = b.origin;
        }
        if (b.features !== undefined) {
          const features = parseFeatures(b.features);
          if (features === null) return Response.json({ error: `features must be a list of up to ${FEATURES_MAX} texts` }, { status: 400 });
          input.features = features;
        }
        if (input.origin === undefined && input.features === undefined) return Response.json({ error: "nothing to edit (origin or features)" }, { status: 400 });
        const row = find(room, requestId);
        if (!row) return Response.json({ error: `no request ${requestId} in room ${room}` }, { status: 404 });
        try {
          const r = entity.apply(row.id, editVerb, input, by, cap);
          return Response.json(r.emitted ? { snapshot: r.snapshot } : { snapshot: r.snapshot, idempotent: true });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      // The delivery report of a request: ledger and git, no model. 409 while a ticket is open (P6-08).
      method: "GET",
      path: /^\/requests\/([^/]+)\/([^/]+)\/delivery$/,
      auth: "read",
      handler: (req) => {
        const parts = new URL(req.url).pathname.split("/");
        const room = decodeURIComponent(parts[2] ?? "");
        const requestId = decodeURIComponent(parts[3] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        if (!REQUEST_ID_RE.test(requestId)) return Response.json({ error: "invalid request id" }, { status: 400 });
        const r = buildDeliveryReport(db, room, requestId);
        if (r.kind === "not_found") return Response.json({ error: `no request ${requestId} in room ${room}` }, { status: 404 });
        if (r.kind === "open") return Response.json({ error: "the request has an open ticket: no delivery report yet" }, { status: 409 });
        return Response.json(r.report);
      },
    },

    {
      // The requests of a room with their scope changes, for the Approve card.
      method: "GET",
      path: "/requests",
      auth: "read",
      handler: (req) => {
        const room = new URL(req.url).searchParams.get("room") ?? "";
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const rows = db.query<Record<string, unknown>, [string]>("SELECT * FROM requests WHERE room = ? ORDER BY created_at_ms, id").all(room);
        const requests = rows.map((r) => {
          const snap = requestDecl.rowToSnapshot(r);
          return { ...snap, scope_change: scopeChange(db, room, snap.request_id) };
        });
        return Response.json({ room, requests });
      },
    },

    {
      // One row for each request of a room: status, progress and the newest event of the request or its tickets (Part 14 H1). Read only.
      method: "GET",
      path: /^\/rooms\/([^/]+)\/requests$/,
      auth: "read",
      handler: (req) => {
        const room = decodeURIComponent(new URL(req.url).pathname.split("/")[2] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const rows = db.query<Record<string, unknown>, [string]>("SELECT * FROM requests WHERE room = ? ORDER BY created_at_ms, id").all(room);
        const tickets = db.query<TicketRow, [string]>("SELECT id, blast_radius, status, request_id FROM tickets WHERE room = ? AND request_id IS NOT NULL").all(room);
        const byRequest = new Map<string, TicketRow[]>();
        for (const t of tickets) byRequest.set(t.request_id!, [...(byRequest.get(t.request_id!) ?? []), t]);
        const doneIds = rows.flatMap((r) => {
          const own = byRequest.get(requestDecl.rowToSnapshot(r).request_id) ?? [];
          return own.length > 0 && own.every((t) => t.status === "done" || t.status === "cancelled") ? own.filter((t) => t.status === "done").map((t) => t.id) : [];
        });
        const merged = ticketsMergedIntoMain(getRoomSettings(db, room)?.project_folder, doneIds);
        const lastEvent = db.query<{ n: number | null }, [string, string, string]>(
          "SELECT MAX(at_ms) AS n FROM events WHERE entity_id = ? OR entity_id IN (SELECT id FROM tickets WHERE room = ? AND request_id = ?)",
        );
        const requests = rows.map((r) => {
          const snap = requestDecl.rowToSnapshot(r);
          const own = byRequest.get(snap.request_id) ?? [];
          const live = own.filter((t) => t.status !== "cancelled");
          const hasHighTicket = own.some((t) => t.blast_radius === "high" && t.status !== "done" && t.status !== "cancelled");
          return {
            request_id: snap.request_id,
            origin: snap.origin,
            status: requestListStatus({
              needsApprove: needsApprove({ origin: snap.origin, features: snap.features, hasHighTicket }),
              approved: snap.approved !== null,
              tickets: own.map((t) => ({ status: t.status, mergedIntoMain: merged.has(t.id) })),
            }),
            tickets_done: own.filter((t) => t.status === "done").length,
            tickets_total: live.length,
            high_radius_count: live.filter((t) => t.blast_radius === "high").length,
            last_event_ms: lastEvent.get(snap.id, room, snap.request_id)?.n ?? snap.created_at_ms,
          };
        });
        return Response.json({ room, requests });
      },
    },
  ];

  return {
    kind: "request",
    migrate: (d: Database) => {
      ensureRequestsTable(d);
      migrateLegacyRequests(d);
    },
    routes: withLedgerRequired(routes),
    pendingFor: () => [],
    toolNames: ["create_request"],
    api,
  };
}

/** The room and request of a ticket, a decision or a stage id, or null. */
function sourceRoom(db: Database, source: string): { room: string; request_id: string | null } | null {
  if (/^t_/.test(source)) return db.query<{ room: string; request_id: string | null }, [string]>("SELECT room, request_id FROM tickets WHERE id = ?").get(source) ?? null;
  if (/^d_/.test(source)) return db.query<{ room: string; request_id: string | null }, [string]>("SELECT room, request_id FROM decisions WHERE id = ?").get(source) ?? null;
  if (/^s_/.test(source)) {
    return (
      db
        .query<{ room: string; request_id: string | null }, [string]>(
          `SELECT COALESCE((SELECT room FROM tickets WHERE id = s.ticket_id),
                           (SELECT t.room FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id WHERE sc.stage_id = s.id ORDER BY sc.ticket_id LIMIT 1)) AS room,
                   s.request_id AS request_id FROM stage s WHERE s.id = ?`,
        )
        .get(source) ?? null
    );
  }
  return null;
}

const tableExists = (d: Database, name: string): boolean => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * One request (origin human, no features) for each request_id of the ledger that has none. A request with a ticket after
 * `draft` gets an Approve by `system`. Only a request that this run creates is approved, so a second run changes nothing.
 */
function migrateLegacyRequests(d: Database): void {
  if (!tableExists(d, "tickets")) return;
  if (!d.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some((c) => c.name === "request_id")) return;
  const pairs = d
    .query<{ room: string; request_id: string }, []>(
      `SELECT DISTINCT t.room AS room, t.request_id AS request_id FROM tickets t
        WHERE t.request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.room = t.room AND r.request_id = t.request_id)
        ORDER BY t.room, t.request_id`,
    )
    .all();
  if (pairs.length === 0) return;
  d.transaction(() => {
    for (const { room, request_id } of pairs) {
      const at = Date.now();
      const id = mintRequestRowId();
      const tickets = d
        .query<TicketRow, [string, string]>("SELECT id, blast_radius, status, request_id FROM tickets WHERE room = ? AND request_id = ? ORDER BY id")
        .all(room, request_id);
      const started = tickets.some((t) => t.status !== "draft");
      const scope: ApprovedScope = {
        features: [],
        tickets: tickets.filter((t) => t.status !== "cancelled").map((t) => ({ id: t.id, radius: t.blast_radius })),
      };
      d.run(
        `INSERT INTO requests (id, room, request_id, origin, features, parent_request_id, source, approved, status, created_by, created_at_ms)
         VALUES (?, ?, ?, 'human', '[]', NULL, NULL, ?, ?, 'system', ?)`,
        [id, room, request_id, started ? JSON.stringify(scope) : null, started ? "approved" : "open", at],
      );
      // The version column is the seq of the newest event of the row, as the store writes it.
      let seq = insertEvent(d, id, "request.created", "system", { actor: "system", request_id, origin: "human", features: [], parent_request_id: null, source: null, migrated: true }, at);
      if (started) seq = insertEvent(d, id, "request.approved", "system", { actor: "system", scope, migrated: true }, at);
      d.run("UPDATE requests SET version = ? WHERE id = ?", [seq, id]);
    }
  })();
}
