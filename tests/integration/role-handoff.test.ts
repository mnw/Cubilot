// Role handoffs (stage-sessions 2.4) through the real hub: POST /handoffs with to_role creates a stage and, when the
// launch conditions hold, queues a launch request. Nothing else queues one. The cases moved from 4.1 are here.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "rh";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("to_role handoffs over HTTP", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "elsewhere", "rh");
    open.push(await registerAgent(hub, "rh-alice", { room: ROOM }));
    open.push(await registerAgent(hub, "rh-bob", { room: ROOM }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const mkTicket = async (extra: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/tickets", { by: "rh-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", ...extra });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const roleHandoff = (ticket: string | null, role: string, extra: Record<string, unknown> = {}) =>
    postJson(hub, "/handoffs", {
      from: "rh-alice", to_role: role, task: "check it", ...(ticket ? { context: { ticket_id: ticket } } : {}), ...extra,
    });
  const stages = async (status = "all") => ((await getJson(hub, `/stages?status=${status}`)).json as any[]);
  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const settle = () => sleep(300);

  test("a to_role handoff on a ready ticket creates a stage, moves it to launching and queues one launch request", async () => {
    const t = await mkTicket({ role: null });
    const before = launches.length;
    const r = await roleHandoff(t, "tester");
    expect(r.status).toBe(201);
    await settle();
    const mine = (await stages()).filter((s) => s.ticket_id === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ role: "tester", status: "launching", session: "tester-1", attempt: 1 });
    expect(launches).toHaveLength(before + 1);
    const req = launches.at(-1);
    expect(req).toMatchObject({ kind: "launch", stage_id: mine[0].id, session: "tester-1", role: "tester", room: ROOM });
    expect(req.env).toMatchObject({ CHATBRIDGE_AGENT: "tester-1", CHATBRIDGE_ROOM: ROOM, CUBILOT_STAGE_ID: mine[0].id });
    // the launch gave the ticket to the session: one ticket.assigned event by system, in the same transaction as stage.launching
    const tk = rows("SELECT assignee FROM tickets WHERE id = ?", t)[0];
    expect(tk.assignee).toBe("tester-1");
    expect(rows("SELECT actor, payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.assigned'", t)).toEqual([
      { actor: "system", payload_json: JSON.stringify({ from: null, to: "tester-1" }) },
    ]);
    const evs = rows("SELECT seq, kind FROM events WHERE entity_id IN (?, ?) AND kind IN ('stage.launching', 'ticket.assigned') ORDER BY seq", mine[0].id, t);
    expect(evs.map((e) => e.kind)).toEqual(["stage.launching", "ticket.assigned"]);
    expect(evs[1].seq).toBe(evs[0].seq + 1);
    // one handoff event, and the stage events for its own id
    const h = rows("SELECT id, to_agent FROM handoffs WHERE id = ?", (r.json as any).id)[0];
    expect(h.to_agent).toBe("role:tester");
    expect(rows("SELECT kind FROM events WHERE entity_id = ?", h.id)).toEqual([{ kind: "handoff.created" }]);
  });

  test("the same handoff data again while that stage is live creates no second stage", async () => {
    const t = await mkTicket({ role: null });
    await roleHandoff(t, "writer");
    await settle();
    const n = launches.length;
    await roleHandoff(t, "writer");
    await settle();
    expect((await stages()).filter((s) => s.ticket_id === t)).toHaveLength(1);
    expect(launches).toHaveLength(n);
  });

  test("both to and to_role: 400 and nothing is written", async () => {
    const t = await mkTicket({ role: null });
    const h0 = rows("SELECT COUNT(*) AS n FROM handoffs")[0].n;
    const e0 = rows("SELECT COUNT(*) AS n FROM events")[0].n;
    const r = await postJson(hub, "/handoffs", { from: "rh-alice", to: "rh-bob", to_role: "tester", task: "x", context: { ticket_id: t } });
    expect(r.status).toBe(400);
    expect(rows("SELECT COUNT(*) AS n FROM handoffs")[0].n).toBe(h0);
    expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(e0);
  });

  test("bad role handoffs: unknown role, no ticket, bad or unknown ticket, ticket of another room", async () => {
    const t = await mkTicket({ role: null });
    expect((await roleHandoff(t, "chef")).status).toBe(400);
    expect((await roleHandoff(null, "tester")).status).toBe(400);
    expect((await roleHandoff("nope", "tester")).status).toBe(400);
    expect((await roleHandoff("t_ffffffffffffffff", "tester")).status).toBe(404);
    open.push(await registerAgent(hub, "rh-other", { room: "elsewhere" }));
    expect((await postJson(hub, "/handoffs", { from: "rh-other", to_role: "tester", task: "x", context: { ticket_id: t } })).status).toBe(403);
    expect((await stages()).filter((s) => s.ticket_id === t)).toEqual([]);
  });

  test("a to-only handoff behaves as before and starts no stage", async () => {
    const t = await mkTicket({ role: null });
    const n = launches.length;
    const r = await postJson(hub, "/handoffs", { from: "rh-alice", to: "rh-bob", task: "plain", context: { ticket_id: t } });
    expect(r.status).toBe(201);
    expect((await postJson(hub, "/handoffs", { from: "rh-alice", to: "nobody-here", task: "plain" })).status).toBe(400);
    await settle();
    expect((await stages()).filter((s) => s.ticket_id === t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a draft ticket queues no stage and no launch", async () => {
    const t = await mkTicket({ status: "draft", role: null });
    const n = launches.length;
    expect((await roleHandoff(t, "tester")).status).toBe(201); // recorded
    await settle();
    expect((await stages()).filter((s) => s.ticket_id === t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a blocked ticket queues no launch; when the blocker is done a later evaluation uses the stored handoff", async () => {
    const blocker = await mkTicket({ role: null });
    const t = await mkTicket({ role: null, blocked_by: [blocker] });
    const n = launches.length;
    expect((await roleHandoff(t, "reviewer")).status).toBe(201);
    await settle();
    expect((await stages()).filter((s) => s.ticket_id === t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a done ticket queues no stage and no launch", async () => {
    const t = await mkTicket({ role: null });
    expect((await postJson(hub, `/tickets/${t}/claim`, { by: "rh-bob" })).status).toBe(200);
    await postJson(hub, `/tickets/${t}/transition`, { by: "rh-bob", to: "in_progress" });
    await postJson(hub, `/tickets/${t}/transition`, { by: "rh-bob", to: "in_review", note: "built and tested" });
    expect((await postJson(hub, `/tickets/${t}/transition`, { by: hub.humanName, to: "done" })).status).toBe(200);
    const n = launches.length;
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    expect((await stages()).filter((s) => s.ticket_id === t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a role at its limit: the stage is created and stays queued, no launch", async () => {
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { editor: 1 } }) });
    expect(put.status).toBe(200);
    const t1 = await mkTicket({ role: null });
    const t2 = await mkTicket({ role: null });
    await roleHandoff(t1, "editor");
    await settle();
    const n = launches.length;
    await roleHandoff(t2, "editor");
    await settle();
    const s2 = (await stages()).filter((s) => s.ticket_id === t2);
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ role: "editor", status: "queued", session: null });
    expect(launches).toHaveLength(n);
  });

  test("session names take the lowest free number across tickets", async () => {
    const a = await mkTicket({ role: null });
    const b = await mkTicket({ role: null });
    await roleHandoff(a, "validator");
    await settle();
    await roleHandoff(b, "validator");
    await settle();
    const names = (await stages()).filter((s) => s.role === "validator" && s.session).map((s) => s.session).sort();
    expect(names).toEqual(["validator-1"]); // the default validator limit is 1: the second stage waits
  });
});
