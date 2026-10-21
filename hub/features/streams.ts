// /stream (Webview SSE) + /agent-stream (per-Agent SSE). Owns per-connection state — wired directly, not via dispatcher.

import type { Entry, AgentCtx, Agent, HubCapabilities, KindModule } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { DropQueue, makeSSE } from "../core/sse";
import { validName } from "../core/ids";
import type { RoomHydrator } from "../core/room-hydrator";
import type { RoomSummariser } from "../core/room-summariser";
import type { BriefingPayload } from "../core/briefing";

export type StreamsDeps = {
  sessionId: string;
  uiQueueMax: number;
  defaultRoom: string;
  ledgerEnabled: () => boolean;
  chatLog: Entry[];
  uiSubscribers: Set<DropQueue<Entry>>;
  agents: AgentRegistry;
  ensureAgent: (name: string, room?: string | null) => Agent | null;
  broadcastPresence: () => void;
  roomHydrator: RoomHydrator | null;
  roomSummariser: RoomSummariser | null;
  buildBriefing: (agent: string) => BriefingPayload;
  /** Called inside /agent-stream's first-connect path so the immediately-scheduled
   *  re-fanout doesn't re-deliver the brief that was just sent inline. */
  seedBriefingSignature: (agent: string, brief: BriefingPayload) => void;
  kinds: readonly KindModule[];
  buildCap: () => HubCapabilities;
};

export type StreamHandlers = {
  handleStream(req: Request): Response;
  handleAgentStream(agent: string, room: string | null): Response;
};

export function createStreamHandlers(deps: StreamsDeps): StreamHandlers {
  const {
    sessionId,
    uiQueueMax,
    defaultRoom,
    chatLog,
    uiSubscribers,
    agents,
    ensureAgent,
    broadcastPresence,
    roomHydrator,
    roomSummariser,
    buildBriefing,
    seedBriefingSignature,
    kinds,
    buildCap,
  } = deps;

  function handleStream(req: Request): Response {
    const url = new URL(req.url);
    const lastIdRaw = url.searchParams.get("last_event_id") ?? req.headers.get("last-event-id");
    const clientSession = url.searchParams.get("session");
    const lastId = clientSession === sessionId && lastIdRaw ? Number(lastIdRaw) : 0;
    return makeSSE(async (send, signal) => {
      const q = new DropQueue<Entry>(uiQueueMax);
      uiSubscribers.add(q);
      try {
        send({ type: "session", id: sessionId });
        send(agents.rosterSnapshot());
        send(agents.presenceSnapshot());
        for (const m of chatLog) {
          if ((m.id ?? 0) > lastId) send(m, m.id);
        }
        while (!signal.aborted) {
          const m = await q.pull(signal);
          if (m.id !== undefined) send(m, m.id);
          else send(m);
        }
      } finally {
        uiSubscribers.delete(q);
      }
    });
  }

  function handleAgentStream(agent: string, room: string | null = null): Response {
    if (!validName(agent)) {
      return Response.json({ error: `invalid agent name: ${agent}` }, { status: 400 });
    }
    const self = ensureAgent(agent, room ?? defaultRoom);
    if (!self) {
      return Response.json({ error: "agent queue missing" }, { status: 500 });
    }
    return makeSSE(async (send, signal) => {
      // The agent has one live stream and every open stream pulls from its one queue, oldest waiter
      // first, so a stream whose bridge is already gone (a restarted bridge's old connection lives
      // on until its next heartbeat) would swallow the next event: a newer connection ends the older
      // one. connect() first, then end the older stream: the count never drops to zero, so presence
      // stays online and the stale timer stays cancelled. Everything here is tied to `self`, the Agent
      // OBJECT this connection registered with: if the agent is removed (and re-created by a newer
      // connection), this stream must not touch the successor's connection count.
      if (agents.get(agent) !== self) return; // removed before this stream started: nothing to serve
      agents.connect(agent);
      const mine = new AbortController();
      const older = agents.replaceLiveStream(self, mine);
      if (older) {
        console.log(`[hub] agent ${agent}: a newer stream took over from the older one`);
        older.abort();
      }
      const live = AbortSignal.any([signal, mine.signal]);
      broadcastPresence();

      const me = agents.get(agent);
      if (me?.room && roomHydrator) {
        roomHydrator.maybeHydrate(me.room).catch((e) =>
          console.error(`[hub] hydration error for room=${me.room}:`, e),
        );
      }
      if (me?.room && roomSummariser) {
        roomSummariser.maybeBackfill(me.room).catch((e) =>
          console.error(`[hub] backfill error for room=${me.room}:`, e),
        );
      }

      if (!agents.isPermanent(agent)) {
        try {
          const brief = buildBriefing(agent);
          send(brief);
          seedBriefingSignature(agent, brief);
        } catch (e) {
          console.error("[briefing]", e);
        }
      }

      if (deps.ledgerEnabled()) {
        const ctx: AgentCtx = {
          name: agent,
          room: me?.room ?? null,
          permanent: agents.isPermanent(agent),
        };
        const myRoom = me?.room ?? defaultRoom;
        const cap = buildCap();
        try {
          const sortedKinds = [...kinds].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          for (const k of sortedKinds) {
            for (const entry of k.pendingFor(ctx, cap)) {
              if (entry.room != null && entry.room !== myRoom) continue;
              const out = agents.forDelivery(agent, entry);   // a pause that started while the agent was away still applies
              if (out) send(out);
            }
          }
        } catch (e) {
          console.error("[replay]", e);
        }
      }

      try {
        // Each entry is on loan until take(), called in the same run as send(): a takeover that lands before
        // that puts the entry back for the successor instead of sending it down this dying stream.
        for await (const lease of agents.subscribeLeased(agent, live)) {
          if (!lease.take()) break;
          const out = lease.deliverable();   // the pause may have started since the lease was yielded
          if (out) send(out);
        }
      } finally {
        agents.releaseLiveStream(self, mine);
        // Only while it is still the registered object: a removed agent's connection count went with it.
        if (agents.get(agent) === self) agents.disconnect(agent);
        broadcastPresence();
      }
    });
  }

  return { handleStream, handleAgentStream };
}
