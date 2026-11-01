// Cancel-trace kind — open → cleared (terminal). A failed stage cancel or sweep leaves one row for the human, not only a log line.
// The row id is a hash of (stage, site, status at failure), so the same failure again writes nothing, and a cleared row never reopens.

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Decision, Entry, HubCapabilities, KindModule, RouteDef, StateMachineDecl, VerbDecl } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { LedgerConflict } from "../core/types";
import { ts, validRoomLabel } from "../core/ids";
import { actorOr400 } from "../core/auth";
import { redactPrivateText } from "../core/redaction";

export type CancelTraceStatus = "open" | "cleared";
export type CancelTraceSite = "cancel" | "sweep";
export type CancelTraceCaller = "ticket_cancel" | "ticket_draft" | "ticket_done" | "start_sweep" | "sweep";

export type CancelTraceSnapshot = {
  id: string;
  status: CancelTraceStatus;
  room: string;
  stage_id: string;
  ticket_id: string | null;
  site: CancelTraceSite;
  caller: CancelTraceCaller;
  status_at_failure: string;
  error: string;
  created_at: number;
  cleared_at: number | null;
  version: number;
};

/** What the stage runtime reports from a catch. `error` is the raw message: the kind redacts and caps it. */
export type CancelTraceInput = {
  room: string;
  stage_id: string;
  ticket_id: string | null;
  site: CancelTraceSite;
  caller: CancelTraceCaller;
  status_at_failure: string;
  error: string;
};

export const CANCEL_TRACE_ERROR_MAX = 500;
const CANCEL_TRACE_ID_RE = /^ct_[0-9a-f]{16}$/;

/** "ct_" + the first 16 hex of sha256(stage_id \n site \n status_at_failure). */
export const cancelTraceId = (stageId: string, site: string, statusAtFailure: string): string =>
  "ct_" + createHash("sha256").update(`${stageId}\n${site}\n${statusAtFailure}`).digest("hex").slice(0, 16);

/** The private parts removed, then cut to 500 characters with one "..." (the cut text included). */
export function cancelTraceError(message: string): string {
  const text = redactPrivateText(message);
  return text.length > CANCEL_TRACE_ERROR_MAX ? text.slice(0, CANCEL_TRACE_ERROR_MAX - 3) + "..." : text;
}

const cancelTraceDecl: StateMachineDecl<CancelTraceSnapshot> = {
  kind: "cancel_trace",
  table: "cancel_traces",
  columns: {
    id: "TEXT",
    status: "TEXT",
    room: "TEXT",
    stage_id: "TEXT",
    ticket_id: "TEXT_NULL",
    site: "TEXT",
    caller: "TEXT",
    status_at_failure: "TEXT",
    error: "TEXT",
    created_at: "INTEGER",
    cleared_at: "INTEGER_NULL",
  },
  terminalStatuses: new Set(["cleared"]),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    status: row.status as CancelTraceStatus,
    room: row.room as string,
    stage_id: row.stage_id as string,
    ticket_id: row.ticket_id == null ? null : (row.ticket_id as string),
    site: row.site as CancelTraceSite,
    caller: row.caller as CancelTraceCaller,
    status_at_failure: row.status_at_failure as string,
    error: row.error as string,
    created_at: Number(row.created_at),
    cleared_at: row.cleared_at == null ? null : Number(row.cleared_at),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(cancelTraceDecl.columns)) {
      const v = (snap as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  },
};

function cancelTraceEntry(snapshot: CancelTraceSnapshot, eventKind: "cancel_trace.created" | "cancel_trace.cleared"): Entry {
  return {
    from: "system",
    to: "all",
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    version: snapshot.version,
    replay: false,
    snapshot,
  };
}

const insertVerb: VerbDecl<CancelTraceSnapshot, CancelTraceInput> = {
  decide(prior, payload): Decision<CancelTraceSnapshot> {
    // Open or cleared: the same failure writes nothing, and a cleared row never reopens.
    if (prior) return { kind: "idempotent" };
    const initial: CancelTraceSnapshot = {
      id: cancelTraceId(payload.stage_id, payload.site, payload.status_at_failure),
      status: "open",
      room: payload.room,
      stage_id: payload.stage_id,
      ticket_id: payload.ticket_id,
      site: payload.site,
      caller: payload.caller,
      status_at_failure: payload.status_at_failure,
      error: cancelTraceError(payload.error),
      created_at: Date.now(),
      cleared_at: null,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "cancel_trace.created",
      payload: (post) => post,
      entry: (post) => cancelTraceEntry(post, "cancel_trace.created"),
    };
  },
  scope: () => ({ kind: "ui-only" }),
};

const clearVerb: VerbDecl<CancelTraceSnapshot, { room: string }> = {
  decide(prior, payload): Decision<CancelTraceSnapshot> {
    if (!prior || prior.room !== payload.room) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.status === "cleared") return { kind: "idempotent" };
    return {
      kind: "transition",
      next: { status: "cleared", cleared_at: Date.now() } as Partial<CancelTraceSnapshot>,
      eventKind: "cancel_trace.cleared",
      payload: (post) => post,
      entry: (post) => cancelTraceEntry(post, "cancel_trace.cleared"),
    };
  },
  scope: () => ({ kind: "ui-only" }),
};

export type CancelTraceKind = KindModule & {
  /** Writes one open row for a failed cancel or sweep. Throws on a ledger error: the caller logs it. */
  record(input: CancelTraceInput, cap: HubCapabilities): void;
};

export function createCancelTraceKind(db: Database): CancelTraceKind {
  const entity = createLedgerEntity({ decl: cancelTraceDecl, db });

  const roomOf = (params: Record<string, string>): string => decodeURIComponent(params.id);

  const routes: RouteDef[] = [
    {
      method: "GET",
      path: /^\/rooms\/([^/]+)\/cancel-traces$/,
      auth: "read",
      handler: (_req, _cap, params) => {
        const room = roomOf(params);
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        // The Store clamps listByStatus to 1000 rows: read every open row of the room, oldest first.
        const rows = db.query<Record<string, unknown>, [string]>(`SELECT * FROM cancel_traces WHERE status = 'open' AND room = ? ORDER BY rowid`).all(room);
        return Response.json({ room, traces: rows.map(cancelTraceDecl.rowToSnapshot) });
      },
    },
    {
      method: "POST",
      path: /^\/rooms\/([^/]+)\/cancel-traces\/([^/]+)\/clear$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        // The dispatcher passes only the first capture group (the room); the trace id comes from the path.
        const room = roomOf(params);
        const id = decodeURIComponent(new URL(req.url).pathname.split("/")[4] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const body = (await req.json().catch(() => ({}))) as { by?: unknown };
        const a = actorOr400(body.by, cap, true);
        if (a instanceof Response) return a;
        const by = a.name;
        if (by !== cap.config.humanName) return Response.json({ error: "only the human may clear a cancel trace" }, { status: 403 });
        if (!CANCEL_TRACE_ID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
        try {
          const r = entity.apply(id, clearVerb, { room }, by, cap);
          return Response.json({ snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },
  ];

  return {
    kind: "cancel_trace",
    migrate: (d: Database) => entity.migrate(d),
    routes: withLedgerRequired(routes),
    // Open rows are read through GET: the UI reads again on connect, and no agent needs these events.
    pendingFor: () => [],
    toolNames: [],
    record(input, cap) {
      const id = cancelTraceId(input.stage_id, input.site, input.status_at_failure);
      entity.apply(id, insertVerb, input, "system", cap);
    },
  };
}
