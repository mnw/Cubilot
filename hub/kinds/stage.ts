// Stage kind — one stage per role's work on a ticket (or, with review = 'spec', on a request).
// States: queued → launching → running → passed | retrying → … → failed. This file holds the
// declaration, the transition function (createStageApi) and the read routes. The evaluator (2.3)
// and the launch queue (4.1) are added by their own tickets; no route here writes a stage.

import { join } from "node:path";
import { renderFirstMessage, renderSpecFirstMessage } from "../core/first-message";
import { createWorktree, removeWorktree, worktreesRoot } from "../core/worktrees";
import type { Database } from "bun:sqlite";
import type {
  AgentCtx,
  Decision,
  Entry,
  HubCapabilities,
  KindModule,
  RouteDef,
  SideEffectCtx,
  StateMachineDecl,
  VerbDecl,
} from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { validName, validRoomLabel } from "../core/ids";
import { getRoomSettings, DEFAULT_ROLE_LIMITS, DEFAULT_STAGE_TIMEOUT_MIN, STAGE_ROLES, type StageRole } from "../core/ledger";
import { LedgerConflict } from "../core/types";
import { createLaunchQueue, type LaunchEnd, type LaunchQueue, type LaunchRequest } from "../core/launch-queue";
import { roleHarness } from "../core/role-harness";
import { makeSSE } from "../core/sse";
import { assignBySystemInTx, closeReviewedBySystemInTx, queueBySystemInTx } from "./ticket";

export type StageStatus = "queued" | "launching" | "running" | "retrying" | "passed" | "failed";

export type StageSnapshot = {
  id: string;
  ticket_id: string | null;
  request_id: string | null;
  review: "spec" | null;
  verdict: string | null;
  role: string;
  attempt: number;
  status: StageStatus;
  session: string | null;
  slot_seq: number | null;
  version: number;
};

const STAGE_ID_RE = /^s_[0-9a-f]{16}$/;
const STAGE_STATUSES = new Set<string>(["queued", "launching", "running", "retrying", "passed", "failed"]);

// created_seq and updated_seq live in the table (the queue order and the audit) but not in the
// snapshot: updated_seq is `version`, and the transitions set created_seq in 2.2.
const stageDecl: StateMachineDecl<StageSnapshot> = {
  kind: "stage",
  table: "stage",
  columns: {
    id: "TEXT",
    ticket_id: "TEXT_NULL",
    request_id: "TEXT_NULL",
    review: "TEXT_NULL",
    verdict: "TEXT_NULL",
    role: "TEXT",
    attempt: "INTEGER",
    status: "TEXT",
    session: "TEXT_NULL",
    slot_seq: "INTEGER_NULL",
  },
  forColumn: "role",
  terminalStatuses: new Set(["passed", "failed"]),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    ticket_id: (row.ticket_id as string | null) ?? null,
    request_id: (row.request_id as string | null) ?? null,
    review: (row.review as "spec" | null) ?? null,
    verdict: (row.verdict as string | null) ?? null,
    role: row.role as string,
    attempt: Number(row.attempt),
    status: row.status as StageStatus,
    session: (row.session as string | null) ?? null,
    slot_seq: row.slot_seq == null ? null : Number(row.slot_seq),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(stageDecl.columns)) {
      const v = (snap as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  },
};

export function stageEntry(snapshot: StageSnapshot, eventKind: string, room: string | null): Entry {
  return {
    from: "system",
    to: "all",
    text: JSON.stringify(snapshot),
    ts: new Date().toISOString(),
    image: null,
    room,
    kind: eventKind,
    version: snapshot.version,
    snapshot,
  };
}

// ---------- Transitions ----------

// The only moves a stage makes. `queued → failed` and `launching → failed` carry the launch errors that
// count no attempt (no project folder). `retrying → launching` is the relaunch and raises the attempt.
const MOVES: Record<StageStatus, readonly StageStatus[]> = {
  queued: ["launching", "failed"],
  launching: ["running", "retrying", "failed"],
  running: ["passed", "retrying", "failed"],
  retrying: ["launching", "failed"],
  passed: [],
  failed: [],
};
const MAX_ATTEMPT = 2;
const TERMINAL = new Set<StageStatus>(["passed", "failed"]);

export type StageCreateInput = {
  ticket_id?: string | null;
  request_id?: string | null;
  review?: "spec" | null;
  role: string;
};

export type StageMoveInput = {
  to: StageStatus;
  /** Required for `launching`: the session name `<role>-<n>`. */
  session?: string;
  slot_seq?: number | null;
  /** Set on `passed`: the verdict of a result. */
  verdict?: string | null;
  /** Why an attempt ended (`retrying`, `failed`): kept in the event, so a restart can still give it to the relaunch (5.3b). */
  reason?: string;
};

function mintStageId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "s_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

const stageScope = () => ({ kind: "ui-only-ambient" as const });

const createVerb: VerbDecl<StageSnapshot, StageCreateInput & { id: string }> = {
  decide(prior, p): Decision<StageSnapshot> {
    if (prior) return { kind: "conflict", httpStatus: 409, message: `stage ${p.id} already exists` };
    const review = p.review ?? null;
    if (review === null && !p.ticket_id) {
      return { kind: "conflict", httpStatus: 400, message: "a ticket stage needs ticket_id" };
    }
    if (review === "spec" && !p.request_id) {
      return { kind: "conflict", httpStatus: 400, message: "a spec stage needs request_id" };
    }
    const initial: StageSnapshot = {
      id: p.id,
      ticket_id: p.ticket_id ?? null,
      request_id: p.request_id ?? null,
      review,
      verdict: null,
      role: p.role,
      attempt: 1,
      status: "queued",
      session: null,
      slot_seq: null,
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "stage.queued",
      payload: (post) => ({ role: post.role, ticket_id: post.ticket_id, request_id: post.request_id, review: post.review }),
      entry: (post) => stageEntry(post, "stage.queued", null),
    };
  },
  scope: stageScope,
};

const moveVerb: VerbDecl<StageSnapshot, StageMoveInput & { id: string }> = {
  decide(prior, p): Decision<StageSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.status === p.to && TERMINAL.has(prior.status)) return { kind: "idempotent" };
    if (!MOVES[prior.status].includes(p.to)) {
      return { kind: "conflict", httpStatus: 409, message: `stage is ${prior.status}; cannot move to ${p.to}` };
    }
    if (p.to === "launching" && !p.session) {
      return { kind: "conflict", httpStatus: 400, message: "launching needs a session name" };
    }
    if (p.to === "launching" && prior.status === "retrying" && prior.attempt >= MAX_ATTEMPT) {
      return { kind: "conflict", httpStatus: 409, message: `attempt ${MAX_ATTEMPT} is the last` };
    }
    const next: Partial<StageSnapshot> = { status: p.to };
    if (p.to === "launching") {
      next.session = p.session!;
      next.slot_seq = p.slot_seq ?? null;
      if (prior.status === "retrying") next.attempt = prior.attempt + 1;
    }
    if (p.to === "passed" && p.verdict !== undefined) next.verdict = p.verdict;
    const eventKind = `stage.${p.to}`;
    return {
      kind: "transition",
      next,
      eventKind,
      payload: (post) => ({ from: prior.status, to: post.status, attempt: post.attempt, session: post.session, verdict: post.verdict, reason: p.reason ?? null }),
      entry: (post) => stageEntry(post, eventKind, null),
    };
  },
  scope: stageScope,
};

export type StageApi = {
  load(id: string): StageSnapshot | null;
  listByStatus(filter: { status: string; for?: string; limit?: number }): StageSnapshot[];
  /** Writes `stage.queued` and the row in one transaction. `extra` runs in that transaction (a throw rolls both back). */
  create(
    input: StageCreateInput,
    actor: string,
    cap: HubCapabilities,
    extra?: (ctx: SideEffectCtx<StageSnapshot>) => void,
  ): StageSnapshot;
  /**
   * Writes `stage.<to>` and the row update in one transaction. `extra` runs in that transaction (a throw rolls everything
   * back); what it returns is given to `afterCommit`, which runs after the commit (for broadcasts).
   */
  move(
    id: string,
    input: StageMoveInput,
    actor: string,
    cap: HubCapabilities,
    extra?: (ctx: SideEffectCtx<StageSnapshot>) => unknown,
    afterCommit?: (extraResult: unknown) => void,
  ): StageSnapshot;
};

// The stage rows are written only through this API; no HTTP route calls it (4.1 checks that).
export function createStageApi(db: Database, onSlotFree?: (freed: StageSnapshot, cap: HubCapabilities) => void): StageApi {
  const entity = createLedgerEntity({ decl: stageDecl, db });
  // created_seq (queue order) and updated_seq are not snapshot fields: the event seq goes into them here.
  const stamp = (ctx: SideEffectCtx<StageSnapshot>, first: boolean) =>
    ctx.tx.run(
      first
        ? "UPDATE stage SET created_seq = ?, updated_seq = ? WHERE id = ?"
        : "UPDATE stage SET updated_seq = ? WHERE id = ?",
      first ? [ctx.seq, ctx.seq, ctx.next.id] : [ctx.seq, ctx.next.id],
    );
  return {
    load: (id) => entity.load(id),
    listByStatus: (f) => entity.listByStatus(f),
    create(input, actor, cap, extra) {
      const id = mintStageId();
      return entity.applyWithSideEffect(id, createVerb, { ...input, id }, actor, cap, (ctx) => {
        stamp(ctx, true);
        extra?.(ctx);
      }).snapshot;
    },
    move(id, input, actor, cap, extra, afterCommit) {
      const was = entity.load(id)?.status;
      const r = entity.applyWithSideEffect(id, moveVerb, { ...input, id }, actor, cap, (ctx) => {
        stamp(ctx, false);
        return extra?.(ctx);
      });
      afterCommit?.(r.sideEffectResult);
      // A stage that leaves launching/running frees a slot of its role: the queue may start the oldest waiting stage.
      if ((was === "launching" || was === "running") && r.snapshot.status !== "launching" && r.snapshot.status !== "running") {
        onSlotFree?.(r.snapshot, cap);
      }
      return r.snapshot;
    },
  };
}

// ---------- Launches ----------

const LAUNCH_ID_RE = /^l_[0-9a-f]{16}$/;
export const DEFAULT_LAUNCH_ACK_MS = 15_000;

function mintLaunchId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "l_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export type LaunchInput = {
  stage_id: string;
  /** `<role>-<n>`, chosen by the caller (3.2 owns the numbering). */
  session: string;
  slot_seq?: number | null;
  room: string;
  harness: string;
  cwd: string | null;
  /** The first message. Empty: the hub renders it from the ticket (a ticket stage). */
  prompt: string;
  /** Why the earlier session of this stage stopped; a retry adds it to the first message. */
  reason?: string;
  /** Extra env for the session. The hub always sets CHATBRIDGE_AGENT, CHATBRIDGE_ROOM and CUBILOT_STAGE_ID itself. */
  env?: Record<string, string>;
  /** Runs in the same transaction as the `stage.launching` event (2.5: the ticket assignment). */
  extra?: (ctx: SideEffectCtx<StageSnapshot>) => void;
};

export type LaunchResult = { ok: true; request_id: string } | { ok: false; reason: string };

/** A `to_role` handoff as the evaluator sees it: the role and the event seq of the handoff (its creation order). */
export type RoleHandoff = { role: string; seq: number };

/** What the handoff kind calls when a `to_role` handoff is recorded. The stage kind implements it. */
export type StageHooks = {
  onRoleHandoff(h: { ticket_id: string; role: string; seq: number }, cap: HubCapabilities): void;
  /** A spec-review handoff (spec-review-stage 2.1) is recorded: creates one queued spec stage with its scope tickets (2.2). It never throws. */
  onSpecHandoff(h: { request_id: string; scope: string[] }, cap: HubCapabilities): void;
  /**
   * What the ticket kind calls after the commit of a change that can make a ticket ready: a draft queued, a ticket created
   * as queued, a blocker done. It evaluates the ticket and starts the stages it creates. It never throws.
   */
  onTicketChanged(ticketId: string, cap: HubCapabilities): void;
  /**
   * The schema check of a result handoff (5.1; spec stages 3.1). A handoff from the session of a `running` stage is a result.
   * Returns null when `from` is no such session, else the list of errors (empty = valid). Errors also go to the same
   * session as a `stage.rejected` entry. It changes no stage: the session stays `running`.
   */
  /**
   * The refusal text for a result that names a stage that is already passed or failed (409, nothing recorded, no
   * stage.rejected), else null (no stage_id, an unknown id, or a stage that is not complete). When `from` has another stage
   * that is running, the text names it: the sender probably copied a stage id from a handoff.
   */
  completedStage(from: string, context: unknown): string | null;
  /** `to` is the recipient of the handoff: a spec result must go to the room lead (spec-review 4.1b). */
  checkResult(from: string, context: unknown, cap: HubCapabilities, to?: string): string[] | null;
  /**
   * A valid result handoff is recorded (5.2): the running stage of `from` passes (a spec PASS runs passSpecStage). The session
   * stays open until its next end of turn (POST /stages/<id>/turn-end), which queues the close. It never throws.
   */
  onResult(from: string, context: unknown, cap: HubCapabilities): void;
};

const VERDICTS = new Set(["PASS", "FAIL"]);
const REVIEW_ROLES = new Set(["validator", "reviewer"]);

/** The recipient name stored for a handoff to a role. validName() refuses ':', so no agent can ever have it. */
export const ROLE_RECIPIENT_PREFIX = "role:";

export type StageRuntime = {
  module: KindModule;
  api: StageApi;
  /**
   * Creates the stages a ticket is ready for (each as `queued`, one `stage.queued` event each) and returns them.
   * A stage is created for a role when the ticket is not draft/done/cancelled, no blocker is open, no stage of that
   * role for the ticket is live (queued, launching, running or retrying), and either the role is `ticket.role` with
   * no stage of that role yet, or a `to_role` handoff for the role is newer than the last stage of that role.
   * `ticket.role` selects only the first stage. It does not start a session: launching is enqueueLaunch.
   * `handoffs` are the role handoffs of the current dispatch (the handoff route passes the new one); the ones stored
   * earlier come from the `roleHandoffs` reader of createStageRuntime (by default: the stored `to_role` handoffs).
   * With `launch: true` it then tries to start each stage it created (the launch conditions and the role limit
   * decide; a stage that cannot start stays `queued`). This is the only caller of enqueueLaunch besides the retry
   * path (5.3).
   */
  evaluateStages(ticketId: string, cap: HubCapabilities, handoffs?: RoleHandoff[], opts?: { launch?: boolean }): StageSnapshot[];
  /** The hook the handoff kind calls for a `to_role` handoff: evaluates the ticket and starts the new stages. */
  hooks: StageHooks;
  /**
   * THE one function that queues a launch request. Only the stage evaluator (2.3) and the stage retry path
   * (5.3) may call it, both in this file; no route calls it (tests/unit/launch-queue.test.ts checks that).
   * It checks the launch conditions again on every call (the ticket is not draft/done/cancelled, no blocker is
   * open, the role has a free slot in the room), moves the stage to `launching` and queues the request. When a
   * condition fails it changes nothing.
   */
  enqueueLaunch(input: LaunchInput, cap: HubCapabilities): LaunchResult;
  queue: LaunchQueue;
  /**
   * The PASS of a spec-review stage (spec-review-stage 3.2). One transaction: `stage.passed` with `verdict = 'PASS'` and one
   * `ticket.queued` (actor `system`) for each scope ticket that is still `draft`. When the request holds a non-terminal
   * `high` ticket, only `stage.passed` is written and the tickets stay `draft` for the human's approval. Any failure rolls
   * everything back. After the commit it starts the stages the queued tickets are ready for. Throws a LedgerConflict when
   * the stage is not a running spec stage.
   */
  passSpecStage(stageId: string, cap: HubCapabilities): { stage: StageSnapshot; queued: string[]; waitingForApproval: boolean };
  /**
   * One check of the running stages (5.3): a stage past `stage_timeout_min`, or whose session left the roster for good, is a
   * stop. Time counts from the first check that saw the stage running. The timer calls it; tests call it with their own clock.
   */
  sweep(cap: HubCapabilities, now?: number): void;
};

export const NO_PROJECT_FOLDER = "room has no project folder: set it in New factory room";
const BRANCH_ROLES = new Set(["worker", "writer"]);
const pathSegment = (x: string) => x.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * The room of a stage: the room of its ticket, or for a spec stage (no ticket) the room of its scope tickets. A spec handoff
 * checks that all of them are in the sender's room, so the first one tells. Used by the role limit and the free-slot start.
 */
const STAGE_ROOM_SQL = `COALESCE(
  (SELECT room FROM tickets WHERE id = s.ticket_id),
  (SELECT t.room FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id WHERE sc.stage_id = s.id ORDER BY sc.ticket_id LIMIT 1))`;

/** The path segment under the room that holds the worktree of a stage: the ticket, or the request of a spec stage. */
const worktreeKey = (s: { ticket_id: string | null; request_id: string | null; review: string | null }): string | null =>
  s.ticket_id ?? (s.review === "spec" && s.request_id ? `request-${s.request_id}` : null);

const isRole = (r: string): r is StageRole => (STAGE_ROLES as readonly string[]).includes(r);

/** A launch that did not start a session: attempt 1 goes to `retrying` (5.3 relaunches), attempt 2 is final. */
function endLaunchAttempt(api: StageApi, stageId: string, cap: HubCapabilities, why: string): void {
  const stage = api.load(stageId);
  if (!stage || stage.status !== "launching") return;
  api.move(stageId, { to: stage.attempt < MAX_ATTEMPT ? "retrying" : "failed", reason: `the launch did not start: ${why}` }, "system", cap);
  console.error(`[stage] launch of ${stage.session ?? stageId} failed: ${why}`);
}

/**
 * "Waiting for approval" (spec-review-stage 3.4), derived from the tables, never stored: the request has a spec stage with
 * `verdict = 'PASS'`, one of its scope tickets is still `draft` (in this request and room), and the request holds a
 * non-terminal `high` ticket. The spec PASS then left the tickets for the human (3.2); the approve route (3.3) ends it.
 */
export const WAITING_FOR_APPROVAL_SQL = `
  SELECT s.id FROM stage s
   WHERE s.request_id = ?1 AND s.review = 'spec' AND s.verdict = 'PASS'
     AND EXISTS (SELECT 1 FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id
                  WHERE sc.stage_id = s.id AND t.status = 'draft' AND t.request_id = ?1 AND t.room = ?2)
     AND EXISTS (SELECT 1 FROM tickets h
                  WHERE h.request_id = ?1 AND h.room = ?2 AND h.blast_radius = 'high' AND h.status NOT IN ('done', 'cancelled'))
   LIMIT 1`;

export function waitingForApproval(db: Database, room: string, requestId: string): boolean {
  return db.query<{ id: string }, [string, string]>(WAITING_FOR_APPROVAL_SQL).get(requestId, room) !== null;
}

export type WaitingRequest = {
  request_id: string;
  /** The spec stage with the PASS verdict. */
  stage_id: string;
  /** The non-terminal high tickets that hold the request. */
  high_tickets: Array<{ id: string; title: string; status: string }>;
  /** The scope tickets of the PASS stage that are still draft. */
  draft_tickets: string[];
};

export type NeedsYouFinding = { ticket_id: string; title: string | null; severity: "blocking" | "suggestion"; text: string };
export type NeedsYouRequest = {
  request_id: string;
  /** Spec FAIL verdicts since the last PASS of the request (always 2 or more here). */
  fail_count: number;
  /** The findings of the latest FAIL, blocking first. */
  findings: NeedsYouFinding[];
};

/**
 * The requests of one room that need the human because their spec review failed twice or more since its last PASS
 * (spec-review-stage 4.3). The open findings are the findings of the latest FAIL result. A PASS ends it: the count restarts.
 */
/**
 * The spec FAIL state of one request IN ONE ROOM: the FAIL stages created after the newest PASS stage, all read by room.
 * A request id is a label the Orchestrator chooses, so two rooms may use the same one: a count or a PASS of another room
 * must never count here. `latest` is the newest of those FAIL stages (by created_seq), or null.
 */
export function specFailState(db: Database, room: string, requestId: string): { fails: number; latest: string | null } {
  const lastPass =
    db
      .query<{ n: number | null }, [string, string]>(
        `SELECT MAX(s.created_seq) AS n FROM stage s WHERE s.review = 'spec' AND s.request_id = ?1 AND s.verdict = 'PASS' AND ${STAGE_ROOM_SQL} = ?2`,
      )
      .get(requestId, room)?.n ?? 0;
  const fails = db
    .query<{ id: string }, [string, string, number]>(
      `SELECT s.id FROM stage s WHERE s.review = 'spec' AND s.request_id = ?1 AND s.verdict = 'FAIL' AND s.created_seq > ?3 AND ${STAGE_ROOM_SQL} = ?2
        ORDER BY s.created_seq DESC, s.rowid DESC`,
    )
    .all(requestId, room, lastPass);
  return { fails: fails.length, latest: fails[0]?.id ?? null };
}

export function needsYouRequests(db: Database, room: string): NeedsYouRequest[] {
  const requests = db
    .query<{ request_id: string }, [string]>(
      `SELECT DISTINCT s.request_id FROM stage s
        WHERE s.review = 'spec' AND s.verdict = 'FAIL' AND s.request_id IS NOT NULL AND ${STAGE_ROOM_SQL} = ? ORDER BY s.request_id`,
    )
    .all(room);
  const out: NeedsYouRequest[] = [];
  for (const { request_id } of requests) {
    const { fails, latest: latestStage } = specFailState(db, room, request_id);
    if (fails < 2 || !latestStage) continue;
    // The findings of the latest FAIL STAGE of this room: its own result handoff names it in context.stage_id.
    const latest = db
      .query<{ c: string | null }, [string]>(
        `SELECT h.context_json AS c FROM handoffs h
          WHERE json_extract(h.context_json, '$.review') = 'spec' AND json_extract(h.context_json, '$.stage_id') = ?1
            AND json_extract(h.context_json, '$.verdict') = 'FAIL'
          ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) DESC LIMIT 1`,
      )
      .get(latestStage)?.c;
    let raw: unknown[] = [];
    try { raw = (JSON.parse(latest ?? "{}") as { findings?: unknown[] }).findings ?? []; } catch { /* no readable result: no findings */ }
    const findings: NeedsYouFinding[] = raw.flatMap((f) => {
      const o = f && typeof f === "object" ? (f as Record<string, unknown>) : null;
      if (!o || typeof o.ticket_id !== "string" || typeof o.text !== "string") return [];
      const title = db.query<{ title: string }, [string]>("SELECT title FROM tickets WHERE id = ?").get(o.ticket_id)?.title ?? null;
      return [{ ticket_id: o.ticket_id, title, severity: o.severity === "suggestion" ? ("suggestion" as const) : ("blocking" as const), text: o.text }];
    });
    findings.sort((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking"));
    out.push({ request_id, fail_count: fails, findings });
  }
  return out;
}

/** The requests of one room that wait for the human's approval, each with the stage and the tickets behind it. */
export function waitingRequests(db: Database, room: string): WaitingRequest[] {
  const requests = db
    .query<{ request_id: string }, []>("SELECT DISTINCT request_id FROM stage WHERE review = 'spec' AND verdict = 'PASS' AND request_id IS NOT NULL ORDER BY request_id")
    .all();
  const out: WaitingRequest[] = [];
  for (const { request_id } of requests) {
    const hit = db.query<{ id: string }, [string, string]>(WAITING_FOR_APPROVAL_SQL).get(request_id, room);
    if (!hit) continue;
    out.push({
      request_id,
      stage_id: hit.id,
      high_tickets: db
        .query<{ id: string; title: string; status: string }, [string, string]>(
          "SELECT id, title, status FROM tickets WHERE request_id = ? AND room = ? AND blast_radius = 'high' AND status NOT IN ('done', 'cancelled') ORDER BY created_at_ms, id",
        )
        .all(request_id, room),
      draft_tickets: db
        .query<{ ticket_id: string }, [string, string, string]>(
          "SELECT sc.ticket_id FROM stage_scope sc JOIN tickets t ON t.id = sc.ticket_id WHERE sc.stage_id = ? AND t.status = 'draft' AND t.request_id = ? AND t.room = ? ORDER BY sc.ticket_id",
        )
        .all(hit.id, request_id, room)
        .map((r) => r.ticket_id),
    });
  }
  return out;
}

export function createStageRuntime(
  db: Database,
  opts: {
    ackMs?: number;
    /** How long a finished launch request stays in memory (default 10 min). */
    retainMs?: number;
    /** The `to_role` handoffs stored for a ticket. Default: read them from the handoffs table. */
    roleHandoffs?: (ticketId: string) => RoleHandoff[];
    /** Tells the room's Orchestrator that a stage failed for good (second failure). index.ts wires the handoff kind in. */
    onFinalFailure?: (info: { stage: StageSnapshot; room: string | null; reason: string }, cap: HubCapabilities) => void;
    /** How often the hub checks running stages for a time-out or a gone agent (default 30 s; tests call sweep). */
    sweepMs?: number;
    /** A passed stage whose session sent no turn-end report is closed after this time (default 120 s). */
    closeGraceMs?: number;
    /** A session younger than this is not "gone" yet: its bridge may still be starting (default 90 s). */
    bootGraceMs?: number;
  } = {},
): StageRuntime {
  const entity = createLedgerEntity({ decl: stageDecl, db });
  const api = createStageApi(db, (freed, cap) => drainQueue(freed, cap));

  const queue = createLaunchQueue({
    ackMs: opts.ackMs ?? DEFAULT_LAUNCH_ACK_MS,
    retainMs: opts.retainMs,
    onCloseEnd(session, cap) {
      // The session is gone: its role slot is free. Start what waits for it (a relaunch of a retrying stage first).
      const held = closing.get(session);
      closing.delete(session);
      // 6.5 fix: the session is closed, so its temporary worktree can go. A stage that ended (passed, retrying, failed) stays
      // in its old session's worktree until here: the close is only queued when the stage moves, and the session may still run.
      try {
        const done = held && api.load(held.stageId);
        if (done && (done.status === "passed" || done.status === "retrying" || done.status === "failed") && held.room) removeTemporaryWorktree(done, held.room);
      } catch (e) {
        console.error(`[stage] removing the worktree of ${session} failed:`, e);
      }
      if (held?.room) startWaiting(held.role, held.room, cap);
    },
    onLaunchEnd(req, end: LaunchEnd, cap) {
      if (req.kind !== "launch") return;
      try {
        if (end.by === "ack" && end.outcome.result === "spawned") {
          const stage = api.load(req.stage_id);
          if (stage?.status === "launching") api.move(req.stage_id, { to: "running" }, "system", cap);
        } else {
          const why = end.by === "timeout" ? "no ack in time" : (end.outcome as { error: string }).error;
          endLaunchAttempt(api, req.stage_id, cap, why);
          reportFinalFailure(req.stage_id, `the launch did not start: ${why}`, cap);
        }
      } catch (e) {
        if (!(e instanceof LedgerConflict)) throw e;
      }
    },
  });

  // A cancelled or declined role handoff is withdrawn; the others (pending, accepted, expired) still ask for a stage.
  const storedRoleHandoffs = (ticketId: string): RoleHandoff[] =>
    db
      .query<{ to_agent: string; seq: number }, [string, string]>(
        `SELECT h.to_agent AS to_agent, (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) AS seq
           FROM handoffs h
          WHERE h.to_agent LIKE ? AND h.status IN ('pending', 'accepted', 'expired')
            AND json_extract(h.context_json, '$.ticket_id') = ?`,
      )
      .all(`${ROLE_RECIPIENT_PREFIX}%`, ticketId)
      .filter((r) => r.seq != null)
      .map((r) => ({ role: r.to_agent.slice(ROLE_RECIPIENT_PREFIX.length), seq: r.seq }));

  /**
   * The role handoff that started this stage: the newest one for the ticket and role that was recorded before the stage
   * (its creation event seq is below the stage's own `created_seq`) and not withdrawn (cancelled or declined) before it. It
   * is judged by its state when the stage was created: a cancel or decline after that does not take it away from a retry.
   * A later handoff has its own stage, so a retry never switches to it. Same rule as the spec stage's `specCommit`.
   */
  const startingHandoffRow = (stageId: string, ticketId: string, role: string) =>
    db
      .query<{ id: string; from_agent: string; task: string; context_json: string | null }, [string, string, string]>(
        `SELECT h.id, h.from_agent, h.task, h.context_json
           FROM handoffs h
          WHERE h.to_agent = ?1
            AND json_extract(h.context_json, '$.ticket_id') = ?2
            AND (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) < (SELECT created_seq FROM stage WHERE id = ?3)
            AND NOT EXISTS (
              SELECT 1 FROM events w
               WHERE w.entity_id = h.id AND w.kind IN ('handoff.cancelled', 'handoff.declined')
                 AND w.seq < (SELECT created_seq FROM stage WHERE id = ?3))
          ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) DESC LIMIT 1`,
      )
      .get(`${ROLE_RECIPIENT_PREFIX}${role}`, ticketId, stageId);

  /** The commit of the handoff that started this stage (context.commit), else null (the ticket branch, else HEAD). */
  const handoffCommit = (stageId: string, ticketId: string, role: string): string | null => {
    try {
      const c = JSON.parse(startingHandoffRow(stageId, ticketId, role)?.context_json ?? "null") as { commit?: unknown } | null;
      return typeof c?.commit === "string" ? c.commit : null;
    } catch {
      return null;
    }
  };

  /** The handoff that started this stage, for its first message; null when no handoff did. */
  const startingHandoff = (stageId: string, ticketId: string, role: string): { id: string; from: string; task: string; context: unknown } | null => {
    const r = startingHandoffRow(stageId, ticketId, role);
    if (!r) return null;
    let context: unknown = null;
    try { context = r.context_json ? JSON.parse(r.context_json) : null; } catch { /* kept as null */ }
    return { id: r.id, from: r.from_agent, task: r.task, context };
  };

  // Sessions of passed stages whose close is not queued yet (memory only: a hub restart forgets them).
  const awaitingClose = new Set<string>();
  // End-of-turn reports per running stage that came without a result (memory only; 5.3 reads it for the stop rule).
  const turnEnds = new Map<string, number>();
  // Running stages whose session had a result refused (stage.rejected) and has not ended that turn yet: the turn end that
  // follows a refusal is the session reading the errors, not a stop, and gets no reminder (memory only).
  const refused = new Set<string>();
  // Sessions that still hold their role slot until their close is acked (5.3b): passed or stopped, close not done yet.
  const closing = new Map<string, { role: string; room: string | null; stageId: string }>();
  // Why the earlier session of a stage stopped, for the relaunch's first message: the reason of its last stage.retrying event.
  const reasonOf = (stageId: string): string | undefined => {
    const row = db
      .query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'stage.retrying' ORDER BY seq DESC LIMIT 1")
      .get(stageId);
    if (!row) return undefined;
    try {
      return (JSON.parse(row.payload_json) as { reason?: string | null }).reason ?? undefined;
    } catch {
      return undefined;
    }
  };
  // A passed stage whose close is not queued yet: since when a sweep first saw it (5.3b: a lost turn-end report).
  const awaitingSince = new Map<string, number>();
  // When a sweep first saw a stage running (the time-out clock). Memory only: a hub restart starts the clock again.
  const runningSeen = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const roomOfStage = (stageId: string): string | null =>
    db.query<{ room: string | null }, [string]>(`SELECT ${STAGE_ROOM_SQL} AS room FROM stage s WHERE s.id = ?`).get(stageId)?.room ?? null;

  /** A stage that ended for good by a second failure: tell the Orchestrator. It never throws. */
  function reportFinalFailure(stageId: string, reason: string, cap: HubCapabilities): void {
    try {
      const stage = api.load(stageId);
      if (stage?.status === "failed") opts.onFinalFailure?.({ stage, room: roomOfStage(stageId), reason }, cap);
    } catch (e) {
      console.error(`[stage] could not report the failure of ${stageId}:`, e);
    }
  }

  /**
   * A stop (5.3): close the session, then end the attempt. Attempt 1 goes to `retrying` and the free-slot start relaunches it
   * with the reason; attempt 2 goes to `failed` and the Orchestrator hears of it. The close is queued first, so the old session
   * name is reserved when the relaunch picks a name.
   */
  function stopStage(stage: StageSnapshot, reason: string, cap: HubCapabilities): void {
    const live = api.load(stage.id);
    if (!live || live.status !== "running") return;
    turnEnds.delete(stage.id);
    refused.delete(stage.id);
    runningSeen.delete(stage.id);
    if (live.session) {
      closing.set(live.session, { role: live.role, room: roomOfStage(stage.id), stageId: stage.id });
      queue.push({ id: mintLaunchId(), kind: "close", session: live.session });
    }
    api.move(stage.id, { to: live.attempt < MAX_ATTEMPT ? "retrying" : "failed", reason }, "system", cap);
    reportFinalFailure(stage.id, reason, cap);
  }

  function sweep(cap: HubCapabilities, now: number = Date.now()): void {
    // A passed stage whose turn-end report never came (5.3b): after the grace, queue its close anyway.
    for (const session of [...awaitingClose]) {
      const since = awaitingSince.get(session) ?? now;
      awaitingSince.set(session, since);
      if (now - since < (opts.closeGraceMs ?? 120_000)) continue;
      awaitingClose.delete(session);
      awaitingSince.delete(session);
      queue.push({ id: mintLaunchId(), kind: "close", session });
    }
    const running = db.query<{ id: string }, []>("SELECT id FROM stage WHERE status = 'running' AND session IS NOT NULL").all();
    const ids = new Set(running.map((r) => r.id));
    for (const id of runningSeen.keys()) if (!ids.has(id)) runningSeen.delete(id);
    for (const { id } of running) {
      try {
        const stage = api.load(id);
        if (!stage || stage.status !== "running") continue;
        const since = runningSeen.get(id) ?? now;
        runningSeen.set(id, since);
        const room = roomOfStage(id);
        const limitMin = (room ? getRoomSettings(db, room)?.stage_timeout_min : null) ?? DEFAULT_STAGE_TIMEOUT_MIN;
        if (now - since >= limitMin * 60_000) stopStage(stage, `the session ran past the time-out of ${limitMin} minutes`, cap);
        else if (now - since >= (opts.bootGraceMs ?? 90_000) && !cap.agents.get(stage.session!)) stopStage(stage, "the session left the room", cap);
      } catch (e) {
        console.error(`[stage] sweep of ${id} failed:`, e);
      }
    }
  }

  /**
   * The commit of the spec handoff that made this spec stage (context.commit), else null (HEAD). onSpecHandoff creates the stage
   * right after the handoff is recorded, so that handoff is the newest one of the request whose creation event is before the
   * stage's own `created_seq`. A later handoff of the same request has its own stage and its own commit.
   */
  const specCommit = (requestId: string, room: string, stageSeq: number): string | null =>
    db
      .query<{ c: string | null }, [string, number, string]>(
        `SELECT json_extract(h.context_json, '$.commit') AS c
           FROM handoffs h
          WHERE h.to_agent = 'role:validator' AND json_extract(h.context_json, '$.request_id') = ?1 AND h.room = ?3
            AND (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) < ?2
          ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) DESC LIMIT 1`,
      )
      .get(requestId, stageSeq, room)?.c ?? null;

  /** The room lead: where a spec result goes. Same default as the ticket kind. */
  const leadOfRoom = (room: string | null): string =>
    (room ? db.query<{ agent: string }, [string]>("SELECT agent FROM ticket_room_lead WHERE room = ?").get(room)?.agent : undefined) ?? "Orchestrator";

  /** The request text, spec paths and scope tickets of a spec stage, from its handoff and its scope. */
  function specFirstMessage(stage: { id: string; request_id: string | null }, room: string, worktree: string, reason?: string): string | null {
    const seq = db.query<{ n: number }, [string]>("SELECT created_seq AS n FROM stage WHERE id = ?").get(stage.id)?.n ?? 0;
    const ctx = db
      .query<{ c: string | null }, [string, number, string]>(
        `SELECT h.context_json AS c FROM handoffs h
          WHERE h.to_agent = 'role:validator' AND json_extract(h.context_json, '$.request_id') = ?1 AND h.room = ?3
            AND (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) < ?2
          ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) DESC LIMIT 1`,
      )
      .get(stage.request_id ?? "", seq, room)?.c;
    let c: { request_text?: unknown; spec_paths?: unknown; commit?: unknown } = {};
    try { c = ctx ? JSON.parse(ctx) : {}; } catch { /* no context: an empty request text */ }
    const scope = db
      .query<{ id: string; title: string; acceptance_criteria: string; role: string | null; blast_radius: string }, [string]>(
        "SELECT t.id, t.title, t.acceptance_criteria, t.role, t.blast_radius FROM stage_scope s JOIN tickets t ON t.id = s.ticket_id WHERE s.stage_id = ? ORDER BY t.id",
      )
      .all(stage.id)
      .map((t) => ({
        ...t,
        blocked_by: db.query<{ blocker_id: string }, [string]>("SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ? ORDER BY blocker_id").all(t.id).map((b) => b.blocker_id),
      }));
    // Findings of the FAIL results of this request since the last spec PASS that began before this stage (spec-review-stage 2.5).
    const lastPass = db
      .query<{ n: number | null }, [string, number, string]>(
        `SELECT MAX(s.created_seq) AS n FROM stage s WHERE s.review = 'spec' AND s.request_id = ?1 AND s.verdict = 'PASS' AND s.created_seq < ?2 AND ${STAGE_ROOM_SQL} = ?3`,
      )
      .get(stage.request_id ?? "", seq, room)?.n ?? 0;
    const earlierFindings: Array<{ ticket_id: string; severity: string; text: string }> = [];
    const results = db
      .query<{ c: string | null }, [string, number, number, string]>(
        `SELECT h.context_json AS c FROM handoffs h
          WHERE json_extract(h.context_json, '$.review') = 'spec' AND json_extract(h.context_json, '$.request_id') = ?1 AND h.room = ?4
            AND json_extract(h.context_json, '$.verdict') = 'FAIL'
            AND (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) > ?2
            AND (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id) < ?3
          ORDER BY (SELECT MIN(e.seq) FROM events e WHERE e.entity_id = h.id)`,
      )
      .all(stage.request_id ?? "", lastPass, seq, room);
    for (const r of results) {
      try {
        for (const f of (JSON.parse(r.c ?? "{}") as { findings?: Array<{ ticket_id?: unknown; severity?: unknown; text?: unknown }> }).findings ?? []) {
          if (typeof f.ticket_id === "string" && typeof f.text === "string") earlierFindings.push({ ticket_id: f.ticket_id, severity: typeof f.severity === "string" ? f.severity : "blocking", text: f.text });
        }
      } catch { /* an unreadable result adds no finding */ }
    }
    return renderSpecFirstMessage({
      stageId: stage.id,
      requestId: stage.request_id ?? "",
      worktree,
      commit: typeof c.commit === "string" ? c.commit : null,
      earlierFindings,
      recipient: leadOfRoom(room),
      requestText: typeof c.request_text === "string" ? c.request_text : "",
      specPaths: Array.isArray(c.spec_paths) ? c.spec_paths.filter((x): x is string => typeof x === "string") : [],
      scope,
      reason,
    });
  }

  /** `<role>-<n>` with the lowest n that no live session (launching or running, in any room) of the role uses. */
  function nextSessionName(role: string): string {
    // A name whose close has no ack is not free: the old session may still exist.
    const reserved = queue.pendingCloses();
    const used = new Set(
      db
        .query<{ session: string }, [string]>("SELECT session FROM stage WHERE role = ? AND status IN ('launching', 'running') AND session IS NOT NULL")
        .all(role)
        .map((r) => r.session),
    );
    for (const name of reserved) used.add(name);
    // A passed stage keeps its session until its turn ends: the name is not free yet.
    for (const name of awaitingClose) if (name.startsWith(`${role}-`)) used.add(name);
    let n = 1;
    while (used.has(`${role}-${n}`)) n++;
    return `${role}-${n}`;
  }

  function evaluateStages(ticketId: string, cap: HubCapabilities, handoffs: RoleHandoff[] = [], eopts: { launch?: boolean } = {}): StageSnapshot[] {
    const t = db.query<{ status: string; role: string | null }, [string]>("SELECT status, role FROM tickets WHERE id = ?").get(ticketId);
    if (!t || t.status === "draft" || t.status === "done" || t.status === "cancelled") return [];
    const openBlocker = db
      .query<{ blocker_id: string }, [string]>(
        "SELECT b.blocker_id FROM ticket_blockers b LEFT JOIN tickets x ON x.id = b.blocker_id WHERE b.ticket_id = ? AND COALESCE(x.status, '') != 'done' LIMIT 1",
      )
      .get(ticketId);
    if (openBlocker) return [];

    const all = [...(opts.roleHandoffs ?? storedRoleHandoffs)(ticketId), ...handoffs].filter((h) => isRole(h.role));
    const roles = new Set<string>(all.map((h) => h.role));
    if (t.role && isRole(t.role)) roles.add(t.role);

    const created: StageSnapshot[] = [];
    for (const role of roles) {
      const live = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM stage WHERE ticket_id = ? AND role = ? AND status IN ('queued', 'launching', 'running', 'retrying') LIMIT 1",
        )
        .get(ticketId, role);
      if (live) continue;
      const last = db
        .query<{ seq: number | null }, [string, string]>("SELECT MAX(created_seq) AS seq FROM stage WHERE ticket_id = ? AND role = ?")
        .get(ticketId, role)!.seq;
      const first = role === t.role && last === null;
      const handed = all.some((h) => h.role === role && (last === null || h.seq > last));
      if (!first && !handed) continue;
      created.push(api.create({ ticket_id: ticketId, role }, "system", cap));
    }
    if (eopts.launch) {
      const room = db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(ticketId)!.room;
      for (const stage of created) {
        // TODO(4.3, 4.5): the real first message and the worktree path. Until then the launch has no prompt and no cwd.
        const r = enqueueLaunch(
          { stage_id: stage.id, session: nextSessionName(stage.role), room, harness: roleHarness(stage.role), cwd: null, prompt: "" },
          cap,
        );
        if (!r.ok) console.log(`[stage] ${stage.id} stays queued: ${r.reason}`);
      }
    }
    return created;
  }

  /** Removes the temporary (detached) worktree of a stage's session. Branch roles keep theirs for the next session of the ticket. */
  function removeTemporaryWorktree(stage: StageSnapshot, room: string): void {
    const key = worktreeKey(stage);
    if (!stage.session || !key || BRANCH_ROLES.has(stage.role)) return;
    const project = getRoomSettings(db, room)?.project_folder;
    if (project) removeWorktree(project, join(worktreesRoot(), pathSegment(room), pathSegment(key), pathSegment(stage.session)));
  }

  /**
   * A slot of `freed.role` is free in the room of its ticket: start the queued stages of that role in that room, oldest
   * first (created_seq). enqueueLaunch checks the ticket and the role limit again, so a stage that cannot start (draft,
   * blocked, limit) stays queued and the next one is tried. It never throws: the move that freed the slot is committed.
   */
  function drainQueue(freed: StageSnapshot, cap: HubCapabilities): void {
    try {
      const room = db
        .query<{ room: string | null }, [string]>(`SELECT ${STAGE_ROOM_SQL} AS room FROM stage s WHERE s.id = ?`)
        .get(freed.id)?.room;
      if (!room) return;
      // 4.5: a temporary worktree goes when no session runs in it. While a close is pending for the session (a passed or
      // stopped stage), the session may still run: the worktree goes at the close ack, in onCloseEnd (6.5 fix).
      if ((freed.status === "failed" || freed.status === "retrying") && !(freed.session && closing.has(freed.session))) removeTemporaryWorktree(freed, room);
      startWaiting(freed.role, room, cap);
    } catch (e) {
      console.error(`[stage] starting queued ${freed.role} stages failed:`, e);
    }
  }

  /** Starts the stages of `role` that wait in `room`: retrying ones first, then queued ones by age. Each launch checks the limits again. */
  function startWaiting(role: string, room: string, cap: HubCapabilities): void {
    try {
      const waiting = db
        .query<{ id: string }, [string, string]>(
          // A stage waiting for its relaunch (5.3) goes before the queued ones: it already held a slot.
          `SELECT s.id FROM stage s WHERE s.role = ? AND s.status IN ('queued', 'retrying') AND ${STAGE_ROOM_SQL} = ?
            ORDER BY (s.status = 'retrying') DESC, s.created_seq, s.rowid`,
        )
        .all(role, room);
      for (const { id } of waiting) {
        const r = enqueueLaunch(
          { stage_id: id, session: nextSessionName(role), room, harness: roleHarness(role), cwd: null, prompt: "", reason: api.load(id)?.status === "retrying" ? reasonOf(id) : undefined },
          cap,
        );
        if (!r.ok) console.log(`[stage] ${id} stays queued: ${r.reason}`);
      }
    } catch (e) {
      console.error(`[stage] starting queued ${role} stages failed:`, e);
    }
  }

  function enqueueLaunch(input: LaunchInput, cap: HubCapabilities): LaunchResult {
    const stage = api.load(input.stage_id);
    if (!stage) return { ok: false, reason: "no such stage" };
    if (stage.status !== "queued" && stage.status !== "retrying") return { ok: false, reason: `stage is ${stage.status}` };
    if (queue.pendingCloses().includes(input.session)) {
      return { ok: false, reason: `session name ${input.session} is reserved until its close is acked` };
    }
    if (stage.ticket_id) {
      const t = db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(stage.ticket_id);
      if (!t) return { ok: false, reason: "no such ticket" };
      if (t.status === "draft" || t.status === "done" || t.status === "cancelled") return { ok: false, reason: `ticket is ${t.status}` };
      const open = db
        .query<{ blocker_id: string }, [string]>(
          "SELECT b.blocker_id FROM ticket_blockers b LEFT JOIN tickets t ON t.id = b.blocker_id WHERE b.ticket_id = ? AND COALESCE(t.status, '') != 'done' LIMIT 1",
        )
        .get(stage.ticket_id);
      if (open) return { ok: false, reason: `blocked by ${open.blocker_id}` };
    }
    // One live spec stage per request (spec-review-stage 2.3): a later one stays queued until the live one ends.
    if (stage.review === "spec") {
      const live = db
        .query<{ id: string }, [string, string, string]>(
          `SELECT s.id FROM stage s WHERE s.review = 'spec' AND s.request_id = ? AND s.id != ? AND s.status IN ('launching', 'running', 'retrying') AND ${STAGE_ROOM_SQL} = ? LIMIT 1`,
        )
        .get(stage.request_id ?? "", stage.id, input.room);
      if (live) return { ok: false, reason: `a spec review of request ${stage.request_id} is already live (${live.id})` };
    }
    // A spec stage counts against the validator limit of the room of its scope tickets (spec-review-stage 2.4).
    if (!isRole(stage.role)) return { ok: false, reason: `unknown role ${stage.role}` };
    const limit = (getRoomSettings(db, input.room)?.role_limits ?? DEFAULT_ROLE_LIMITS)[stage.role];
    const live = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM stage s WHERE s.role = ? AND s.status IN ('launching', 'running') AND ${STAGE_ROOM_SQL} = ?`,
      )
      .get(stage.role, input.room)!.n;
    // The previous session of this very stage must be closed first, whatever slot is free: both would use one worktree (5.3c).
    for (const [session, c] of closing) {
      if (c.stageId === stage.id) return { ok: false, reason: `the close of ${session} is not acked yet` };
    }
    // A session that ended but is not closed yet still holds its slot and its worktree (5.3b).
    const closingNow = [...closing.values()].filter((c) => c.role === stage.role && c.room === input.room).length;
    if (live + closingNow >= limit) return { ok: false, reason: `role ${stage.role} is at its limit (${limit}) in room ${input.room}` };

    // 4.5: the hub makes the worktree; the shell only starts in it. A spec stage gets a detached read-only one at the
    // commit of its handoff, or HEAD (spec-review 2.4), under the request instead of a ticket.
    let cwd = input.cwd;
    let branch: string | null = null;
    const wtKey = worktreeKey(stage);
    if (wtKey && cwd === null) {
      const project = getRoomSettings(db, input.room)?.project_folder;
      if (!project) {
        // No attempt is counted: queued -> failed without going through launching.
        api.move(input.stage_id, { to: "failed" }, "system", cap);
        console.error(`[stage] ${input.stage_id} failed: ${NO_PROJECT_FOLDER}`);
        return { ok: false, reason: NO_PROJECT_FOLDER };
      }
      try {
        const wt = createWorktree({
          project, room: input.room, ticketId: wtKey, session: input.session, role: stage.role,
          commit: stage.ticket_id
            ? handoffCommit(stage.id, stage.ticket_id, stage.role)
            : specCommit(stage.request_id ?? "", input.room, db.query<{ n: number }, [string]>("SELECT created_seq AS n FROM stage WHERE id = ?").get(stage.id)?.n ?? 0),
        });
        cwd = wt.path;
        branch = wt.branch;
      } catch (e) {
        return { ok: false, reason: `worktree: ${(e as Error).message}` };
      }
    }

    try {
      api.move(
        input.stage_id,
        { to: "launching", session: input.session, slot_seq: input.slot_seq ?? null },
        "system",
        cap,
        (ctx) => {
          input.extra?.(ctx);
          // stage.launching and ticket.assigned (actor system) commit together: the one cross-kind transaction.
          // A spec-review stage has no ticket and skips this. A failure here rolls the launch back.
          return stage.ticket_id ? assignBySystemInTx(db, stage.ticket_id, input.session) : null;
        },
        (assigned) => {
          const a = assigned as ReturnType<typeof assignBySystemInTx>;
          if (!a) return;
          cap.sse.emit(a.entry, { kind: "room", room: a.snapshot.room });
          cap.briefing.refresh();
        },
      );
    } catch (e) {
      if (e instanceof LedgerConflict) return { ok: false, reason: e.message };
      throw e;
    }
    // 4.3: the ticket part of the first message; the role prompt is a separate file passed by the launch command.
    let prompt = input.prompt;
    if (prompt === "" && stage.ticket_id && cwd) {
      const t = db
        .query<{ id: string; title: string; acceptance_criteria: string; blast_radius: string; request_id: string | null }, [string]>(
          "SELECT id, title, acceptance_criteria, blast_radius, request_id FROM tickets WHERE id = ?",
        )
        .get(stage.ticket_id);
      if (t) prompt = renderFirstMessage({ stageId: input.stage_id, role: stage.role, ticket: t, branch, worktree: cwd, reason: input.reason, recipient: leadOfRoom(input.room), handoff: startingHandoff(stage.id, stage.ticket_id, stage.role) ?? undefined });
    } else if (prompt === "" && stage.review === "spec" && cwd) {
      prompt = specFirstMessage(stage, input.room, cwd, input.reason) ?? "";
    }
    const req: LaunchRequest = {
      id: mintLaunchId(),
      kind: "launch",
      stage_id: input.stage_id,
      session: input.session,
      role: stage.role,
      room: input.room,
      harness: input.harness,
      cwd,
      prompt,
      env: {
        ...(input.env ?? {}),
        CHATBRIDGE_AGENT: input.session,
        CHATBRIDGE_ROOM: input.room,
        CUBILOT_STAGE_ID: input.stage_id,
      },
    };
    queue.push(req);
    return { ok: true, request_id: req.id };
  }

  /**
   * A second FAIL (or later) since the last PASS of the request goes to the human as a `ui-only` system entry with the
   * findings of THIS FAIL (spec-review-stage 4.2). The count is read from the spec stages of the request: the FAIL
   * stages created after the newest PASS stage. A PASS in between resets it. It never throws: the result is recorded.
   */
  function noticeRepeatedFail(stageId: string, result: Record<string, unknown>, cap: HubCapabilities): void {
    try {
      const stage = api.load(stageId);
      if (!stage || stage.review !== "spec" || !stage.request_id) return;
      // The count is the room's own: the same request id in another room is another request (4.3 review).
      const room = roomOfStage(stageId);
      if (!room) return;
      const { fails } = specFailState(db, room, stage.request_id);
      if (fails < 2) return;
      const titles = new Map(
        db
          .query<{ id: string; title: string }, [string]>("SELECT t.id, t.title FROM stage_scope s JOIN tickets t ON t.id = s.ticket_id WHERE s.stage_id = ?")
          .all(stageId)
          .map((t) => [t.id, t.title]),
      );
      const findings = (Array.isArray(result.findings) ? result.findings : []).flatMap((f) => {
        const o = f && typeof f === "object" ? (f as Record<string, unknown>) : null;
        return o && typeof o.ticket_id === "string" && typeof o.text === "string"
          ? [{ ticket_id: o.ticket_id, severity: o.severity === "suggestion" ? "suggestion" : "blocking", text: o.text }]
          : [];
      });
      findings.sort((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking"));
      const lines = [
        `Spec review of ${stage.request_id} failed ${fails} times since its last PASS. Findings of the latest FAIL:`,
        ...(findings.length ? findings.map((f) => `- [${f.severity}] ${f.ticket_id}${titles.has(f.ticket_id) ? ` (${titles.get(f.ticket_id)})` : ""}: ${f.text}`) : ["- (no findings listed)"]),
      ];
      cap.sse.emit(
        { from: "system", to: cap.config.humanName, text: lines.join("\n"), ts: new Date().toISOString(), image: null, room } as Entry,
        { kind: "ui-only" },
      );
    } catch (e) {
      console.error(`[stage] the second-FAIL notice of ${stageId} failed:`, e);
    }
  }

  function passSpecStage(stageId: string, cap: HubCapabilities): { stage: StageSnapshot; queued: string[]; waitingForApproval: boolean } {
    const prior = api.load(stageId);
    if (!prior || prior.review !== "spec") throw new LedgerConflict(404, "not a spec stage", null);
    if (prior.status !== "running") throw new LedgerConflict(409, `spec stage is ${prior.status}, not running`, prior);
    const all = db.query<{ ticket_id: string; room: string; status: string; request_id: string | null }, [string]>(
      "SELECT s.ticket_id, t.room, t.status, t.request_id FROM stage_scope s JOIN tickets t ON t.id = s.ticket_id WHERE s.stage_id = ? ORDER BY s.ticket_id",
    ).all(stageId);
    // Only a scope ticket that is still a draft of this request is promoted: one that moved on or left the request
    // after the review began was not reviewed as it stands now.
    const scope = all.filter((t) => t.status === "draft" && t.request_id === prior.request_id);
    const room = all[0]?.room;
    const high = room
      ? db.query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM tickets WHERE request_id = ? AND room = ? AND blast_radius = 'high' AND status NOT IN ('done', 'cancelled')",
        ).get(prior.request_id ?? "", room)!.n > 0
      : false;
    const queuedNow: Array<NonNullable<ReturnType<typeof queueBySystemInTx>>> = [];
    const stage = api.move(
      stageId,
      { to: "passed", verdict: "PASS" },
      "system",
      cap,
      () => {
        // A ticket that left `draft` meanwhile is skipped. With a high ticket in the request nothing moves.
        if (high) return;
        for (const { ticket_id } of scope) {
          const q = queueBySystemInTx(db, cap, ticket_id, prior.request_id);
          if (q) queuedNow.push(q);
        }
      },
      () => {
        for (const q of queuedNow) cap.sse.emit(q.entry, { kind: "room", room: q.snapshot.room });
        if (queuedNow.length) cap.briefing.refresh();
      },
    );
    for (const q of queuedNow) {
      try {
        evaluateStages(q.snapshot.id, cap, [], { launch: true });
      } catch (e) {
        console.error(`[stage] evaluating ${q.snapshot.id} after the spec PASS failed:`, e);
      }
    }
    return { stage, queued: queuedNow.map((q) => q.snapshot.id), waitingForApproval: high && scope.length > 0 };
  }

  /**
   * One end of turn of a stage session. A passed stage: queue the close, once. A running stage: the first end without a
   * result sends one reminder; a later one changes nothing here ("stop": 5.3 owns the retry).
   */
  function turnEnd(stage: StageSnapshot, cap: HubCapabilities): "close" | "reminder" | "stop" | "none" {
    const session = stage.session!;
    if (stage.status === "passed") {
      if (!awaitingClose.delete(session)) return "none";
      awaitingSince.delete(session);
      queue.push({ id: mintLaunchId(), kind: "close", session });
      return "close";
    }
    if (stage.status !== "running") return "none";
    // The refusal woke the session for a new turn; the turn that ended now was the one that sent the bad result.
    if (refused.delete(stage.id)) return "none";
    const n = (turnEnds.get(stage.id) ?? 0) + 1;
    turnEnds.set(stage.id, n);
    if (n > 1) {
      stopStage(stage, "a second end of turn without a result", cap);
      return "stop";
    }
    const room = stage.ticket_id ? (db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(stage.ticket_id)?.room ?? null) : null;
    cap.sse.emit(
      {
        from: "system",
        to: session,
        text: `Your turn ended and the hub has no result from you. Send your result handoff now. It must name context.stage_id ${stage.id}${stage.ticket_id ? ` and context.ticket_id ${stage.ticket_id}` : ""}.`,
        ts: new Date().toISOString(),
        image: null,
        room,
        kind: "stage.reminder",
      } as Entry,
      { kind: "to-agents", agents: [session] },
    );
    return "reminder";
  }

  const routes: RouteDef[] = [
    {
      method: "GET",
      path: "/stages",
      auth: "read",
      handler: (req) => {
        const url = new URL(req.url);
        const status = url.searchParams.get("status") ?? "queued";
        const role = url.searchParams.get("role") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;
        if (status !== "all" && !STAGE_STATUSES.has(status)) {
          return Response.json({ error: `invalid status: ${status}` }, { status: 400 });
        }
        if (role !== undefined && !validName(role)) {
          return Response.json({ error: `invalid role: ${role}` }, { status: 400 });
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return Response.json({ error: "invalid limit" }, { status: 400 });
        }
        const statuses = status === "all" ? [...STAGE_STATUSES] : [status];
        const list = statuses.flatMap((s) => entity.listByStatus({ status: s, for: role, limit })).slice(0, limit);
        return Response.json(list);
      },
    },
    {
      // Requests of one room that wait for the human's approval (spec-review-stage 3.4b). Read only.
      method: "GET",
      path: /^\/requests\/([^/]+)\/waiting$/,
      auth: "read",
      handler: (_req, _cap, params) => {
        const room = decodeURIComponent(params.id);
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        return Response.json({ room, waiting: waitingRequests(db, room) });
      },
    },
    {
      // Requests of one room whose spec review failed twice or more, with the findings of the latest FAIL (spec-review-stage 4.3). Read only.
      method: "GET",
      path: /^\/requests\/([^/]+)\/needs-you$/,
      auth: "read",
      handler: (_req, _cap, params) => {
        const room = decodeURIComponent(params.id);
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        return Response.json({ room, requests: needsYouRequests(db, room) });
      },
    },
    {
      method: "GET",
      path: /^\/stages\/([^/]+)$/,
      auth: "read",
      handler: (_req, _cap, params) => {
        if (!STAGE_ID_RE.test(params.id)) return Response.json({ error: "invalid stage id" }, { status: 400 });
        const snap = entity.load(params.id);
        return snap ? Response.json(snap) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
  ];

  routes.push(
    {
      // The bridge of a stage session reports the end of a turn (5.2). Only that session may report.
      method: "POST",
      path: /^\/stages\/([^/]+)\/turn-end$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        if (!STAGE_ID_RE.test(params.id)) return Response.json({ error: "invalid stage id" }, { status: 400 });
        const raw: unknown = await req.json().catch(() => null);
        const agent = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { agent?: unknown }).agent : undefined;
        if (typeof agent !== "string" || !validName(agent)) return Response.json({ error: "invalid agent" }, { status: 400 });
        const stage = api.load(params.id);
        if (!stage) return Response.json({ error: "not found" }, { status: 404 });
        if (stage.session !== agent) return Response.json({ error: "not the session of this stage" }, { status: 403 });
        return Response.json({ action: turnEnd(stage, cap) });
      },
    },
    {
      method: "GET",
      path: "/launches/stream",
      auth: "read",
      handler: (_req, cap) =>
        makeSSE(async (send, signal) => {
          queue.attach((r) => send(r, r.id), signal, cap);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }),
    },
    {
      method: "POST",
      path: /^\/launches\/([^/]+)\/ack$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        if (!LAUNCH_ID_RE.test(params.id)) return Response.json({ error: "invalid launch id" }, { status: 400 });
        const raw: unknown = await req.json().catch(() => null);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return Response.json({ error: "the body must be a JSON object" }, { status: 400 });
        }
        const body = raw as { result?: unknown; error?: unknown; absent?: unknown };
        if (body.absent !== undefined && (typeof body.absent !== "boolean" || body.result !== "error")) {
          return Response.json({ error: "absent must be a boolean and goes with result error" }, { status: 400 });
        }
        if (body.result !== "spawned" && body.result !== "error") {
          return Response.json({ error: "result must be spawned or error" }, { status: 400 });
        }
        const error = typeof body.error === "string" ? body.error.slice(0, 500) : "";
        if (body.result === "error" && !error) return Response.json({ error: "an error ack needs error text" }, { status: 400 });
        let r;
        try {
          r = queue.ack(params.id, body.result === "spawned" ? { result: "spawned" } : { result: "error", error, ...(body.absent === true ? { absent: true } : {}) }, cap);
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
        if (r.status === "error") return Response.json({ error: r.message }, { status: 500 });
        if (r.status === "pending") return Response.json({ ok: true, pending: true, message: r.message }, { status: 200 });
        if (r.status === "unknown") return Response.json({ error: "not found" }, { status: 404 });
        if (r.status === "conflict") return Response.json({ error: r.message }, { status: 409 });
        return Response.json(r.status === "idempotent" ? { idempotent: true } : { ok: true }, { status: 200 });
      },
    },
  );

  const module: KindModule = {
    kind: "stage",
    migrate: (d: Database) => entity.migrate(d),
    routes: withLedgerRequired(routes),
    // A stage is the hub's own bookkeeping: agents never get a stage replayed on reconnect.
    pendingFor: (_agent: AgentCtx, _cap: HubCapabilities) => [],
    toolNames: [],
    dispose: () => {
      if (sweepTimer) clearInterval(sweepTimer);
      queue.dispose();
    },
    // The launch queue lives in memory. A launch the hub had sent, or queued, before a restart is gone, so each stage
    // still `launching` counts as a launch with no ack (attempt 1 -> retrying, attempt 2 -> failed; 5.3 relaunches).
    start: (cap) => {
      const stuck = db.query<{ id: string }, []>("SELECT id FROM stage WHERE status = 'launching' ORDER BY rowid").all();
      for (const { id } of stuck) {
        try {
          endLaunchAttempt(api, id, cap, "the hub restarted before the shell acked");
          reportFinalFailure(id, "the hub restarted before the launch was acked", cap);
        } catch (e) {
          console.error(`[stage] could not settle stage ${id} at start:`, e);
        }
      }
      if (stuck.length) console.log(`[stage] ${stuck.length} stage(s) in launching settled at start`);
      // 5.2 kept "close at the next turn end" in memory only. A passed stage whose session name no live stage holds may still
      // have its session open: queue one close for it. A close of a session that is gone is acked as absent (harmless).
      const passed = db
        .query<{ session: string; role: string; id: string }, []>(
          `SELECT p.session AS session, p.role AS role, p.id AS id FROM stage p WHERE p.status = 'passed' AND p.session IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM stage l WHERE l.session = p.session AND l.status IN ('launching', 'running'))
              AND p.rowid = (SELECT MAX(q.rowid) FROM stage q WHERE q.session = p.session)`,
        )
        .all();
      for (const { session, role, id } of passed) {
        closing.set(session, { role, room: roomOfStage(id), stageId: id }); // the slot is held until the close is acked
        queue.push({ id: mintLaunchId(), kind: "close", session });
      }
      // 5.3b: a stage persisted as `retrying` lost its relaunch with the process. Start it again; the reason comes from its event.
      const waitingRelaunch = db
        .query<{ id: string; role: string }, []>("SELECT id, role FROM stage WHERE status = 'retrying' ORDER BY rowid")
        .all();
      for (const w of new Set(waitingRelaunch.map((r) => `${r.role}\u0000${roomOfStage(r.id) ?? ""}`))) {
        const [role, room] = w.split("\u0000");
        if (room) startWaiting(role, room, cap);
      }
      sweepTimer = setInterval(() => sweep(cap), opts.sweepMs ?? 30_000);
      (sweepTimer as { unref?: () => void }).unref?.();
    },
  };
  const hooks: StageHooks = {
    completedStage(from, context) {
      const id = context && typeof context === "object" && !Array.isArray(context) ? (context as Record<string, unknown>).stage_id : undefined;
      if (typeof id !== "string") return null;
      const row = db.query<{ id: string; status: string }, [string]>("SELECT id, status FROM stage WHERE id = ? AND status IN ('passed', 'failed')").get(id);
      if (!row) return null;
      const own = db.query<{ id: string }, [string]>("SELECT id FROM stage WHERE session = ? AND status = 'running' LIMIT 1").get(from);
      return own
        ? `stage ${row.id} is already ${row.status}. Your running stage is ${own.id}. Send your result with that stage_id.`
        : `stage ${row.id} is already ${row.status}; it takes no more results`;
    },
    checkResult(from, context, cap, to) {
      const stage = db
        .query<{ id: string; ticket_id: string | null; role: string; review: string | null; request_id: string | null }, [string]>(
          "SELECT id, ticket_id, role, review, request_id FROM stage WHERE session = ? AND status = 'running' LIMIT 1",
        )
        .get(from);
      if (!stage) return null;
      const errors: string[] = [];
      const c = context && typeof context === "object" && !Array.isArray(context) ? (context as Record<string, unknown>) : null;
      if (!c) errors.push("context must be an object");
      else if (stage.review === "spec") {
        // The result goes to the Orchestrator of the room (spec-review-stage 4.1b); the error goes back to this session.
        if (to !== undefined) {
          const lead = leadOfRoom(roomOfStage(stage.id));
          if (to !== lead) errors.push(`a spec review result must be sent to ${lead}, not to ${to}`);
        }
        // Spec result (spec-review-stage 3.1): the schema of the request-level review.
        if (c.stage_id !== stage.id) errors.push(`context.stage_id must be ${stage.id}`);
        if (c.review !== "spec") errors.push('context.review must be "spec"');
        if (c.request_id !== stage.request_id) errors.push(`context.request_id must be ${stage.request_id}`);
        const verdictOk = typeof c.verdict === "string" && VERDICTS.has(c.verdict);
        if (!verdictOk) errors.push("context.verdict must be PASS or FAIL (upper case)");
        const scope = new Set(db.query<{ ticket_id: string }, [string]>("SELECT ticket_id FROM stage_scope WHERE stage_id = ?").all(stage.id).map((r) => r.ticket_id));
        let blocking = false;
        if (!Array.isArray(c.findings)) errors.push("context.findings must be a list of {ticket_id, severity, text}");
        else {
          c.findings.forEach((f, i) => {
            const o = f && typeof f === "object" ? (f as Record<string, unknown>) : null;
            if (!o || typeof o.ticket_id !== "string" || !scope.has(o.ticket_id)) errors.push(`context.findings[${i}].ticket_id must be a ticket in the scope of this review`);
            if (!o || (o.severity !== "blocking" && o.severity !== "suggestion")) errors.push(`context.findings[${i}].severity must be blocking or suggestion`);
            if (!o || typeof o.text !== "string" || !o.text.trim()) errors.push(`context.findings[${i}].text must be a non-empty string`);
            if (o?.severity === "blocking") blocking = true;
          });
        }
        const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
        if (!strings(c.questions_for_human)) errors.push("context.questions_for_human must be a list of strings (may be empty)");
        if (c.verdict === "PASS" && !strings(c.suggestions)) errors.push("context.suggestions must be a list of strings on PASS (may be empty)");
        if (c.verdict !== "PASS" && c.suggestions !== undefined && !strings(c.suggestions)) errors.push("context.suggestions must be a list of strings");
        if (c.verdict === "PASS" && blocking) errors.push("a PASS must not have a blocking finding");
      } else {
        if (c.stage_id !== stage.id) errors.push(`context.stage_id must be ${stage.id}`);
        if (c.ticket_id !== stage.ticket_id) errors.push(`context.ticket_id must be ${stage.ticket_id}`);
        if (REVIEW_ROLES.has(stage.role)) {
          if (typeof c.verdict !== "string" || !VERDICTS.has(c.verdict)) errors.push("context.verdict must be PASS or FAIL (upper case)");
          if (!Array.isArray(c.findings)) errors.push("context.findings must be a list of {ticket_id, text}");
          else {
            c.findings.forEach((f, i) => {
              const o = f && typeof f === "object" ? (f as Record<string, unknown>) : null;
              if (!o || typeof o.ticket_id !== "string" || !o.ticket_id || typeof o.text !== "string" || !o.text.trim()) {
                errors.push(`context.findings[${i}] needs a ticket_id and a text`);
              }
            });
          }
        }
      }
      if (errors.length) {
        refused.add(stage.id);
        const room = stage.ticket_id ? (db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(stage.ticket_id)?.room ?? null) : null;
        cap.sse.emit(
          {
            from: "system",
            to: from,
            text: JSON.stringify({ stage_id: stage.id, errors }),
            ts: new Date().toISOString(),
            image: null,
            room,
            kind: "stage.rejected",
          } as Entry,
          { kind: "to-agents", agents: [from] },
        );
      }
      return errors;
    },
    onResult(from, context, cap) {
      const stage = db
        .query<{ id: string; review: string | null; role: string; ticket_id: string | null }, [string]>("SELECT id, review, role, ticket_id FROM stage WHERE session = ? AND status = 'running' LIMIT 1")
        .get(from);
      if (!stage) return;
      refused.delete(stage.id); // a valid result ends any refusal flag
      const c = (context ?? {}) as Record<string, unknown>;
      // Reserve the name and the slot before the move: the move frees the slot and the queue may start a stage at once.
      // The slot stays held until the close is acked (5.3b).
      awaitingClose.add(from);
      closing.set(from, { role: stage.role, room: roomOfStage(stage.id), stageId: stage.id });
      try {
        if (stage.review === "spec") {
          // PASS: the scope tickets are queued. FAIL (spec-review 4.1): the stage passes as a record with verdict FAIL, no ticket
          // moves and nothing is relaunched; the findings stay in the result handoff, which the Validator sent to the Orchestrator.
          if (c.verdict === "PASS") passSpecStage(stage.id, cap);
          else {
            api.move(stage.id, { to: "passed", verdict: "FAIL" }, "system", cap);
            noticeRepeatedFail(stage.id, c, cap);
          }
        } else {
          // A final PASS of a validator or reviewer closes its ticket in the same transaction (the third cross-kind one).
          const ticketId = stage.ticket_id;
          const closes = !!ticketId && c.verdict === "PASS" && (stage.role === "validator" || stage.role === "reviewer");
          let closed: ReturnType<typeof closeReviewedBySystemInTx> = null;
          api.move(
            stage.id,
            { to: "passed", verdict: typeof c.verdict === "string" ? c.verdict : undefined },
            "system",
            cap,
            closes ? () => void (closed = closeReviewedBySystemInTx(db, cap, ticketId!)) : undefined,
            () => {
              if (!closed) return;
              cap.sse.emit(closed.entry, { kind: "room", room: closed.snapshot.room });
              cap.briefing.refresh();
            },
          );
          // A ticket that became done frees the tickets that wait for it.
          const done = closed as ReturnType<typeof closeReviewedBySystemInTx>;
          if (done?.snapshot.status === "done") {
            const waiting = db.query<{ ticket_id: string }, [string]>("SELECT ticket_id FROM ticket_blockers WHERE blocker_id = ? ORDER BY rowid").all(done.snapshot.id);
            for (const w of waiting) hooks.onTicketChanged(w.ticket_id, cap);
          }
        }
      } catch (e) {
        awaitingClose.delete(from);
        closing.delete(from);
        console.error(`[stage] recording the result of ${stage.id} failed:`, e);
      }
    },
    onTicketChanged(ticketId, cap) {
      try {
        evaluateStages(ticketId, cap, [], { launch: true });
      } catch (e) {
        // The ticket change is already committed. A later event (or a role handoff) evaluates the ticket again.
        console.error(`[stage] evaluating ${ticketId} after a ticket change failed:`, e);
      }
    },
    onSpecHandoff(h, cap) {
      try {
        // The scope rows are written in the transaction of stage.queued.
        const created = api.create({ request_id: h.request_id, review: "spec", role: "validator" }, "system", cap, (ctx) => {
          for (const t of h.scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
        });
        // Start the oldest queued validator stage of the room if a slot is free (this one, unless an older one waits).
        drainQueue(created, cap);
      } catch (e) {
        console.error(`[stage] creating the spec stage of ${h.request_id} failed:`, e);
      }
    },
    onRoleHandoff(h, cap) {
      try {
        evaluateStages(h.ticket_id, cap, [{ role: h.role, seq: h.seq }], { launch: true });
      } catch (e) {
        // The handoff is already recorded and counts as stored: a later evaluation creates the stage.
        console.error(`[stage] evaluating ${h.ticket_id} after a role handoff failed:`, e);
      }
    },
  };
  return { module, api, evaluateStages, hooks, enqueueLaunch, queue, passSpecStage, sweep };
}

export function createStageKind(db: Database): KindModule {
  return createStageRuntime(db, { ackMs: Number(process.env.CUBILOT_LAUNCH_ACK_MS) || undefined }).module;
}

export { STAGE_ID_RE };
