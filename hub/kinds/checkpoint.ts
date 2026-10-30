// Checkpoint kind — the room lead writes a short note, the hub clears its session and gives it the state summary
// (human-touchpoints-checkpoint decision 12). Legal moves: noting -> clearing -> done | failed, and noting -> failed.
// `done` and `failed` are final. One event and one table update for each change. Starts: `human` (POST /checkpoints) now,
// `rule` (the safe-point start, t_e948) later; both go through `api.start`.
//
// Flow: the lead's Stop hook posts its turn end. The first turn end after the start asks for a note (`note_asked`). The
// lead answers with the chatbridge tool `checkpoint_note(text)` (`noted`, at most 200 words). The next turn end - with a
// note or without one - writes the summary file and asks the shell for `/clear` (`clearing`). The lead's SessionStart hook (matcher
// clear) returns the file as context and removes it. The sweep sees the file gone and moves the checkpoint to `done`;
// no removal in 2 minutes moves it to `failed`.

import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Decision, Entry, HubCapabilities, KindModule, RouteDef, StateMachineDecl, VerbDecl } from "../core/types";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { ts, validName, validRoomLabel } from "../core/ids";
import { readContextPct } from "../core/context-usage";
import { checkpointDueReason } from "../core/checkpoint-due";
import { roleHarness } from "../core/role-harness";
import { buildStateSummary } from "../core/state-summary";
import { roomLead } from "./ticket";

// ---------- Types ----------

export type CheckpointStatus = "noting" | "clearing" | "done" | "failed";
export type CheckpointTrigger = "human" | "rule";

export type CheckpointSnapshot = {
  id: string;
  room: string;
  /** The room lead; also the name of its session. */
  agent: string;
  trigger: CheckpointTrigger;
  status: CheckpointStatus;
  /** The lead's note, at most 200 words; null when none came. */
  note: string | null;
  /** The note request went out (the first turn end after the start). */
  note_asked: boolean;
  context_pct_before: number | null;
  context_pct_after: number | null;
  summary_bytes: number | null;
  /** Why it failed. */
  reason: string | null;
  created_by: string;
  started_at_ms: number;
  clearing_at_ms: number | null;
  ended_at_ms: number | null;
  version: number;
};

export const NOTE_MAX_WORDS = 200;
const NOTE_TEXT_MAX = 20_000;
const CHECKPOINT_ID_RE = /^c_[0-9a-f]{16}$/;
export const DEFAULT_CLEAR_TIMEOUT_MS = 120_000;
const DEFAULT_SWEEP_MS = 2_000;

const LEGAL: Record<CheckpointStatus, ReadonlySet<CheckpointStatus>> = {
  noting: new Set(["noting", "clearing", "failed"]), // noting -> noting: the note request, the note
  clearing: new Set(["done", "failed"]),
  done: new Set(),
  failed: new Set(),
};

function mintCheckpointId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "c_";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The first 200 words of `text`, as typed (line breaks stay). */
export function capNote(text: string): string {
  const t = text.trim();
  let words = 0;
  const re = /\S+/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (++words > NOTE_MAX_WORDS) return t.slice(0, m.index).trimEnd();
  }
  return t;
}

const dataDir = () => process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot");
/** `<app data>/checkpoints`: one summary file for each lead, `<agent>.md`, mode 0600. */
export const checkpointsDir = () => join(dataDir(), "checkpoints");
const summaryPath = (agent: string) => join(checkpointsDir(), `${agent}.md`);

// ---------- StateMachine declaration ----------

const checkpointDecl: StateMachineDecl<CheckpointSnapshot> = {
  kind: "checkpoint",
  table: "checkpoints",
  columns: {
    id: "TEXT",
    room: "TEXT",
    agent: "TEXT",
    trigger: "TEXT",
    status: "TEXT",
    note: "TEXT_NULL",
    note_asked: "INTEGER",
    context_pct_before: "INTEGER_NULL",
    context_pct_after: "INTEGER_NULL",
    summary_bytes: "INTEGER_NULL",
    reason: "TEXT_NULL",
    created_by: "TEXT",
    started_at_ms: "INTEGER",
    clearing_at_ms: "INTEGER_NULL",
    ended_at_ms: "INTEGER_NULL",
  },
  terminalStatuses: new Set(["done", "failed"]),
  rowToSnapshot: (row) => {
    const n = (k: string) => (row[k] == null ? null : Number(row[k]));
    return {
      id: row.id as string,
      room: row.room as string,
      agent: row.agent as string,
      trigger: row.trigger as CheckpointTrigger,
      status: row.status as CheckpointStatus,
      note: (row.note as string | null) ?? null,
      note_asked: Number(row.note_asked) === 1,
      context_pct_before: n("context_pct_before"),
      context_pct_after: n("context_pct_after"),
      summary_bytes: n("summary_bytes"),
      reason: (row.reason as string | null) ?? null,
      created_by: row.created_by as string,
      started_at_ms: Number(row.started_at_ms),
      clearing_at_ms: n("clearing_at_ms"),
      ended_at_ms: n("ended_at_ms"),
      version: Number(row.version ?? 0),
    };
  },
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of [
      "id", "room", "agent", "trigger", "status", "note", "context_pct_before", "context_pct_after", "summary_bytes",
      "reason", "created_by", "started_at_ms", "clearing_at_ms", "ended_at_ms",
    ] as const) {
      if (snap[k] !== undefined) out[k] = snap[k];
    }
    if (snap.note_asked !== undefined) out.note_asked = snap.note_asked ? 1 : 0;
    return out;
  },
};

// ---------- Entry projection ----------

/** A UI-only signal: a view of checkpoints reads the row again. The lead gets its note request from the turn-end route. */
function checkpointEntry(snapshot: CheckpointSnapshot, eventKind: string, actor: string): Entry {
  return {
    from: actor,
    to: "all",
    text: `[checkpoint ${snapshot.id} ${snapshot.status}]`,
    ts: ts(),
    image: null,
    room: snapshot.room,
    kind: eventKind,
    checkpoint_id: snapshot.id,
    version: snapshot.version,
    snapshot,
  };
}

// ---------- Verbs ----------

type StartInput = { id: string; room: string; agent: string; trigger: CheckpointTrigger; context_pct_before: number | null };

const startVerb: VerbDecl<CheckpointSnapshot, StartInput> = {
  decide(prior, p, actor): Decision<CheckpointSnapshot> {
    if (prior) return { kind: "conflict", httpStatus: 409, message: `checkpoint ${p.id} already exists` };
    const initial: CheckpointSnapshot = {
      id: p.id, room: p.room, agent: p.agent, trigger: p.trigger, status: "noting", note: null, note_asked: false,
      context_pct_before: p.context_pct_before, context_pct_after: null, summary_bytes: null, reason: null,
      created_by: actor, started_at_ms: Date.now(), clearing_at_ms: null, ended_at_ms: null, version: 0,
    };
    return {
      kind: "create",
      initial,
      eventKind: "checkpoint.started",
      payload: () => ({ actor, room: p.room, agent: p.agent, trigger: p.trigger, context_pct_before: p.context_pct_before }),
      entry: (post) => checkpointEntry(post, "checkpoint.started", actor),
    };
  },
  scope: () => ({ kind: "ui-only-ambient" }),
};

type StepInput = { op: "note_asked" | "noted" | "clearing" | "done" | "failed"; patch: Partial<CheckpointSnapshot> };

const TARGET: Record<StepInput["op"], CheckpointStatus> = { note_asked: "noting", noted: "noting", clearing: "clearing", done: "done", failed: "failed" };

const stepVerb: VerbDecl<CheckpointSnapshot, StepInput> = {
  decide(prior, p, actor): Decision<CheckpointSnapshot> {
    if (!prior) return { kind: "conflict", httpStatus: 404, message: "not found" };
    const to = TARGET[p.op];
    // A final state keeps its record: the same status again is a retry (200, nothing written); another one is 409.
    if (prior.status === to && (to === "done" || to === "failed" || to === "clearing")) return { kind: "idempotent" };
    if (!LEGAL[prior.status].has(to)) return { kind: "conflict", httpStatus: 409, message: `illegal move ${prior.status} -> ${to}` };
    const next: Partial<CheckpointSnapshot> = { ...p.patch, status: to };
    if (to === "done" || to === "failed") next.ended_at_ms = Date.now();
    return {
      kind: "transition",
      next,
      eventKind: `checkpoint.${p.op}`,
      payload: (post) => ({ from: prior.status, actor, reason: post.reason, summary_bytes: post.summary_bytes, context_pct_after: post.context_pct_after }),
      entry: (post) => checkpointEntry(post, `checkpoint.${p.op}`, actor),
    };
  },
  scope: () => ({ kind: "ui-only-ambient" }),
};

// ---------- Factory ----------

export type CheckpointDeps = {
  /** Queues text for the PTY of one named session (stage runtime `sendInput`); returns the request id. */
  sendInput(session: string, text: string): string;
  /** Removes an input the shell never received. */
  dropInput(id: string): boolean;
  /** The harness of the lead. Default: the harness of the orchestrator role. */
  leadHarness?: () => "claude" | "pi";
};

export type CheckpointApi = {
  /** Starts a checkpoint for the lead of `room`. Throws LedgerConflict (400 Pi lead, 404 no lead, 409 one is active). */
  start(cap: HubCapabilities, input: { room: string; trigger: CheckpointTrigger }, actor: string): CheckpointSnapshot;
  /** One check of the clearing checkpoints: summary file gone = done, past the time-out = failed. Tests pass `now`. */
  sweep(cap: HubCapabilities, now?: number): void;
};
export type CheckpointKind = KindModule & { api: CheckpointApi };

export function createCheckpointKind(db: Database, deps: CheckpointDeps): CheckpointKind {
  const entity = createLedgerEntity({ decl: checkpointDecl, db });
  const leadHarness = deps.leadHarness ?? (() => roleHarness("orchestrator"));
  const clearTimeoutMs = () => Number(process.env.CUBILOT_CHECKPOINT_TIMEOUT_MS) || DEFAULT_CLEAR_TIMEOUT_MS;
  /** The shell request of a clearing checkpoint, to drop it when the checkpoint fails before the shell got it. */
  const inputs = new Map<string, string>();

  const active = (agent: string): CheckpointSnapshot | null => {
    const row = db
      .query<Record<string, unknown>, [string]>(`SELECT * FROM checkpoints WHERE agent = ? AND status IN ('noting','clearing') ORDER BY rowid DESC LIMIT 1`)
      .get(agent);
    return row ? checkpointDecl.rowToSnapshot(row) : null;
  };

  const step = (cap: HubCapabilities, id: string, input: StepInput, actor = "system") => entity.apply(id, stepVerb, input, actor, cap);

  const removeSummary = (agent: string) => rmSync(summaryPath(agent), { force: true });

  function fail(cap: HubCapabilities, cp: CheckpointSnapshot, reason: string): CheckpointSnapshot {
    removeSummary(cp.agent);
    const inputId = inputs.get(cp.id);
    if (inputId) deps.dropInput(inputId);
    inputs.delete(cp.id);
    return step(cap, cp.id, { op: "failed", patch: { reason } }).snapshot;
  }

  /** Writes the summary file (mode 0600, tmpfile + rename), moves to `clearing`, then asks the shell for `/clear`. */
  function clear(cap: HubCapabilities, cp: CheckpointSnapshot): CheckpointSnapshot {
    let bytes: number;
    try {
      const text = buildStateSummary(db, cp.room, cp.note);
      const dir = checkpointsDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = summaryPath(cp.agent);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, text, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      bytes = Buffer.byteLength(text);
    } catch (e) {
      return fail(cap, cp, `summary file not written: ${(e as Error).message}`);
    }
    let moved: CheckpointSnapshot;
    try {
      moved = step(cap, cp.id, { op: "clearing", patch: { summary_bytes: bytes, clearing_at_ms: Date.now() } }).snapshot;
    } catch (e) {
      removeSummary(cp.agent);
      throw e;
    }
    try {
      inputs.set(cp.id, deps.sendInput(cp.agent, "/clear"));
    } catch (e) {
      return fail(cap, moved, `clear not sent: ${(e as Error).message}`);
    }
    return moved;
  }

  function sweep(cap: HubCapabilities, now = Date.now()): void {
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM checkpoints WHERE status = 'clearing' ORDER BY rowid`).all();
    for (const row of rows) {
      const cp = checkpointDecl.rowToSnapshot(row);
      try {
        if (!existsSync(summaryPath(cp.agent))) {
          // The SessionStart hook returned the file and removed it. The context percentage now is the "after" value.
          inputs.delete(cp.id);
          const pct = readContextPct(cp.agent);
          step(cap, cp.id, { op: "done", patch: { context_pct_after: pct === null ? null : Math.round(pct) } });
        } else if (now - (cp.clearing_at_ms ?? cp.started_at_ms) >= clearTimeoutMs()) {
          fail(cap, cp, "no hook removal of the summary file in 2 minutes");
        }
      } catch (e) {
        console.error(`[checkpoint] sweep of ${cp.id} failed, tries again:`, e);
      }
    }
  }

  const api: CheckpointApi = {
    start(cap, { room, trigger }, actor) {
      const agent = roomLead(cap, room);
      if (!agent) throw new LedgerConflict(404, `room ${room} has no lead`, null);
      if (leadHarness() === "pi") throw new LedgerConflict(400, "a Pi lead has no checkpoint", null);
      if (active(agent)) throw new LedgerConflict(409, `${agent} has a checkpoint that is not finished`, active(agent));
      const pct = readContextPct(agent);
      const id = mintCheckpointId();
      return entity.apply(id, startVerb, { id, room, agent, trigger, context_pct_before: pct === null ? null : Math.round(pct) }, actor, cap).snapshot;
    },
    sweep,
  };

  /** The newest checkpoint of `agent`, whatever its status: its start is the line a request must pass to be due again. */
  const newestStartMs = (agent: string): number | null =>
    db.query<{ t: number | null }, [string]>("SELECT MAX(started_at_ms) AS t FROM checkpoints WHERE agent = ?").get(agent)?.t ?? null;

  /** The safe-point start (R4): only for the room lead (never a Pi lead), with no checkpoint active. Null when none is due. */
  function startByRule(cap: HubCapabilities, name: string): CheckpointSnapshot | null {
    const room = cap.agents.get(name)?.room;
    if (!room || roomLead(cap, room) !== name || leadHarness() === "pi") return null;
    const pct = readContextPct(name);
    if (!checkpointDueReason(db, room, newestStartMs(name), pct)) return null;
    try {
      return api.start(cap, { room, trigger: "rule" }, "system");
    } catch (e) {
      if (e instanceof LedgerConflict) return null;
      throw e;
    }
  }

  const askForNote = (cap: HubCapabilities, cp: CheckpointSnapshot) => {
    // The note comes back through the chatbridge tool checkpoint_note: no shell, no model text in a command.
    return cap.sse.emit(
      {
        from: "system",
        to: cp.agent,
        room: cp.room,
        ts: ts(),
        image: null,
        text:
          `Checkpoint ${cp.id}: write a note of at most ${NOTE_MAX_WORDS} words with the open points that are not on the board.\n` +
          `Call the tool checkpoint_note once with the note as its text argument. Then end your turn.\n` +
          `The hub clears your context after that turn and gives you the note and the state summary.`,
      },
      { kind: "to-agents", agents: [cp.agent] },
    );
  };

  /** Turn ends and notes are posted by the lead's own hooks: `by` is self-asserted and must be the agent in the path. */
  async function agentCall(req: Request, name: string): Promise<{ body: Record<string, unknown> } | Response> {
    if (!validName(name)) return Response.json({ error: "invalid agent" }, { status: 400 });
    const raw: unknown = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Response.json({ error: "a JSON object is required" }, { status: 400 });
    const body = raw as Record<string, unknown>;
    if (body.by !== name) return Response.json({ error: "by must be the agent in the path" }, { status: 403 });
    return { body };
  }

  const routes: RouteDef[] = [
    {
      // Human only. The checkpoint waits for the next turn end of the room lead.
      method: "POST",
      path: "/checkpoints",
      auth: "mutating",
      caller: "human",
      handler: async (req, cap) => {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const by = typeof b.by === "string" ? b.by.trim() : "";
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (by !== cap.config.humanName) return Response.json({ error: "only the human may start a checkpoint" }, { status: 403 });
        const room = typeof b.room === "string" ? b.room.trim() : "";
        if (!validRoomLabel(room)) return Response.json({ error: "room is required" }, { status: 400 });
        try {
          const snapshot = api.start(cap, { room, trigger: "human" }, by);
          return Response.json({ id: snapshot.id, snapshot }, { status: 201 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },
    {
      // The record of a room: newest first.
      method: "GET",
      path: "/checkpoints",
      auth: "read",
      handler: (req) => {
        const room = new URL(req.url).searchParams.get("room") ?? "";
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        const rows = db.query<Record<string, unknown>, [string]>(`SELECT * FROM checkpoints WHERE room = ? ORDER BY rowid DESC LIMIT 50`).all(room);
        return Response.json({ room, checkpoints: rows.map(checkpointDecl.rowToSnapshot) });
      },
    },
    {
      method: "GET",
      path: /^\/checkpoints\/([^/]+)$/,
      auth: "read",
      handler: (_req, _cap, params) => {
        const snap = CHECKPOINT_ID_RE.test(params.id) ? entity.load(params.id) : null;
        return snap ? Response.json({ snapshot: snap }) : Response.json({ error: "not found" }, { status: 404 });
      },
    },
    {
      // The Stop hook of the lead. With no checkpoint active, a due one starts here (safe point). The turn end of any other agent changes nothing.
      method: "POST",
      path: /^\/agents\/([^/]+)\/turn-end$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const name = decodeURIComponent(params.id);
        const call = await agentCall(req, name);
        if (call instanceof Response) return call;
        let cp = active(name);
        if (!cp) cp = startByRule(cap, name);
        if (!cp || cp.status !== "noting") return Response.json({ action: "none" });
        try {
          if (!cp.note_asked) {
            const r = step(cap, cp.id, { op: "note_asked", patch: { note_asked: true } });
            askForNote(cap, r.snapshot);
            return Response.json({ action: "note_asked", checkpoint_id: cp.id });
          }
          // The lead ended the turn that followed the request. It may have sent a note (checkpoint_note); if not, the checkpoint goes on with none.
          const r = clear(cap, cp);
          return Response.json({ action: r.status === "clearing" ? "clearing" : "failed", checkpoint_id: cp.id, snapshot: r });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },
    {
      // The chatbridge tool checkpoint_note of the lead. Only after the request; a longer note is cut at 200 words.
      method: "POST",
      path: /^\/agents\/([^/]+)\/checkpoint-note$/,
      auth: "mutating",
      handler: async (req, cap, params) => {
        const name = decodeURIComponent(params.id);
        const call = await agentCall(req, name);
        if (call instanceof Response) return call;
        const text = typeof call.body.text === "string" ? call.body.text : "";
        if (!text.trim() || text.length > NOTE_TEXT_MAX) {
          return Response.json({ error: `text must be non-empty text (max ${NOTE_TEXT_MAX} chars)` }, { status: 400 });
        }
        const cp = active(name);
        if (!cp || cp.status !== "noting" || !cp.note_asked) {
          return Response.json({ error: "no checkpoint of this agent waits for a note" }, { status: 409 });
        }
        try {
          const r = step(cap, cp.id, { op: "noted", patch: { note: capNote(text) } }, name);
          return Response.json({ snapshot: r.snapshot });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },
  ];

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    kind: "checkpoint",
    migrate: (d: Database) => {
      entity.migrate(d);
      d.exec(`CREATE INDEX IF NOT EXISTS "idx_checkpoints_agent_status" ON "checkpoints" ("agent", "status")`);
    },
    routes: withLedgerRequired(routes),
    pendingFor: () => [],
    toolNames: ["checkpoint_note"],
    // A restart keeps a clearing checkpoint: the sweep finishes it from the file and the clock in the row.
    start(cap) {
      const every = Number(process.env.CUBILOT_CHECKPOINT_SWEEP_MS) || DEFAULT_SWEEP_MS;
      timer = setInterval(() => sweep(cap), every);
      (timer as { unref?: () => void }).unref?.();
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    api,
  };
}
