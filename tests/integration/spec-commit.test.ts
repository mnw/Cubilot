// Each spec stage keeps the commit of its own handoff (spec-review-stage 2.4b), through the real hub.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Launch = { id: string; kind: string; stage_id: string; session: string; cwd: string | null };

describe("spec stage commit", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: Launch[] = [];
  let stream: ReturnType<typeof openSSE>;
  let c1 = "";
  let c2 = "";
  let repoDir = "";

  const launchesOnly = () => launches.filter((l) => l.kind === "launch");
  // The session ends its turn: the hub queues the close; the shell acks it and the slot is free again.
  const endSession = async (stageId: string, session: string) => {
    const n = launches.filter((l) => l.kind === "close").length;
    expect((await postJson(hub, `/stages/${stageId}/turn-end`, { agent: session })).json).toEqual({ action: "close" });
    for (let i = 0; i < 60 && launches.filter((l) => l.kind === "close").length === n; i++) await sleep(50);
    const close = launches.filter((l) => l.kind === "close").at(-1)!;
    expect((await postJson(hub, `/launches/${close.id}/ack`, { result: "spawned" })).status).toBe(200);
  };

  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), "speccommit-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    for (const n of ["1", "2"]) {
      writeFileSync(join(repo, "a.txt"), n);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", n);
    }
    repoDir = repo;
    c2 = git(repo, "rev-parse", "HEAD");
    c1 = git(repo, "rev-parse", "HEAD~1");
    hub = await spawnHub();
    expect((await authedFetch(hub, "/rooms/sc/settings", { method: "PUT", body: JSON.stringify({ project_folder: repo, role_limits: { validator: 1 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, "sc-alice", { room: "sc" }));
    // The result of a spec review goes to the room lead (spec-review 4.1b): the default lead is "Orchestrator".
    open.push(await registerAgent(hub, "Orchestrator", { room: "sc" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e as Launch); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("two spec handoffs with different commits: the second stage, started later, gets a worktree at its own commit", async () => {
    const draft = () => postJson(hub, "/tickets", { by: "sc-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-1", status: "draft" });
    const spec = (commit: string) =>
      postJson(hub, "/handoffs", { from: "sc-alice", to_role: "validator", review: "spec", request_id: "req-1", task: "review", context: { request_text: "X", commit } });
    expect((await draft()).status).toBe(201);
    expect((await spec(c1)).status).toBe(201);
    expect((await spec(c2)).status).toBe(201);
    for (let i = 0; i < 60 && launchesOnly().length < 1; i++) await sleep(50);
    expect(launchesOnly()).toHaveLength(1);
    expect(git(launchesOnly()[0].cwd!, "rev-parse", "HEAD")).toBe(c1);

    // The first review ends (spawned, then a valid result), so the queued one starts.
    expect((await postJson(hub, `/launches/${launchesOnly()[0].id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, launchesOnly()[0].session, { room: "sc" }));
    const pass = await postJson(hub, "/handoffs", {
      from: launchesOnly()[0].session, to: "Orchestrator", task: "result",
      context: { stage_id: launchesOnly()[0].stage_id, review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
    await endSession(launchesOnly()[0].stage_id, launchesOnly()[0].session);
    for (let i = 0; i < 60 && launchesOnly().length < 2; i++) await sleep(50);
    expect(launchesOnly()).toHaveLength(2);
    expect(git(launchesOnly()[1].cwd!, "rev-parse", "HEAD")).toBe(c2);
  });

  test("a handoff with no commit pins HEAD of that moment: a later commit does not move the worktree", async () => {
    const draft = () => postJson(hub, "/tickets", { by: "sc-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-2", status: "draft" });
    const spec = () =>
      postJson(hub, "/handoffs", { from: "sc-alice", to_role: "validator", review: "spec", request_id: "req-2", task: "review", context: { request_text: "X" } });
    // The validator slot is taken by the second stage of the first test (limit 1), so this stage waits.
    expect((await draft()).status).toBe(201);
    expect((await spec()).status).toBe(201);
    writeFileSync(join(repoDir, "a.txt"), "3");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "3");
    const c3 = git(repoDir, "rev-parse", "HEAD");
    expect(c3).not.toBe(c2);
    await sleep(300);
    expect(launchesOnly()).toHaveLength(2); // still queued
    const second = launchesOnly()[1];
    open.push(await registerAgent(hub, second.session, { room: "sc" }));
    expect((await postJson(hub, `/launches/${second.id}/ack`, { result: "spawned" })).status).toBe(200);
    const pass = await postJson(hub, "/handoffs", {
      from: second.session, to: "Orchestrator", task: "result",
      context: { stage_id: second.stage_id, review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
    await endSession(second.stage_id, second.session);
    for (let i = 0; i < 60 && launchesOnly().length < 3; i++) await sleep(50);
    expect(launchesOnly()).toHaveLength(3);
    expect(git(launchesOnly()[2].cwd!, "rev-parse", "HEAD")).toBe(c2); // HEAD when the handoff arrived, not c3
  });
});
