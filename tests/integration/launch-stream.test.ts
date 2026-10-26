// Launch stream and ack through the real hub: auth, input checks, and that no existing route queues a launch.
// The positive path (a ready stage reaches the shell) is covered in-process in tests/unit/launch-queue.test.ts,
// because no route may start a launch.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("launch stream over HTTP", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    open.push(await registerAgent(hub, "bob", { room: "r1" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("the stream and the ack need the hub token", async () => {
    expect((await fetch(`${hub.url}/launches/stream`)).status).toBe(401);
    expect((await fetch(`${hub.url}/launches/stream?token=wrong`)).status).toBe(401);
    const noAuth = await fetch(`${hub.url}/launches/l_0123456789abcdef/ack`, {
      method: "POST", body: JSON.stringify({ result: "spawned" }), headers: { "content-type": "application/json" },
    });
    expect(noAuth.status).toBe(401);
  });

  test("ack input checks: bad id 400, bad body 400, unknown id 404", async () => {
    expect((await postJson(hub, "/launches/nope/ack", { result: "spawned" })).status).toBe(400);
    expect((await postJson(hub, "/launches/l_0123456789abcdef/ack", { result: "maybe" })).status).toBe(400);
    expect((await postJson(hub, "/launches/l_0123456789abcdef/ack", { result: "error" })).status).toBe(400);
    expect((await postJson(hub, "/launches/l_0123456789abcdef/ack", { result: "spawned" })).status).toBe(404);
    expect((await postJson(hub, "/launches/l_0123456789abcdef/ack", { result: "error", error: "x" })).status).toBe(404);
  });

  test("no route writes to the launch queue: the stream stays empty after calls to ticket, handoff, interrupt and room routes", async () => {
    const sse = openSSE(hub, "/launches/stream");
    const got: unknown[] = [];
    void (async () => { try { for await (const e of sse.events) got.push(e); } catch { /* closed */ } })();
    await sleep(150);

    // Every body carries launch-looking fields: no route reads them.
    // (`role` and `to_role` are real fields now: a queued ticket with a role is ready for a stage on purpose, and
    // tests/integration/ticket-stage-trigger.test.ts covers that. Here the ticket has no role.)
    const launchy = { launch: true, launch_session: "worker-1", stage: "queue", enqueue_launch: true };
    const t = await postJson(hub, "/tickets", {
      by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", ...launchy,
    });
    expect(t.status).toBe(201);
    const id = (t.json as { snapshot: { id: string } }).snapshot.id;
    await postJson(hub, `/tickets/${id}/claim`, { by: "bob", ...launchy });
    await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_progress", ...launchy });
    await postJson(hub, `/tickets/${id}/edit`, { by: "alice", title: "T2", ...launchy });
    await postJson(hub, `/tickets/${id}/assign`, { by: "alice", assignee: "bob", ...launchy });
    await postJson(hub, `/tickets/${id}/notes`, { by: "bob", text: "n", ...launchy });
    await postJson(hub, "/handoffs", { from: "alice", to: "bob", task: "t", ...launchy });
    await postJson(hub, "/handoffs", { from: "alice", to_role: "worker", task: "t", ...launchy });
    await postJson(hub, "/interrupts", { from: "alice", to: "bob", text: "hi", ...launchy });
    await postJson(hub, "/post", { from: "alice", to: "all", text: "launch worker-1", ...launchy });
    await authedFetch(hub, "/rooms/r1/settings", { method: "PUT", body: JSON.stringify({ role_limits: { worker: 2 }, ...launchy }) });
    await authedFetch(hub, "/rooms/r1/lead", { method: "POST", body: JSON.stringify({ by: hub.humanName, agent: "bob", ...launchy }) });

    await sleep(500);
    sse.close();
    expect(got).toEqual([]);
    expect((await getJson(hub, "/stages?status=all")).json).toEqual([]);
  });

  test("POST /launches/stream and GET /launches/<id>/ack are not routes", async () => {
    expect((await authedFetch(hub, "/launches/stream", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await authedFetch(hub, "/launches/l_0123456789abcdef/ack")).status).toBe(404);
    expect((await authedFetch(hub, "/launches", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
