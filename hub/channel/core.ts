// Bridge core: the one place that owns the room gate, briefing/nutshell text,
// the message envelope, the delivery-mode policy and the post-delivery check.
// Runtime adapters implement `Host` and forward turn/tool events; they decide nothing.

import type { DeliveryMode, Host } from "./host";
import { authedPost, resolveHub, URL_PATH, TOKEN_PATH } from "./hub-client";

// Every adapter bounds host.reload() to RELOAD_MS and rejects with a ReloadTimeout. That is not a failure: the
// runtime reload may still be running, so the core does not forget the hub's order for it.
export const RELOAD_MS = 30_000;
export class ReloadTimeout extends Error {
  constructor() {
    super(`reload did not end within ${RELOAD_MS / 1000} s`);
    this.name = "ReloadTimeout";
  }
}

const BUF_MAX = 1 << 20;
const RETRY_MS = 2000;

export type BridgeEvent = {
  id?: number;
  type?: string;
  from?: string;
  to?: string;
  text?: string;
  ts?: string;
  room?: string | null;
  kind?: string;
  handoff_id?: string;
  interrupt_id?: string;
  permission_id?: string;
  version?: number;
  expires_at_ms?: number;
  status?: string;
  replay?: boolean;
  tools?: string[];
  peers?: Array<{ name: string; online: boolean; room?: string | null }>;
  attachments_dir?: string;
  human_name?: string;
  nutshell?: string | null;
  kind_lines?: string[];
  factory_version?: string | null;
  // ticket.new or ticket.assigned for an unassigned ticket: the room lead, who triages it (null/absent: no lead).
  lead?: string | null;
  paused?: boolean;
  // permission.* events carry the permission snapshot; only tool_name is read here.
  snapshot?: { tool_name?: string; assignee?: string | null; creator?: string };
};

export type BridgeOpts = {
  agent: string;
  room: string;
  hubEnv: string;
  // Backoff timer, supplied by the adapter: the core names no runtime timer (the mod has no setTimeout).
  sleep: (ms: number) => Promise<void>;
  // Wall clock in ms; the default is Date.now. Tests pass a fake.
  now?: () => number;
  // False once a newer module of the same agent runs (a reloaded Claude mod). The bridge then ends by itself.
  // A rejection counts as false: the engine unloaded the module this bridge runs in.
  alive?: () => Promise<boolean>;
};

// A peer that got a nudge opens no new check for this long, so two agents cannot nudge each other forever.
export const NUDGE_WINDOW_MS = 5 * 60 * 1000;

// Handoff gate. CHATBRIDGE_HANDOFF_GATE (host.handoffGate) in the launch environment names a command that runs before send_handoff.
// It gets the Claude hook shape on stdin: {tool_name, tool_input}. Exit 2 blocks the handoff and its stderr goes
// to the agent. Exit 0 lets it through. Any other result (another exit code, a timeout, a start failure) is a fault
// of the gate, not a verdict: it is logged and the handoff goes on, as a Claude hook does. No gate set: nothing runs.
export const HANDOFF_GATE_MS = 60_000;

export async function runHandoffGate(host: Host, toolInput: Record<string, unknown>): Promise<void> {
  const gate = await host.handoffGate();
  if (!gate) return;
  const stdin = JSON.stringify({ tool_name: "mcp__chatbridge__send_handoff", tool_input: toolInput });
  let r;
  try {
    r = await host.exec(gate, stdin, HANDOFF_GATE_MS);
  } catch (e) {
    host.log(`[channel] handoff gate not run: ${(e as Error).message ?? e}`);
    return;
  }
  if (r.timedOut) {
    host.log(`[channel] handoff gate timed out after ${HANDOFF_GATE_MS} ms; the handoff goes on`);
    return;
  }
  if (r.code === 2) throw new Error(r.stderr.trim() || "the handoff gate blocked this handoff");
  if (r.code !== 0) host.log(`[channel] handoff gate failed (exit ${r.code}); the handoff goes on`);
}

export type Bridge = {
  stop(): void;
  // The whole run that consumed delivered messages is over (not one model/tool iteration).
  // answered=false (aborted, refused, failed): the agent had no chance to reply, so armed
  // checks are dropped and no nudge is sent.
  onRunEnd(answered?: boolean): void;
  // The main agent starts a run (not a subagent's). Until onRunEnd the agent counts as busy.
  onRunStart(): void;
  // A chatbridge tool finished; ok = the hub answered 2xx.
  onToolResult(tool: string, ok: boolean): void;
};

export const NUDGE_TEXT =
  "A message addressed to you got no reply in the room. Your terminal output is visible to nobody. Call post if a reply is needed. An acknowledgement needs no reply.";

// Reply policy for the `post` tool, shared by the adapters that show it to the model (pi system prompt).
export const REPLY_POLICY =
  "Call `post` when a message addressed to you needs a reply. A message that only acknowledges needs no reply.";

// Traffic the agent itself caused (its own permission request and the resulting
// verdict/ack events) is context, not a reason to start another turn. No general
// `from === agent` rule: handoff.update carries the creator in `from` and must wake.
const CONTEXT_KINDS = new Set(["permission.resolved", "permission.dismissed", "interrupt.ack"]);

export function modeFor(evt: BridgeEvent, agent: string): DeliveryMode {
  if (evt.type === "briefing" || evt.type === "nutshell.updated") return "context";
  // A ticket:done approval: the human's answer wakes the requester (it waits for it),
  // and nobody else is woken for the request (only the human votes on it).
  if (evt.snapshot?.tool_name === "ticket:done") {
    if (evt.kind === "permission.resolved" && evt.from === agent) return "wake";
    if (evt.kind === "permission.new") return "context";
  }
  if (evt.kind && CONTEXT_KINDS.has(evt.kind)) return "context";
  // A paused agent (the hub stamps `paused`) reads handoff, interrupt and ticket events as context; nothing wakes or steers it.
  if (evt.paused && !evt.kind?.startsWith("permission.")) return "context";
  // A ticket handed to an agent (assigned later, or at creation) wakes that agent once; an
  // unassigned ticket (new, or unassigned again) wakes the room lead, who triages it. Everyone else reads it as
  // context. Only a NEW ticket is skipped for its own creator (the agent made it and already knows); a
  // ticket.assigned is a later event the creator has not seen, so it always wakes the assignee.
  if (evt.kind === "ticket.assigned" || evt.kind === "ticket.new") {
    const s = evt.snapshot;
    if (evt.kind === "ticket.new" && s?.creator === agent) return "context";
    if (s?.assignee === agent) return "wake";
    // An unassigned ticket (new, or just unassigned) goes to the room lead to triage.
    if (!s?.assignee && evt.lead === agent) return "wake";
    return "context";
  }
  if (evt.kind?.startsWith("ticket.")) return "context";
  if (evt.kind === "permission.new" && evt.from === agent) return "context";
  if (evt.kind === "interrupt.new") return "steer";
  return "wake";
}

export function renderBriefing(evt: BridgeEvent, agent: string, room: string): string {
  const parts: string[] = [`[Cubilot briefing] You are "${agent}" in room "${room}".`];
  if (evt.human_name) parts.push(`The human's name is "${evt.human_name}".`);
  if (evt.peers?.length) {
    const online = evt.peers.filter((p) => p.online).map((p) => p.name);
    const offline = evt.peers.filter((p) => !p.online).map((p) => p.name);
    if (online.length) parts.push(`Online peers in your room: ${online.join(", ")}.`);
    if (offline.length) parts.push(`Known but offline peers: ${offline.join(", ")}.`);
  }
  if (evt.tools?.length) parts.push(`Available chatbridge tools: ${evt.tools.join(", ")}.`);
  if (evt.attachments_dir) {
    parts.push(
      `Attachments dir: ${evt.attachments_dir}. Incoming files arrive as [attachment: <path>] suffixes you can Read directly.`,
    );
  }
  if (evt.nutshell && evt.nutshell.trim()) {
    parts.push(`Current project summary (nutshell for room "${room}"):\n${evt.nutshell.trim()}`);
  }
  if (evt.kind_lines?.length) parts.push(evt.kind_lines.join("\n"));
  return parts.join("\n\n");
}

// `[chatbridge id=42 from="alice" ...]`. Keys only when present, fixed order.
// String values are JSON literals so spaces, quotes, `]` and newlines in names or
// room labels cannot break or forge the line; numbers are bare; `catchup` is a bare flag.
export function renderEnvelope(evt: BridgeEvent, room: string): string {
  const bits: string[] = [];
  const str = (k: string, v: unknown) => {
    if (typeof v === "string" && v) bits.push(`${k}=${JSON.stringify(v)}`);
  };
  const num = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) bits.push(`${k}=${v}`);
  };
  num("id", evt.id);
  str("from", evt.from);
  str("to", evt.to);
  str("room", evt.room ?? room);
  str("kind", evt.kind);
  str("handoff_id", evt.handoff_id);
  str("interrupt_id", evt.interrupt_id);
  str("permission_id", evt.permission_id);
  num("version", evt.version);
  str("status", evt.status);
  num("expires_at_ms", evt.expires_at_ms);
  if (evt.replay === true) bits.push("catchup");
  return `[chatbridge ${bits.join(" ")}]`;
}

export function renderEvent(evt: BridgeEvent, agent: string, room: string): string {
  if (evt.type === "briefing") return renderBriefing(evt, agent, room);
  if (evt.type === "nutshell.updated") return `[Cubilot nutshell update]\n${evt.text ?? ""}`;
  return `${renderEnvelope(evt, room)}\n${evt.text ?? ""}`;
}

export function startBridge(host: Host, opts: BridgeOpts): Bridge {
  const { agent, room, hubEnv } = opts;
  const { sleep } = opts;
  const ac = new AbortController();

  // Post check (D7). One object per delivery (hub ids restart with the hub, so they are display-only).
  // Pending entries are untouched by posts: only an armed entry can be disarmed.
  const checks = new Set<{ armed: boolean; from: string | undefined }>();
  // When each peer last earned a nudge. A peer nudged within NUDGE_WINDOW_MS earns no second one.
  const nudgedAt = new Map<string, number>();
  const now = opts.now ?? Date.now;

  // Hot reload. The hub keeps two records per agent (the link and the .applied file) and compares them with the
  // desired version (POST /factory/relink), so the bridge keeps no version state: it survives a module replacement
  // and a hub restart. host.reload records the version (POST /factory/applied) only after the reload succeeds. A briefing with a factory_version, and every run end, mark "check needed". At the idle point
  // (at once when idle, at run end when busy) one reload at a time asks the hub to move the link.
  let sawVersion: string | null = null;
  let checkNeeded = false;
  let reloading = false;
  let retryWait = false;
  let stuckLogged = false;
  let noLink = false; // 404: no role, or a legacy launch. Never reloads.
  let busy = false;
  const failures = new Map<string, number>();

  const post = (path: string, body: Record<string, unknown>) => authedPost(host, hubEnv, path, { agent, ...body });

  // The hub answered "pending": a reload (maybe this agent's earlier module) is still running. The check must not
  // be lost, because nothing tells this bridge when that reload ends. Ask again after 5 s, 10, 20, ... up to 60 s.
  // It stops when relink answers anything but pending. No model turn: it uses the injected sleep.
  const POLL_MIN_MS = 5_000;
  const POLL_MAX_MS = 60_000;
  let polling = false;
  async function pollWhilePending(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      let delay = POLL_MIN_MS;
      while (!ac.signal.aborted) {
        await sleep(delay);
        delay = Math.min(delay * 2, POLL_MAX_MS);
        if (ac.signal.aborted) return;
        checkNeeded = true;
        if ((await maybeReload()) !== "pending") return;
      }
    } finally {
      polling = false;
    }
  }

  async function maybeReload(): Promise<"pending" | "other"> {
    if (reloading || !checkNeeded || busy || noLink || sawVersion === null) return "other";
    if ((failures.get(sawVersion) ?? 0) >= 2) return "other";
    checkNeeded = false;
    reloading = true;
    try {
      const r = await post("/factory/relink", {});
      if (r.status === 404) { noLink = true; return "other"; }
      const j = (r.json ?? {}) as { reload?: boolean; pending?: boolean; version?: string };
      if (r.status < 200 || r.status >= 300) {
        host.log(`[channel] factory relink refused: HTTP ${r.status}`);
        return "other";
      }
      if (!j.reload) {
        // The hub holds a reload with no completion: it never clears by time. Say so once per process.
        if (j.pending && !stuckLogged) {
          stuckLogged = true;
          host.log("[channel] hot reload still pending: restart the agent");
        }
        if (j.pending) { void pollWhilePending(); return "pending"; }
        return "other";
      }
      const version = j.version ?? sawVersion;
      try {
        await host.reload(version);
      } catch (e) {
        // No rollback and no applied record. A real failure tells the hub, which forgets the order, so the next
        // relink asks for the reload again. A timeout does not: the reload may still run, the window blocks a second.
        if (!(e instanceof ReloadTimeout)) {
          await post("/factory/applied", { failed: true }).catch((err) => host.log(`[channel] failure not reported: ${(err as Error).message ?? err}`));
        }
        const n = (failures.get(version) ?? 0) + 1;
        failures.set(version, n);
        if (n >= 2) host.log(`[channel] hot reload failed for ${version}: ${(e as Error).message ?? e}`);
        else { retryWait = true; checkNeeded = true; }
        return "other";
      }
    } catch (e) {
      host.log(`[channel] reload check failed: ${(e as Error).message ?? e}`);
      return "other";
    } finally {
      reloading = false;
      // A change that arrived during the reload gets one more check after it (not a retry after a failure).
      if (checkNeeded && !retryWait) void maybeReload();
    }
    return "other";
  }

  function trigger(): void {
    retryWait = false;
    checkNeeded = true;
    void maybeReload();
  }

  async function deliver(evt: BridgeEvent): Promise<void> {
    const id = typeof evt.id === "number" ? evt.id : null;
    // The hub writes several named recipients as "A,B"; "all" never matches an agent name.
    const qualifies =
      id !== null &&
      !evt.type &&
      !evt.kind &&
      (evt.to ?? "").split(",").some((n) => n.trim() === agent);
    const check = qualifies ? { armed: false, from: evt.from } : null;
    if (check) checks.add(check);
    try {
      await host.deliver({
        id,
        text: renderEvent(evt, agent, room),
        mode: modeFor(evt, agent),
        onRead: () => {
          if (check) check.armed = true;
        },
        onFail: () => {
          if (check) checks.delete(check);
          host.log(`[channel] message not delivered (id=${id ?? "none"}): the runtime refused it`);
        },
      });
    } catch (e) {
      if (check) checks.delete(check);
      throw e;
    }
  }

  async function handleEvent(evt: BridgeEvent): Promise<void> {
    // evt.room null/absent = system/global (let through); concrete cross-room = drop.
    if (evt.room !== undefined && evt.room !== null && evt.room !== room) {
      host.log(
        `[channel] dropped cross-room event: mine=${room} theirs=${evt.room} kind=${evt.kind ?? evt.type ?? "?"}`,
      );
      return;
    }
    await deliver(evt);
    if (evt.type === "briefing" && evt.factory_version) {
      sawVersion = evt.factory_version;
      trigger();
    }
  }

  async function processBuffer(buf: string): Promise<string> {
    let idx: number;
    // Stopped bridges must not leak already-buffered frames into a replacement session.
    while (!ac.signal.aborted && (idx = buf.indexOf("\n\n")) >= 0) {
      if (opts.alive && !(await opts.alive().catch(() => false))) {
        ac.abort();
        break;
      }
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      let evt: BridgeEvent;
      try {
        evt = JSON.parse(dataLine.slice(6));
      } catch (e) {
        host.log(`[channel] SSE JSON parse failed: ${(e as Error).message ?? e}`);
        continue;
      }
      try {
        // Awaits acceptance only; read-time is reported through onRead, never awaited here.
        await handleEvent(evt);
      } catch (e) {
        host.log(`[channel] delivery failed: ${(e as Error).message ?? e}`);
      }
    }
    return buf;
  }

  async function tail(): Promise<void> {
    let loggedMissingOnce = false;
    while (!ac.signal.aborted) {
      if (opts.alive && !(await opts.alive().catch(() => false))) return;
      const hub = await resolveHub(host, hubEnv);
      if (!hub) {
        if (!loggedMissingOnce) {
          host.log(
            `[channel] hub not found; waiting for Cubilot.app to start (expects ${URL_PATH} and ${TOKEN_PATH})`,
          );
          loggedMissingOnce = true;
        }
        await sleep(RETRY_MS);
        continue;
      }
      loggedMissingOnce = false;
      try {
        const url =
          `${hub.url}/agent-stream` +
          `?agent=${encodeURIComponent(agent)}` +
          `&room=${encodeURIComponent(room)}`;
        let buf = "";
        for await (const chunk of host.stream(url, hub.token, ac.signal)) {
          buf += chunk;
          if (buf.length > BUF_MAX) buf = buf.slice(-BUF_MAX);
          buf = await processBuffer(buf);
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        host.log(`[channel] tail error: ${(e as Error).message ?? e}`);
      }
      if (ac.signal.aborted) return;
      await sleep(RETRY_MS);
    }
  }

  void tail();

  return {
    stop: () => ac.abort(),
    onToolResult(tool, ok) {
      if (!ok || (tool !== "post" && tool !== "post_file")) return;
      for (const c of checks) if (c.armed) checks.delete(c);
    },
    onRunStart() {
      busy = true;
    },
    onRunEnd(answered = true) {
      busy = false;
      if (sawVersion !== null) trigger();
      // The limit is checked here, when the nudge would go out, so messages queued before the first nudge
      // share one nudge per peer.
      const t = now();
      const peers: string[] = [];
      let unanswered = false;
      for (const c of checks) {
        if (!c.armed) continue;
        checks.delete(c);
        const last = c.from === undefined ? undefined : nudgedAt.get(c.from);
        if (last !== undefined && t - last < NUDGE_WINDOW_MS) continue;
        unanswered = true;
        if (c.from !== undefined) peers.push(c.from);
      }
      if (!unanswered || !answered) return;
      for (const p of peers) nudgedAt.set(p, t);
      // id null: the nudge never qualifies for a check, so it cannot re-arm.
      host
        .deliver({ id: null, text: NUDGE_TEXT, mode: "wake", onRead: () => {} })
        .catch((e) => host.log(`[channel] nudge failed: ${(e as Error).message ?? e}`));
    },
  };
}
