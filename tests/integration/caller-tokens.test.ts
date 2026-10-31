// The human and the agents have different tokens (hub-first-browser group 11, specs hub-discovery and caller-identity).
// The shell's own mint (hub.token mode, atomic write) is covered by `cargo test hub_tokens`; here the hub side is real.

import { describe, test, expect, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";

const hubs: HubHandle[] = [];
async function boot(opts?: Parameters<typeof spawnHub>[0]): Promise<HubHandle> {
  const h = await spawnHub(opts);
  hubs.push(h);
  return h;
}
afterAll(async () => { for (const h of hubs) await h.kill(); });

const get = (h: HubHandle, path: string, token: string) =>
  fetch(`${h.url}${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe("hub tokens", () => {
  test("Token file created at startup: the hub knows the agent token and the human token as two credentials", async () => {
    const h = await boot();
    expect(h.token).not.toBe(h.humanToken);
    expect((await get(h, "/agents", h.token)).status).toBe(200);
    expect((await get(h, "/agents", h.humanToken)).status).toBe(200);
    expect((await get(h, "/agents", "wrong")).status).toBe(401);
  });

  test("Token file is the agent token: the human token is in no env value of the hub process", async () => {
    const h = await boot();
    const ps = Bun.spawnSync(["ps", "-wwE", "-p", String(h.pid)]).stdout.toString();
    expect(ps).toContain(h.token); // CUBILOT_TOKEN, the agent token
    expect(ps).not.toContain(h.humanToken);
  });

  test("Token rotates on restart: a hub on new tokens refuses the old ones", async () => {
    const first = await boot();
    const second = await boot();
    expect(second.token).not.toBe(first.token);
    expect(second.humanToken).not.toBe(first.humanToken);
    expect((await get(second, "/agents", first.token)).status).toBe(401);
    expect((await get(second, "/agents", first.humanToken)).status).toBe(401);
  });

  test("Webview receives full auth bundle: the human token opens the UI stream, the agent token does not", async () => {
    const h = await boot();
    const ac = new AbortController();
    const ui = await fetch(`${h.url}/stream?token=${h.humanToken}`, { signal: ac.signal });
    expect(ui.status).toBe(200);
    ac.abort();
    expect((await fetch(`${h.url}/stream?token=${h.token}`)).status).toBe(403);
  });

  test("a hub with no human token on stdin has no human caller and keeps the agent token", async () => {
    const h = await boot({ noHumanToken: true });
    expect((await get(h, "/agents", h.token)).status).toBe(200);
    const r = await fetch(`${h.url}/remove`, { method: "POST", headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "x" }) });
    expect(r.status).toBe(403);
  });

  test("a human token equal to the agent token is ignored", async () => {
    const h = await boot({ token: "same-token-for-both-aaaaaaaaaaaaaaaaaaaa", humanToken: "same-token-for-both-aaaaaaaaaaaaaaaaaaaa" });
    const r = await fetch(`${h.url}/remove`, { method: "POST", headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "x" }) });
    expect(r.status).toBe(403);
  });
});
