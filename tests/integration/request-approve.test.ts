// Human approval of a request (spec-review-stage 3.3): POST /requests/<room>/<request_id>/approve.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, postJson, registerAgent } from "../helpers/fetch";

describe("POST /requests/<room>/<request_id>/approve", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "claude-a", { room: "ap" }));
    open.push(await registerAgent(hub, "pi-a", { room: "ap" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const draft = async (request_id: string, over: Record<string, unknown> = {}, by = "claude-a") => {
    const t = await postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  const status = (id: string) => rows("SELECT status FROM tickets WHERE id = ?", id)[0].status;
  const approve = (room: string, request: string, by: string) => postJson(hub, `/requests/${room}/${request}/approve`, { by });

  test("the human approves: every draft ticket of the request is queued, one ticket.queued event each, actor human", async () => {
    const a = await draft("rq-1");
    const b = await draft("rq-1", { blast_radius: "high" });
    const r = await approve("ap", "rq-1", hub.humanName);
    expect(r.status).toBe(200);
    expect((r.json as { queued: string[] }).queued.sort()).toEqual([a, b].sort());
    expect([status(a), status(b)]).toEqual(["queued", "queued"]);
    // Two tickets made in one millisecond have no fixed order, so compare by id.
    expect(rows("SELECT entity_id, actor FROM events WHERE kind = 'ticket.queued' ORDER BY entity_id")).toEqual(
      [a, b].sort().map((entity_id) => ({ entity_id, actor: hub.humanName })),
    );
  });

  test("a Claude agent and a Pi agent get 403 and no ticket changes", async () => {
    const a = await draft("rq-2");
    const events0 = rows("SELECT COUNT(*) AS n FROM events")[0].n;
    for (const who of ["claude-a", "pi-a"]) {
      const r = await approve("ap", "rq-2", who);
      expect(r.status).toBe(403);
    }
    expect(status(a)).toBe("draft");
    expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(events0);
  });

  test("only draft tickets of that request in that room move; the others stay", async () => {
    const d = await draft("rq-3");
    const queued = await draft("rq-3", { status: undefined });
    const other = await draft("rq-3-other");
    open.push(await registerAgent(hub, "claude-b", { room: "ap2" }));
    const otherRoom = await draft("rq-3", {}, "claude-b");
    const r = await approve("ap", "rq-3", hub.humanName);
    expect((r.json as { queued: string[] }).queued).toEqual([d]);
    expect([status(d), status(queued), status(other), status(otherRoom)]).toEqual(["queued", "queued", "draft", "draft"]);
  });

  test("a second approval queues nothing and answers 200 idempotent; an unknown request is 404; bad ids are 400", async () => {
    await draft("rq-4");
    await approve("ap", "rq-4", hub.humanName);
    const again = await approve("ap", "rq-4", hub.humanName);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ queued: [], idempotent: true });
    expect((await approve("ap", "rq-nope", hub.humanName)).status).toBe(404);
    expect((await approve("ap", "bad id!", hub.humanName)).status).toBe(400);
    expect((await postJson(hub, "/requests/ap/rq-4/approve", { by: "system" })).status).toBe(400);
  });

  test("a failure in the middle rolls every ticket back (one transaction)", async () => {
    const a = await draft("rq-5");
    const b = await draft("rq-5");
    const db = new Database(hub.ledgerPath);
    db.exec(`CREATE TRIGGER rq5_boom BEFORE UPDATE ON tickets WHEN NEW.id = '${b}' AND NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    try {
      const events0 = rows("SELECT COUNT(*) AS n FROM events")[0].n;
      const res = await authedFetch(hub, "/requests/ap/rq-5/approve", { method: "POST", body: JSON.stringify({ by: hub.humanName }) });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect([status(a), status(b)]).toEqual(["draft", "draft"]);
      expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(events0);
    } finally {
      db.exec("DROP TRIGGER rq5_boom");
      db.close();
    }
  });
});
