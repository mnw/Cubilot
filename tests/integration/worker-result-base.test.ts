// G2 base check through the real hub: a rebased rework is new work, a same or older commit is not, and a git failure refuses.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

describe("worker result base check", () => {
  let hub: HubHandle;
  let seq = 0;
  const open: Array<{ close: () => void }> = [];
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const commitOn = (parent: string, msg: string) => git("commit-tree", `${parent}^{tree}`, "-p", parent, "-m", msg);

  /** Creates a ticket in the room, runs its first worker stage and returns the ids. */
  async function startWorker(room: string) {
    open.push(await registerAgent(hub, `${room}-lead`, { room }));
    const t = await postJson(hub, "/tickets", { by: `${room}-lead`, title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: "worker" });
    const ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
    let worker = "";
    const sse = openSSE(hub, "/launches/stream");
    for await (const req of sse.events) {
      // The stream replays earlier launches (a tester from a former test): ack only the worker we wait for.
      if (!String(req.session).startsWith("worker-")) continue;
      worker = req.session;
      expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
      break;
    }
    sse.close();
    open.push(await registerAgent(hub, worker, { room }));
    const stages = (await getJson(hub, "/stages?status=running")).json as Array<{ id: string; session: string }>;
    return { ticketId, worker, stageId: stages.find((s) => s.session === worker)!.id };
  }
  const send = (from: string, stageId: string, ticketId: string, commit: string) =>
    postJson(hub, "/handoffs", { from, to_role: "tester", task: "result", context: { notes: "n", stage_id: stageId, ticket_id: ticketId, commit } });
  const status = async (id: string) => ((await getJson(hub, `/stages/${id}`)).json as { status: string }).status;
  const refusal = (r: { json: unknown }) => (r.json as { errors: string[] }).errors[0];

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "rb1", "rb2");
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    const put = await authedFetch(hub, "/rooms/rb1/settings", { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10 } }) });
    expect(put.status).toBe(200);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  /** Passes the first worker stage on commit A, then opens a second running worker stage on the same ticket (a rework). */
  async function reworkSetup() {
    const { ticketId, worker, stageId } = await startWorker("rb1");
    const ref = `refs/heads/ticket/${ticketId}`;
    const a = commitOn(git("rev-parse", ref), "A");
    git("update-ref", ref, a);
    expect((await send(worker, stageId, ticketId, a)).status).toBe(201);
    expect(await status(stageId)).toBe("passed");
    // The hub ledger is the only way to open a second worker stage without the Tester round trip.
    const db = new Database(hub.ledgerPath);
    db.run("PRAGMA busy_timeout = 5000");
    const id = "s_" + "0".repeat(15) + String(++seq);
    const session = `worker-${70 + seq}`;
    db.run("INSERT INTO stage (id, ticket_id, role, attempt, status, session) VALUES (?, ?, 'worker', 2, 'running', ?)", [id, ticketId, session]);
    db.close();
    open.push(await registerAgent(hub, session, { room: "rb1" }));
    return { ticketId, ref, a, stage2: id, session };
  }

  test("rebased rework accepted", async () => {
    const { ticketId, ref, a, stage2, session } = await reworkSetup();
    // Rebase: B is built on staging, not on A, then gets one new commit. A is no longer an ancestor of the branch.
    const b = commitOn(commitOn(git("rev-parse", "staging"), "rebased work"), "rework");
    git("update-ref", ref, b);
    expect(Bun.spawnSync(["git", "-C", projectRepo(), "merge-base", "--is-ancestor", a, b]).exitCode).toBe(1);
    const r = await send(session, stage2, ticketId, b);
    expect(r.status).toBe(201);
    expect(await status(stage2)).toBe("passed");
  });

  test("same or older commit refused", async () => {
    const { ticketId, ref, a, stage2, session } = await reworkSetup();
    // The same commit as the earlier result.
    let r = await send(session, stage2, ticketId, a);
    expect(r.status).toBe(400);
    expect(refusal(r)).toContain("not new work");
    // A commit older than the base.
    const c = commitOn(a, "C");
    git("update-ref", ref, c);
    git("branch", "-f", `${ticketId}-keep`, c);
    const older = git("rev-parse", `${a}^`);
    r = await send(session, stage2, ticketId, older);
    expect(r.status).toBe(400);
    expect(refusal(r)).toContain("not new work");
    // After a rebase, a commit with no work beyond staging is still refused.
    const rebased = git("rev-parse", "staging");
    git("update-ref", ref, rebased);
    r = await send(session, stage2, ticketId, rebased);
    expect(r.status).toBe(400);
    expect(refusal(r)).toContain("not new work");
    expect(await status(stage2)).toBe("running");
  });

  test("git failure refuses", async () => {
    // A real repository while the room saves it (the route checks), broken afterwards so every git call fails.
    const dir = mkdtempSync(join(tmpdir(), "nogit-"));
    expect(Bun.spawnSync(["git", "-C", dir, "init", "-q"]).exitCode).toBe(0);
    const put = await authedFetch(hub, "/rooms/rb2/settings", { method: "PUT", body: JSON.stringify({ project_folder: dir, role_limits: { worker: 10 } }) });
    expect(put.status).toBe(200);
    renameSync(join(dir, ".git"), join(dir, ".git-gone"));
    const db = new Database(hub.ledgerPath);
    db.run("PRAGMA busy_timeout = 5000");
    open.push(await registerAgent(hub, "rb2-lead", { room: "rb2" }));
    open.push(await registerAgent(hub, "worker-9", { room: "rb2" }));
    const ticketId = "t_" + "0".repeat(15) + "9";
    const id = "s_" + "0".repeat(15) + "f";
    db.run("INSERT INTO stage (id, ticket_id, role, attempt, status, session) VALUES (?, ?, 'worker', 1, 'running', 'worker-9')", [id, ticketId]);
    db.close();
    const r = await send("worker-9", id, ticketId, git("rev-parse", "staging"));
    expect(r.status).toBe(400);
    expect(await status(id)).toBe("running");
  });
});
