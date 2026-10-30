// Routes that only the human may call give 403 to the agent token (hub-first-browser group 11, design decision 5).
// If a route is added with caller: "human", add it here.
// The permission verdict and dismiss routes are not here on purpose: the relay hook dismisses as the agent and a peer may vote
// (docs/rules/permissions.md). An agent that names the human there still gets 403 from the actor guard.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";

const ROUTES: Array<[method: string, path: string]> = [
  ["POST", "/requests/r1/req-1/approve"],
  ["POST", "/decisions/d_0123456789abcdef/answer"],
  ["POST", "/checkpoints"],
  ["PUT", "/rooms/r1/settings"],
  ["POST", "/agents/w1/pause"],
  ["POST", "/remove"],
  ["GET", "/launches/stream"],
  ["POST", "/launches/l_0123456789abcdef/ack"],
];

describe("human-only routes", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

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
    const r = await send("POST", "/remove", hub.token);
    expect(r.status).toBe(403);
  });

  test("Pause with the agent token", async () => {
    expect((await send("POST", "/agents/w1/pause", hub.token)).status).toBe(403);
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
