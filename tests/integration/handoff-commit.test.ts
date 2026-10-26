// stage-sessions 4.5, brief test 3: a tester handoff gets a worktree detached at the commit it names (HEAD when none).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "hc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

describe("the handoff commit reaches the worktree", () => {
  let hub: HubHandle;
  let repo: string, first: string, second: string;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "hc-repo-"));
    sh(repo, "git", "init", "-q", "-b", "main");
    sh(repo, "git", "config", "user.email", "t@t");
    sh(repo, "git", "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "one");
    first = sh(repo, "git", "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "2");
    sh(repo, "git", "commit", "-qam", "two");
    second = sh(repo, "git", "rev-parse", "HEAD");

    hub = await spawnHub();
    expect((await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ project_folder: repo }) })).status).toBe(200);
    open.push(await registerAgent(hub, "hc-alice", { room: ROOM }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const ticket = async () => {
    const r = await postJson(hub, "/tickets", { by: "hc-alice", title: "t", acceptance_criteria: "c", blast_radius: "low" });
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const handoff = (t: string, context: Record<string, unknown>) =>
    postJson(hub, "/handoffs", { from: "hc-alice", to_role: "tester", task: "check", context: { ticket_id: t, ...context } });
  const headOf = (req: any) => sh(req.cwd, "git", "rev-parse", "HEAD");

  test("a named commit is the head of the tester worktree", async () => {
    const t = await ticket();
    expect((await handoff(t, { commit: first })).status).toBe(201);
    await sleep(500);
    const req = launches.at(-1);
    expect(req).toMatchObject({ kind: "launch", role: "tester" });
    expect(headOf(req)).toBe(first);
  });

  test("no commit means HEAD of the project", async () => {
    const t = await ticket();
    expect((await handoff(t, {})).status).toBe(201);
    await sleep(500);
    expect(headOf(launches.at(-1))).toBe(second);
  });

  test("a commit that is not a hash gets 400 and nothing is created", async () => {
    const t = await ticket();
    const before = launches.length;
    expect((await handoff(t, { commit: "--output=x" })).status).toBe(400);
    expect((await handoff(t, { commit: 5 })).status).toBe(400);
    await sleep(300);
    expect(launches.length).toBe(before);
  });

  test("a commit that does not exist keeps the stage queued and queues no launch", async () => {
    const t = await ticket();
    const before = launches.length;
    expect((await handoff(t, { commit: "deadbeefdeadbeef" })).status).toBe(201);
    await sleep(500);
    expect(launches.length).toBe(before);
  });
});
