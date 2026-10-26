// 4.5: the hub makes the worktree before it queues a launch; no project folder fails the stage without an attempt.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { giveProject, projectRepo } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, NO_PROJECT_FOLDER } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  let n = 0;
  const stage = (role: string, room = "r1") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', 'low', 'medium', 'a', 'queued', 1, 1, 1)`,
      [id, room],
    );
    return rt.api.create({ ticket_id: id, role }, "system", cap);
  };
  const launch = (stage_id: string, session: string, room = "r1") =>
    rt.enqueueLaunch({ stage_id, session, room, harness: "claude", cwd: null, prompt: "" }, cap);
  return { db, rt, cap, sent, stage, launch };
}

// The session of a passed stage ends its turn: the hub queues the close; the shell acks it.
async function closeAndAck(e: ReturnType<typeof makeEnv>, session: string, stageId: string) {
  const route = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  await route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: session }) }), e.cap, { id: stageId });
  const close = e.sent.filter((r) => r.kind === "close").at(-1)!;
  expect(close.session).toBe(session);
  expect(e.rt.queue.ack(close.id, { result: "spawned" }, e.cap).status).toBe("ok");
}

describe("worktrees for launches (4.5)", () => {
  test("a room with no project folder fails the stage at once, counts no attempt and queues nothing", () => {
    const e = makeEnv();
    const s = e.stage("worker");
    const r = e.launch(s.id, "worker-1");
    expect(r).toEqual({ ok: false, reason: NO_PROJECT_FOLDER });
    expect(e.rt.api.load(s.id)).toMatchObject({ status: "failed", attempt: 1, session: null });
    expect(e.sent).toHaveLength(0);
  });

  test("a worker launch starts in a ticket/<id> worktree; a tester launch in a detached one that goes after the pass", async () => {
    const e = makeEnv();
    giveProject(e.db, "r1");
    const w = e.stage("worker");
    expect(e.launch(w.id, "worker-1").ok).toBe(true);
    const wr = e.sent[0] as Extract<LaunchRequest, { kind: "launch" }>;
    expect(wr.cwd).toContain("/worktrees/r1/");
    expect(Bun.spawnSync(["git", "-C", wr.cwd!, "branch", "--show-current"]).stdout.toString().trim()).toBe(`ticket/${w.ticket_id}`);

    const t = e.stage("tester");
    expect(e.launch(t.id, "tester-1").ok).toBe(true);
    const tr = e.sent[1] as Extract<LaunchRequest, { kind: "launch" }>;
    expect(Bun.spawnSync(["git", "-C", tr.cwd!, "branch", "--show-current"]).stdout.toString().trim()).toBe("");
    e.rt.api.move(t.id, { to: "running" }, "system", e.cap);
    e.rt.hooks.onResult("tester-1", { stage_id: t.id }, e.cap);
    expect(existsSync(tr.cwd!)).toBe(true); // the session is still open: its worktree stays until the close is acked
    await closeAndAck(e, "tester-1", t.id);
    expect(existsSync(tr.cwd!)).toBe(false);
    expect(existsSync(wr.cwd!)).toBe(true); // the branch worktree is kept for the next session of the ticket
    expect(projectRepo()).toBeTruthy();
  });

  test("a project folder that stopped being a repository keeps the stage queued with the reason", () => {
    const e = makeEnv();
    e.db.run("INSERT INTO room_settings (room, project_folder, updated_at) VALUES ('r1', '/nonexistent', 1)");
    const s = e.stage("worker");
    const r = e.launch(s.id, "worker-1");
    expect(r.ok).toBe(false);
    expect(e.rt.api.load(s.id)!.status).toBe("queued");
  });

  test("a validator launch starts in a read-only worktree, and the pass removes it although it is read-only (4.4)", async () => {
    const e = makeEnv();
    giveProject(e.db, "r1");
    const v = e.stage("validator");
    expect(e.launch(v.id, "validator-1").ok).toBe(true);
    const req = e.sent[0] as Extract<LaunchRequest, { kind: "launch" }>;
    expect(() => writeFileSync(`${req.cwd}/a.txt`, "x")).toThrow();
    expect(Bun.spawnSync(["git", "-C", req.cwd!, "status", "--porcelain"]).exitCode).toBe(0);
    e.rt.api.move(v.id, { to: "running" }, "system", e.cap);
    e.rt.hooks.onResult("validator-1", { stage_id: v.id, verdict: "PASS", findings: [] }, e.cap);
    await closeAndAck(e, "validator-1", v.id);
    expect(existsSync(req.cwd!)).toBe(false);
  });

  test("a tester result keeps the worktree until the close is acked; a failed or retrying stage still removes it at once (6.5 fix)", async () => {
    const e = makeEnv();
    giveProject(e.db, "r1");
    const t = e.stage("tester");
    expect(e.launch(t.id, "tester-1").ok).toBe(true);
    const cwd = (e.sent[0] as Extract<LaunchRequest, { kind: "launch" }>).cwd!;
    e.rt.api.move(t.id, { to: "running" }, "system", e.cap);
    e.rt.hooks.onResult("tester-1", { stage_id: t.id, verdict: "PASS" }, e.cap);
    expect(e.rt.api.load(t.id)!.status).toBe("passed");
    expect(existsSync(cwd)).toBe(true);
    await closeAndAck(e, "tester-1", t.id);
    expect(existsSync(cwd)).toBe(false);
  });

  // A stop queues the close; the session may still run until the shell acks it, so the worktree stays until then (6.5 fix, Validator).
  test("a stopped tester stage (retrying, then failed) keeps its worktree until the delayed close ack", async () => {
    const e = makeEnv();
    giveProject(e.db, "r1");
    const t = e.stage("tester");
    const route = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("turn-end"))!;
    const turnEnd = (session: string) => route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: session }) }), e.cap, { id: t.id });
    const launches = () => e.sent.filter((r) => r.kind === "launch") as Array<Extract<LaunchRequest, { kind: "launch" }>>;
    const ack = (r: LaunchRequest) => expect(e.rt.queue.ack(r.id, { result: "spawned" }, e.cap).status).toBe("ok");
    const lastClose = () => e.sent.filter((r) => r.kind === "close").at(-1)!;

    expect(e.launch(t.id, "tester-1").ok).toBe(true);
    ack(launches()[0]);
    const cwd = launches()[0].cwd!;
    writeFileSync(`${cwd}/marker.txt`, "1");
    await turnEnd("tester-1");
    await turnEnd("tester-1"); // a stop: retrying, close queued, not acked
    expect(e.rt.api.load(t.id)!.status).toBe("retrying");
    expect(existsSync(`${cwd}/marker.txt`)).toBe(true); // the session may still run in it
    ack(lastClose()); // the close is done: the old tree goes, the relaunch (attempt 2) makes a fresh one
    expect(existsSync(`${cwd}/marker.txt`)).toBe(false);
    expect(e.rt.api.load(t.id)).toMatchObject({ status: "launching", attempt: 2 });

    ack(launches()[1]);
    writeFileSync(`${cwd}/marker.txt`, "2");
    await turnEnd("tester-1");
    await turnEnd("tester-1"); // a second stop: failed
    expect(e.rt.api.load(t.id)!.status).toBe("failed");
    expect(existsSync(`${cwd}/marker.txt`)).toBe(true);
    ack(lastClose());
    expect(existsSync(cwd)).toBe(false);
  });
});
