// Decision kind — rulings and human questions in one table (human-escalation spec, ruling R5).
// Start: `recorded` (arbiter ruling) or `open` (escalation). Legal moves: see LEGAL. `answered` is final.

import type { Database } from "bun:sqlite";
import type {
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
import { mintDecisionId, ts, validName, validRoomLabel } from "../core/ids";
import { pausedRefusal } from "../core/auth";
import { roomLead } from "./ticket";

// ---------- Types ----------

export type DecisionStatus = "recorded" | "applied" | "escalated" | "open" | "answered" | "overruled";
export type DecisionReason = "scope" | "feature" | "irreversible" | "security";

export type EscalationOption = { id: string; label: string; effect: string; recommended: boolean };
export type HumanAction = { ticket_id: string; action: string };
/** The escalation format of factory/orchestrator/unblocking.md. */
export type EscalationBody = {
  block: string;
  facts: string[];
  options: EscalationOption[];
  human_actions: HumanAction[];
  next: string;
};

export type DecisionSnapshot = {
  id: string;
  room: string;
  ticket_id: string | null;
  request_id: string | null;
  decider: "arbiter" | "human";
  fail_count: number;
  option: string | null;
  text: string | null;
  reason: DecisionReason | null;
  body: EscalationBody | null;
  status: DecisionStatus;
  created_by: string;
  created_at_ms: number;
  version: number;
};

const DECISION_ID_RE = /^d_[0-9a-f]{16}$/;
const TICKET_ID_RE = /^t_[0-9a-f]{16}$/;
const REASONS: ReadonlySet<string> = new Set(["scope", "feature", "irreversible", "security"]);
// A commit hash (7 to 40 hex digits with a digit in it) or a hub record id (ticket, decision, stage, handoff, request).
const FACT_REF_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|\b[tdsh]_[0-9a-f]{4,16}\b|\br-\d{4}-\d{2}-\d{2}-[\w-]+/;
const BLOCK_MAX = 300;
const LINE_MAX = 500;
const ANSWER_TEXT_MAX = 2_000;
const OPTION_ID_MAX = 64;
const FACTS_MAX = 20;
const ACTIONS_MAX = 20;
const NOTE_MAX_BYTES = 4_096; // the ticket note cap (ticket.ts TICKET_NOTE_MAX_BYTES)

/** from -> the statuses it may move to. Anything else is 409. `answered` has no way out. */
const LEGAL: Record<DecisionStatus, ReadonlySet<DecisionStatus>> = {
  recorded: new Set(["applied", "escalated"]),
  escalated: new Set(["answered"]),
  open: new Set(["answered"]),
  applied: new Set(["overruled"]),
  answered: new Set(),
  overruled: new Set(),
};

// ---------- StateMachine declaration ----------

const decisionDecl: StateMachineDecl<DecisionSnapshot> = {
  kind: "decision",
  table: "decisions",
  columns: {
    id: "TEXT",
    room: "TEXT",
    ticket_id: "TEXT_NULL",
    request_id: "TEXT_NULL",
    decider: "TEXT",
    fail_count: "INTEGER",
    option: "TEXT_NULL",
    text: "TEXT_NULL",
    reason: "TEXT_NULL",
    body: "JSON",
    status: "TEXT",
    created_by: "TEXT",
    created_at_ms: "INTEGER",
  },
  terminalStatuses: new Set(["answered", "overruled"]),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    room: row.room as string,
    ticket_id: (row.ticket_id as string | null) ?? null,
    request_id: (row.request_id as string | null) ?? null,
    decider: row.decider as "arbiter" | "human",
    fail_count: Number(row.fail_count),
    option: (row.option as string | null) ?? null,
    text: (row.text as string | null) ?? null,
    reason: (row.reason as DecisionReason | null) ?? null,
    body: row.body == null ? null : (JSON.parse(row.body as string) as EscalationBody),
    status: row.status as DecisionStatus,
    created_by: row.created_by as string,
    created_at_ms: Number(row.created_at_ms),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of ["id", "room", "ticket_id", "request_id", "decider", "fail_count", "option", "text", "reason", "status", "created_by", "created_at_ms"] as const) {
      if (snap[k] !== undefined) out[k] = snap[k];
    }
    if (snap.body !== undefined) out.body = snap.body === null ? null : JSON.stringify(snap.body);
    return out;
  },
};

// ---------- Entry projection ----------

/** A UI-only signal: the Needs-you line reads the decision again. No agent gets it. */
export function decisionEntry(snapshot: DecisionSnapshot, eventKind: string, actor: string): Entry {
  return {
    from: actor,
    to: "all",
    text: `[decision ${snapshot.id} ${snapshot.status}]`,
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    decision_id: snapshot.id,
    version: snapshot.version,
    snapshot,
  };
}

// ---------- Verbs ----------

export type CreateInput = {
  id: string;
  status: "recorded" | "open";
  room: string;
  ticket_id: string | null;
  request_id: string | null;
  decider: "arbiter" | "human";
  fail_count: number;
  option?: string | null;
  text?: string | null;
  reason?: DecisionReason | null;
  body?: EscalationBody | null;
};

const createVerb: VerbDecl<DecisionSnapshot, CreateInput> = {
  decide(prior, p, actor): Decision<DecisionSnapshot> {
    if (prior) return { kind: "conflict", httpStatus: 409, message: `decision ${p.id} already exists` };
    const initial: DecisionSnapshot = {
      id: p.id,
      room: p.room,
      ticket_id: p.ticket_id,
      request_id: p.request_id,
      decider: p.decider,
      fail_count: p.fail_count,
      option: p.option ?? null,
      text: p.text ?? null,
      reason: p.reason ?? null,
      body: p.body ?? null,
      status: p.status,
      created_by: actor,
      created_at_ms: Date.now(),
      version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: `decision.${p.status}`,
      payload: () => ({ actor, option: initial.option, text: initial.text, reason: initial.reason, ticket_id: p.ticket_id, request_id: p.request_id }),
      entry: (post) => decisionEntry(post, `decision.${p.status}`, actor),
    };
  },
  scope: () => ({ kind: "ui-only-ambient" }), // the lead gets its one entry from the answer route; no other agent sees a decision
};

type MoveInput = { to: DecisionStatus; option?: string | null; text?: string | null };

const moveVerb: VerbDecl<DecisionSnapshot, MoveInput> = {
  decide(prior, p, actor): Decision<DecisionSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    if (prior.status === p.to) return { kind: "idempotent" }; // same-status retry: 200, nothing written
    if (!LEGAL[prior.status].has(p.to)) {
      return { kind: "conflict", httpStatus: 409, message: `illegal move ${prior.status} -> ${p.to}` };
    }
    const next: Partial<DecisionSnapshot> = { status: p.to };
    if (p.option !== undefined) next.option = p.option;
    if (p.text !== undefined) next.text = p.text;
    return {
      kind: "transition",
      next,
      eventKind: `decision.${p.to}`,
      payload: (post) => ({ from: prior.status, actor, option: post.option, text: post.text }),
      entry: (post) => decisionEntry(post, `decision.${p.to}`, actor),
    };
  },
  scope: () => ({ kind: "ui-only-ambient" }), // the lead gets its one entry from the answer route; no other agent sees a decision
};

// ---------- Escalation format ----------

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;

type Escalation = { reason: DecisionReason; body: EscalationBody };

/** The five parts of the escalation format, or the first reason one is wrong. */
export function parseEscalation(b: Record<string, unknown>): Escalation | { error: string } {
  const reason = typeof b.reason === "string" ? b.reason : "";
  if (!REASONS.has(reason)) return { error: "reason must be scope, feature, irreversible or security" };
  const block = str(b.block, BLOCK_MAX);
  if (!block || /[\r\n]/.test(block) || /[.!?]\s+\S/.test(block)) return { error: `block must be one sentence on one line (max ${BLOCK_MAX} chars)` };
  if (!Array.isArray(b.facts) || b.facts.length < 1 || b.facts.length > FACTS_MAX) {
    return { error: `facts must be a list of 1 to ${FACTS_MAX} items` };
  }
  const facts = b.facts.map((f) => str(f, LINE_MAX));
  if (facts.some((f) => f === null)) return { error: `each fact must be text (max ${LINE_MAX} chars)` };
  if (!facts.every((f) => FACT_REF_RE.test(f as string))) return { error: "each fact must name a commit hash or a hub record id" };
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 3) {
    return { error: "options must be 2 or 3" };
  }
  const options: EscalationOption[] = [];
  for (const o of b.options as Array<Record<string, unknown> | null>) {
    const id = str(o?.id, OPTION_ID_MAX);
    const label = str(o?.label, LINE_MAX);
    const effect = str(o?.effect, LINE_MAX);
    if (!id || !label || !effect) return { error: "each option needs id, label and effect" };
    options.push({ id, label, effect, recommended: o?.recommended === true });
  }
  if (new Set(options.map((o) => o.id)).size !== options.length) return { error: "option ids must differ" };
  if (options.filter((o) => o.recommended).length !== 1) return { error: "exactly one option must be the recommendation" };
  if (!Array.isArray(b.human_actions) || b.human_actions.length < 1 || b.human_actions.length > ACTIONS_MAX) {
    return { error: `human_actions must be a list of 1 to ${ACTIONS_MAX} items` };
  }
  const human_actions: HumanAction[] = [];
  for (const a of b.human_actions as Array<Record<string, unknown> | null>) {
    const action = str(a?.action, LINE_MAX);
    if (typeof a?.ticket_id !== "string" || !TICKET_ID_RE.test(a.ticket_id) || !action) {
      return { error: "each human action needs a full ticket id and the exact action" };
    }
    human_actions.push({ ticket_id: a.ticket_id, action });
  }
  const next = str(b.next, LINE_MAX);
  if (!next) return { error: "next is required" };
  return { reason: reason as DecisionReason, body: { block, facts: facts as string[], options, human_actions, next } };
}

// ---------- Factory ----------

export type DecisionApi = {
  /** Hub-internal: start a decision as `recorded` (arbiter ruling) or `open` (escalation). */
  create(cap: HubCapabilities, input: Omit<CreateInput, "id">, actor: string): DecisionSnapshot;
  /** Hub-internal: one legal move. Throws LedgerConflict (404, 409). */
  move(cap: HubCapabilities, id: string, to: DecisionStatus, actor: string, extra?: { option?: string | null; text?: string | null }): { snapshot: DecisionSnapshot; emitted: boolean };
};
export type DecisionKind = KindModule & { api: DecisionApi };

export function createDecisionKind(db: Database): DecisionKind {
  const entity = createLedgerEntity({ decl: decisionDecl, db });

  const api: DecisionApi = {
    create: (cap, input, actor) => {
      const id = mintDecisionId();
      return entity.apply(id, createVerb, { id, ...input }, actor, cap).snapshot;
    },
    move: (cap, id, to, actor, extra = {}) => {
      const r = entity.apply(id, moveVerb, { to, ...extra }, actor, cap);
      return { snapshot: r.snapshot, emitted: r.emitted };
    },
  };

  /** The ticket note of an answer: its own transaction, after the decision row is answered. */
  function writeTicketNote(cap: HubCapabilities, d: DecisionSnapshot, author: string): boolean {
    if (!d.ticket_id) return false;
    const t = db.query<{ id: string; room: string }, [string]>("SELECT id, room FROM tickets WHERE id = ?").get(d.ticket_id);
    if (!t) return false;
    const label = d.body?.options.find((o) => o.id === d.option)?.label;
    let text = `Decision ${d.id} answered: ${d.option}${label ? ` (${label})` : ""}${d.text ? `. ${d.text}` : ""}`;
    while (new TextEncoder().encode(text).length > NOTE_MAX_BYTES) text = text.slice(0, -1);
    const at = Date.now();
    let seq = 0;
    db.transaction(() => {
      seq = cap.events.insert(db, t.id, "ticket.noted", author, { text }, at);
      db.run("INSERT INTO ticket_notes (id, ticket_id, author, text, created_at_ms) VALUES (?, ?, ?, ?, ?)", [seq, t.id, author, text, at]);
    })();
    const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?").get(t.id)!.n;
    cap.sse.emit(
      { kind: "ticket.noted", ticket_id: t.id, room: t.room, version: seq, notes_count: count, note: { id: seq, author, text, created_at_ms: at }, from: author, to: "all", text: `[note on ${t.id}]`, ts: ts(), image: null },
      { kind: "ui-only-ambient" },
    );
    return true;
  }

  const routes: RouteDef[] = [
    {
      // The room lead opens a human decision. Another agent, and the human, get 403.
      method: "POST",
      path: "/decisions",
      auth: "mutating",
      handler: async (req, cap) => {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const by = typeof b.by === "string" ? b.by.trim() : "";
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (cap.agents.isPaused(by)) return pausedRefusal();
        const agent = cap.agents.get(by);
        if (!agent || agent.room === null || roomLead(cap, agent.room) !== by) {
          return Response.json({ error: "only the room lead may open a decision" }, { status: 403 });
        }
        const parsed = parseEscalation(b);
        if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
        const ticket_id = b.ticket_id === undefined || b.ticket_id === null ? null : String(b.ticket_id);
        const request_id = b.request_id === undefined || b.request_id === null ? null : str(b.request_id, 128);
        if (ticket_id === null && request_id === null) {
          return Response.json({ error: "ticket_id or request_id is required" }, { status: 400 });
        }
        if (ticket_id !== null) {
          const t = TICKET_ID_RE.test(ticket_id)
            ? db.query<{ room: string }, [string]>("SELECT room FROM tickets WHERE id = ?").get(ticket_id)
            : null;
          if (!t || t.room !== agent.room) return Response.json({ error: "unknown ticket in this room" }, { status: 400 });
        }
        try {
          const snapshot = api.create(cap, {
            status: "open", room: agent.room, ticket_id, request_id, decider: "human", fail_count: 0,
            reason: parsed.reason, body: parsed.body,
          }, by);
          return Response.json({ id: snapshot.id, snapshot }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      // Human only. Row first (one event), then one entry to the lead, then one ticket note.
      method: "POST",
      path: /^\/decisions\/([^/]+)\/answer$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const id = params.id;
        if (!DECISION_ID_RE.test(id)) return Response.json({ error: "invalid decision id" }, { status: 400 });
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const by = typeof b.by === "string" ? b.by.trim() : "";
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (by !== cap.config.humanName) return Response.json({ error: "only the human may answer a decision" }, { status: 403 });
        const option = str(b.option, OPTION_ID_MAX);
        if (!option) return Response.json({ error: "option required" }, { status: 400 });
        let text: string | null = null;
        if (b.text !== undefined && b.text !== null) {
          text = str(b.text, ANSWER_TEXT_MAX);
          if (text === null) return Response.json({ error: `text must be non-empty text (max ${ANSWER_TEXT_MAX} chars)` }, { status: 400 });
        }
        const prior = entity.load(id);
        if (!prior) return Response.json({ error: "not found" }, { status: 404 });
        if (prior.body && !prior.body.options.some((o) => o.id === option)) {
          return Response.json({ error: "option is not one of the decision options" }, { status: 400 });
        }
        try {
          const r = api.move(cap, id, "answered", by, { option, text });
          if (!r.emitted) return Response.json({ snapshot: r.snapshot, idempotent: true }, { status: 200 });
          const d = r.snapshot;
          const lead = roomLead(cap, d.room);
          if (lead) {
            const label = d.body?.options.find((o) => o.id === d.option)?.label;
            cap.sse.emit(
              { from: by, to: lead, room: d.room, ts: ts(), image: null,
                text: `Decision ${d.id} answered: ${d.option}${label ? ` (${label})` : ""}${d.text ? `. ${d.text}` : ""}${d.body ? ` Block: ${d.body.block}` : ""}` },
              { kind: "to-agents", agents: [lead] },
            );
          }
          let ticket_note = false;
          try {
            ticket_note = writeTicketNote(cap, d, by);
          } catch (e) {
            console.error(`[decision] ticket note for ${d.id} failed:`, e);
          }
          return Response.json({ snapshot: d, lead, ticket_note }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },

    {
      // The Needs-you lines of a room: its open and escalated decisions, newest first.
      method: "GET",
      path: "/decisions",
      auth: "read",
      handler: (req, _cap) => {
        const room = new URL(req.url).searchParams.get("room") ?? "";
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const decisions = ["open", "escalated"]
          .flatMap((status) => entity.listByStatus({ status, room, limit: 200 }))
          .sort((a, b) => b.created_at_ms - a.created_at_ms);
        return Response.json({ room, decisions });
      },
    },
  ];

  return {
    kind: "decision",
    migrate: (d: Database) => {
      entity.migrate(d);
      d.exec(`CREATE INDEX IF NOT EXISTS "idx_decisions_room_status" ON "decisions" ("room", "status")`);
    },
    routes: withLedgerRequired(routes),
    pendingFor: () => [],
    toolNames: ["escalate"],
    api,
  };
}

export { DECISION_ID_RE };
