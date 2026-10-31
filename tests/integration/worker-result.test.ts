// G2 through the real hub: a worker stage passes only on a handoff to_role tester with a new commit on ticket/<id>.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

describe("worker result needs a new commit", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let stageId = "";
  let ticketId = "";
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    const t = await postJson(hub, "/tickets", {
      by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: "worker",
    });
    ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
    const sse = openLaunchStream(hub);
    for await (const req of sse.events) {
      expect(req.session).toBe("worker-1");
      expect((await ackLaunch(hub, req.id, { result: "spawned" })).status).toBe(200);
      break;
    }
    sse.close();
    open.push(await registerAgent(hub, "worker-1", { room: "r1" }));
    stageId = ((await getJson(hub, "/stages?status=running")).json as Array<{ id: string }>)[0].id;
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const handoffCount = async () => ((await getJson(hub, "/handoffs?for=alice")).json as unknown[]).length;
  const status = async () => ((await getJson(hub, `/stages/${stageId}`)).json as { status: string }).status;
  const send = (body: Record<string, unknown>, commit?: unknown) =>
    postJson(hub, "/handoffs", { from: "worker-1", task: "result", ...body, context: { notes: "n", stage_id: stageId, ticket_id: ticketId, ...(commit === undefined ? {} : { commit }) } });
  const newCommit = () => {
    const tip = git("rev-parse", `refs/heads/ticket/${ticketId}`);
    const sha = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "work");
    git("update-ref", `refs/heads/ticket/${ticketId}`, sha);
    return sha;
  };

  test("a handoff to the Orchestrator with the stage_id, or without a commit, is refused; no row; stage running", async () => {
    const before = await handoffCount();
    const sse = openSSE(hub, "/agent-stream?agent=worker-1&room=r1");
    const seen: any[] = [];
    void (async () => { try { for await (const e of sse.events) seen.push(e); } catch { /* closed */ } })();
    await new Promise((r) => setTimeout(r, 150));
    for (const r of [await send({ to: "alice" }), await send({ to_role: "tester" })]) {
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("A worker result needs to_role tester and a new commit");
    }
    // A malformed hash gets the same worker refusal, before any git call.
    for (const h of ["abc123", "A".repeat(40), "g".repeat(40), "ticket/" + ticketId]) {
      const bad = await send({ to_role: "tester" }, h);
      expect(bad.status).toBe(400);
      expect((bad.json as { errors: string[] }).errors[0]).toContain("A worker result needs to_role tester and a new commit on ticket/");
    }
    await new Promise((r) => setTimeout(r, 300));
    sse.close();
    expect(seen.some((e) => e.kind === "stage.rejected")).toBe(true);
    expect(await handoffCount()).toBe(before);
    expect(await status()).toBe("running");
  });

  test("a commit that is not new work is refused with the git reason", async () => {
    const r = await send({ to_role: "tester" }, git("rev-parse", "staging"));
    expect(r.status).toBe(400);
    expect((r.json as { errors: string[] }).errors[0]).toContain("not new work");
    expect(await status()).toBe("running");
  });

  test("a new commit on the ticket branch, sent to the tester, passes the stage", async () => {
    const r = await send({ to_role: "tester" }, newCommit());
    expect(r.status).toBe(201);
    expect(await status()).toBe("passed");
  });
});
