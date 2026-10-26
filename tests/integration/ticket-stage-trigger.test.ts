// Ticket changes run the stage evaluator (stage-sessions 2.4b): a draft queued, a ticket created as queued, a blocker done.
// Real hub with a launch stream client.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ticket changes start stages", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "ts");
    open.push(await registerAgent(hub, "ts-alice", { room: ROOM }));
    open.push(await registerAgent(hub, "ts-bob", { room: ROOM }));
    // The default limits (2 workers, 2 testers) would keep later stages queued; this file is about the triggers.
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10 } }) });
    expect(put.status).toBe(200);
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const mk = async (extra: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/tickets", { by: "ts-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", ...extra });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const stagesOf = async (ticket: string) => ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.ticket_id === ticket);
  const settle = () => sleep(300);

  test("a ticket created as queued with role worker and no blocker gets one worker stage and one launch request", async () => {
    const n = launches.length;
    const t = await mk({ role: "worker" });
    await settle();
    const s = await stagesOf(t);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ role: "worker", status: "launching" });
    expect(launches).toHaveLength(n + 1);
    expect(launches.at(-1)).toMatchObject({ kind: "launch", stage_id: s[0].id, role: "worker", room: ROOM });
  });

  test("the same ticket while draft gets none; the move to queued starts it once", async () => {
    const n = launches.length;
    const t = await mk({ role: "worker", status: "draft" });
    await settle();
    expect(await stagesOf(t)).toEqual([]);
    expect(launches).toHaveLength(n);

    expect((await postJson(hub, `/tickets/${t}/transition`, { by: hub.humanName, to: "queued" })).status).toBe(200);
    await settle();
    const s = await stagesOf(t);
    expect(s).toHaveLength(1);
    expect(launches).toHaveLength(n + 1);

    // a second event for the same ticket creates no second stage
    expect((await postJson(hub, `/tickets/${t}/transition`, { by: hub.humanName, to: "queued" })).status).toBe(200); // idempotent
    expect((await postJson(hub, `/tickets/${t}/edit`, { by: "ts-alice", title: "renamed" })).status).toBe(200);
    await settle();
    expect(await stagesOf(t)).toHaveLength(1);
    expect(launches).toHaveLength(n + 1);
  });

  test("a ticket with an open blocker gets its stage when the blocker moves to done", async () => {
    const blocker = await mk({ role: null });
    const t = await mk({ role: "worker", blocked_by: [blocker] });
    await settle();
    expect(await stagesOf(t)).toEqual([]);
    const n = launches.length;

    expect((await postJson(hub, `/tickets/${blocker}/claim`, { by: "ts-bob" })).status).toBe(200);
    await postJson(hub, `/tickets/${blocker}/transition`, { by: "ts-bob", to: "in_progress" });
    await postJson(hub, `/tickets/${blocker}/transition`, { by: "ts-bob", to: "in_review", note: "built and tested" });
    await settle();
    expect(await stagesOf(t)).toEqual([]); // in_review is not done
    expect((await postJson(hub, `/tickets/${blocker}/transition`, { by: hub.humanName, to: "done" })).status).toBe(200);
    await settle();
    const s = await stagesOf(t);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ role: "worker", status: "launching" });
    expect(launches).toHaveLength(n + 1);
  });

  test("a cancelled blocker starts nothing", async () => {
    const blocker = await mk({ role: null });
    const t = await mk({ role: "worker", blocked_by: [blocker] });
    const n = launches.length;
    expect((await postJson(hub, `/tickets/${blocker}/transition`, { by: hub.humanName, to: "cancelled" })).status).toBe(200);
    await settle();
    expect(await stagesOf(t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a blocker done starts every ticket that waited for it, and only the ready ones", async () => {
    const blocker = await mk({ role: null });
    const other = await mk({ role: null });
    const a = await mk({ role: "tester", blocked_by: [blocker] });
    const b = await mk({ role: "tester", blocked_by: [blocker, other] }); // still blocked by `other`
    const n = launches.length;
    expect((await postJson(hub, `/tickets/${blocker}/transition`, { by: hub.humanName, to: "done" })).status).toBe(200);
    await settle();
    expect(await stagesOf(a)).toHaveLength(1);
    expect(await stagesOf(b)).toEqual([]);
    expect(launches).toHaveLength(n + 1);
  });

  test("a ticket without a role, created queued or moved out of draft, starts nothing", async () => {
    const n = launches.length;
    const t1 = await mk({ role: null });
    const t2 = await mk({ role: null, status: "draft" });
    await postJson(hub, `/tickets/${t2}/transition`, { by: hub.humanName, to: "queued" });
    await settle();
    expect(await stagesOf(t1)).toEqual([]);
    expect(await stagesOf(t2)).toEqual([]);
    expect(launches).toHaveLength(n);
  });

  test("a role edit starts nothing by itself (the draft to queued move does)", async () => {
    const t = await mk({ role: null });
    const n = launches.length;
    expect((await postJson(hub, `/tickets/${t}/edit`, { by: "ts-alice", role: "worker" })).status).toBe(200);
    await settle();
    expect(await stagesOf(t)).toEqual([]);
    expect(launches).toHaveLength(n);
  });
});
