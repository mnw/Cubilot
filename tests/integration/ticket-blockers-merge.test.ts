// L3: a blocker clears when it is done or when the commit of its latest tester PASS result is an ancestor of the
// project's staging branch. One hub rule for the open-blocker list, the claim gate and the auto-launch.
// Real hub, one temp git repo and one room per test.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import "../helpers/repo"; // points CUBILOT_DATA_DIR at a temp folder
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A repo whose branch staging holds `base`; branch feat holds `unmerged` on top of it. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bm-proj-"));
  sh(dir, "git", "init", "-q", "-b", "staging");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  const commit = (file: string) => {
    writeFileSync(join(dir, file), file);
    sh(dir, "git", "add", ".");
    sh(dir, "git", "commit", "-qm", file);
    return sh(dir, "git", "rev-parse", "HEAD");
  };
  const base = commit("a.txt");
  sh(dir, "git", "checkout", "-q", "-b", "feat");
  const unmerged = commit("b.txt");
  sh(dir, "git", "checkout", "-q", "staging");
  return { dir, base, unmerged };
}

describe("a blocker clears when its code is merged into staging", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let stream: ReturnType<typeof openSSE>;
  let n = 0;

  beforeAll(async () => {
    hub = await spawnHub();
    stream = openLaunchStream(hub);
    // Every launch request is acked and its session joins the room, as the shell and the bridge do.
    void (async () => {
      try {
        for await (const req of stream.events) {
          if (req.kind !== "launch") continue;
          await ackLaunch(hub, req.id, { result: "spawned" });
          open.push(await registerAgent(hub, req.session, { room: req.room }));
        }
      } catch { /* closed */ }
    })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  async function room(project: string | null) {
    const name = `bm${++n}`;
    const body = { role_limits: { worker: 10, tester: 10, validator: 10 }, ...(project ? { project_folder: project } : {}) };
    expect((await authedFetch(hub, `/rooms/${name}/settings`, { method: "PUT", body: JSON.stringify(body) })).status).toBe(200);
    open.push(await registerAgent(hub, `${name}-alice`, { room: name }));
    return { name, alice: `${name}-alice` };
  }
  const mk = async (r: { name: string; alice: string }, extra: Record<string, unknown> = {}) => {
    const res = await postJson(hub, "/tickets", { by: r.alice, title: "t", acceptance_criteria: "c", blast_radius: "low", ...extra });
    expect(res.status).toBe(201);
    return (res.json as { snapshot: { id: string } }).snapshot.id;
  };
  const stagesOf = async (ticket: string) => ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.ticket_id === ticket);
  const waitFor = async (fn: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(200);
    }
    return fn();
  };
  /** A blocker whose tester stage sent a PASS result at `commit` (no result when commit is null). */
  async function testerPassed(r: { name: string; alice: string }, commit: string | null) {
    const id = await mk(r, { role: "tester" });
    expect(await waitFor(async () => (await stagesOf(id)).some((s) => s.status === "running"), 10_000)).toBe(true);
    const stage = (await stagesOf(id)).find((s) => s.status === "running");
    if (commit) {
      const res = await postJson(hub, "/handoffs", {
        from: stage.session, to_role: "validator", task: "validate",
        context: { notes: "n", stage_id: stage.id, ticket_id: id, verdict: "PASS", report: "r", commit, full_suite: false, tests_run: ["tests/integration/ticket-blockers-merge.test.ts"] },
      });
      expect(res.status).toBe(201);
    }
    return id;
  }
  const openOf = async (r: { name: string }, id: string) =>
    ((await getJson(hub, `/tickets?room=${r.name}`)).json as any[]).find((t) => t.id === id).open_blockers as string[];

  test("merged blocker clears", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.base);
    const a = await mk(r, { blocked_by: [b] }); // no role: no stage, so the claim gate is the only rule
    expect(await openOf(r, a)).toEqual([]);
    expect((await postJson(hub, `/tickets/${a}/claim`, { by: r.alice })).status).toBe(200);
  });

  test("merged blocker starts the stage of its dependent", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.base);
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect((await stagesOf(a)).map((s) => s.role)).toEqual(["worker"]);
  });

  test("ordinary handoff cannot clear a blocker", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, null); // tester stage is running, with no result
    const stage = (await stagesOf(b)).find((s) => s.status === "running");
    const forged = await postJson(hub, "/handoffs", {
      from: r.alice, to_role: "validator", task: "forged",
      context: { notes: "n", stage_id: stage.id, ticket_id: b, verdict: "PASS", report: "r", commit: repo.base },
    });
    expect(forged.status).toBe(201);
    const a = await mk(r, { blocked_by: [b] });
    expect(await openOf(r, a)).toEqual([b]);
    expect((await postJson(hub, `/tickets/${a}/claim`, { by: r.alice })).status).toBe(409);
  });

  test("not merged stays open", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.unmerged);
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect(await openOf(r, a)).toEqual([b]);
    expect(await stagesOf(a)).toEqual([]);
    const claim = await postJson(hub, `/tickets/${a}/claim`, { by: r.alice });
    expect(claim.status).toBe(409);
  });

  test("no tester commit stays open", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, null);
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect(await openOf(r, a)).toEqual([b]);
    expect(await stagesOf(a)).toEqual([]);
  });

  test("cancelled still blocks", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.base); // merged commit, but the ticket is cancelled
    expect((await postJson(hub, `/tickets/${b}/transition`, { by: hub.humanName, to: "cancelled" })).status).toBe(200);
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect(await openOf(r, a)).toEqual([b]);
    expect(await stagesOf(a)).toEqual([]);
  });

  test("git failure stays open", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.base); // merged, but the repository breaks before the check
    renameSync(join(repo.dir, ".git"), join(repo.dir, ".git-off"));
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect(await openOf(r, a)).toEqual([b]);
    expect(await stagesOf(a)).toEqual([]);
  });

  test("staging moves", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const b = await testerPassed(r, repo.unmerged);
    const a = await mk(r, { role: "worker", blocked_by: [b] });
    expect(await stagesOf(a)).toEqual([]);
    await sleep(300);
    sh(repo.dir, "git", "update-ref", "refs/heads/staging", repo.unmerged); // the branch of b is merged: no ticket event follows
    expect(await waitFor(async () => (await stagesOf(a)).length > 0, 45_000)).toBe(true);
    expect(await openOf(r, a)).toEqual([]);
  }, 60_000);
});
