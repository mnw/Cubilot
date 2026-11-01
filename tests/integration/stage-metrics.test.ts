// GET /rooms/<room>/stage-metrics through the real hub (context-pack 5.2). Stage sessions need the app shell, so the stage and
// metrics rows are written directly into the ledger; the route is read only.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, registerAgent } from "../helpers/fetch";

describe("GET /rooms/<room>/stage-metrics", () => {
  let hub: HubHandle;
  const open: Array<{ close(): void }> = [];
  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "sm-alice", { room: "sma" }));
    open.push(await registerAgent(hub, "sm-bob", { room: "smb" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const ticket = async (by: string) => {
    const t = await postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", status: "draft" });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  let n = 0;
  const metric = (ticketId: string, role: string, attempt = 1, over: Record<string, unknown> = {}) => {
    const id = `s_${(++n).toString(16).padStart(16, "0")}`;
    const db = new Database(hub.ledgerPath);
    try {
      db.run(
        `INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, session, slot_seq, created_seq, updated_seq, version)
         VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'passed', ?, NULL, ?, ?, ?)`,
        [id, ticketId, role, attempt, `${role}-1`, n, n, n],
      );
      db.run(
        `INSERT INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, prompt_tokens_first, cache_read_tokens, tokens_before_action, source, created_seq)
         VALUES (?, ?, ?, 400, 100, ?, ?, ?, ?, ?)`,
        [id, attempt, role, "prompt" in over ? over.prompt : 5000, "cache" in over ? over.cache : 4000, "before" in over ? over.before : 9000, over.source ?? "claude", n],
      );
    } finally {
      db.close();
    }
    return id;
  };
  const get = (path: string, init?: RequestInit) => fetch(`${hub.url}${path}`, init);

  test("rows by role for one room; another room's rows are not listed", async () => {
    const ta = await ticket("sm-alice");
    const tb = await ticket("sm-bob");
    const w = metric(ta, "worker");
    const t = metric(ta, "tester", 1, { source: "none", prompt: null, cache: null, before: null });
    metric(tb, "worker");
    const r = await get("/rooms/sma/stage-metrics", { headers: { Authorization: `Bearer ${hub.token}` } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { room: string; roles: Record<string, Array<Record<string, unknown>>> };
    expect(j.room).toBe("sma");
    expect(Object.keys(j.roles).sort()).toEqual(["tester", "worker"]);
    expect(j.roles.worker.map((x) => x.stage_id)).toEqual([w]);
    expect(j.roles.worker[0]).toMatchObject({ attempt: 1, role: "worker", source: "claude", cache_read_tokens: 4000, first_message_tokens_est: 100 });
    expect(j.roles.tester.map((x) => x.stage_id)).toEqual([t]);
    expect(j.roles.tester[0]).toMatchObject({ source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null });
  });

  test("an empty room gives no roles", async () => {
    const r = await get("/rooms/nobody/stage-metrics", { headers: { Authorization: `Bearer ${hub.token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ room: "nobody", roles: {} });
  });

  test("auth: the bearer header gets 200, ?token= gets 200, no token and a wrong token get 401", async () => {
    expect((await get("/rooms/sma/stage-metrics", { headers: { Authorization: `Bearer ${hub.token}` } })).status).toBe(200);
    expect((await get(`/rooms/sma/stage-metrics?token=${hub.token}`)).status).toBe(200);
    expect((await get("/rooms/sma/stage-metrics")).status).toBe(401);
    expect((await get("/rooms/sma/stage-metrics?token=wrong")).status).toBe(401);
  });

  test("the route is read only: POST is not served", async () => {
    const r = await get("/rooms/sma/stage-metrics", { method: "POST", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).not.toBe(200);
  });
});
