// The hub side of the shared fake launch executor. spawnHub (tests/helpers/hub.ts) names this file in
// CUBILOT_LAUNCH_EXECUTOR, so a test hub never starts a tmux session. The module opens a small control server on
// 127.0.0.1 (port 0) and writes the port to CUBILOT_FAKE_EXECUTOR_PORT_FILE. A test connects with `openShell`
// (tests/helpers/fake-executor.ts): GET /stream attaches the consumer of the launch queue, POST /ack/<id> answers a
// request. The status codes are the ones the removed POST /launches/<id>/ack route gave.

import { writeFileSync } from "node:fs";
import type { ExecutorHost } from "../../hub/core/launch-executor";

const LAUNCH_ID_RE = /^l_[0-9a-f]{16}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });

export function start(host: ExecutorHost, env: Record<string, string | undefined>): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/stream") {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const ac = new AbortController();
            req.signal.addEventListener("abort", () => ac.abort(), { once: true });
            host.attach((r) => c.enqueue(enc.encode(`id: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`)), ac.signal);
            c.enqueue(enc.encode(": open\n\n"));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const m = req.method === "POST" ? /^\/ack\/([^/]+)$/.exec(url.pathname) : null;
      if (!m) return json({ error: "not found" }, 404);
      const id = m[1];
      if (!LAUNCH_ID_RE.test(id)) return json({ error: "invalid launch id" }, 400);
      const raw: unknown = await req.json().catch(() => null);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "the body must be a JSON object" }, 400);
      const b = raw as { result?: unknown; error?: unknown; absent?: unknown };
      if (b.absent !== undefined && (typeof b.absent !== "boolean" || b.result !== "error")) return json({ error: "absent must be a boolean and goes with result error" }, 400);
      if (b.result !== "spawned" && b.result !== "error") return json({ error: "result must be spawned or error" }, 400);
      const error = typeof b.error === "string" ? b.error.slice(0, 500) : "";
      if (b.result === "error" && !error) return json({ error: "an error ack needs error text" }, 400);
      const r = host.ack(id, b.result === "spawned" ? { result: "spawned" } : { result: "error", error, ...(b.absent === true ? { absent: true } : {}) });
      if (r.status === "error") return json({ error: r.message }, 500);
      if (r.status === "pending") return json({ ok: true, pending: true, message: r.message });
      if (r.status === "unknown") return json({ error: "not found" }, 404);
      if (r.status === "conflict") return json({ error: r.message }, 409);
      return json(r.status === "idempotent" ? { idempotent: true } : { ok: true });
    },
  });
  const file = env.CUBILOT_FAKE_EXECUTOR_PORT_FILE;
  if (file) writeFileSync(file, String(server.port));
}
