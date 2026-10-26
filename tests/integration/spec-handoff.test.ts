// Spec-review handoff (spec-review-stage 2.1) through the real hub: creates one queued spec stage, validates the context.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("spec-review handoff over HTTP", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: unknown[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "sp", "sp2");
    open.push(await registerAgent(hub, "sp-alice", { room: "sp" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const spec = (over: Record<string, unknown> = {}, context: unknown = { request_text: "Build X" }) =>
    postJson(hub, "/handoffs", { from: "sp-alice", to_role: "validator", review: "spec", request_id: "req-1", task: "review the plan", context, ...over });

  test("creates one queued spec stage, no ticket, no launch; a draft ticket of the request gets no Worker stage (brief test 9)", async () => {
    const t = await postJson(hub, "/tickets", {
      by: "sp-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", role: "worker", request_id: "req-1", status: "draft",
    });
    expect(t.status).toBe(201);
    const r = await spec({}, { request_text: "Build X", spec_paths: ["openspec/a.md"], commit: "abc1234" });
    expect(r.status).toBe(201);
    await sleep(300);
    const stages = (await getJson(hub, "/stages?status=all")).json as any[];
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ review: "spec", request_id: "req-1", ticket_id: null, role: "validator", status: "queued" });
    expect(launches).toEqual([]);
    expect(rows("SELECT COUNT(*) AS n FROM stage WHERE role = 'worker'")[0].n).toBe(0);
  });

  test.each([
    ["no request_text", {}, { context: { spec_paths: [] } }],
    ["empty request_text", {}, { context: { request_text: "  " } }],
    ["request_text over 20 000", {}, { context: { request_text: "x".repeat(20_001) } }],
    ["spec_paths not a list", {}, { context: { request_text: "t", spec_paths: "a" } }],
    ["ticket_ids not ticket ids", {}, { context: { request_text: "t", ticket_ids: ["nope"] } }],
    ["commit not a hash", {}, { context: { request_text: "t", commit: "main" } }],
    ["no request_id", { request_id: undefined }, {}],
    ["review other than spec", { review: "code" }, {}],
    ["review with another role", { to_role: "tester" }, {}],
  ])("%s: 400 and nothing is written", async (_n, over, extra) => {
    const h0 = rows("SELECT COUNT(*) AS n FROM handoffs")[0].n;
    const e0 = rows("SELECT COUNT(*) AS n FROM events")[0].n;
    const r = await postJson(hub, "/handoffs", {
      from: "sp-alice", to_role: "validator", review: "spec", request_id: "req-1", task: "t", context: { request_text: "ok" }, ...over, ...extra,
    });
    expect(r.status).toBe(400);
    expect(rows("SELECT COUNT(*) AS n FROM handoffs")[0].n).toBe(h0);
    expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(e0);
  });

  const draft = async (request_id: string, over: Record<string, unknown> = {}) => {
    const t = await postJson(hub, "/tickets", { by: "sp-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  const scopeOf = (stageId: string) => rows("SELECT ticket_id FROM stage_scope WHERE stage_id = ? ORDER BY ticket_id", stageId).map((r) => r.ticket_id);
  const stageOf = async (request_id: string) =>
    ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.request_id === request_id);

  test("exactly 20 000 characters is accepted", async () => {
    await draft("req-2");
    expect((await spec({ request_id: "req-2" }, { request_text: "x".repeat(20_000) })).status).toBe(201);
  });

  test("default scope: every draft ticket of the request in the room; a queued ticket and another request are left out", async () => {
    const a = await draft("req-3");
    const b = await draft("req-3");
    const queued = await draft("req-3", { status: undefined });
    await draft("req-other");
    expect((await spec({ request_id: "req-3" })).status).toBe(201);
    await sleep(200);
    const [st] = await stageOf("req-3");
    expect(scopeOf(st.id)).toEqual([a, b].sort());
    expect(scopeOf(st.id)).not.toContain(queued);
  });

  test("named tickets: the scope is exactly the list", async () => {
    const a = await draft("req-4");
    await draft("req-4");
    expect((await spec({ request_id: "req-4" }, { request_text: "t", ticket_ids: [a] })).status).toBe(201);
    await sleep(200);
    expect(scopeOf((await stageOf("req-4"))[0].id)).toEqual([a]);
  });

  test("a named ticket that is queued, of another request, unknown, or in another room gets 400 and nothing is written", async () => {
    const good = await draft("req-5");
    const queued = await draft("req-5", { status: undefined });
    const other = await draft("req-other-2");
    open.push(await registerAgent(hub, "sp-bob", { room: "sp2" }));
    const foreign = ((await postJson(hub, "/tickets", { by: "sp-bob", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-5", status: "draft" })).json as any).snapshot.id;
    const h0 = rows("SELECT COUNT(*) AS n FROM handoffs")[0].n;
    const e0 = rows("SELECT COUNT(*) AS n FROM events")[0].n;
    for (const ids of [[good, queued], [good, other], [good, "t_0000000000000000"], [good, foreign]]) {
      expect((await spec({ request_id: "req-5" }, { request_text: "t", ticket_ids: ids })).status).toBe(400);
    }
    expect(rows("SELECT COUNT(*) AS n FROM handoffs")[0].n).toBe(h0);
    expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(e0);
  });

  test("a request with no draft ticket gets 400", async () => {
    expect((await spec({ request_id: "req-empty" })).status).toBe(400);
  });

  test("spec review of one changed ticket (5.2): the edited queued ticket is back to draft, the handoff names it, the scope is that ticket only", async () => {
    const other = await draft("req-6");
    const changed = await draft("req-6", { status: undefined }); // queued
    const e = await postJson(hub, `/tickets/${changed}/edit`, { by: "sp-alice", acceptance_criteria: "new criteria" });
    expect(e.status).toBe(200);
    expect(rows("SELECT status FROM tickets WHERE id = ?", changed)[0].status).toBe("draft");
    expect((await spec({ request_id: "req-6" }, { request_text: "t", ticket_ids: [changed] })).status).toBe(201);
    await sleep(200);
    const st = await stageOf("req-6");
    expect(scopeOf(st[0].id)).toEqual([changed]);
    expect(scopeOf(st[0].id)).not.toContain(other);
  });
});
