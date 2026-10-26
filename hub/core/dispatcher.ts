// Route dispatcher. Precompiles `FEATURES.flatMap(f => f.routes)` into a flat
// table keyed by (method, pathname-matcher), then dispatches incoming requests
// with per-route auth + body-size + ledger guards before invoking the handler.
//
// Adding a route = creating or editing a HubFeature module under hub/features/
// and appending it to the FEATURES array in hub.ts. No edit to dispatcher.ts.
// Path matchers support strings (exact match → {}) and RegExps (single-capture
// → { id: <capture> }).
//
// SSE long-lived routes (/stream, /agent-stream) do NOT go through this
// dispatcher — see hub/features/streams.ts and hub.ts's direct Bun.serve wiring
// (per design.md Decision 3).

import type {
  AuthHelpers,
} from "./auth";
import { corsHeaders } from "./auth";
import type { HubCapabilities, HubFeature, RouteDef } from "./types";

// WebKit rejects cross-origin responses (even on 127.0.0.1) that lack
// Access-Control-Allow-Origin — the browser surfaces this as "Load failed"
// with no further detail. Kind handlers use Bun's `Response.json()` which
// doesn't set CORS; this helper rewrites the response with CORS merged in.
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type CompiledRoute = {
  method: "GET" | "POST" | "PUT";
  matcher: (pathname: string) => Record<string, string> | null;
  auth: "mutating" | "read";
  bodyMax?: number;
  requiresLedger: boolean;
  handler: RouteDef["handler"];
};

export type Dispatcher = {
  dispatch: (req: Request, url: URL) => Promise<Response | null>;
};

export type DispatcherOptions = {
  features: readonly HubFeature[];
  auth: AuthHelpers;
  ledgerGuard: () => Response | null;
  buildCap: () => HubCapabilities;
};

// `system` is the actor of the hub's own writes (a stage launch, a retry). No HTTP caller may use it: validName() refuses
// the reserved name on the routes that read an actor, and this guard covers all the others, now and later. It looks at the
// JSON body fields that name a person or agent. It reads the body as JSON whatever the Content-Type header says, because a
// route parses it as JSON whatever the header says (Bun's req.json() ignores it); a header check would be a bypass.
// A request that is not a JSON object is left to its route.
const ACTOR_FIELDS = ["by", "from", "actor", "voter", "requester", "agent", "creator"] as const;

async function namesSystemActor(req: Request): Promise<boolean> {
  const body: unknown = await req.clone().json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const o = body as Record<string, unknown>;
  return ACTOR_FIELDS.some((f) => typeof o[f] === "string" && (o[f] as string).trim().toLowerCase() === "system");
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const compiled: CompiledRoute[] = opts.features.flatMap((f) => f.routes).map((r) => {
    let matcher: CompiledRoute["matcher"];
    if (typeof r.path === "string") {
      const path = r.path;
      matcher = (p: string) => (p === path ? {} : null);
    } else {
      const re = r.path;
      matcher = (p: string) => {
        const m = p.match(re);
        if (!m) return null;
        const params: Record<string, string> = {};
        if (m[1] !== undefined) params.id = m[1];
        return params;
      };
    }
    return {
      method: r.method,
      matcher,
      auth: r.auth,
      bodyMax: r.bodyMax,
      requiresLedger: r.requiresLedger ?? false,
      handler: r.handler,
    };
  });

  async function dispatch(req: Request, url: URL): Promise<Response | null> {
    const { pathname } = url;
    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const params = r.matcher(pathname);
      if (!params) continue;
      if (r.auth === "mutating") {
        const authFail = opts.auth.requireAuth(req);
        if (authFail) return withCors(authFail);
        const size = opts.auth.requireJsonBody(req, r.bodyMax);
        if (size) return withCors(size);
        if (await namesSystemActor(req)) {
          return withCors(Response.json({ error: "the actor 'system' is reserved for the hub" }, { status: 400 }));
        }
      } else {
        const authFail = opts.auth.requireReadAuth(req, url);
        if (authFail) return withCors(authFail);
      }
      if (r.requiresLedger) {
        const guard = opts.ledgerGuard();
        if (guard) return withCors(guard);
      }
      return withCors(await r.handler(req, opts.buildCap(), params));
    }
    return null;
  }

  return { dispatch };
}
