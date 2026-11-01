import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

describe("GET /handoffs/<id>", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let id: string;
  const context = { verdict: "FAIL", findings: [{ ticket_id: "t_0123456789abcdef", severity: "blocking", text: "full finding text" }] };

  beforeAll(async () => {
    hub = await spawnHub();
    for (const [name, room] of [["alice", "ra"], ["lead-a", "ra"], ["mallory", "rb"]] as const) open.push(await registerAgent(hub, name, { room }));
    expect((await postJson(hub, "/rooms/ra/lead", { by: hub.humanName, agent: "lead-a" })).status).toBe(200);
    const r = await postJson(hub, "/handoffs", { from: "alice", to: "lead-a", task: "result", context, ttl_seconds: 60 });
    expect(r.status).toBe(201);
    id = (r.json as { id: string }).id;
  });

  afterAll(async () => {
    for (const o of open) o.close();
    await hub.kill();
  });

  test("same room reads the full handoff", async () => {
    const r = await getJson(hub, `/handoffs/${id}?agent=lead-a`);
    expect(r.status).toBe(200);
    expect((r.json as { context: unknown }).context).toEqual(context);
    expect((await getJson(hub, `/handoffs/${id}?agent=alice`)).status).toBe(200);
  });

  test("another room gets 403", async () => {
    expect((await getJson(hub, `/handoffs/${id}?agent=mallory`)).status).toBe(403);
  });

  test("the human reads any room", async () => {
    expect((await getJson(hub, `/handoffs/${id}?agent=${hub.humanName}`)).status).toBe(200);
  });

  test("no bearer token gets 401", async () => {
    const r = await fetch(`${hub.url}/handoffs/${id}?agent=alice`);
    expect(r.status).toBe(401);
  });

  test("bad id, missing agent and unknown id", async () => {
    expect((await getJson(hub, `/handoffs/nope?agent=alice`)).status).toBe(400);
    expect((await getJson(hub, `/handoffs/${id}`)).status).toBe(400);
    expect((await getJson(hub, `/handoffs/${id}?agent=ghost`)).status).toBe(400);
    expect((await getJson(hub, `/handoffs/h_ffffffffffffffff?agent=alice`)).status).toBe(404);
  });

  test("the replayed entry to the lead names the lead", async () => {
    const sse = openSSE(hub, `/agent-stream?agent=lead-a&room=ra`);
    open.push(sse);
    let seen: any = null;
    for await (const e of sse.events) {
      if (e.kind === "handoff.new" && e.handoff_id === id) { seen = e; break; }
    }
    expect(seen.lead).toBe("lead-a");
  });
});
