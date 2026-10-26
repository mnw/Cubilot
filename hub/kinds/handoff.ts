// Handoff kind — pending → accepted | declined | cancelled | expired. TTL sweep + nutshell coupling.

import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Decision,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
  StateMachineDecl,
  VerbDecl,
} from "../core/types";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { insertEvent } from "../core/events";
import { mintHandoffId, ts, validName, validRoomLabel } from "../core/ids";
import { pausedRefusal } from "../core/auth";
import { getRoomSettings, STAGE_ROLES } from "../core/ledger";
import { ROLE_RECIPIENT_PREFIX, type StageHooks } from "./stage";
import {
  writeNutshellInTx,
  nutshellEntry,
  type NutshellSnapshot,
} from "../nutshell";

// ---------- Types ----------

export type HandoffStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

const HANDOFF_TERMINAL: ReadonlySet<HandoffStatus> = new Set([
  "accepted",
  "declined",
  "cancelled",
  "expired",
]);

const HANDOFF_STATUS_FILTERS = new Set<HandoffStatus | "all">([
  "pending", "accepted", "declined", "cancelled", "expired", "all",
]);
function isHandoffStatusFilter(s: string): s is HandoffStatus | "all" {
  return (HANDOFF_STATUS_FILTERS as Set<string>).has(s);
}

export type HandoffSnapshot = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context: unknown;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
  room: string;
  version: number;
};

type HandoffRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  task: string;
  context_json: string | null;
  status: HandoffStatus;
  decline_reason: string | null;
  comment: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms: number | null;
  room: string;
  version?: number;
};

const HANDOFF_ID_RE = /^h_[0-9a-f]{16}$/;
const HANDOFF_TTL_MIN_SECONDS = 1;
const HANDOFF_TTL_MAX_SECONDS = 86_400;
const HANDOFF_TTL_DEFAULT_SECONDS = 3_600;
const HANDOFF_CONTEXT_MAX_BYTES = 1_048_576;
const HANDOFF_TASK_MAX_CHARS = 500;
const HANDOFF_REASON_MAX_CHARS = 500;
const HANDOFF_BODY_MAX = 1_048_576;

// ---------- Row ↔ Snapshot ----------

function rowToSnapshot(row: HandoffRow, version: number): HandoffSnapshot {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    task: row.task,
    context: row.context_json ? JSON.parse(row.context_json) : null,
    status: row.status,
    decline_reason: row.decline_reason,
    comment: row.comment,
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    created_at_ms: row.created_at_ms,
    expires_at_ms: row.expires_at_ms,
    resolved_at_ms: row.resolved_at_ms,
    room: row.room,
    version,
  };
}

// ---------- StateMachine declaration ----------

const handoffDecl: StateMachineDecl<HandoffSnapshot> = {
  kind: "handoff",
  table: "handoffs",
  columns: {
    id: "TEXT",
    from_agent: "TEXT",
    to_agent: "TEXT",
    task: "TEXT",
    context_json: "TEXT_NULL",
    status: "TEXT",
    decline_reason: "TEXT_NULL",
    comment: "TEXT_NULL",
    cancel_reason: "TEXT_NULL",
    cancelled_by: "TEXT_NULL",
    created_at_ms: "INTEGER",
    expires_at_ms: "INTEGER",
    resolved_at_ms: "INTEGER_NULL",
    room: "TEXT",
  },
  forColumn: "to_agent",
  terminalStatuses: HANDOFF_TERMINAL as ReadonlySet<string>,
  rowToSnapshot: (row) =>
    rowToSnapshot(row as unknown as HandoffRow, Number(row.version ?? 0)),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    if (snap.id !== undefined) out.id = snap.id;
    if (snap.from_agent !== undefined) out.from_agent = snap.from_agent;
    if (snap.to_agent !== undefined) out.to_agent = snap.to_agent;
    if (snap.task !== undefined) out.task = snap.task;
    if (snap.context !== undefined) out.context_json = snap.context === null ? null : JSON.stringify(snap.context);
    if (snap.status !== undefined) out.status = snap.status;
    if (snap.decline_reason !== undefined) out.decline_reason = snap.decline_reason;
    if (snap.comment !== undefined) out.comment = snap.comment;
    if (snap.cancel_reason !== undefined) out.cancel_reason = snap.cancel_reason;
    if (snap.cancelled_by !== undefined) out.cancelled_by = snap.cancelled_by;
    if (snap.created_at_ms !== undefined) out.created_at_ms = snap.created_at_ms;
    if (snap.expires_at_ms !== undefined) out.expires_at_ms = snap.expires_at_ms;
    if (snap.resolved_at_ms !== undefined) out.resolved_at_ms = snap.resolved_at_ms;
    if (snap.room !== undefined) out.room = snap.room;
    return out;
  },
};

// ---------- Entry projection ----------

export function handoffEntry(
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
  replay = false,
): Entry {
  return {
    from: snapshot.from_agent,
    to: snapshot.to_agent,
    text: JSON.stringify(snapshot),
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    handoff_id: snapshot.id,
    version: snapshot.version,
    expires_at_ms: snapshot.expires_at_ms,
    replay,
    snapshot,
  };
}

// ---------- Verbs ----------

type CreateInput = {
  id: string;
  from: string;
  to: string;
  task: string;
  context?: unknown;
  ttl_seconds: number;
  room: string;
};

const createHandoffVerb: VerbDecl<HandoffSnapshot, CreateInput> = {
  decide(prior, payload, _actor): Decision<HandoffSnapshot> {
    if (prior) {
      return { kind: "conflict", httpStatus: 409, message: `handoff ${payload.id} already exists` };
    }
    const now = Date.now();
    const initial: HandoffSnapshot = {
      id: payload.id,
      from_agent: payload.from,
      to_agent: payload.to,
      task: payload.task,
      context: payload.context ?? null,
      status: "pending",
      decline_reason: null,
      comment: null,
      cancel_reason: null,
      cancelled_by: null,
      created_at_ms: now,
      expires_at_ms: now + payload.ttl_seconds * 1000,
      resolved_at_ms: null,
      room: payload.room,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "handoff.created",
      payload: () => ({
        to: payload.to,
        task: payload.task,
        context: payload.context ?? null,
        ttl_seconds: payload.ttl_seconds,
      }),
      entry: (post) => handoffEntry(post, "handoff.new"),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.to_agent] }),
};

type AcceptInput = { by: string; comment: string | undefined; humanName: string };

const acceptHandoffVerb: VerbDecl<HandoffSnapshot, AcceptInput> = {
  decide(prior, payload, _actor): Decision<HandoffSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.to_agent !== payload.by) {
      return { kind: "conflict", httpStatus: 403, message: "not the recipient" };
    }
    if (prior.status === "accepted") return { kind: "idempotent" };
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `handoff already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: "accepted",
        comment: payload.comment ?? null,
        resolved_at_ms: now,
      } as Partial<HandoffSnapshot>,
      eventKind: "handoff.accepted",
      payload: () => ({ comment: payload.comment ?? null }),
      entry: (post) => handoffEntry(post, "handoff.update"),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.from_agent, post.to_agent] }),
};

type DeclineInput = { by: string; reason: string };

const declineHandoffVerb: VerbDecl<HandoffSnapshot, DeclineInput> = {
  decide(prior, payload, _actor): Decision<HandoffSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.to_agent !== payload.by) {
      return { kind: "conflict", httpStatus: 403, message: "not the recipient" };
    }
    if (prior.status === "declined") return { kind: "idempotent" };
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `handoff already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: "declined",
        decline_reason: payload.reason,
        resolved_at_ms: now,
      } as Partial<HandoffSnapshot>,
      eventKind: "handoff.declined",
      payload: () => ({ reason: payload.reason }),
      entry: (post) => handoffEntry(post, "handoff.update"),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.from_agent, post.to_agent] }),
};

type CancelInput = { by: string; reason: string | undefined; humanName: string };

const cancelHandoffVerb: VerbDecl<HandoffSnapshot, CancelInput> = {
  decide(prior, payload, _actor): Decision<HandoffSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.from_agent !== payload.by && payload.by !== payload.humanName) {
      return { kind: "conflict", httpStatus: 403, message: "not the sender" };
    }
    if (prior.status === "cancelled") return { kind: "idempotent" };
    if (prior.status !== "pending") {
      return { kind: "conflict", httpStatus: 409, message: `handoff already ${prior.status}` };
    }
    const now = Date.now();
    return {
      kind: "transition",
      next: {
        status: "cancelled",
        cancel_reason: payload.reason ?? null,
        cancelled_by: payload.by,
        resolved_at_ms: now,
      } as Partial<HandoffSnapshot>,
      eventKind: "handoff.cancelled",
      payload: () => ({ reason: payload.reason ?? null }),
      entry: (post) => handoffEntry(post, "handoff.update"),
    };
  },
  scope: (post) => ({ kind: "to-agents", agents: [post.from_agent, post.to_agent] }),
};

// Used by hub.ts's TTL-sweep loop where no `cap` is available.
export function broadcastHandoffSnapshot(
  fanoutSend: (entry: Entry, scope: import("../core/types").Scope) => void,
  snapshot: HandoffSnapshot,
  eventKind: "handoff.new" | "handoff.update",
): void {
  const recipients =
    eventKind === "handoff.new"
      ? [snapshot.to_agent]
      : [snapshot.from_agent, snapshot.to_agent];
  fanoutSend(handoffEntry(snapshot, eventKind), { kind: "to-agents", agents: recipients });
}

export function expireHandoff(db: Database, id: string): HandoffSnapshot | null {
  let result: HandoffSnapshot | null = null;
  db.transaction(() => {
    const row = db
      .query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE id = ?")
      .get(id);
    if (!row || row.status !== "pending") return;
    const now = Date.now();
    const seq = insertEvent(db, id, "handoff.expired", "system", {}, now);
    db.run(
      "UPDATE handoffs SET status='expired', resolved_at_ms=?, version=? WHERE id=?",
      [now, seq, id],
    );
    result = rowToSnapshot({ ...row, status: "expired", resolved_at_ms: now }, seq);
  })();
  return result;
}

export function findExpirable(db: Database, nowMs: number): string[] {
  const rows = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM handoffs WHERE status='pending' AND expires_at_ms < ?",
    )
    .all(nowMs);
  return rows.map((r) => r.id);
}

// ---------- Factory ----------

const TICKET_ID_RE = /^t_[0-9a-f]{16}$/;
const SPEC_REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SPEC_REQUEST_TEXT_MAX = 20_000;

/**
 * A handoff from the hub itself (actor `system`), for the stage kind: the Orchestrator hears that a stage failed for good
 * (stage-sessions 5.3). No route calls it. One event and one row, like every handoff.
 */
export function createSystemHandoff(db: Database, cap: HubCapabilities, h: { to: string; task: string; context: unknown; room: string }): HandoffSnapshot {
  const entity = createLedgerEntity({ decl: handoffDecl, db });
  const id = mintHandoffId();
  return entity.apply(id, createHandoffVerb, { id, from: "system", to: h.to, task: h.task, context: h.context, ttl_seconds: HANDOFF_TTL_DEFAULT_SECONDS, room: h.room }, "system", cap).snapshot;
}

export function createHandoffKind(db: Database, stage?: StageHooks): KindModule {
  const entity = createLedgerEntity({ decl: handoffDecl, db });

  const routes: RouteDef[] = [
    {
      method: "POST",
      path: "/handoffs",
      auth: "mutating",
      bodyMax: HANDOFF_BODY_MAX,
      handler: async (req, cap) => {
        const body = (await req.json().catch(() => ({}))) as {
          from?: string;
          to?: string;
          to_role?: unknown;
          review?: unknown;
          request_id?: unknown;
          task?: string;
          context?: unknown;
          ttl_seconds?: number;
        };
        const from = (body.from ?? "").trim();
        const task = (body.task ?? "").trim();
        // Exactly one target: an agent (`to`) or a role (`to_role`, stage-sessions).
        const toRole = body.to_role === undefined || body.to_role === null ? "" : typeof body.to_role === "string" ? body.to_role.trim() : null;
        if (toRole === null) return Response.json({ error: "to_role must be a string" }, { status: 400 });
        const toNamed = (body.to ?? "").trim() !== "";
        if (toRole !== "" && toNamed) {
          return Response.json({ error: "name either to or to_role, not both" }, { status: 400 });
        }
        const to = toRole !== "" ? `${ROLE_RECIPIENT_PREFIX}${toRole}` : (body.to ?? "").trim();

        if (!validName(from)) return Response.json({ error: "invalid from" }, { status: 400 });
        if (cap.agents.isPaused(from)) return pausedRefusal();
        if (toRole !== "") {
          if (!(STAGE_ROLES as readonly string[]).includes(toRole)) {
            return Response.json({ error: `invalid to_role (one of ${STAGE_ROLES.join(", ")})` }, { status: 400 });
          }
        } else if (!validName(to)) return Response.json({ error: "invalid to" }, { status: 400 });
        if (!task) return Response.json({ error: "task required" }, { status: 400 });
        if (task.length > HANDOFF_TASK_MAX_CHARS) {
          return Response.json({ error: `task too long (max ${HANDOFF_TASK_MAX_CHARS})` }, { status: 400 });
        }
        if (body.context !== undefined && body.context !== null) {
          const serialized = JSON.stringify(body.context);
          if (serialized.length > HANDOFF_CONTEXT_MAX_BYTES) {
            return Response.json({ error: "context too large" }, { status: 400 });
          }
        }
        let ttl = body.ttl_seconds ?? HANDOFF_TTL_DEFAULT_SECONDS;
        if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
          return Response.json({ error: "ttl_seconds must be a number" }, { status: 400 });
        }
        ttl = Math.trunc(ttl);
        if (ttl < HANDOFF_TTL_MIN_SECONDS || ttl > HANDOFF_TTL_MAX_SECONDS) {
          return Response.json(
            { error: `ttl_seconds must be between ${HANDOFF_TTL_MIN_SECONDS} and ${HANDOFF_TTL_MAX_SECONDS}` },
            { status: 400 },
          );
        }

        // Never registers the sender: an agent created here would be pinned to the default room, because
        // its room is fixed by its first /agent-stream (a handoff can beat the bridge's reconnect).
        if (!cap.agents.get(from)) {
          return Response.json({ error: `unknown sender ${from}: connect /agent-stream first` }, { status: 409 });
        }
        const fromAgent = cap.agents.get(from)!;
        let handoffRoom: string;
        let ticketId: string | null = null;
        // A spec review (spec-review-stage 2.1): to_role validator + review "spec" + request_id; it names a request, not a ticket.
        const isSpec = body.review !== undefined && body.review !== null;
        let specRequestId = "";
        let specScope: string[] = [];
        if (isSpec) {
          if (body.review !== "spec" || toRole !== "validator") {
            return Response.json({ error: 'review "spec" goes with to_role "validator"' }, { status: 400 });
          }
          if (typeof body.request_id !== "string" || !SPEC_REQUEST_ID_RE.test(body.request_id)) {
            return Response.json({ error: "a spec review needs request_id" }, { status: 400 });
          }
          specRequestId = body.request_id;
          const c = body.context as Record<string, unknown> | null | undefined;
          if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.request_text !== "string" || !c.request_text.trim()) {
            return Response.json({ error: "a spec review needs context.request_text" }, { status: 400 });
          }
          if (c.request_text.length > SPEC_REQUEST_TEXT_MAX) {
            return Response.json({ error: `context.request_text too long (max ${SPEC_REQUEST_TEXT_MAX})` }, { status: 400 });
          }
          const strList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x);
          if (c.spec_paths !== undefined && !strList(c.spec_paths)) {
            return Response.json({ error: "context.spec_paths must be a list of paths" }, { status: 400 });
          }
          if (c.ticket_ids !== undefined && !(strList(c.ticket_ids) && (c.ticket_ids as string[]).every((t) => TICKET_ID_RE.test(t)))) {
            return Response.json({ error: "context.ticket_ids must be a list of ticket ids" }, { status: 400 });
          }
          if (c.commit !== undefined && (typeof c.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(c.commit))) {
            return Response.json({ error: "context.commit must be a commit hash" }, { status: 400 });
          }
          handoffRoom = fromAgent.room ?? cap.config.defaultRoom;
          // The stored context names the request, so the launch finds the commit of this review (spec-review 2.4).
          // No commit named: pin HEAD of the room's project as it is now, so a later commit does not move this review (2.4b).
          let commit = c.commit;
          if (commit === undefined) {
            const project = getRoomSettings(db, handoffRoom)?.project_folder;
            const head = project ? Bun.spawnSync(["git", "-C", project, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }) : null;
            if (head?.exitCode === 0) commit = head.stdout.toString().trim();
          }
          body.context = { ...c, request_id: specRequestId, ...(commit !== undefined ? { commit } : {}) };
          // Scope (spec-review-stage 2.2): the named tickets, else every draft ticket of the request in the room.
          // Every one must be a draft of this request in this room; nothing is recorded otherwise.
          const named = c.ticket_ids as string[] | undefined;
          if (named) {
            for (const id of new Set(named)) {
              const t = db.query<{ status: string; request_id: string | null; room: string }, [string]>("SELECT status, request_id, room FROM tickets WHERE id = ?").get(id);
              if (!t || t.room !== handoffRoom) return Response.json({ error: `unknown ticket ${id} in room ${handoffRoom}` }, { status: 400 });
              if (t.status !== "draft") return Response.json({ error: `ticket ${id} is ${t.status}, not draft` }, { status: 400 });
              if (t.request_id !== specRequestId) return Response.json({ error: `ticket ${id} is not in request ${specRequestId}` }, { status: 400 });
            }
            specScope = [...new Set(named)];
          } else {
            specScope = db
              .query<{ id: string }, [string, string]>("SELECT id FROM tickets WHERE request_id = ? AND room = ? AND status = 'draft' ORDER BY created_at_ms, id")
              .all(specRequestId, handoffRoom)
              .map((r) => r.id);
          }
          if (specScope.length === 0) return Response.json({ error: `no draft ticket to review in request ${specRequestId}` }, { status: 400 });
        } else if (toRole !== "") {
          // A role handoff names its ticket in context.ticket_id; it does not name a session.
          const ctx = body.context as { ticket_id?: unknown; commit?: unknown } | null | undefined;
          if (!ctx || typeof ctx !== "object" || typeof ctx.ticket_id !== "string" || !TICKET_ID_RE.test(ctx.ticket_id)) {
            return Response.json({ error: "a to_role handoff needs context.ticket_id" }, { status: 400 });
          }
          // The commit a Tester, Validator, Editor or Reviewer worktree is detached at (stage-sessions 4.5).
          if (ctx.commit !== undefined && (typeof ctx.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(ctx.commit))) {
            return Response.json({ error: "context.commit must be a commit hash" }, { status: 400 });
          }
          const t = db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(ctx.ticket_id);
          if (!t) return Response.json({ error: `unknown ticket ${ctx.ticket_id}` }, { status: 404 });
          if (fromAgent.room !== null && fromAgent.room !== t.room) {
            return Response.json({ error: "cross-room handoff not permitted" }, { status: 403 });
          }
          ticketId = ctx.ticket_id;
          handoffRoom = t.room;
        } else {
          const toAgent = cap.agents.get(to);
          if (!toAgent) {
            return Response.json(
              {
                error: `unknown recipient: ${to} (must be a currently-registered agent or "${cap.config.humanName}")`,
              },
              { status: 400 },
            );
          }
          if (fromAgent.room !== null && toAgent.room !== null && fromAgent.room !== toAgent.room) {
            return Response.json({ error: "cross-room handoff not permitted" }, { status: 403 });
          }
          handoffRoom = fromAgent.room ?? toAgent.room ?? cap.config.defaultRoom;
        }

        // A result for a stage that is already passed or failed is refused: its result is recorded (stage-sessions, 6.5 run 3).
        const done = stage?.completedStage(from, body.context);
        if (done) return Response.json({ error: done }, { status: 409 });

        // A result handoff of a stage session must pass the schema check; a failing one records nothing (stage-sessions 5.1).
        const resultErrors = stage?.checkResult(from, body.context, cap, to) ?? null;
        if (resultErrors?.length) return Response.json({ error: "result rejected", errors: resultErrors }, { status: 400 });

        const id = mintHandoffId();
        try {
          const r = entity.apply(
            id,
            createHandoffVerb,
            { id, from, to, task, context: body.context, ttl_seconds: ttl, room: handoffRoom },
            from,
            cap,
          );
          // A valid result passes the stage of the sender (stage-sessions 5.2); the session closes at its next end of turn.
          if (resultErrors) stage?.onResult(from, body.context, cap);
          // The evaluator runs in the same request, after the handoff is recorded (stage.ts logs its own failure).
          if (isSpec) stage?.onSpecHandoff({ request_id: specRequestId, scope: specScope }, cap);
          else if (toRole !== "" && ticketId && stage) {
            stage.onRoleHandoff({ ticket_id: ticketId, role: toRole, seq: r.snapshot.version }, cap);
          }
          return Response.json({ id: r.snapshot.id }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/handoffs\/([^/]+)\/accept$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const id = params.id;
        if (!HANDOFF_ID_RE.test(id)) {
          return Response.json({ error: "invalid handoff id" }, { status: 400 });
        }
        const body = (await req.json().catch(() => ({}))) as { by?: string; comment?: string };
        const by = (body.by ?? "").trim();
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (cap.agents.isPaused(by)) return pausedRefusal();   // taking work is intervening; decline and cancel stay open
        if (body.comment && body.comment.length > HANDOFF_REASON_MAX_CHARS) {
          return Response.json(
            { error: `comment too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
            { status: 400 },
          );
        }

        const prior = entity.load(id);
        const wantsNutshell =
          prior !== null &&
          prior.status === "pending" &&
          prior.to_agent === cap.config.humanName &&
          prior.task.startsWith("[nutshell]") &&
          prior.context !== null &&
          typeof prior.context === "object";
        let nutshellPatch: string | null = null;
        let nutshellRoom: string = prior?.room ?? "";
        if (wantsNutshell && prior) {
          const ctx = prior.context as { patch?: unknown; room?: unknown };
          if (typeof ctx.patch === "string") nutshellPatch = ctx.patch;
          if (typeof ctx.room === "string" && validRoomLabel(ctx.room)) {
            if (ctx.room === prior.room || prior.from_agent === cap.config.humanName) {
              nutshellRoom = ctx.room;
            } else {
              nutshellPatch = null;
            }
          }
        }

        try {
          if (nutshellPatch !== null && prior) {
            const fromAgent = prior.from_agent;
            const r = entity.applyWithSideEffect(
              id,
              acceptHandoffVerb,
              { by, comment: body.comment, humanName: cap.config.humanName },
              by,
              cap,
              ({ tx: _tx }) => writeNutshellInTx(cap.db, nutshellRoom, nutshellPatch!, fromAgent),
            );
            const nutshell = (r.sideEffectResult ?? null) as NutshellSnapshot | null;
            if (r.emitted && nutshell) {
              cap.sse.emit(nutshellEntry(nutshell), { kind: "room-ambient", room: nutshell.room });
            }
            return Response.json(
              { snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) },
              { status: 200 },
            );
          }
          const r = entity.apply(
            id,
            acceptHandoffVerb,
            { by, comment: body.comment, humanName: cap.config.humanName },
            by,
            cap,
          );
          return Response.json(
            { snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) },
            { status: 200 },
          );
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/handoffs\/([^/]+)\/decline$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const id = params.id;
        if (!HANDOFF_ID_RE.test(id)) {
          return Response.json({ error: "invalid handoff id" }, { status: 400 });
        }
        const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
        const by = (body.by ?? "").trim();
        const reason = (body.reason ?? "").trim();
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (!reason) return Response.json({ error: "reason required" }, { status: 400 });
        if (reason.length > HANDOFF_REASON_MAX_CHARS) {
          return Response.json(
            { error: `reason too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
            { status: 400 },
          );
        }
        try {
          const r = entity.apply(id, declineHandoffVerb, { by, reason }, by, cap);
          return Response.json(
            { snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) },
            { status: 200 },
          );
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "POST",
      path: /^\/handoffs\/([^/]+)\/cancel$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const id = params.id;
        if (!HANDOFF_ID_RE.test(id)) {
          return Response.json({ error: "invalid handoff id" }, { status: 400 });
        }
        const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
        const by = (body.by ?? "").trim();
        const reason = body.reason?.trim();
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (reason && reason.length > HANDOFF_REASON_MAX_CHARS) {
          return Response.json(
            { error: `reason too long (max ${HANDOFF_REASON_MAX_CHARS} chars)`, max: HANDOFF_REASON_MAX_CHARS },
            { status: 400 },
          );
        }
        try {
          const r = entity.apply(
            id,
            cancelHandoffVerb,
            { by, reason, humanName: cap.config.humanName },
            by,
            cap,
          );
          return Response.json(
            { snapshot: r.snapshot, ...(r.emitted ? {} : { idempotent: true }) },
            { status: 200 },
          );
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      method: "GET",
      path: "/handoffs",
      auth: "read",
      handler: (req, _cap) => {
        const url = new URL(req.url);
        const statusParam = url.searchParams.get("status") ?? "pending";
        const forParam = url.searchParams.get("for") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;

        if (!isHandoffStatusFilter(statusParam)) {
          return Response.json({ error: `invalid status: ${statusParam}` }, { status: 400 });
        }
        if (forParam !== undefined && !validName(forParam)) {
          return Response.json({ error: `invalid for: ${forParam}` }, { status: 400 });
        }
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          return Response.json({ error: "invalid limit" }, { status: 400 });
        }

        const statuses: HandoffStatus[] = statusParam === "all"
          ? ["pending", "accepted", "declined", "cancelled", "expired"]
          : [statusParam];
        const out: HandoffSnapshot[] = [];
        for (const s of statuses) {
          const slice = entity.listByStatus({ status: s, limit: 1000 });
          for (const snap of slice) {
            if (forParam && snap.from_agent !== forParam && snap.to_agent !== forParam) continue;
            out.push(snap);
            if (out.length >= limit) break;
          }
          if (out.length >= limit) break;
        }
        return Response.json(out);
      },
    },
  ];

  function pendingFor(agent: AgentCtx, _cap: HubCapabilities): Entry[] {
    return entity
      .listByStatus({ status: "pending", limit: 1000 })
      .filter((s) => s.from_agent === agent.name || s.to_agent === agent.name)
      .map((s) => handoffEntry(s, "handoff.new", true));
  }

  return {
    kind: "handoff",
    migrate: (d: Database) => entity.migrate(d),
    routes: withLedgerRequired(routes),
    pendingFor,
    toolNames: ["send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff"],
  };
}

// ---------- Re-exports ----------

export {
  HANDOFF_ID_RE,
  HANDOFF_BODY_MAX,
  HANDOFF_REASON_MAX_CHARS,
};
