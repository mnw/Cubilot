// A ticket that the human moves back to queued starts a new stage of its role when the earlier stage of that role
// failed. A passed stage, or a live stage, starts nothing (G9). Real hub, fake shell.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "rqs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Stage = { id: string; ticket_id: string | null; role: string; status: string };

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

describe("a ticket moved back to queued by the human", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10, validator: 10 } }) });
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

  const mk = async () => {
    const r = await postJson(hub, "/tickets", { by: "Orchestrator", title: "t", acceptance_criteria: "c", blast_radius: "low", role: "worker" });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const stagesOf = (ticket: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db.query("SELECT id, ticket_id, role, status FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(ticket) as Stage[];
    } finally { db.close(); }
  };
  const settle = () => sleep(400);
  const humanMove = async (ticket: string, to: string) =>
    expect((await postJson(hub, `/tickets/${ticket}/transition`, { by: hub.humanName, to })).status).toBe(200);
  const launchOf = async (stageId: string, nth: number) => {
    let req: any;
    for (let i = 0; i < 100 && !(req = launches.filter((r) => r.stage_id === stageId)[nth]); i++) await sleep(50);
    expect(req).toBeDefined();
    return req;
  };
  /** Two launch errors fail the stage. */
  const failStage = async (stageId: string) => {
    for (let n = 0; n < 2; n++) {
      const req = await launchOf(stageId, n);
      await postJson(hub, `/launches/${req.id}/ack`, { result: "error", error: "tmux failed" });
    }
    await settle();
  };

  test("1: a failed worker stage: one new worker stage starts", async () => {
    const t = await mk();
    await settle();
    const [first] = stagesOf(t);
    expect(first).toMatchObject({ role: "worker", status: "launching" });
    await failStage(first.id);
    expect(stagesOf(t).map((s) => s.status)).toEqual(["failed"]);
    await humanMove(t, "in_progress");
    await settle();
    expect(stagesOf(t)).toHaveLength(1);
    await humanMove(t, "queued");
    await settle();
    const after = stagesOf(t);
    expect(after.map((s) => [s.role, s.status])).toEqual([["worker", "failed"], ["worker", "launching"]]);
    expect((await launchOf(after[1].id, 0)).stage_id).toBe(after[1].id);
  });

  test("2: a passed worker stage and no new ticket.queued event: no second worker stage", async () => {
    const t = await mk();
    await settle();
    const [worker] = stagesOf(t);
    const req = await launchOf(worker.id, 0);
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, req.session, { room: ROOM }));
    const tip = git("rev-parse", "staging");
    const commit = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "work");
    git("update-ref", `refs/heads/ticket/${t}`, commit);
    const r = await postJson(hub, "/handoffs", { from: req.session, to_role: "tester", task: "test", context: { notes: "n", stage_id: worker.id, ticket_id: t, commit } });
    expect(r.status).toBe(201);
    await settle();
    expect(stagesOf(t).map((s) => [s.role, s.status])).toEqual([["worker", "passed"], ["tester", "launching"]]);
    // the tester stage fails, so no stage is live
    await failStage(stagesOf(t)[1].id);
    expect(stagesOf(t).map((s) => s.status)).toEqual(["passed", "failed"]);
    expect((await postJson(hub, `/tickets/${t}/edit`, { by: "Orchestrator", title: "other" })).status).toBe(200);
    await settle();
    expect(stagesOf(t).map((s) => s.role)).toEqual(["worker", "tester"]);
  });

  test("3: a live worker stage: the move to queued adds no stage", async () => {
    const t = await mk();
    await settle();
    const [first] = stagesOf(t);
    expect(first.status).toBe("launching");
    await humanMove(t, "in_progress");
    await humanMove(t, "queued");
    await settle();
    expect(stagesOf(t).map((s) => [s.role, s.status])).toEqual([["worker", "launching"]]);
  });
});
