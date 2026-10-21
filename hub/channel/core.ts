// Bridge core: the one place that owns the room gate, briefing/nutshell text,
// the message envelope, the delivery-mode policy and the post-delivery check.
// Runtime adapters implement `Host` and forward turn/tool events; they decide nothing.

import type { DeliveryMode, Host } from "./host";
import { resolveHub, URL_PATH, TOKEN_PATH } from "./hub-client";

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
};

export type Bridge = {
  stop(): void;
  // The whole run that consumed delivered messages is over (not one model/tool iteration).
  // answered=false (aborted, refused, failed): the agent had no chance to reply, so armed
  // checks are dropped and no nudge is sent.
  onRunEnd(answered?: boolean): void;
  // A chatbridge tool finished; ok = the hub answered 2xx.
  onToolResult(tool: string, ok: boolean): void;
};

export const NUDGE_TEXT =
  "A message addressed to you got no reply in the room. Your terminal output is visible to nobody — call post.";

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
  const checks = new Set<{ armed: boolean }>();

  async function deliver(evt: BridgeEvent): Promise<void> {
    const id = typeof evt.id === "number" ? evt.id : null;
    // The hub writes several named recipients as "A,B"; "all" never matches an agent name.
    const qualifies =
      id !== null &&
      !evt.type &&
      !evt.kind &&
      (evt.to ?? "").split(",").some((n) => n.trim() === agent);
    const check = qualifies ? { armed: false } : null;
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
  }

  async function processBuffer(buf: string): Promise<string> {
    let idx: number;
    // Stopped bridges must not leak already-buffered frames into a replacement session.
    while (!ac.signal.aborted && (idx = buf.indexOf("\n\n")) >= 0) {
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
    onRunEnd(answered = true) {
      let unanswered = false;
      for (const c of checks) {
        if (!c.armed) continue;
        checks.delete(c);
        unanswered = true;
      }
      if (!unanswered || !answered) return;
      // id null: the nudge never qualifies for a check, so it cannot re-arm.
      host
        .deliver({ id: null, text: NUDGE_TEXT, mode: "wake", onRead: () => {} })
        .catch((e) => host.log(`[channel] nudge failed: ${(e as Error).message ?? e}`));
    },
  };
}
