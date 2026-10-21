// Agent registry — owns the four-structure invariant (knownAgents,
// agentQueues, agentConnections, staleTimers). All four are SEALED inside this
// module: external callers never see the Maps. Mutation is only possible
// through the methods exposed below, which keeps the four structures in sync
// atomically and makes the CLAUDE.md "never mutate individually" rule a
// structural fact rather than a convention.
//
// Roster changes (add/remove) and connection-count changes (open/close) invoke
// caller-provided callbacks so `hub.ts` can trigger broadcastRoster() /
// broadcastPresence() without circular imports.

import { DropQueue } from "./sse";
import { colorFromName, validName } from "./ids";
import type { Agent, Entry } from "./types";

export type AgentRegistryOptions = {
  defaultRoom: string;
  staleMs: number;
  queueMax: number;
  resolveRoom: (raw: string | null | undefined) => string;
  onRosterChange: () => void;
  onPresenceChange: () => void;
};

export type AgentRegistry = {
  // Reads
  get(name: string): Agent | null;
  has(name: string): boolean;
  isPermanent(name: string): boolean;
  // Pause: see enqueueFor. Only the human sets it (routes in features/chat.ts); setPaused reports a change.
  isPaused(name: string): boolean;
  setPaused(name: string, paused: boolean): boolean;
  // The pause policy for one entry bound for `name` (null = drop, else the entry, stamped `paused` where it applies).
  forDelivery(name: string, entry: Entry): Entry | null;
  values(): IterableIterator<Agent>;
  entries(): IterableIterator<[string, Agent]>;
  connectionCount(name: string): number;

  // The one live /agent-stream of an Agent OBJECT (not of a name: a removed and re-created agent is a
  // new object). `replaceLiveStream` registers the new stream's abort handle and returns the older
  // one for the caller to end; `releaseLiveStream` drops it when the stream ends on its own.
  // `remove()` aborts it, so a removed agent's stream never outlives the removal.
  replaceLiveStream(agent: Agent, next: AbortController): AbortController | undefined;
  releaseLiveStream(agent: Agent, mine: AbortController): void;

  // Lifecycle
  ensure(name: string, room?: string | null): Agent | null;
  remove(name: string, reason: string): boolean;
  markPermanent(name: string): void;

  // Connection accounting. disconnect() auto-schedules stale removal when the
  // count hits 0 — callers no longer need to remember that bookkeeping.
  connect(name: string): number;
  disconnect(name: string): number;

  // Per-agent queue access — sealed substitutes for `agentQueues.get(...).push(...)`
  // and `agentQueues.get(...).pull(signal)`. enqueueFor returns false when the
  // agent has no queue (already removed); subscribe yields entries until signal
  // aborts or the queue drains (after removal it no longer receives).
  enqueueFor(name: string, entry: Entry): boolean;
  subscribe(name: string, signal: AbortSignal): AsyncGenerator<Entry>;
  // Like subscribe(), but each entry is only on loan until the consumer calls take(), right where it
  // sends it. An abort before take() puts the entry back at the front of the queue (DropQueue.claim).
  // A false take() means that happened: drop the entry and stop.
  subscribeLeased(name: string, signal: AbortSignal): AsyncGenerator<{ item: Entry; take(): boolean; deliverable(): Entry | null }>;
  // `deliverable()` re-applies the pause policy at the moment of sending: call it right after take(), in the same run as the send.

  // Snapshots
  rosterSnapshot(): Entry;
  presenceSnapshot(): Entry;
};

export function createAgentRegistry(opts: AgentRegistryOptions): AgentRegistry {
  const knownAgents = new Map<string, Agent>();
  const agentQueues = new Map<string, DropQueue<Entry>>();
  const agentConnections = new Map<string, number>();
  const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Keyed by the Agent object, like the pause flag: a stream outlives neither its agent's removal nor
  // a same-named successor's connection count.
  const liveStreams = new WeakMap<Agent, AbortController>();
  const permanentAgents = new Set<string>();

  function cancelStaleTimer(name: string): void {
    const t = staleTimers.get(name);
    if (t) {
      clearTimeout(t);
      staleTimers.delete(name);
    }
  }

  function scheduleStaleRemoval(name: string): void {
    if (permanentAgents.has(name)) return;
    cancelStaleTimer(name);
    const t = setTimeout(() => {
      staleTimers.delete(name);
      if ((agentConnections.get(name) ?? 0) > 0) return;
      if (permanentAgents.has(name)) return;
      remove(name, "stale (no connection)");
    }, opts.staleMs);
    staleTimers.set(name, t);
  }

  function ensure(name: string, room: string | null = opts.defaultRoom): Agent | null {
    if (!validName(name)) return null;
    const existing = knownAgents.get(name);
    if (existing) {
      cancelStaleTimer(name);
      return existing;
    }
    const resolvedRoom = room === null ? null : opts.resolveRoom(room);
    const a: Agent = { name, color: colorFromName(name), room: resolvedRoom };
    knownAgents.set(name, a);
    agentQueues.set(name, new DropQueue<Entry>(opts.queueMax));
    agentConnections.set(name, 0);
    console.log(`[hub] agent joined: ${name} (${a.color}) room=${resolvedRoom ?? "*"}`);
    opts.onRosterChange();
    return a;
  }

  function remove(name: string, reason: string): boolean {
    const known = knownAgents.get(name);
    if (!known) return false;
    // End its stream: it holds the removed agent's queue and would otherwise stay open for good. The
    // bridge sees the end and reconnects, which registers the agent anew.
    liveStreams.get(known)?.abort();
    liveStreams.delete(known);
    cancelStaleTimer(name);
    knownAgents.delete(name);
    agentQueues.delete(name);
    agentConnections.delete(name);
    console.log(`[hub] agent removed: ${name} (${reason})`);
    opts.onRosterChange();
    opts.onPresenceChange();
    return true;
  }

  function markPermanent(name: string): void {
    permanentAgents.add(name);
  }

  function connect(name: string): number {
    const next = (agentConnections.get(name) ?? 0) + 1;
    agentConnections.set(name, next);
    cancelStaleTimer(name);
    return next;
  }

  function disconnect(name: string): number {
    const next = Math.max(0, (agentConnections.get(name) ?? 1) - 1);
    agentConnections.set(name, next);
    if (next === 0 && knownAgents.has(name)) scheduleStaleRemoval(name);
    return next;
  }

  // Pause is keyed by the Agent object, so it lives exactly as long as the object (see features/chat.ts).
  const pausedAgents = new WeakSet<Agent>();
  const isPaused = (name: string): boolean => {
    const a = knownAgents.get(name);
    return a !== undefined && pausedAgents.has(a);
  };
  function setPaused(name: string, paused: boolean): boolean {
    const a = knownAgents.get(name);
    if (!a || pausedAgents.has(a) === paused) return false;
    if (paused) pausedAgents.add(a);
    else pausedAgents.delete(a);
    return true;
  }

  // The pause policy for one entry bound for `name`: null = do not deliver. A paused agent hears nothing
  // from other agents. Plain chat from an agent is dropped; structured events (handoff, interrupt,
  // ticket) still arrive, stamped `paused` so the bridge delivers them as context and never wakes the
  // agent. The human, the system and the agent's own permission traffic pass untouched; a peer's
  // permission traffic is no business of a paused agent (only the human votes on it).
  // Applied when an entry is queued AND again where it is delivered (queue pull, reconnect replay),
  // because the pause can start after the entry was queued or stored.
  function forDelivery(name: string, entry: Entry): Entry | null {
    if (!isPaused(name)) return entry;
    const from = typeof entry.from === "string" ? entry.from : "";
    // A peer is anyone but the human ("you" is the webview's label), the system, and a permanent member.
    // Not "a currently known agent": a sender removed after queueing is still a peer.
    const fromAgent = from !== "" && from !== "you" && from !== "system" && !permanentAgents.has(from);
    if (!entry.kind && !entry.type && fromAgent) return null;
    if (entry.kind?.startsWith("permission.") && from !== name) return null;
    if (entry.kind && !entry.kind.startsWith("permission.") && entry.paused !== true) return { ...entry, paused: true };
    return entry;
  }

  function enqueueFor(name: string, entry: Entry): boolean {
    const q = agentQueues.get(name);
    if (!q) return false;
    const out = forDelivery(name, entry);
    if (out) q.push(out);
    return true;
  }

  async function* subscribe(name: string, signal: AbortSignal): AsyncGenerator<Entry> {
    // Capture queue ref ONCE — survives map removal so an in-flight pull doesn't
    // get orphaned mid-stream when the agent is stale-cleaned. The SSE handler
    // aborts via `signal` when the connection drops.
    const q = agentQueues.get(name);
    if (!q) return;
    while (!signal.aborted) {
      // The item is on loan until take(): a takeover or removal that aborts this reader first puts it back
      // in front of the queue at once (see DropQueue.claim), so the next reader keeps the original order.
      const lease = await q.claim(signal);
      if (!lease || !lease.take()) return;
      const out = forDelivery(name, lease.item);
      if (out) yield out;
    }
  }

  async function* subscribeLeased(name: string, signal: AbortSignal): AsyncGenerator<{ item: Entry; take(): boolean; deliverable(): Entry | null }> {
    const q = agentQueues.get(name);
    if (!q) return;
    while (!signal.aborted) {
      const lease = await q.claim(signal);
      if (!lease) return;
      const out = forDelivery(name, lease.item);
      if (out === null) {   // paused since it was queued: consume it without sending
        if (!lease.take()) return;
        continue;
      }
      yield { item: out, take: () => lease.take(), deliverable: () => forDelivery(name, lease.item) };
    }
  }

  function rosterSnapshot(): Entry {
    return { type: "roster", agents: [...knownAgents.values()] as unknown as Entry["agents"] };
  }

  function presenceSnapshot(): Entry {
    const map: Record<string, boolean> = {};
    for (const name of knownAgents.keys()) {
      // Permanent members (e.g. human) have no channel-bin → force online whenever the hub is up.
      map[name] = permanentAgents.has(name) ? true : (agentConnections.get(name) ?? 0) > 0;
    }
    return { type: "presence", agents: map };
  }

  return {
    get: (name) => knownAgents.get(name) ?? null,
    has: (name) => knownAgents.has(name),
    isPermanent: (name) => permanentAgents.has(name),
    isPaused,
    setPaused,
    forDelivery,
    values: () => knownAgents.values(),
    entries: () => knownAgents.entries(),
    connectionCount: (name) => agentConnections.get(name) ?? 0,
    replaceLiveStream(agent, next) {
      const older = liveStreams.get(agent);
      liveStreams.set(agent, next);
      return older;
    },
    releaseLiveStream(agent, mine) {
      if (liveStreams.get(agent) === mine) liveStreams.delete(agent);
    },
    ensure,
    remove,
    markPermanent,
    connect,
    disconnect,
    enqueueFor,
    subscribe,
    subscribeLeased,
    rosterSnapshot,
    presenceSnapshot,
  };
}
