// Terminal feature — the turn capture, tap read, capture read and geometry heal of an agent's tmux session
// (hub-first-browser, group 6; they replace pty_capture_turn, pty_tap_read, pty_read_capture and pty_heal_geometry).
// The primitives live in core/tmux.ts. This file only maps HTTP onto them.

import { join } from "node:path";
import { validName } from "../core/ids";
import { CapturePathError, capturesDir, readCapture, type Tmux } from "../core/tmux";
import { createTerminal, type Viewer } from "../core/terminal";
import type { AgentRegistry } from "../core/agents";
import type { Caller } from "../core/auth";
import type { HubFeature } from "../core/types";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

export type TerminalDeps = {
  /** The tmux of the hub. null when CUBILOT_TMUX or CUBILOT_DATA_DIR is not set: the routes answer 503. */
  tmux: Tmux | null;
  /** Root of the capture folders: <root>/<agent>/captures. */
  capturesRoot: string;
};

const CAPTURE_TURN_RE = /^\/terminal\/([^/]+)\/capture-turn$/;
const TAP_RE = /^\/terminal\/([^/]+)\/tap$/;
const CAPTURE_RE = /^\/terminal\/([^/]+)\/capture$/;
const HEAL_RE = /^\/terminal\/([^/]+)\/heal$/;
const SHELL_SESSION = "shell";
const INPUT_RE = /^\/terminal\/([^/]+)\/input$/;
const WS_RE = /^\/terminal\/([^/]+)$/;
const INPUT_MAX_CHARS = 65_536;
const FRAME_MAX_BYTES = 262_144;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const READY_TIMEOUT_MS = 3000;
const READY_SETTLE_MS = 300;
/** Time for the last write to reach the pane before the attach client closes. */
const FLUSH_MS = 100;
/** Wait until the attach client is listed by tmux, then let it set raw mode. Input sent earlier is lost. */
async function clientReady(tmux: Tmux, agent: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    const out = await tmux.run(["list-clients", "-F", "#{client_session}"]).catch(() => "");
    if (out.split("\n").includes(agent)) break;
    await Bun.sleep(25);
  }
  await Bun.sleep(READY_SETTLE_MS);
}
const bad = (error: string, status = 400) => Response.json({ error }, { status });

export function createTerminalFeature({ tmux, capturesRoot }: TerminalDeps): HubFeature {
  /** The agent of the path, or the 400/503/404 answer. */
  async function target(raw: string): Promise<{ agent: string; tmux: Tmux } | Response> {
    if (!tmux) return bad("terminal is not configured", 503);
    let agent: string;
    try { agent = decodeURIComponent(raw); } catch { return bad("invalid agent"); }
    if (!validName(agent)) return bad("invalid agent");
    if (!(await tmux.hasSession(agent).catch(() => false))) return bad(`no session: ${agent}`, 404);
    return { agent, tmux };
  }

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  return {
    routes: [
      {
        method: "POST",
        path: CAPTURE_TURN_RE,
        auth: "mutating",
        handler: async (req, _cap, params) => {
          const t = await target(params.id);
          if (t instanceof Response) return t;
          const body = (await req.json().catch(() => null)) as { input?: unknown; timeout_ms?: unknown } | null;
          if (!body || typeof body.input !== "string") return bad("input must be a string");
          const term = createTerminal(t.tmux);
          let viewer: Awaited<ReturnType<typeof term.attach>> | null = null;
          try {
            const result = await t.tmux.captureTurn(t.agent, body.input, {
              dir: capturesDir(capturesRoot, t.agent),
              timeoutMs: num(body.timeout_ms),
              write: async (input) => {
                viewer = await term.attach(t.agent, { onData: () => {} });
                await clientReady(t.tmux, t.agent);
                viewer.write(input);
              },
            });
            return Response.json(result);
          } catch (e) {
            return bad(e instanceof Error ? e.message : String(e), 500);
          } finally {
            (viewer as { close: () => void } | null)?.close();
          }
        },
      },
      {
        // One tab per live tmux session (the pane's tab list). The shell session is not an agent.
        method: "GET",
        path: "/terminal-sessions",
        auth: "read",
        caller: "human",
        handler: async () => {
          if (!tmux) return bad("terminal is not configured", 503);
          const names = (await tmux.listSessions()).filter((n) => n !== SHELL_SESSION && validName(n));
          return Response.json({ sessions: names.sort((a, b) => a.localeCompare(b)) });
        },
      },
      {
        // The composer's slash mode: one write, no Take control (hub-first-browser 9.4).
        method: "POST",
        path: INPUT_RE,
        auth: "mutating",
        caller: "human",
        handler: async (req, _cap, params) => {
          const t = await target(params.id);
          if (t instanceof Response) return t;
          const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
          if (!body || typeof body.text !== "string" || body.text === "") return bad("text must be a non-empty string");
          if (body.text.length > INPUT_MAX_CHARS) return bad("text is too long", 413);
          let viewer: Viewer | null = null;
          try {
            viewer = await createTerminal(t.tmux).attach(t.agent, { onData: () => {} });
            await clientReady(t.tmux, t.agent);
            viewer.write(body.text);
            await Bun.sleep(FLUSH_MS);
            return Response.json({ ok: true });
          } catch (e) {
            return bad(e instanceof Error ? e.message : String(e), 500);
          } finally {
            viewer?.close();
            await t.tmux.healGeometry(t.agent).catch(() => {});
          }
        },
      },
      {
        method: "GET",
        path: TAP_RE,
        auth: "read",
        handler: async (req, _cap, params) => {
          const t = await target(params.id);
          if (t instanceof Response) return t;
          const ms = new URL(req.url).searchParams.get("ms");
          const screen = await t.tmux.tapRead(t.agent, ms === null || ms === "" ? undefined : Number(ms));
          return new Response(screen, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        },
      },
      {
        method: "GET",
        path: CAPTURE_RE,
        auth: "read",
        handler: async (req, _cap, params) => {
          // A log outlives its session, so this route checks the name only.
          let agent: string;
          try { agent = decodeURIComponent(params.id); } catch { return bad("invalid agent"); }
          if (!validName(agent)) return bad("invalid agent");
          const q = new URL(req.url).searchParams;
          const name = q.get("name");
          if (!name) return bad("name is required");
          const max = q.get("max_bytes");
          try {
            const text = readCapture(capturesDir(capturesRoot, agent), name, max ? Number(max) : undefined);
            return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
          } catch (e) {
            if (e instanceof CapturePathError) return bad(e.message);
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return bad("no such capture", 404);
            return bad(e instanceof Error ? e.message : String(e), 500);
          }
        },
      },
      {
        method: "POST",
        path: HEAL_RE,
        auth: "mutating",
        handler: async (_req, _cap, params) => {
          const t = await target(params.id);
          if (t instanceof Response) return t;
          await t.tmux.healGeometry(t.agent);
          return Response.json({ ok: true });
        },
      },
    ],
  };
}

export const defaultCapturesRoot = () => (process.env.CUBILOT_CAPTURES_DIR ?? "").trim() || join("/tmp", "cubilot");


// ---- the terminal WebSocket (design decision 4) -------------------------------------------------------------
// GET /terminal/<agent> upgrades for the human caller. Binary frames carry the raw PTY bytes out. Text frames carry JSON:
// {"t":"take"[,"cols","rows"]}, {"t":"hand_back"}, {"t":"resize","cols","rows"}, {"t":"in","d":"<base64>"} in;
// {"t":"control","by":"you"|"other"|"none"} and {"t":"error","e":"read-only"} out.
// A viewer is read-only (attach -f read-only,ignore-size) until Take control. One controller per agent; the hold of the
// agent's entries lasts as long as a controller exists.

type WsData = {
  agent: string;
  cols: number;
  rows: number;
  viewer: Viewer | null;
  controller: boolean;
  closed: boolean;
  /** Messages of one socket run one at a time: Take control swaps the attach client. */
  chain: Promise<void>;
};

export type TerminalSocketDeps = {
  tmux: Tmux | null;
  agents: Pick<AgentRegistry, "setHeld">;
  requireReadAuth: (req: Request, url: URL) => Response | Caller;
};

const clampDim = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 10 && v <= 500 ? v : fallback;

export function createTerminalSocket({ tmux, agents, requireReadAuth }: TerminalSocketDeps) {
  const controllers = new Map<string, ServerWebSocket<WsData>>();
  const term = tmux ? createTerminal(tmux) : null;
  const say = (ws: ServerWebSocket<WsData>, m: unknown) => { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } };

  /** Replaces the attach client of a socket. The new one attaches before the old one closes. */
  async function reattach(ws: ServerWebSocket<WsData>, readOnly: boolean): Promise<void> {
    const d = ws.data;
    let next: Viewer | null = null;
    next = await term!.attach(d.agent, {
      readOnly,
      cols: d.cols,
      rows: d.rows,
      onData: (chunk) => { if (d.viewer === next && !d.closed) { try { ws.sendBinary(new Uint8Array(chunk)); } catch { /* closed */ } } },
      onExit: () => { if (d.viewer === next && !d.closed) ws.close(1000, "session ended"); },
    });
    const old = d.viewer;
    d.viewer = next;
    old?.close();
    if (d.closed) { next.close(); d.viewer = null; }
  }

  function release(ws: ServerWebSocket<WsData>): void {
    if (controllers.get(ws.data.agent) === ws) {
      controllers.delete(ws.data.agent);
      agents.setHeld(ws.data.agent, false);
    }
    ws.data.controller = false;
  }

  async function take(ws: ServerWebSocket<WsData>, m: { cols?: unknown; rows?: unknown }): Promise<void> {
    const d = ws.data;
    d.cols = clampDim(m.cols, d.cols);
    d.rows = clampDim(m.rows, d.rows);
    if (d.controller) {
      if (m.cols !== undefined || m.rows !== undefined) d.viewer?.resize(d.cols, d.rows);
      return say(ws, { t: "control", by: "you" });
    }
    await reattach(ws, false);
    if (d.closed) return;
    const prev = controllers.get(d.agent);
    controllers.set(d.agent, ws);
    d.controller = true;
    agents.setHeld(d.agent, true);
    if (prev && prev !== ws) {
      prev.data.controller = false;
      say(prev, { t: "control", by: "other" });
      await reattach(prev, true).catch(() => {});
    }
    say(ws, { t: "control", by: "you" });
  }

  async function handBack(ws: ServerWebSocket<WsData>): Promise<void> {
    if (!ws.data.controller) return;
    release(ws);
    await reattach(ws, true);
    say(ws, { t: "control", by: "none" });
  }

  async function onText(ws: ServerWebSocket<WsData>, raw: string): Promise<void> {
    let m: { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };
    try { m = JSON.parse(raw); } catch { return say(ws, { t: "error", e: "bad frame" }); }
    switch (m?.t) {
      case "take": return take(ws, m);
      case "hand_back": return handBack(ws);
      case "in":
      case "resize": {
        if (!ws.data.controller) return say(ws, { t: "error", e: "read-only" });
        if (m.t === "resize") {
          ws.data.cols = clampDim(m.cols, ws.data.cols);
          ws.data.rows = clampDim(m.rows, ws.data.rows);
          ws.data.viewer?.resize(ws.data.cols, ws.data.rows);
          return;
        }
        if (typeof m.d !== "string") return say(ws, { t: "error", e: "bad frame" });
        ws.data.viewer?.write(new Uint8Array(Buffer.from(m.d, "base64")));
        return;
      }
      default:
        return say(ws, { t: "error", e: "bad frame" });
    }
  }

  const websocket: WebSocketHandler<WsData> = {
    maxPayloadLength: FRAME_MAX_BYTES,
    idleTimeout: 960,
    open(ws) {
      // On the chain, so a Take control sent at once waits for the first attach.
      ws.data.chain = ws.data.chain.then(() => reattach(ws, true)).catch(() => { ws.close(1011, "attach failed"); });
    },
    message(ws, message) {
      if (typeof message !== "string") return say(ws, { t: "error", e: "bad frame" });
      const d = ws.data;
      d.chain = d.chain.then(() => onText(ws, message)).catch((e) => {
        console.error("[terminal] ws message failed", e);
        say(ws, { t: "error", e: "internal error" });
      });
    },
    close(ws) {
      const d = ws.data;
      d.closed = true;
      release(ws);
      d.viewer?.close();
      d.viewer = null;
    },
  };

  /** null: not a terminal socket path. "upgraded": Bun took the request. Else the answer. */
  async function upgrade(req: Request, url: URL, server: Server<WsData>): Promise<Response | "upgraded" | null> {
    const m = url.pathname.match(WS_RE);
    if (!m || req.method !== "GET") return null;
    const who = requireReadAuth(req, url);
    if (who instanceof Response) return who;
    if (who !== "human") return bad("only the human may open a terminal", 403);
    if (!tmux) return bad("terminal is not configured", 503);
    let agent: string;
    try { agent = decodeURIComponent(m[1]); } catch { return bad("invalid agent"); }
    if (!validName(agent)) return bad("invalid agent");
    if (!(await tmux.hasSession(agent).catch(() => false))) return bad(`no session: ${agent}`, 404);
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return bad("websocket upgrade required", 426);
    const num = (k: string) => { const v = url.searchParams.get(k); return v === null ? undefined : Number(v); };
    const data: WsData = {
      agent,
      cols: clampDim(num("cols"), DEFAULT_COLS),
      rows: clampDim(num("rows"), DEFAULT_ROWS),
      viewer: null,
      controller: false,
      closed: false,
      chain: Promise.resolve(),
    };
    return server.upgrade(req, { data }) ? "upgraded" : bad("websocket upgrade failed", 400);
  }

  return { upgrade, websocket };
}
