// Request kind (plan-approval, tasks 2.1 and 2.2): create, edit, the origin rule, the source rule, unknown request_id.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, postJson, registerAgent } from "../helpers/fetch";

describe("request kind", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "rk-lead", { room: "rk" }));
    open.push(await registerAgent(hub, "rk-worker", { room: "rk" }));
    open.push(await registerAgent(hub, "rk-other", { room: "rk2" }));
    expect((await postJson(hub, "/rooms/rk/lead", { by: hub.humanName, agent: "rk-lead" })).status).toBe(200);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const events = (request: string) =>
    rows("SELECT e.kind, e.actor FROM events e JOIN requests r ON r.id = e.entity_id WHERE r.request_id = ? ORDER BY e.seq", request);
  const create = (body: Record<string, unknown>, by = "rk-lead") => postJson(hub, "/requests", { by, ...body });
  // Raw ticket POST: no request is created for the caller.
  const ticket = (body: Record<string, unknown>, by = "rk-lead") =>
    postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", status: "draft", noSeed: true, ...body });

  test("Default origin: the room lead creates a request with two features and no origin: origin human", async () => {
    const r = await create({ request_id: "r-1", features: ["Export", "Import"] });
    expect(r.status).toBe(201);
    expect((r.json as any).snapshot).toMatchObject({ request_id: "r-1", room: "rk", origin: "human", features: ["Export", "Import"], status: "open", approved: null });
    expect(events("r-1")).toEqual([{ kind: "request.created", actor: "rk-lead" }]);
  });

  test("Lead changes the origin: 403, and nothing is written", async () => {
    const before = events("r-1").length;
    const r = await postJson(hub, "/requests/rk/r-1/edit", { by: "rk-lead", origin: "factory" });
    expect(r.status).toBe(403);
    expect(rows("SELECT origin FROM requests WHERE request_id = 'r-1'")[0].origin).toBe("human");
    expect(events("r-1").length).toBe(before);
  });

  test("the human changes the origin: one request.edited event with from and to; a repeat writes nothing", async () => {
    await create({ request_id: "r-2" });
    const r = await postJson(hub, "/requests/rk/r-2/edit", { by: hub.humanName, origin: "factory" });
    expect(r.status).toBe(200);
    expect(rows("SELECT origin FROM requests WHERE request_id = 'r-2'")[0].origin).toBe("factory");
    expect(events("r-2")).toEqual([{ kind: "request.created", actor: "rk-lead" }, { kind: "request.edited", actor: hub.humanName }]);
    const payload = JSON.parse(rows("SELECT e.payload_json AS p FROM events e JOIN requests r ON r.id = e.entity_id WHERE r.request_id = 'r-2' AND e.kind = 'request.edited'")[0].p);
    expect(payload.origin).toEqual({ from: "human", to: "factory" });
    expect((await postJson(hub, "/requests/rk/r-2/edit", { by: hub.humanName, origin: "factory" })).json).toMatchObject({ idempotent: true });
    expect(events("r-2").length).toBe(2);
  });

  test("the lead edits the features: one event for the change", async () => {
    await create({ request_id: "r-3", features: ["a"] });
    expect((await postJson(hub, "/requests/rk/r-3/edit", { by: "rk-lead", features: ["a", "b"] })).status).toBe(200);
    expect(events("r-3").map((e) => e.kind)).toEqual(["request.created", "request.edited"]);
  });

  test("a worker of the room, and an agent of another room, cannot create or edit a request", async () => {
    expect((await create({ request_id: "r-4" }, "rk-worker")).status).toBe(403);
    expect((await create({ request_id: "r-4" }, "rk-other")).status).toBe(403);
    expect((await postJson(hub, "/requests/rk/r-3/edit", { by: "rk-worker", features: ["z"] })).status).toBe(403);
    expect((await postJson(hub, "/requests/rk/r-3/edit", { by: "rk-other", features: ["z"] })).status).toBe(403);
    expect(rows("SELECT COUNT(*) AS n FROM requests WHERE request_id = 'r-4'")[0].n).toBe(0);
  });

  test("a second request with the same label in the room gets 409; the same label in another room is allowed", async () => {
    expect((await create({ request_id: "r-1" })).status).toBe(409);
    expect((await postJson(hub, "/requests", { by: hub.humanName, room: "rk2", request_id: "r-1" })).status).toBe(201);
  });

  test("No source: a factory request of the lead without source gets 400", async () => {
    const r = await create({ request_id: "f-1", origin: "factory" });
    expect(r.status).toBe(400);
    expect(rows("SELECT COUNT(*) AS n FROM requests WHERE request_id = 'f-1'")[0].n).toBe(0);
  });

  test("a factory request names a source of the room, and its parent when the source has a request", async () => {
    await create({ request_id: "p-1" });
    const inReq = await ticket({ request_id: "p-1" });
    expect(inReq.status).toBe(201);
    const withReq = (inReq.json as any).snapshot.id as string;
    const lone = (await ticket({})).json as any;
    const loneId = lone.snapshot.id as string;
    // A source in a request needs the parent.
    expect((await create({ request_id: "f-2", origin: "factory", source: withReq })).status).toBe(400);
    expect((await create({ request_id: "f-2", origin: "factory", source: withReq, parent_request_id: "p-1" })).status).toBe(201);
    // A source without a request needs no parent.
    expect((await create({ request_id: "f-3", origin: "factory", source: loneId })).status).toBe(201);
    // The parent must be the request of the source.
    await create({ request_id: "p-2" });
    expect((await create({ request_id: "f-5", origin: "factory", source: withReq, parent_request_id: "p-2" })).status).toBe(400);
    // An unknown source, and a source of another room.
    expect((await create({ request_id: "f-4", origin: "factory", source: "t_0123456789abcdef" })).status).toBe(400);
    const foreign = (await postJson(hub, "/tickets", { by: "rk-other", title: "T", acceptance_criteria: "c", blast_radius: "low", status: "draft" })).json as any;
    expect((await create({ request_id: "f-5", origin: "factory", source: foreign.snapshot.id })).status).toBe(400);
    // An unknown parent.
    expect((await create({ request_id: "f-6", origin: "factory", source: loneId, parent_request_id: "nope" })).status).toBe(400);
  });

  test("the human creates a factory request without a source", async () => {
    const r = await postJson(hub, "/requests", { by: hub.humanName, room: "rk", request_id: "f-7", origin: "factory" });
    expect(r.status).toBe(201);
  });

  test("bad input gets 400: request_id, origin, features", async () => {
    expect((await create({ request_id: "bad id!" })).status).toBe(400);
    expect((await create({ request_id: "b-1", origin: "robot" })).status).toBe(400);
    expect((await create({ request_id: "b-2", features: "x" })).status).toBe(400);
    expect((await create({ request_id: "b-3", features: [""] })).status).toBe(400);
  });

  test("Unknown request: a ticket create or edit with an unknown request_id gets 400 and persists nothing", async () => {
    const before = rows("SELECT COUNT(*) AS n FROM tickets")[0].n;
    const r = await ticket({ request_id: "r-9" });
    expect(r.status).toBe(400);
    expect((r.json as any).error).toContain("create the request first");
    expect(rows("SELECT COUNT(*) AS n FROM tickets")[0].n).toBe(before);
    // The human gets the same 400.
    expect((await postJson(hub, "/tickets", { by: hub.humanName, room: "rk", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "r-9", noSeed: true })).status).toBe(400);
    // An edit to an unknown request_id; the ticket keeps its label.
    const id = ((await ticket({ request_id: "r-1", status: "draft" })).json as any).snapshot.id as string;
    const edit = await postJson(hub, `/tickets/${id}/edit`, { by: "rk-lead", request_id: "r-9" });
    expect(edit.status).toBe(400);
    expect(rows("SELECT request_id FROM tickets WHERE id = ?", id)[0].request_id).toBe("r-1");
    // A known request in another room is unknown here.
    expect((await ticket({ request_id: "p-1" }, "rk-other")).status).toBe(400);
  });

  test("a ticket without request_id is queued only by the human: the lead gets 403", async () => {
    const id = ((await ticket({ status: "draft" })).json as any).snapshot.id as string;
    const lead = await postJson(hub, `/tickets/${id}/transition`, { by: "rk-lead", to: "queued" });
    expect(lead.status).toBe(403);
    expect(rows("SELECT status FROM tickets WHERE id = ?", id)[0].status).toBe("draft");
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: hub.humanName, to: "queued" })).status).toBe(200);
  });

  test("a plain non-lead agent creates a queued ticket without request_id: 403, and nothing is written", async () => {
    const before = rows("SELECT COUNT(*) AS n FROM tickets")[0].n;
    const r = await ticket({ status: "queued" }, "rk-worker");
    expect(r.status).toBe(403);
    expect(rows("SELECT COUNT(*) AS n FROM tickets")[0].n).toBe(before);
    expect((await ticket({ status: "queued", room: "rk" }, hub.humanName)).status).toBe(201);
  });

  test("GET /requests lists the requests of a room with their scope change", async () => {
    const r = await authedFetch(hub, "/requests?room=rk");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { requests: Array<{ request_id: string; scope_change: { changed: boolean } }> };
    expect(body.requests.map((x) => x.request_id)).toContain("r-1");
    expect(body.requests.every((x) => x.scope_change.changed === false)).toBe(true);
    expect((await authedFetch(hub, "/requests?room=bad%20room!")).status).toBe(400);
  });
});
