// Routes that only the human may call give 403 to the agent token (hub-first-browser group 11, design decision 5).
// If a route is added with caller: "human", add it here.
// POST /permissions/<id>/dismiss is not here on purpose: the relay hook dismisses its own request with the agent token
// (docs/rules/permissions.md). An agent that names the human there still gets 403 from the actor guard.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { registerAgent } from "../helpers/fetch";

const ROUTES: Array<[method: string, path: string]> = [
  ["POST", "/requests/r1/req-1/approve"],
  ["POST", "/decisions/d_0123456789abcdef/answer"],
  ["POST", "/checkpoints"],
  ["PUT", "/rooms/r1/settings"],
  ["POST", "/agents/w1/pause"],
  ["POST", "/remove"],
  ["GET", "/launches/stream"],
  ["POST", "/launches/l_0123456789abcdef/ack"],
  ["POST", "/permissions/abcde/verdict"],
];

describe("human-only routes", () => {
  let hub: HubHandle;
  let w1: { close: () => void };
  beforeAll(async () => { hub = await spawnHub(); w1 = await registerAgent(hub, "w1"); });
  afterAll(async () => { w1.close(); await hub.kill(); });

  const send = (method: string, path: string, token: string) =>
    fetch(`${hub.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });

  for (const [method, path] of ROUTES) {
    test(`${method} ${path} with the agent token gives 403, with the human token not`, async () => {
      const agent = await send(method, path, hub.token);
      expect(agent.status).toBe(403);
      expect(await agent.json()).toEqual({ error: "only the human may call this route" });
      const ac = new AbortController();
      const human = await fetch(`${hub.url}${path}`, {
        method, signal: ac.signal,
        headers: { Authorization: `Bearer ${hub.humanToken}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      ac.abort();
      expect(human.status).not.toBe(403);
      expect(human.status).not.toBe(401);
    });
  }

  test("Remove agent with the agent token: the agent stays on the roster", async () => {
    const r = await fetch(`${hub.url}/remove`, { method: "POST", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "w1" }) });
    expect(r.status).toBe(403);
    const roster = (await (await fetch(`${hub.url}/agents`, { headers: { Authorization: `Bearer ${hub.token}` } })).json()) as Array<{ name: string }>;
    expect(roster.map((a) => a.name)).toContain("w1");
  });

  test("Pause with the agent token", async () => {
    expect((await send("POST", "/agents/w1/pause", hub.token)).status).toBe(403);
  });

  test("Dismiss with the agent token is not refused as a human-only route", async () => {
    const r = await send("POST", "/permissions/abcde/dismiss", hub.token);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  test("Agent token on the UI stream", async () => {
    expect((await fetch(`${hub.url}/stream?token=${hub.token}`)).status).toBe(403);
  });

  test("Session on the agent stream: a human caller gets 403 and registers nobody", async () => {
    const r = await fetch(`${hub.url}/agent-stream?agent=x&token=${hub.humanToken}`);
    expect(r.status).toBe(403);
    const roster = (await (await fetch(`${hub.url}/agents`, { headers: { Authorization: `Bearer ${hub.token}` } })).json()) as Array<{ name: string }>;
    expect(roster.map((a) => a.name)).not.toContain("x");
  });
});
