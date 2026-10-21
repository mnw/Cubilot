// HTTP client for the hub's /post, /handoffs, /interrupts, /permissions, /upload
// routes. Handles auth token rotation (on 401, re-reads the discovery file and
// retries once with the fresh token). Per-retry resolve keeps us in sync with
// A2AChannel.app restarts that mint new URL/port + new token pairs.

import type { Host, HttpResult } from "./host";

// The discovery files are in the app data folder. Host.readText expands this
// prefix with expandPath(), so this module needs no env or home-dir lookup.
export const DISCOVERY_DIR = "$CUBILOT_DATA_DIR";
export const URL_PATH = `${DISCOVERY_DIR}/hub.url`;
export const TOKEN_PATH = `${DISCOVERY_DIR}/hub.token`;
const DEFAULT_DATA_DIR = "~/Library/Application Support/Cubilot";

// Expand a leading DISCOVERY_DIR, then a leading "~/". `dataDir` is the
// CUBILOT_DATA_DIR env. When it is empty, use DEFAULT_DATA_DIR.
export function expandPath(path: string, home: string, dataDir: string | undefined): string {
  if (path.startsWith(`${DISCOVERY_DIR}/`)) path = (dataDir || DEFAULT_DATA_DIR) + path.slice(DISCOVERY_DIR.length);
  return path.startsWith("~/") ? home + path.slice(1) : path;
}

export type HubInfo = { url: string; token: string };

export type HubResponse = { status: number; body: string; json: unknown };

async function readTrimmed(host: Host, path: string): Promise<string | null> {
  try {
    const raw = (await host.readText(path))?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

// CHATBRIDGE_HUB env pins the URL (debug escape hatch); token always comes from disk.
export async function resolveHub(host: Host, hubEnv: string): Promise<HubInfo | null> {
  const url = hubEnv || (await readTrimmed(host, URL_PATH));
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = await readTrimmed(host, TOKEN_PATH);
  if (!token) return null;
  return { url, token };
}

// Shared auth shell: resolve hub → send → retry once on 401 after re-reading
// the token → parse response. `send` performs the Host call for one hub/token.
async function authedRequest(
  host: Host,
  hubEnv: string,
  send: (h: HubInfo) => Promise<HttpResult>,
): Promise<HubResponse> {
  let hub = await resolveHub(host, hubEnv);
  if (!hub) {
    throw new Error(
      `hub not found (need ${URL_PATH} and ${TOKEN_PATH}, or CHATBRIDGE_HUB env)`,
    );
  }
  let r = await send(hub);
  if (r.status === 401) {
    const refreshed = await resolveHub(host, hubEnv);
    if (refreshed && refreshed.token !== hub.token) {
      hub = refreshed;
      r = await send(hub);
    }
  }
  let parsed: unknown = null;
  try {
    parsed = r.text ? JSON.parse(r.text) : null;
  } catch {}
  return { status: r.status, body: r.text, json: parsed };
}

// Auto-retries once with a fresh token on 401.
export function authedPost(
  host: Host,
  hubEnv: string,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<HubResponse> {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return authedRequest(host, hubEnv, (h) =>
    host.request(`${h.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.token}` },
      body: bodyStr,
      timeoutMs,
    }),
  );
}

// Auto-retries once with a fresh token on 401.
export function authedGet(host: Host, hubEnv: string, path: string, timeoutMs?: number): Promise<HubResponse> {
  return authedRequest(host, hubEnv, (h) =>
    host.request(`${h.url}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${h.token}` },
      timeoutMs,
    }),
  );
}

// Size/regular-file checks live in Host.upload.
export function authedUpload(
  host: Host,
  hubEnv: string,
  filePath: string,
): Promise<HubResponse> {
  return authedRequest(host, hubEnv, (h) => host.upload(`${h.url}/upload`, h.token, filePath));
}

// The hub answers 423 to every write of a paused agent. One fixed line, so the agent waits
// instead of retrying.
export const PAUSED_LINE = "You are paused by the human; wait until the human resumes you";

// Map an error response from the hub into an Error with the hub-side message.
// Used by every tool handler — never returns (throws).
export function toolError(resp: HubResponse, action: string): never {
  if (resp.status === 423) throw new Error(`${action} failed: ${PAUSED_LINE}`);
  const msg =
    resp.json &&
    typeof resp.json === "object" &&
    "error" in resp.json &&
    typeof (resp.json as { error: unknown }).error === "string"
      ? (resp.json as { error: string }).error
      : resp.body || `HTTP ${resp.status}`;
  throw new Error(`${action} failed: ${resp.status} ${msg}`);
}
