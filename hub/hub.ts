// Cubilot hub. Dynamic roster; any agent that hits /agent-stream?agent=<n> auto-registers.
// Env vars: PORT, CUBILOT_TOKEN, CUBILOT_ATTACHMENTS_DIR, CUBILOT_LEDGER_DB, CUBILOT_HUMAN_NAME, CUBILOT_ALLOWED_EXTENSIONS.

import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  JSON_BODY_MAX,
  HANDOFF_BODY_MAX,
  PERMISSION_BODY_MAX,
  IMAGE_MAX_BYTES,
  corsHeaders,
  json,
  ctEquals,
  makeAuthHelpers,
} from "./core/auth";
import { DropQueue, HEARTBEAT_MS, makeSSE, type SSESend } from "./core/sse";
import { createAgentRegistry } from "./core/agents";
import { createLeadInbound } from "./core/lead-inbound";
import {
  buildAllowedExtensions,
  IMAGE_URL_RE,
} from "./core/attachments";
import { createDispatcher } from "./core/dispatcher";
import { createFanout } from "./core/fanout";
import { createBriefingDispatcher } from "./core/briefing-dispatcher";
import { createCapBuilder } from "./core/capabilities";
import { readHumanToken } from "./core/human-token";
import { createFactoryFeature } from "./features/factory";
import { createUsageFeature } from "./features/usage";
import { createConfigFeature } from "./features/config";
import { createSessionsFeature } from "./features/sessions";
import { createAttachmentsFeature } from "./features/attachments";
import { createRosterFeature } from "./features/roster";
import { createSearchFeature } from "./features/search";
import { createSettingsFeature } from "./features/settings";
import { createTranscriptFeature } from "./features/transcript";
import { createChatFeature } from "./features/chat";
import { createTerminalFeature, createTerminalSocket, defaultCapturesRoot } from "./features/terminal";
import { createTmux, tmuxFromEnv } from "./core/tmux";
import { runFactoryCleanup } from "./core/factory-cleanup";
import { createStreamHandlers } from "./features/streams";
import {
  openLedger as openLedgerCore,
  LEDGER_SCHEMA_VERSION,
  listOptedInRooms,
} from "./core/ledger";
import * as transcript from "./core/transcript";
import { createRoomHydrator, type RoomHydrator } from "./core/room-hydrator";
import {
  createRoomSummariser,
  type RoomSummariser as RoomSummariserT,
} from "./core/room-summariser";
import {
  createSummariser,
  readSummariserConfigFromEnv,
  type Summariser,
} from "./core/summariser";
import { createLaunchRecord, loadLaunchBindings } from "./core/launch-record";
import {
  createBriefingBuilder,
  briefingSignature as computeBriefingSignature,
  type BriefingBuilder,
  type BriefingPayload,
} from "./core/briefing";
import type {
  Entry,
  HubFeature,
  KindModule,
} from "./core/types";
import {
  readNutshell as readNutshellCore,
  nutshellEntry,
  type NutshellSnapshot,
} from "./nutshell";
import { buildKinds, roomLeadOf } from "./kinds";
import {
  expireHandoff as expireHandoffK,
  findExpirable as findExpirableK,
  broadcastHandoffSnapshot,
} from "./kinds/handoff";
import {
  AGENT_NAME_RE,
  RESERVED_NAMES,
  randomId,
  ts,
  colorFromName,
  validName,
  validRoomLabel,
} from "./core/ids";

// Close chmod-after-write race on SQLite's ledger.db-wal / ledger.db-shm.
process.umask(0o077);

const PORT = Number(process.env.PORT ?? 8011);
const AUTH_TOKEN = (process.env.CUBILOT_TOKEN ?? "").trim();
const HUMAN_TOKEN = await (async () => {
  const t = await readHumanToken(Bun.stdin.stream());
  if (t && t === AUTH_TOKEN) {
    console.error("[hub] the human token equals the agent token — ignored, no caller is the human");
    return "";
  }
  return t;
})();
const ATTACHMENTS_DIR = (process.env.CUBILOT_ATTACHMENTS_DIR ?? "").trim();
const LEDGER_DB = (process.env.CUBILOT_LEDGER_DB ?? "").trim();
const HUMAN_NAME = (process.env.CUBILOT_HUMAN_NAME ?? "human").trim();
const DEFAULT_ROOM = (process.env.CUBILOT_DEFAULT_ROOM ?? "default").trim() || "default";
const HISTORY_LIMIT = (() => {
  const raw = process.env.CUBILOT_CHAT_HISTORY_LIMIT;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 10 && n <= 100_000) return Math.floor(n);
  return 1000;
})();
const AGENT_QUEUE_MAX = 500;
const UI_QUEUE_MAX = 500;
// CUBILOT_STALE_AGENT_MS shortens it for tests; the app never sets it.
const STALE_AGENT_MS = Number(process.env.CUBILOT_STALE_AGENT_MS) > 0 ? Number(process.env.CUBILOT_STALE_AGENT_MS) : 15_000;
const SWEEP_INTERVAL_MS = 5_000;
import type { HandoffStatus } from "./kinds/handoff";
const ALLOWED_EXTENSIONS = buildAllowedExtensions(process.env.CUBILOT_ALLOWED_EXTENSIONS);

if (!AUTH_TOKEN) {
  console.error(
    "[hub] CUBILOT_TOKEN env not set — mutating routes will reject all requests",
  );
}
if (!ATTACHMENTS_DIR) {
  console.error(
    "[hub] CUBILOT_ATTACHMENTS_DIR env not set — uploads will fail",
  );
}
if (!LEDGER_DB) {
  console.error(
    "[hub] CUBILOT_LEDGER_DB env not set — handoff routes will be disabled",
  );
}

const chatLog: Entry[] = [];
const uiSubscribers = new Set<DropQueue<Entry>>();
let entrySeq = 0;
const SESSION_ID = randomId(8);

const leadInbound = createLeadInbound({
  file: join(dirname(LEDGER_DB || join(ATTACHMENTS_DIR || ".", "x")), "metrics", "lead-inbound.jsonl"),
  leads: () => {
    const out: Array<{ room: string; lead: string }> = [];
    for (const a of agents.values()) {
      if (!a.room) continue;
      if ((ledgerDb ? roomLeadOf(ledgerDb, a.room) : "Orchestrator") === a.name) out.push({ room: a.room, lead: a.name });
    }
    return out;
  },
  isLead: (name) => {
    const room = agents.get(name)?.room;
    return !!room && (ledgerDb ? roomLeadOf(ledgerDb, room) : "Orchestrator") === name;
  },
});

const agents = createAgentRegistry({
  onEnqueue: (name, entry) => leadInbound.record(name, entry),
  defaultRoom: DEFAULT_ROOM,
  staleMs: STALE_AGENT_MS,
  queueMax: AGENT_QUEUE_MAX,
  resolveRoom: (raw) => resolveRoom(raw),
  onRosterChange: () => {
    fanout.send(agents.rosterSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
  onPresenceChange: () => {
    fanout.send(agents.presenceSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
});
// The context files change with no roster event: re-send the roster when a percentage changed.
const CONTEXT_REFRESH_MS = 5000;
let lastContextKey = "";
setInterval(() => {
  const snap = agents.rosterSnapshot();
  const key = JSON.stringify((snap.agents as any[]).map((a) => a.context_pct));
  if (key === lastContextKey) return;
  lastContextKey = key;
  fanout.send(snap, { kind: "ui-only-ambient" });
}, CONTEXT_REFRESH_MS).unref?.();
const ensureAgent = agents.ensure;
const removeAgent = agents.remove;

let ledgerDb: Database | null = null;
let ledgerEnabled = false;

function openLedger(): void {
  const result = openLedgerCore(LEDGER_DB);
  ledgerDb = result.db;
  ledgerEnabled = result.enabled;
}

openLedger();
if (ledgerDb) {
  try { transcript.init(); }
  catch (e) { console.error("[transcript] init failed:", e); }
}

let roomHydrator: RoomHydrator | null = null;
if (ledgerDb) {
  roomHydrator = createRoomHydrator({
    db: ledgerDb,
    capLines: HISTORY_LIMIT,
    replay: (entry) => fanout.send(entry, { kind: "ui-only" }),
  });
}

// Pluggable Summariser — env-driven adapter (CUBILOT_SUMMARISER, default disabled).
let summariser: Summariser | null = null;
let roomSummariser: RoomSummariserT | null = null;
if (ledgerDb) {
  const sCfg = readSummariserConfigFromEnv();
  summariser = createSummariser(sCfg);
  if (summariser) {
    roomSummariser = createRoomSummariser({
      db: ledgerDb,
      summariser,
    });
    transcript.setAppendHook((room) => {
      roomSummariser?.maybeSummarise(room).catch((e) =>
        console.error(`[summariser] maybeSummarise error room=${room}:`, e),
      );
    });
    console.log(`[summariser] enabled adapter=${sCfg.adapter} model=${summariser.modelId}`);
  } else {
    console.log(`[summariser] disabled (CUBILOT_SUMMARISER=${sCfg.adapter})`);
  }
}

function resolveRoom(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  return s && validRoomLabel(s) ? s : DEFAULT_ROOM;
}

function readNutshell(room: string): NutshellSnapshot {
  return readNutshellCore(ledgerDb, resolveRoom(room));
}

const fanout = createFanout({
  chatLog,
  uiSubscribers,
  agents,
  historyLimit: HISTORY_LIMIT,
  ledgerDb,
  nextEntryId: () => ++entrySeq,
});

// Filled below, after the Kind migrations and before the server listens (no agent stream is open yet).
const launchRecord = createLaunchRecord();
// Lazy-init: depends on KINDS, defined below in source order.
let _briefingBuilder: BriefingBuilder | null = null;
function buildBriefing(agent: string): BriefingPayload {
  if (!_briefingBuilder) {
    _briefingBuilder = createBriefingBuilder({
      agents, kinds: KINDS, ledgerDb, ledgerEnabled, roomSummariser,
      defaultRoom: DEFAULT_ROOM, attachmentsDir: ATTACHMENTS_DIR, humanName: HUMAN_NAME,
      factoryVersion: (process.env.CUBILOT_FACTORY_VERSION ?? "").trim() || null,
      buildCap: () => buildCap(),
      isLead: (name) => {
        const room = agents.get(name)?.room;
        return !!room && (ledgerDb ? roomLeadOf(ledgerDb, room) : "Orchestrator") === name;
      },
      stageSessions: () => launchRecord.sessions(),
    });
  }
  return _briefingBuilder.build(agent);
}

const briefingDispatcher = createBriefingDispatcher({
  agents, buildBriefing, briefingSignature: computeBriefingSignature,
});

const { requireAuth, requireReadAuth, requireJsonBody } = makeAuthHelpers(AUTH_TOKEN, HUMAN_TOKEN);

function ledgerGuard(): Response | null {
  return ledgerEnabled ? null : json({ error: "ledger disabled" }, { status: 503 });
}

const buildCap = createCapBuilder({
  db: ledgerDb,
  agents,
  ensureAgent,
  fanoutSend: (entry, scope) => fanout.send(entry, scope),
  briefingRefresh: () => briefingDispatcher.scheduleFanout(),
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  config: { humanName: HUMAN_NAME, attachmentsDir: ATTACHMENTS_DIR, defaultRoom: DEFAULT_ROOM, allowedExtensions: ALLOWED_EXTENSIONS },
});

// Add a Kind: one entry in `hub/kinds/index.ts`. hub.ts unchanged.
const KINDS: readonly KindModule[] = buildKinds(ledgerDb, launchRecord);

if (ledgerDb) {
  for (const k of KINDS) k.migrate(ledgerDb);
  launchRecord.load(loadLaunchBindings(ledgerDb));
  for (const k of KINDS) k.start?.(buildCap());
}

const terminalTmux = (() => { try { return createTmux(tmuxFromEnv()); } catch { return null; } })();
try { for (const line of runFactoryCleanup()) console.error(line); } catch (e) { console.error(`[factory] cleanup failed: ${(e as Error).message}`); }
const terminalSocket = createTerminalSocket({ tmux: terminalTmux, agents, requireReadAuth });

const FEATURES: readonly HubFeature[] = [
  ...KINDS,
  createUsageFeature(),
  createConfigFeature(),
  createFactoryFeature({
    dir: (process.env.CUBILOT_FACTORY_DIR ?? "").trim(),
    version: (process.env.CUBILOT_FACTORY_VERSION ?? "").trim(),
    online: (name) => (agents.presenceSnapshot().agents as Record<string, boolean> | undefined)?.[name] === true,
  }),
  createSessionsFeature({ tmux: terminalTmux }),
  createAttachmentsFeature({
    attachmentsDir: ATTACHMENTS_DIR,
    allowedExtensions: ALLOWED_EXTENSIONS,
    imageMaxBytes: IMAGE_MAX_BYTES,
  }),
  createRosterFeature({ agents, removeAgent, readNutshell }),
  createSettingsFeature({ agents, defaultRoom: DEFAULT_ROOM }),
  createTerminalFeature({
    tmux: terminalTmux,
    capturesRoot: defaultCapturesRoot(),
  }),
  createSearchFeature({ db: ledgerDb, agents, humanName: HUMAN_NAME }),
  ...(ledgerDb
    ? [createTranscriptFeature({ db: ledgerDb, chatLog, roomSummariser, onRoleLimitsChanged: (room, cap) => { for (const k of KINDS) k.onRoomLimitsChanged?.(room, cap); } })]
    : []),
  createChatFeature({
    agents,
    broadcastUI: (entry, scope) => fanout.send(entry, scope ?? { kind: "ui-only" }),
    attachmentsDir: ATTACHMENTS_DIR,
    chatLog,
  }),
];

const { dispatch } = createDispatcher({
  features: FEATURES,
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  ledgerGuard,
  buildCap,
  humanName: HUMAN_NAME,
});

const { handleStream, handleAgentStream } = createStreamHandlers({
  sessionId: SESSION_ID,
  uiQueueMax: UI_QUEUE_MAX,
  defaultRoom: DEFAULT_ROOM,
  ledgerEnabled: () => ledgerEnabled,
  chatLog,
  uiSubscribers,
  agents,
  ensureAgent,
  broadcastPresence: () => {
    fanout.send(agents.presenceSnapshot(), { kind: "ui-only-ambient" });
    briefingDispatcher.scheduleFanout();
  },
  roomHydrator,
  roomSummariser,
  buildBriefing,
  seedBriefingSignature: (agent, brief) => briefingDispatcher.seedSignature(agent, brief),
  kinds: KINDS,
  buildCap,
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  websocket: terminalSocket.websocket,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // SSE long-lived routes are wired directly (own per-connection state).
      if (req.method === "GET" && pathname === "/stream") {
        const who = requireReadAuth(req, url);
        if (who instanceof Response) return who;
        // The UI stream is for the human: an agent token never opens it.
        if (who !== "human") return json({ error: "only the human may open the UI stream" }, { status: 403 });
        return handleStream(req);
      }
      if (req.method === "GET" && pathname === "/agent-stream") {
        const who = requireReadAuth(req, url);
        if (who instanceof Response) return who;
        // A human caller never gets the agent tools.
        if (who === "human") return json({ error: "the agent stream is for agents" }, { status: 403 });
        const agent = url.searchParams.get("agent") ?? "";
        const room = url.searchParams.get("room");
        return handleAgentStream(agent, room);
      }

      const ws = await terminalSocket.upgrade(req, url, srv as never);
      if (ws === "upgraded") return undefined;
      if (ws) return ws;

      const featResp = await dispatch(req, url);
      if (featResp) return featResp;

      return json({ error: "not found", path: pathname }, { status: 404 });
    } catch (e) {
      console.error("[hub] error", e);
      return json({ error: "internal error" }, { status: 500 });
    }
  },
});

if (validName(HUMAN_NAME)) {
  agents.markPermanent(HUMAN_NAME);
  ensureAgent(HUMAN_NAME, null);
  console.log(`[hub] human registered as "${HUMAN_NAME}" (permanent, all rooms)`);
} else {
  console.error(`[hub] invalid CUBILOT_HUMAN_NAME "${HUMAN_NAME}" — human not registered`);
}

leadInbound.start();

const sweepTimer = setInterval(() => {
  if (!ledgerEnabled || !ledgerDb) return;
  try {
    for (const id of findExpirableK(ledgerDb, Date.now())) {
      const snapshot = expireHandoffK(ledgerDb, id);
      if (snapshot) {
        broadcastHandoffSnapshot((entry, scope) => fanout.send(entry, scope), snapshot, "handoff.update");
      }
    }
  } catch (e) {
    console.error("[sweep]", e);
  }
}, SWEEP_INTERVAL_MS);

function shutdown() {
  clearInterval(sweepTimer);
  leadInbound.stop();
  briefingDispatcher.dispose();
  try { ledgerDb?.close(); } catch {}
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

// Last-resort guards — log + continue rather than crash the hub.
process.on("uncaughtException", (e) => {
  console.error("[hub] uncaughtException — continuing:", e);
});
process.on("unhandledRejection", (reason) => {
  console.error("[hub] unhandledRejection — continuing:", reason);
});

console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
console.log(
  `[hub] dynamic roster — agents register on /agent-stream connect (auth ${AUTH_TOKEN ? "enabled" : "DISABLED"})`,
);
console.log(
  `[hub] protocol ledger ${ledgerEnabled ? "enabled" : "DISABLED"}; handoff sweep every ${SWEEP_INTERVAL_MS} ms`,
);
