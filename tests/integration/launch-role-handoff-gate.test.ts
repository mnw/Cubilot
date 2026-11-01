// A to_role handoff queues no launch when the ticket is draft, blocked or done, or when the role is at its limit (4.1).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("to_role handoff and the launch gate", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const frames: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  const mk = async (extra: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/tickets", { by: "alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: null, ...extra });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const roleHandoff = (ticket: string, role = "worker") =>
    postJson(hub, "/handoffs", { from: "alice", to_role: role, task: "x", context: { ticket_id: ticket } });
  const launchesFor = (role: string) => frames.filter((f) => f.kind === "launch" && f.role === role).length;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    stream = openLaunchStream(hub);
    void (async () => { try { for await (const e of stream.events) frames.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("a draft ticket: the handoff is stored, no launch is queued", async () => {
    const t = await mk({ status: "draft" });
    expect((await roleHandoff(t)).status).toBe(201);
    await sleep(400);
    expect(launchesFor("worker")).toBe(0);
  });

  test("a blocked ticket: no launch is queued", async () => {
    const blocker = await mk();
    const t = await mk({ blocked_by: [blocker] });
    expect((await roleHandoff(t)).status).toBe(201);
    await sleep(400);
    expect(launchesFor("worker")).toBe(0);
  });

  test("a done ticket: no launch is queued", async () => {
    const t = await mk();
    expect((await postJson(hub, `/tickets/${t}/transition`, { by: hub.humanName, to: "done" })).status).toBe(200);
    await roleHandoff(t);
    await sleep(400);
    expect(launchesFor("worker")).toBe(0);
  });

  test("a role at its limit: no second launch is queued", async () => {
    const put = await authedFetch(hub, "/rooms/r1/settings", { method: "PUT", body: JSON.stringify({ role_limits: { worker: 1 } }) });
    expect(put.status).toBe(200);
    const first = await mk();
    await roleHandoff(first);
    await sleep(400);
    expect(launchesFor("worker")).toBe(1); // control: a ready ticket under the limit launches
    const second = await mk();
    expect((await roleHandoff(second)).status).toBe(201);
    await sleep(400);
    expect(launchesFor("worker")).toBe(1);
    const st = ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.ticket_id === second);
    expect(st.every((s) => s.status === "queued")).toBe(true);
  });
});
