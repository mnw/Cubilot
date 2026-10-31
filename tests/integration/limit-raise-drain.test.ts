// A raised role limit starts the stages that wait for a slot (request r-2026-10-29-limit-drain), through the real hub (HTTP only).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "lrd";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Stage = { id: string; ticket_id: string | null; role: string; status: string; attempt: number };

describe("role limit change drains the waiting stages", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  const limits = async (role_limits: Record<string, number>) => {
    const r = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits }) });
    expect(r.status).toBe(200);
  };
  const mk = async () => {
    const r = await postJson(hub, "/tickets", { by: "lrd-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: null });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const roleHandoff = async (ticket: string, role = "tester") =>
    expect((await postJson(hub, "/handoffs", { from: "lrd-alice", to_role: role, task: "do it", context: { ticket_id: ticket } })).status).toBe(201);
  const stageOf = (ticket: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db.query("SELECT id, ticket_id, role, status, attempt FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(ticket) as Stage[];
    } finally { db.close(); }
  };
  const requestsOf = (stageId: string) => launches.filter((r) => r.stage_id === stageId);
  const settle = () => sleep(400);

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) {
      Bun.spawnSync(["git", "-C", projectRepo(), "branch", "staging"]);
    }
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
    open.push(await registerAgent(hub, "lrd-alice", { room: ROOM }));
    stream = openLaunchStream(hub);
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("raised limit starts waiting stages", async () => {
    await limits({ tester: 0 });
    const tickets = [await mk(), await mk(), await mk()];
    for (const t of tickets) await roleHandoff(t);
    await settle();
    expect(tickets.map((t) => stageOf(t)[0].status)).toEqual(["queued", "queued", "queued"]);
    await limits({ tester: 2 });
    await settle();
    expect(tickets.map((t) => stageOf(t)[0].status)).toEqual(["launching", "launching", "queued"]);
    expect(requestsOf(stageOf(tickets[2])[0].id)).toHaveLength(0);
  });

  test("retrying stage starts first", async () => {
    await limits({ validator: 1 });
    const a = await mk();
    await roleHandoff(a, "validator");
    await settle();
    const [first] = stageOf(a);
    expect(first.status).toBe("launching");
    // the limit drops to 0 before the launch fails, so the relaunch has to wait
    await limits({ validator: 0 });
    const req = requestsOf(first.id)[0];
    await ackLaunch(hub, req.id, { result: "error", error: "tmux failed" });
    await settle();
    expect(stageOf(a)[0].status).toBe("retrying");
    // a later stage of the same role also waits
    const b = await mk();
    await roleHandoff(b, "validator");
    await settle();
    expect(stageOf(b)[0].status).toBe("queued");
    await limits({ validator: 1 });
    await settle();
    expect(stageOf(a)[0].status).toBe("launching");
    expect(stageOf(b)[0].status).toBe("queued");
  });

  test("lowered limit stops nothing", async () => {
    await limits({ worker: 2 });
    const t1 = await mk();
    const t2 = await mk();
    await roleHandoff(t1, "worker");
    await roleHandoff(t2, "worker");
    await settle();
    expect([stageOf(t1)[0].status, stageOf(t2)[0].status]).toEqual(["launching", "launching"]);
    const t3 = await mk();
    await roleHandoff(t3, "worker");
    await settle();
    expect(stageOf(t3)[0].status).toBe("queued");
    const n = launches.length;
    await limits({ worker: 1 });
    await settle();
    expect([stageOf(t1)[0].status, stageOf(t2)[0].status, stageOf(t3)[0].status]).toEqual(["launching", "launching", "queued"]);
    expect(launches).toHaveLength(n);
  });
});
