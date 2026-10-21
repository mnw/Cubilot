import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("handoff lifecycle", () => {
  let hub: HubHandle;
  let alice: Awaited<ReturnType<typeof registerAgent>>;
  let bob: Awaited<ReturnType<typeof registerAgent>>;

  beforeAll(async () => {
    hub = await spawnHub();
    alice = await registerAgent(hub, "alice");
    bob = await registerAgent(hub, "bob");
  });

  afterAll(async () => {
    alice.close();
    bob.close();
    await hub.kill();
  });

  test("create → list pending → accept → list accepted", async () => {
    const create = await postJson(hub, "/handoffs", {
      from: "alice",
      to: "bob",
      task: "review the diff",
      ttl_seconds: 60,
    });
    expect(create.status).toBe(201);
    const id = (create.json as { id: string }).id;
    expect(id).toMatch(/^h_[0-9a-f]{16}$/);

    const listPending = await getJson(hub, `/handoffs?status=pending&for=bob&token=${hub.token}`);
    expect(listPending.status).toBe(200);
    expect((listPending.json as Array<{ id: string }>).some((h) => h.id === id)).toBe(true);

    const accept = await postJson(hub, `/handoffs/${id}/accept`, { by: "bob" });
    expect(accept.status).toBe(200);
    expect((accept.json as { snapshot: { status: string } }).snapshot.status).toBe("accepted");

    const listAccepted = await getJson(hub, `/handoffs?status=accepted&for=bob&token=${hub.token}`);
    const hit = (listAccepted.json as Array<{ id: string; status: string }>).find((h) => h.id === id);
    expect(hit?.status).toBe("accepted");
  });

  test("idempotent accept by the same recipient", async () => {
    const create = await postJson(hub, "/handoffs", {
      from: "alice", to: "bob", task: "idempotent test", ttl_seconds: 60,
    });
    const id = (create.json as { id: string }).id;

    await postJson(hub, `/handoffs/${id}/accept`, { by: "bob" });
    const second = await postJson(hub, `/handoffs/${id}/accept`, { by: "bob" });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("409 conflict on accept-after-decline", async () => {
    const create = await postJson(hub, "/handoffs", {
      from: "alice", to: "bob", task: "conflict test", ttl_seconds: 60,
    });
    const id = (create.json as { id: string }).id;

    await postJson(hub, `/handoffs/${id}/decline`, { by: "bob", reason: "no thanks" });
    const accept = await postJson(hub, `/handoffs/${id}/accept`, { by: "bob" });
    expect(accept.status).toBe(409);
    expect((accept.json as { error: string }).error).toContain("declined");
  });

  test("403 when non-recipient attempts accept", async () => {
    const create = await postJson(hub, "/handoffs", {
      from: "alice", to: "bob", task: "forbidden test", ttl_seconds: 60,
    });
    const id = (create.json as { id: string }).id;

    const accept = await postJson(hub, `/handoffs/${id}/accept`, { by: "alice" });
    expect(accept.status).toBe(403);
  });

  test("404 on unknown handoff id", async () => {
    const accept = await postJson(hub, "/handoffs/h_0000000000000000/accept", { by: "bob" });
    expect(accept.status).toBe(404);
  });
});

// A handoff can beat a bridge's reconnect (after a hub restart). It must not register the sender: that
// would pin it to the default room, because the room is fixed by the first /agent-stream.
describe("handoff from an unknown sender", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("409, no agent created, and the first stream then sets the room", async () => {
    const peer = await registerAgent(hub, "ho-peer", { room: "ho-room" });
    const early = await postJson(hub, "/handoffs", { from: "ho-late", to: "ho-peer", task: "t" });
    expect(early.status).toBe(409);
    expect((early.json as { error: string }).error).toContain("connect /agent-stream first");
    expect(((await getJson(hub, "/agents")).json as Array<{ name: string }>).some((a) => a.name === "ho-late")).toBe(false);

    const late = await registerAgent(hub, "ho-late", { room: "ho-room" });
    expect(((await getJson(hub, "/agents")).json as Array<{ name: string; room: string }>).find((a) => a.name === "ho-late")!.room).toBe("ho-room");
    expect((await postJson(hub, "/handoffs", { from: "ho-late", to: "ho-peer", task: "t" })).status).toBe(201);
    late.close(); peer.close();
  });
});
