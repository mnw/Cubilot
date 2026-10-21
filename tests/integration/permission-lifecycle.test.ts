import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import type { HubCapabilities } from "../../hub/core/types";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

describe("permission lifecycle", () => {
  let hub: HubHandle;
  let alice: Awaited<ReturnType<typeof registerAgent>>;

  beforeAll(async () => {
    hub = await spawnHub();
    alice = await registerAgent(hub, "alice");
  });

  afterAll(async () => {
    alice.close();
    await hub.kill();
  });

  test("create → verdict allow → list allowed", async () => {
    const create = await postJson(hub, "/permissions", {
      agent: "alice",
      request_id: "abcde",
      tool_name: "Bash",
      description: "list files",
      input_preview: "ls -la /tmp",
    });
    expect(create.status).toBe(201);
    const id = (create.json as { snapshot: { id: string } }).snapshot.id;
    expect(id).toBe("abcde");

    const verdict = await postJson(hub, `/permissions/${id}/verdict`, {
      by: hub.humanName,
      behavior: "allow",
    });
    expect(verdict.status).toBe(200);
    const snap = (verdict.json as { snapshot: { status: string; behavior: string; resolved_by: string } }).snapshot;
    expect(snap.status).toBe("allowed");
    expect(snap.behavior).toBe("allow");
    expect(snap.resolved_by).toBe(hub.humanName);

    const listed = await getJson(hub, `/permissions?status=allowed&token=${hub.token}`);
    expect((listed.json as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);
  });

  test("a pending id is an idempotent retry only for the same agent and tool; anything else is a 409 collision", async () => {
    const body = { agent: "alice", request_id: "mnopq", tool_name: "Bash", description: "d", input_preview: "p" };
    expect((await postJson(hub, "/permissions", body)).status).toBe(201);
    const again = await postJson(hub, "/permissions", body);
    expect(again.status).toBe(200);
    expect((again.json as { idempotent?: boolean }).idempotent).toBe(true);
    // The same id from another agent, or for another tool, is not a retry.
    await registerAgent(hub, "mallory");
    const other = await postJson(hub, "/permissions", { ...body, agent: "mallory" });
    expect(other.status).toBe(409);
    expect((other.json as { error: string }).error).toBe("permission id already in use");
    expect((await postJson(hub, "/permissions", { ...body, tool_name: "Write" })).status).toBe(409);
    // The pending request is untouched and still alice's.
    const pending = (await getJson(hub, `/permissions?status=pending&token=${hub.token}`)).json as Array<{ id: string; agent: string; tool_name: string }>;
    expect(pending.find((p) => p.id === "mnopq")).toMatchObject({ agent: "alice", tool_name: "Bash" });
  });

  test("a request from an unknown agent is a 409 and creates no agent; the stream then sets the room", async () => {
    const body = { agent: "pl-late", request_id: "pqrst", tool_name: "Bash", description: "d", input_preview: "p" };
    const early = await postJson(hub, "/permissions", body);
    expect(early.status).toBe(409);
    expect((early.json as { error: string }).error).toContain("connect /agent-stream first");
    expect(((await getJson(hub, "/agents")).json as Array<{ name: string }>).some((a) => a.name === "pl-late")).toBe(false);
    const late = await registerAgent(hub, "pl-late", { room: "pl-room" });
    expect(((await getJson(hub, "/agents")).json as Array<{ name: string; room: string }>).find((a) => a.name === "pl-late")!.room).toBe("pl-room");
    const ok = await postJson(hub, "/permissions", body);
    expect(ok.status).toBe(201);
    expect((ok.json as { snapshot: { room: string } }).snapshot.room).toBe("pl-room");   // not "default"
    late.close();
  });

  test("same-verdict retry is idempotent", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "fghij", tool_name: "Read",
      description: "read file", input_preview: "/etc/hosts",
    });
    await postJson(hub, "/permissions/fghij/verdict", { by: hub.humanName, behavior: "allow" });
    const second = await postJson(hub, "/permissions/fghij/verdict", { by: hub.humanName, behavior: "allow" });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("409 conflict on different verdict", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "kmnop", tool_name: "Read",
      description: "conflict test", input_preview: "x",
    });
    await postJson(hub, "/permissions/kmnop/verdict", { by: hub.humanName, behavior: "allow" });
    const conflict = await postJson(hub, "/permissions/kmnop/verdict", { by: hub.humanName, behavior: "deny" });
    expect(conflict.status).toBe(409);
  });

  test("dismiss clears a pending ghost", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "qrstu", tool_name: "Bash",
      description: "ghost test", input_preview: "y",
    });
    const dismiss = await postJson(hub, "/permissions/qrstu/dismiss", { by: hub.humanName });
    expect(dismiss.status).toBe(200);
    const snap = (dismiss.json as { snapshot: { status: string; behavior: string | null } }).snapshot;
    expect(snap.status).toBe("dismissed");
    expect(snap.behavior).toBeNull();
  });

  test("409 on verdict after dismiss", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "vwxyz", tool_name: "Bash",
      description: "post-dismiss test", input_preview: "z",
    });
    await postJson(hub, "/permissions/vwxyz/dismiss", { by: hub.humanName });
    const verdict = await postJson(hub, "/permissions/vwxyz/verdict", {
      by: hub.humanName, behavior: "allow",
    });
    expect(verdict.status).toBe(409);
  });

  test("idempotent dismiss", async () => {
    await postJson(hub, "/permissions", {
      agent: "alice", request_id: "bcdef", tool_name: "Read",
      description: "idempotent dismiss", input_preview: "q",
    });
    await postJson(hub, "/permissions/bcdef/dismiss", { by: hub.humanName });
    const second = await postJson(hub, "/permissions/bcdef/dismiss", { by: hub.humanName });
    expect(second.status).toBe(200);
    expect((second.json as { idempotent?: boolean }).idempotent).toBe(true);
  });

  test("400 on invalid request_id shape", async () => {
    // 'l' is excluded from the id charset
    const r = await postJson(hub, "/permissions", {
      agent: "alice", request_id: "abcle", tool_name: "Bash",
      description: "invalid id", input_preview: "x",
    });
    expect(r.status).toBe(400);
  });

  // ---- GET /permissions/:id/wait ----

  const mkPerm = (id: string) =>
    postJson(hub, "/permissions", {
      agent: "alice", request_id: id, tool_name: "Bash",
      description: "wait test", input_preview: "w",
    });
  const wait = async (id: string, qs = "", init: RequestInit = {}) => {
    const r = await authedFetch(hub, `/permissions/${id}/wait${qs}`, init);
    return { status: r.status, json: (await r.json()) as { status?: string } };
  };

  test("wait: timeout_ms=0 returns pending immediately", async () => {
    await mkPerm("waita");
    const t0 = Date.now();
    const r = await wait("waita", "?timeout_ms=0");
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("pending");
    expect(Date.now() - t0).toBeLessThan(250);
  });

  test("wait: verdict during the wait returns early with the terminal status", async () => {
    await mkPerm("waitb");
    const t0 = Date.now();
    setTimeout(() => void postJson(hub, "/permissions/waitb/verdict", { by: hub.humanName, behavior: "deny" }), 300);
    const r = await wait("waitb", "?timeout_ms=10000");
    expect(r.json.status).toBe("denied");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("wait: short timeout returns pending after the timeout", async () => {
    await mkPerm("waitc");
    const t0 = Date.now();
    const r = await wait("waitc", "?timeout_ms=400");
    expect(r.json.status).toBe("pending");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
  });

  test("wait: bad id 400, unknown id 404, non-numeric timeout_ms 400", async () => {
    expect((await wait("ab1de", "?timeout_ms=0")).status).toBe(400);
    expect((await wait("zzzzz", "?timeout_ms=0")).status).toBe(404);
    await mkPerm("waitd");
    expect((await wait("waitd", "?timeout_ms=abc")).status).toBe(400);
  });

  test("wait: two concurrent waiters both receive the verdict", async () => {
    await mkPerm("waite");
    setTimeout(() => void postJson(hub, "/permissions/waite/verdict", { by: hub.humanName, behavior: "allow" }), 300);
    const [a, b] = await Promise.all([
      wait("waite", "?timeout_ms=10000"),
      wait("waite", "?timeout_ms=10000"),
    ]);
    expect(a.json.status).toBe("allowed");
    expect(b.json.status).toBe("allowed");
  });
});

// Handler-level: calls the route handler in-process so the abort is observable. A client
// disconnect over HTTP is invisible from outside, and the handler would otherwise poll to
// timeout_ms. Fails (times out at 3 s) if the `req.signal.aborted` check is removed.
describe("permission wait route: abort", () => {
  test("handler stops polling when the request signal aborts", async () => {
    const db = new Database(":memory:");
    migrateLedger(db);
    const kind = createPermissionKind(db);
    const route = kind.routes.find((r) => r.path instanceof RegExp && r.path.source.includes("wait"))!;
    db.run(
      `INSERT INTO permissions (id, agent, tool_name, description, input_preview, status, created_at_ms, room)
       VALUES ('abrtq', 'alice', 'Bash', 'd', 'p', 'pending', ?, 'default')`,
      [Date.now()],
    );

    const ac = new AbortController();
    const req = new Request("http://hub.test/permissions/abrtq/wait?timeout_ms=30000", { signal: ac.signal });
    const t0 = Date.now();
    const done = route.handler(req, {} as HubCapabilities, { id: "abrtq" });
    setTimeout(() => ac.abort(), 40);
    const res = await done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(((await res.json()) as { status: string }).status).toBe("pending");
  }, 3000);
});
