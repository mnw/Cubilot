// Pi runtime adapter — the chatbridge as a pi.dev extension.
//
// It registers the chatbridge tools and tails /agent-stream (via the bridge core) into
// the agent's context. Pi has no MCP support by design, so tools are registered
// in-process instead.
//
// Tool definitions are NOT duplicated: this imports the same CHATBRIDGE_TOOLS
// registry and hub-client that the Claude Code mod uses. Only the transport differs.
//
// Shipped as a bundled single file (resources/pi-extension.js, built by
// scripts/build-sidecars.sh) and loaded via `pi -e <path>`; pty.rs passes
// CHATBRIDGE_AGENT / CHATBRIDGE_ROOM as env on the tmux session.

import { CHATBRIDGE_TOOLS } from "./tools";
import { buildInstructions } from "./instructions";
import { nodeHost, nodeSleep } from "./node-host";
import { startBridge, REPLY_POLICY, ReloadTimeout, RELOAD_MS, type Bridge } from "./core";
import type { Host } from "./host";
import { authedPost } from "./hub-client";

const AGENT = (process.env.CHATBRIDGE_AGENT ?? "").trim();
const ROOM = (process.env.CHATBRIDGE_ROOM ?? "default").trim() || "default";
const HUB_ENV = (process.env.CHATBRIDGE_HUB ?? "").trim();

// Pending onRead callbacks keyed by the exact delivered text, FIFO per key: hub ids
// restart with the hub, so two deliveries can share an id but never an in-flight text.
export function createReadMatcher() {
  const pending = new Map<string, Array<() => void>>();
  return {
    track(text: string, onRead: () => void): void {
      pending.set(text, [...(pending.get(text) ?? []), onRead]);
    },
    // Fires and removes the first callback queued for exactly this text.
    read(text: string): void {
      const q = pending.get(text);
      const cb = q?.shift();
      if (!cb) return;
      if (!q!.length) pending.delete(text);
      cb();
    },
    clear(): void {
      pending.clear();
    },
  };
}

function messageText(message: { content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join("");
}

// False when the run ended on an abort or an error: the agent never got to reply.
export function runAnswered(messages: unknown): boolean {
  if (!Array.isArray(messages)) return true;
  const last = [...messages].reverse().find((m: { role?: string }) => m?.role === "assistant") as
    | { stopReason?: string }
    | undefined;
  return last?.stopReason !== "aborted" && last?.stopReason !== "error";
}

function firstSentence(text: string): string {
  const cut = text.indexOf(". ");
  return (cut === -1 ? text : text.slice(0, cut + 1)).trim();
}

// The one behaviour a channel agent must not get wrong: terminal output is
// private. Only `post` is visible to the room.
const POST_GUIDELINES = [
  "Your terminal output is visible to NOBODY. Writing a reply as ordinary prose does not communicate it — the room never sees it.",
  "To say anything to the human or another agent you MUST call the `post` tool. Narrating that you have posted is not posting.",
  REPLY_POLICY,
];

export default function (pi: any): void {
  if (!AGENT) {
    console.error("[channel] CHATBRIDGE_AGENT not set — chatbridge inactive");
    return;
  }

  // Delivery modes (D2). sendUserMessage returns undefined at runtime, so it is never
  // chained unwrapped; deliver resolves right after the call (acceptance, not read).
  const reads = createReadMatcher();
  const host: Host = nodeHost(async (d) => {
    if (d.mode === "context") {
      // Context never yields a user message_start, so its onRead is not queued.
      const [customType, display] = d.text.startsWith("[Cubilot briefing]")
        ? ["chatbridge.briefing", "Briefing"]
        : d.text.startsWith("[Cubilot nutshell update]")
          ? ["chatbridge.nutshell.updated", "Nutshell"]
          : ["chatbridge.context", "Chatbridge"];
      await pi.sendMessage(
        { customType, content: d.text, display, details: null },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      return;
    }
    if (d.id !== null) reads.track(d.text, d.onRead);
    Promise.resolve(
      pi.sendUserMessage(d.text, { deliverAs: d.mode === "steer" ? "steer" : "followUp" }),
    ).catch((e: Error) => {
      console.error(`[channel] sendUserMessage failed: ${e?.message ?? e}`);
      d.onFail?.();
    });
  }, (version: string) => {
    // Spike 7.1: a followUp command with expandPromptTemplates runs after the run and calls ctx.reload().
    // sendUserMessage returns no completion, so the command handler settles this promise. It resolves only after
    // ctx.reload() resolves and rejects when it throws, also after session_shutdown (a reload fires that first).
    // Bound: RELOAD_MS for the whole reload. After the bound the reload is not stopped: a late success still
    // records applied (the handler), and the hub's pending window blocks a second reload meanwhile.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ReloadTimeout()), RELOAD_MS);
      reloadDone = { version, started: () => {}, resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      Promise.resolve(pi.sendUserMessage("/cubilot-reload", { deliverAs: "followUp", expandPromptTemplates: true }))
        .catch((e: Error) => { clearTimeout(timer); reloadDone = null; reject(e); });
    });
  });

  let bridge: Bridge | null = null;

  // The pending reload() of the core. Never settled by session_shutdown.
  let reloadDone: { version: string; started(): void; resolve(): void; reject(e: Error): void } | null = null;
  pi.registerCommand("cubilot-reload", {
    description: "Reload skills and prompt files (sent by the chatbridge when the factory files change)",
    handler: async (_args: string, ctx: { reload(): Promise<void> }) => {
      const done = reloadDone;
      reloadDone = null;
      done?.started();
      try {
        try {
          await ctx.reload();
        } catch (e) {
          // ctx.reload() stopped the bridge (session_shutdown) and invalidated this runtime's API before it failed, and
          // a failed reload starts no new session. This agent cannot recover itself: tell the hub, tell the human
          // through the hub (pi.sendMessage is invalid now), and log. The agent needs a restart.
          const msg = (e as Error)?.message ?? String(e);
          host.log(`[channel] hot reload failed: ${msg}`);
          await authedPost(host, HUB_ENV, "/factory/applied", { agent: AGENT, failed: true }).catch(() => {});
          await authedPost(host, HUB_ENV, "/post", { from: AGENT, to: "you", text: `${AGENT}: hot reload failed, restart this agent` }).catch(() => {});
          throw e;
        }
        // Success is recorded here, after ctx.reload() resolved. session_shutdown is not success.
        if (done) {
          const r = await authedPost(host, HUB_ENV, "/factory/applied", { agent: AGENT, version: done.version });
          if (r.status < 200 || r.status >= 300) throw new Error(`factory applied not recorded: HTTP ${r.status}`);
        }
        done?.resolve();
      } catch (e) {
        done?.reject(e as Error);
      }
    },
  });

  for (const t of CHATBRIDGE_TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      // Without promptSnippet pi OMITS custom tools from the system prompt's
      // "Available tools" section entirely — the model then has no standing
      // reason to reach for them. First sentence of the description is enough.
      promptSnippet: `${t.name} — ${firstSentence(t.description)}`,
      promptGuidelines: t.name === "post" ? POST_GUIDELINES : undefined,
      // Pi accepts the same JSON Schema the Claude mod registers — no conversion.
      parameters: t.inputSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        let r;
        try {
          r = await t.handler({ agent: AGENT, hubEnv: HUB_ENV, host, room: ROOM }, params ?? {});
        } catch (e) {
          bridge?.onToolResult(t.name, false);
          throw e;
        }
        bridge?.onToolResult(t.name, true);
        return { content: r.content, details: null };
      },
    });
  }

  // The Claude mod adds this text as a prompt section; pi's equivalent is to append it
  // to the rendered system prompt each turn. Same source of truth (instructions.json) so
  // the two harnesses cannot drift.
  const CHANNEL_INSTRUCTIONS = buildInstructions({ agent: AGENT, room: ROOM });
  pi.on("before_agent_start", (event: { systemPrompt: string }) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CHANNEL_INSTRUCTIONS}`,
  }));

  // A reload fires session_start again: stop the previous bridge first.
  pi.on("session_start", () => {
    bridge?.stop();
    reads.clear();
    bridge = startBridge(host, { agent: AGENT, room: ROOM, hubEnv: HUB_ENV, sleep: nodeSleep });
  });
  pi.on("session_shutdown", () => {
    bridge?.stop();
    bridge = null;
    reads.clear();
  });

  // Read signal: the user message entering context has the delivered text.
  pi.on("message_start", (event: { message?: { role?: string; content?: unknown } }) => {
    const m = event.message;
    if (m?.role !== "user") return;
    reads.read(messageText(m));
  });

  pi.on("agent_start", () => bridge?.onRunStart());
  // agent_end fires once per run; turn_end fires per model/tool iteration.
  pi.on("agent_end", (event: { messages?: unknown }) => bridge?.onRunEnd(runAnswered(event?.messages)));
}
