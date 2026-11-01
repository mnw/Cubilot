// HTTP framework primitives: body-size caps, CORS, JSON responses, bearer-token auth.
// Consumers compose these via the `makeAuthHelpers(token)` factory so AUTH_TOKEN
// stays owned by the hub entry point, not scattered as a module-level global here.

import crypto from "node:crypto";
import type { HubCapabilities } from "./types";
import { validName } from "./ids";

export const JSON_BODY_MAX = 262_144;         // 256 KiB (default for JSON routes)
export const HANDOFF_BODY_MAX = 1_048_576;    // 1 MiB (POST /handoffs — accommodates context payloads)
export const PERMISSION_BODY_MAX = 16_384;    // 16 KiB (POST /permissions — bounded fields)
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// CORS origin allowlist for mutating routes. No-Origin requests (curl, sidecars) pass;
// cross-origin browsers are rejected.
export const ALLOWED_ORIGINS = new Set<string>([
  "tauri://localhost",
  "http://tauri.localhost",
]);

// A paused agent's own writes that reach others are refused with this (423 Locked).
export function pausedRefusal(): Response {
  return new Response(JSON.stringify({ error: "agent is paused" }), {
    status: 423,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// The acting name of a mutating route: 400 for a missing, invalid or unknown name. A paused agent is
// refused (423) unless the route is one a running tool call may need (allowPaused).
// A human caller acts as the human whatever `by` holds.
export function actorOr400(by: unknown, cap: HubCapabilities, allowPaused = false): { name: string } | Response {
  if (cap.caller === "human") return { name: cap.config.humanName };
  const name = typeof by === "string" ? by.trim() : "";
  if (!validName(name)) return Response.json({ error: "invalid by" }, { status: 400 });
  if (!cap.agents.get(name)) return Response.json({ error: `unknown actor: ${name}` }, { status: 400 });
  if (!allowPaused && cap.agents.isPaused(name)) return pausedRefusal();
  return { name };
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

// Constant-time string comparison. A token of another length gets a dummy compare, so it is refused without a throw.
export function ctEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

// Who a request is: the human (human token) or an agent (agent token). A browser session is group 12.
export type Caller = "human" | "agent";

export type AuthHelpers = {
  requireAuth: (req: Request) => Response | Caller;
  requireReadAuth: (req: Request, url: URL) => Response | Caller;
  requireJsonBody: (req: Request, max?: number) => Response | null;
};

// Factory so the hub entry point retains ownership of the tokens. Closures over them
// avoid re-reading env, and tests can inject known tokens. Both tokens are always compared.
// Without a human token (none came on stdin) nobody is the human.
export function makeAuthHelpers(agentToken: string, humanToken = ""): AuthHelpers {
  function callerOf(token: string): Caller | null {
    const isAgent = ctEquals(token, agentToken) && agentToken !== "";
    const isHuman = ctEquals(token, humanToken) && humanToken !== "";
    return isHuman ? "human" : isAgent ? "agent" : null;
  }

  function requireAuth(req: Request): Response | Caller {
    const origin = req.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "forbidden origin" }, { status: 403 });
    }
    if (!agentToken) {
      return json({ error: "hub misconfigured: no token" }, { status: 500 });
    }
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const caller = match ? callerOf(match[1].trim()) : null;
    return caller ?? json({ error: "unauthorized" }, { status: 401 });
  }

  function requireReadAuth(req: Request, url: URL): Response | Caller {
    if (!agentToken) {
      return json({ error: "hub misconfigured: no token" }, { status: 500 });
    }
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : (url.searchParams.get("token") ?? "").trim();
    const caller = token ? callerOf(token) : null;
    return caller ?? json({ error: "unauthorized" }, { status: 401 });
  }

  function requireJsonBody(req: Request, max = JSON_BODY_MAX): Response | null {
    const lenRaw = req.headers.get("content-length");
    if (lenRaw === null) {
      return json({ error: "length required" }, { status: 411 });
    }
    const len = Number(lenRaw);
    if (!Number.isFinite(len) || len < 0) {
      return json({ error: "invalid content-length" }, { status: 400 });
    }
    if (len > max) {
      return json({ error: "payload too large" }, { status: 413 });
    }
    return null;
  }

  return { requireAuth, requireReadAuth, requireJsonBody };
}
