// Terminal feature — the turn capture, tap read, capture read and geometry heal of an agent's tmux session
// (hub-first-browser, group 6; they replace pty_capture_turn, pty_tap_read, pty_read_capture and pty_heal_geometry).
// The primitives live in core/tmux.ts. This file only maps HTTP onto them.

import { join } from "node:path";
import { validName } from "../core/ids";
import { CAPTURE, CapturePathError, capturesDir, readCapture, type Tmux } from "../core/tmux";
import { createTerminal } from "../core/terminal";
import type { HubFeature } from "../core/types";

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
const READY_TIMEOUT_MS = 3000;
const READY_SETTLE_MS = 300;
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
    let exists: boolean;
    try { exists = await tmux.hasSession(agent); } catch (e) { return bad(e instanceof Error ? e.message : String(e), 500); }
    if (!exists) return bad(`no session: ${agent}`, 404);
    return { agent, tmux };
  }

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  return {
    routes: [
      {
        method: "POST",
        path: CAPTURE_TURN_RE,
        auth: "mutating",
        caller: "human",
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
        method: "GET",
        path: TAP_RE,
        auth: "read",
        caller: "human",
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
        caller: "human",
        handler: async (req, _cap, params) => {
          // A log outlives its session, so this route checks the name only.
          let agent: string;
          try { agent = decodeURIComponent(params.id); } catch { return bad("invalid agent"); }
          if (!validName(agent)) return bad("invalid agent");
          const q = new URL(req.url).searchParams;
          const name = q.get("name");
          if (!name) return bad("name is required");
          const max = q.get("max_bytes");
          const maxBytes = max ? Math.min(Number(max), CAPTURE.readMaxBytes) : undefined;
          try {
            const text = readCapture(capturesDir(capturesRoot, agent), name, maxBytes);
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
        caller: "human",
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
