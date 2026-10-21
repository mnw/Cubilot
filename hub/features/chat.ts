// /post (agent send) + /send (UI/human send). Owns agentEntry URL→disk-path rewrite.

import type { Entry, HubFeature, Scope } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { imageUrlToPath } from "../core/attachments";
import { handleSend, handlePost, type ChatDeps } from "../chat";
import { json } from "../core/auth";
import { ts } from "../core/ids";

export type ChatFeatureDeps = {
  agents: AgentRegistry;
  broadcastUI: (entry: Entry, scope?: Scope) => void;
  attachmentsDir: string;
};

const AGENT_PAUSE_RE = /^\/agents\/([^/]+)\/pause$/;

export function createChatFeature(deps: ChatFeatureDeps): HubFeature {
  // In-memory, not persisted: pause is a session-level mood, not durable config.
  // A hub restart clearing it is the correct behaviour — and it saves a
  // room_settings migration for a flag nobody wants surviving a reboot.
  // Keyed by the registry's Agent object, so the pause lives exactly as long as the
  // object: removal (/remove, or the 15 s stale timer after the last stream drops) drops it.
  // A stream that reconnects inside that window gets the SAME object back, so a network
  // reconnect keeps the pause on purpose. The hub cannot tell that from a quick respawn, so a
  // launch from the UI clears the pause itself (handleLaunch POSTs paused:false as the human).
  // The flag lives in the registry (deps.agents.isPaused / setPaused), which enforces the delivery side.
  const isPaused = (name: string): boolean => deps.agents.isPaused(name);
  function announcePause(agent: string, paused: boolean): void {
    // ui-only by nature: the pause state is a view concern, and waking an agent
    // to tell it it has been paused would defeat the point. Ambient, too: it is not
    // chat, so it stays out of the chat log, the transcript, summaries and hydration.
    deps.broadcastUI({
      from: "system",
      to: agent,
      text: `[agent ${paused ? "paused" : "resumed"}]`,
      image: null,
      ts: ts(),
      room: deps.agents.get(agent)?.room ?? null,
    } as Entry, { kind: "ui-only-ambient" });
  }

  const clearPause = (name: string): void => {
    if (deps.agents.setPaused(name, false)) announcePause(name, false);
  };

  // Inline absolute path into entry.text for agent-bound entries; UI keeps the /image URL via /stream.
  function agentEntry(entry: Entry): Entry {
    if (!entry.image) return entry;
    const absPath = deps.attachmentsDir
      ? imageUrlToPath(entry.image, deps.attachmentsDir)
      : entry.image;
    const suffix = `\n[attachment: ${absPath}]`;
    return { ...entry, text: (entry.text ?? "") + suffix };
  }

  function enqueueTo(name: string, entry: Entry): void {
    if (deps.agents.isPermanent(name)) return;
    deps.agents.enqueueFor(name, entry);
  }

  const chatDeps: ChatDeps = {
    agents: deps.agents,
    broadcastUI: deps.broadcastUI,
    agentEntry,
    enqueueTo,
    isPaused,
    clearPause,
  };

  return {
    routes: [
      {
        method: "POST",
        path: "/send",
        auth: "mutating",
        handler: (req) => handleSend(req, chatDeps),
      },
      {
        method: "POST",
        path: "/post",
        auth: "mutating",
        handler: (req) => handlePost(req, chatDeps),
      },
      {
        method: "GET",
        path: AGENT_PAUSE_RE,
        auth: "read",
        handler: (_req, _cap, params) => {
          const agent = decodeURIComponent(params.id);
          return Response.json({ agent, paused: isPaused(agent) });
        },
      },
      {
        method: "POST",
        path: AGENT_PAUSE_RE,
        auth: "mutating",
        handler: async (req, cap, params) => {
          const agent = decodeURIComponent(params.id);
          const a = deps.agents.get(agent);
          if (!a) {
            return json({ error: `unknown agent: ${agent}` }, { status: 400 });
          }
          const body = (await req.json().catch(() => null)) as { paused?: unknown; by?: unknown } | null;
          if (typeof body?.paused !== "boolean") {
            return json({ error: "paused must be a boolean" }, { status: 400 });
          }
          // Only the human pauses or resumes: an agent must not silence a peer or lift its own pause.
          // Trust-on-self-assertion like every route, but a wrong or missing `by` is refused.
          if (body.by !== cap.config.humanName) {
            return json({ error: "only the human may pause or resume an agent" }, { status: 403 });
          }
          if (deps.agents.setPaused(agent, body.paused)) announcePause(agent, body.paused);
          return Response.json({ agent, paused: body.paused });
        },
      },
    ],
  };
}
