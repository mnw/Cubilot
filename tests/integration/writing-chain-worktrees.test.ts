// Writing chain worktrees (request r-2026-10-29-writing-chain-2): the Editor continues on the Writer's branch, only the
// Editor of the finished ticket starts, and the Reviewer gets a read-only tree at the Editor's commit. Real hub, fake shell.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "wcw";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

describe("writing chain worktrees", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    // Two tickets run side by side: the role limit must not decide which stage starts.
    expect((await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { writer: 3, editor: 3, reviewer: 3 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
    open.push(await registerAgent(hub, "wcw-alice", { room: ROOM }));
    stream = openLaunchStream(hub);
    void (async () => { try { for await (const e of stream.events) reqs.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const mk = async () => {
    const r = await postJson(hub, "/tickets", { by: "wcw-alice", title: "doc", acceptance_criteria: "c", blast_radius: "low", role: null });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const handoff = async (ticket: string, role: string, context: Record<string, unknown> = {}) =>
    expect((await postJson(hub, "/handoffs", { from: "wcw-alice", to_role: role, task: `do ${ticket}`, context: { ticket_id: ticket, ...context } })).status).toBe(201);
  const stageOf = (ticket: string, role: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query("SELECT id, status, session FROM stage WHERE ticket_id = ? AND role = ? ORDER BY created_seq DESC").get(ticket, role) as { id: string; status: string; session: string } | null; } finally { db.close(); }
  };
  const launchOf = async (stageId: string) => {
    for (let i = 0; i < 60 && !reqs.some((r) => r.kind === "launch" && r.stage_id === stageId); i++) await sleep(50);
    return reqs.find((r) => r.kind === "launch" && r.stage_id === stageId);
  };
  // The newest one: a session name is reused after its close.
  const closeOf = (session: string) => reqs.findLast((r) => r.kind === "close" && r.session === session);
  // The fake shell: ack the launch, then register the session as an agent.
  const spawn = async (req: any) => {
    expect((await ackLaunch(hub, req.id, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, req.session, { room: ROOM }));
  };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", ".");
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  // The result passes the stage; the end of the session's turn queues its close.
  // A writer or editor result is the hand-over to the next role (t_6e70): it carries the new commit.
  const finish = async (req: any, ticket: string, sha: string, next: string) => {
    const closes = () => reqs.filter((r) => r.kind === "close" && r.session === req.session).length;
    const before = closes();
    expect((await postJson(hub, "/handoffs", { from: req.session, to_role: next, task: "done", context: { stage_id: req.stage_id, ticket_id: ticket, notes: "n", commit: sha } })).status).toBe(201);
    expect((await postJson(hub, `/stages/${req.stage_id}/turn-end`, { agent: req.session })).status).toBe(200);
    // A session name is reused: wait for this session's own close request, so ackClose never acks an older one.
    for (let i = 0; i < 60 && closes() === before; i++) await sleep(50);
  };
  // The writer of a ticket runs, commits and finishes. Its close is not acked.
  const writerDone = async (ticket: string) => {
    await handoff(ticket, "writer");
    const req = await launchOf(stageOf(ticket, "writer")!.id);
    await spawn(req);
    const sha = commit(req.cwd, `${ticket}-w.txt`);
    await finish(req, ticket, sha, "editor");
    return { req, sha };
  };
  const ackClose = async (session: string) => {
    for (let i = 0; i < 60 && !closeOf(session); i++) await sleep(50);
    expect((await ackLaunch(hub, closeOf(session).id, { result: "spawned" })).status).toBe(200);
  };

  test("editor on the writer branch", async () => {
    const t = await mk();
    const { req: w, sha } = await writerDone(t);
    await ackClose(w.session);
    const e = await launchOf(stageOf(t, "editor")!.id);
    expect(e).toBeTruthy();
    expect(realpathSync(e.cwd)).toBe(realpathSync(w.cwd));
    expect(git(e.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ticket/${t}`);
    expect(git(e.cwd, "log", "-1", "--format=%H")).toBe(sha);
    expect(existsSync(join(e.cwd, `${t}-w.txt`))).toBe(true);
  });

  test("only the editor of the same ticket starts", async () => {
    const a = await mk();
    const b = await mk();
    const wa = await writerDone(a);
    const wb = await writerDone(b);
    await sleep(300);
    expect(stageOf(a, "editor")!.status).toBe("queued");
    expect(stageOf(b, "editor")!.status).toBe("queued");
    await ackClose(wa.req.session);
    await sleep(400);
    expect(stageOf(a, "editor")!.status).toBe("launching");
    expect(stageOf(b, "editor")!.status).toBe("queued");
    expect(reqs.some((r) => r.kind === "launch" && r.stage_id === stageOf(b, "editor")!.id)).toBe(false);
  });

  test("reviewer reviews the editor version read-only", async () => {
    const t = await mk();
    const { req: w, sha } = await writerDone(t);
    await ackClose(w.session);
    const e = await launchOf(stageOf(t, "editor")!.id);
    await spawn(e);
    const editorSha = commit(e.cwd, `${t}-e.txt`);
    await finish(e, t, editorSha, "reviewer");
    await ackClose(e.session);
    const r = await launchOf(stageOf(t, "reviewer")!.id);
    expect(r).toBeTruthy();
    expect(realpathSync(r.cwd)).not.toBe(realpathSync(e.cwd));
    expect(git(r.cwd, "rev-parse", "HEAD")).toBe(editorSha);
    expect(git(r.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // detached
    expect(existsSync(join(r.cwd, `${t}-e.txt`))).toBe(true);
    expect(() => accessSync(join(r.cwd, "a.txt"), constants.W_OK)).toThrow();
    expect(() => writeFileSync(join(r.cwd, "new.txt"), "x")).toThrow();
    expect(projectRepo()).toBeTruthy();
  });
});
