// context-pack 3.5: the pack is built inside enqueueLaunch, after stage.launching and before the first message and queue.push.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject } from "../helpers/repo";
import { repoWithBranch, stubGraphify, withEnv, writeGraph } from "../helpers/pack-fixture";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { buildPack, type Pack, type PackInput } from "../../hub/core/context-pack";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const PATH = process.env.PATH ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Launch = Extract<LaunchRequest, { kind: "launch" }>;

function makeEnv(buildPackFn: (i: PackInput) => Promise<Pack>) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000, buildPack: buildPackFn });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  giveProject(db, "r1");
  let n = 0;
  const stage = (role: string) => {
    const id = `t_${(++n + 0x5000).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'Title of ticket', 'the criteria', 'low', 'medium', 'a', 'queued', 1, 1, 1)`,
      [id],
    );
    return { ticket: id, ...rt.api.create({ ticket_id: id, role }, "system", cap) };
  };
  const launch = (stage_id: string, session: string) => rt.enqueueLaunch({ stage_id, session, room: "r1", harness: "claude", cwd: null, prompt: "" }, cap);
  const launches = () => sent.filter((r): r is Launch => r.kind === "launch");
  return { db, rt, cap, sent, stage, launch, launches };
}

/** A pack builder the test resolves by hand. It records what the world looked like when it was called. */
function deferred() {
  let release!: (p: Pack) => void;
  const calls: Array<{ input: PackInput; worktreeExisted: boolean; status: string | null }> = [];
  const gate = new Promise<Pack>((r) => (release = r));
  return { calls, release, fn: async (input: PackInput) => { calls.push({ input, worktreeExisted: existsSync(input.worktree), status: null }); return gate; } };
}

describe("pack at the launch seam (3.5)", () => {
  test("ordering: worktree exists and the stage is launching before the first pack command; no push until the pack resolves; the message holds the pack", async () => {
    const d = deferred();
    const e = makeEnv(d.fn);
    const s = e.stage("worker");
    const r = e.launch(s.id, "worker-1");
    expect(r.ok).toBe(true);
    // enqueueLaunch returned: the stage moved to launching and the build started, but nothing was queued.
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
    await sleep(20);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].worktreeExisted).toBe(true);
    expect(d.calls[0].input.question).toContain("Title of ticket the criteria");
    expect(e.launches()).toHaveLength(0);
    d.release({ text: { graph: "Graph status: fresh\nGRAPH-HIT" }, graphStatus: "fresh" });
    await sleep(20);
    expect(e.launches()).toHaveLength(1);
    const req = e.launches()[0];
    expect(req.id).toBe((r as { request_id: string }).request_id);
    expect(req.prompt).toContain("GRAPH-HIT");
    expect(req.prompt.indexOf("## Ticket")).toBeLessThan(req.prompt.indexOf("GRAPH-HIT"));
  });

  test("3.3: a ticket that names a file and a host with no ctags: the first message says the signatures are missing", async () => {
    const { project, worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    let files: string[] | undefined;
    const e = makeEnv((i) => { files = i.files; return buildPack({ ...i, worktree, projectFolder: project, findCtags: () => null }); });
    const s = e.stage("worker");
    e.db.run("UPDATE tickets SET acceptance_criteria = 'Change src.ts and ../outside.ts' WHERE id = ?", [s.ticket]);
    await withEnv({ PATH: "/usr/bin:/bin" }, async () => {
      e.launch(s.id, "worker-1");
      await sleep(500);
    });
    expect(files).toEqual(["src.ts", "../outside.ts"]);
    expect(e.launches()[0].prompt).toMatch(/## Symbol signatures\nSymbol signatures: missing/);
  });

  // Spec paths come from context.spec_paths of the spec-review handoff of the ticket's request (stage.ts specPathsOf).
  function specHandoff(e: ReturnType<typeof makeEnv>, requestId: string, ctx: unknown, id = "h_spec1") {
    e.db.run("INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms, room) VALUES (?, 'Orchestrator', 'role:validator', 'spec', ?, 'pending', 1, 2, 'r1')", [id, JSON.stringify(ctx)]);
    e.db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms, room) VALUES (?, 'handoff.created', 'Orchestrator', '{}', 1, 'r1')", [id]);
  }
  async function filesFor(spec: string[] | null, criteria: string): Promise<string[] | undefined> {
    let files: string[] | undefined;
    const e = makeEnv((i) => { files = i.files; return Promise.resolve({ text: {}, graphStatus: "missing" } as Pack); });
    if (spec) specHandoff(e, "r-1", { request_id: "r-1", review: "spec", spec_paths: spec });
    const s = e.stage("worker");
    e.db.run("UPDATE tickets SET acceptance_criteria = ?, request_id = 'r-1' WHERE id = ?", [criteria, s.ticket]);
    e.launch(s.id, "worker-1");
    await sleep(100);
    return files;
  }

  test("3.3 spec paths: criteria paths and spec paths both reach the pack, a path in both once", async () => {
    expect(await filesFor(["openspec/x/spec.md", "src.ts"], "Change src.ts and hub/a.ts")).toEqual(["src.ts", "hub/a.ts", "openspec/x/spec.md"]);
  });
  test("3.3 spec paths: no spec handoff gives the criteria paths only", async () => {
    expect(await filesFor(null, "Change src.ts")).toEqual(["src.ts"]);
  });
  test("3.3 spec paths: an outside spec path reaches buildPack but is dropped by containment", async () => {
    const { project, worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    const out = mkdtempSync(join(tmpdir(), "pack-out-"));
    writeFileSync(join(out, "s.ts"), "s");
    symlinkSync(join(out, "s.ts"), join(worktree, "link.ts"));
    const seen: string[][] = [];
    const run = async (a: string[]) => { seen.push(a); return { ok: true as const, stdout: "" }; };
    const e = makeEnv((i) => buildPack({ ...i, worktree, projectFolder: project, findCtags: () => "/stub/ctags" }, run));
    specHandoff(e, "r-1", { request_id: "r-1", spec_paths: ["src.ts", join(out, "s.ts"), "../s.ts", "link.ts"] });
    const s = e.stage("worker");
    e.db.run("UPDATE tickets SET acceptance_criteria = 'x', request_id = 'r-1' WHERE id = ?", [s.ticket]);
    e.launch(s.id, "worker-1");
    await sleep(500);
    const c = seen.find((a) => a[0] === "/stub/ctags")!;
    expect(c.slice(5)).toEqual(["./src.ts"]);
  });

  test("the ack time-out starts at the push: a launch waiting for its pack is not timed out", async () => {
    const d = deferred();
    const e = makeEnv(d.fn);
    const s = e.stage("worker");
    e.launch(s.id, "worker-1");
    await sleep(20);
    expect(e.rt.queue.size()).toEqual({ undelivered: 0, awaitingAck: 0, retained: 0 });
    d.release({ text: {}, graphStatus: "missing" });
    await sleep(20);
    expect(e.rt.queue.size().awaitingAck).toBe(1);
  });

  test("a tester gets the changed files and no graph; an editor-style role with no depth queues at once", async () => {
    const { project, worktree } = repoWithBranch();
    const e = makeEnv((i) => buildPack({ ...i, worktree, projectFolder: project }));
    const s = e.stage("tester");
    e.launch(s.id, "tester-1");
    await sleep(500);
    const req = e.launches()[0];
    expect(req.prompt).toContain("## Changed files\nb.txt");
    expect(req.prompt).not.toContain("## Graph query");
    const ed = e.stage("editor");
    e.launch(ed.id, "editor-1");
    expect(e.launches().some((l) => l.session === "editor-1")).toBe(true); // synchronous: no command to run
  });

  test("a failing graphify still launches, with no graph section", async () => {
    const { project } = repoWithBranch();
    writeGraph(project);
    const e = makeEnv((i) => buildPack({ ...i, projectFolder: project }));
    const bin = stubGraphify("exit 7");
    const s = e.stage("worker");
    await withEnv({ PATH: `${bin}:${PATH}` }, async () => {
      expect(e.launch(s.id, "worker-1").ok).toBe(true);
      await sleep(1500);
    });
    expect(e.launches()).toHaveLength(1);
    expect(e.launches()[0].prompt).not.toContain("## Graph query");
    expect(e.rt.api.load(s.id)!.status).toBe("launching");
  });

  test("a stub that sleeps past the limit is stopped and the launch continues", async () => {
    const { project } = repoWithBranch();
    writeGraph(project);
    const e = makeEnv((i) => buildPack({ ...i, projectFolder: project, limitMs: 300 }));
    const bin = stubGraphify("sleep 30");
    const s = e.stage("worker");
    const t0 = Date.now();
    await withEnv({ PATH: `${bin}:${PATH}` }, async () => {
      e.launch(s.id, "worker-1");
      for (let i = 0; i < 100 && e.launches().length === 0; i++) await sleep(50);
    });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(e.launches()).toHaveLength(1);
    expect(e.launches()[0].prompt).not.toContain("## Graph query");
  });

  test("a pack builder that throws still launches", async () => {
    const e = makeEnv(async () => { throw new Error("boom"); });
    const s = e.stage("worker");
    e.launch(s.id, "worker-1");
    await sleep(50);
    expect(e.launches()).toHaveLength(1);
  });

  test("a stage failed during the build gets no push; its temporary worktree and slot are released", async () => {
    const d = deferred();
    const e = makeEnv(d.fn);
    const s = e.stage("tester");
    e.launch(s.id, "tester-1");
    await sleep(20);
    const wt = d.calls[0].input.worktree;
    expect(existsSync(wt)).toBe(true);
    e.rt.api.move(s.id, { to: "failed", reason: "test" }, "system", e.cap);
    d.release({ text: {}, graphStatus: "missing" });
    await sleep(50);
    expect(e.launches()).toHaveLength(0);
    expect(existsSync(wt)).toBe(false);
    // the slot is free: a new stage of the role may launch
    const s2 = e.stage("tester");
    expect(e.launch(s2.id, "tester-1").ok).toBe(true);
  });

  test("a stage cancelled during the build gets no push and no close; its name, slot and worktree are free at once", async () => {
    const d = deferred();
    const e = makeEnv(d.fn);
    const s = e.stage("tester");
    e.launch(s.id, "tester-1");
    await sleep(20);
    const wt = d.calls[0].input.worktree;
    e.rt.hooks.onTicketCancelled(s.ticket, e.cap);
    expect(e.rt.api.load(s.id)!.status).toBe("cancelled");
    expect(existsSync(wt)).toBe(false);
    d.release({ text: {}, graphStatus: "missing" });
    await sleep(50);
    expect(e.sent).toHaveLength(0); // no launch and no close
    expect(e.rt.queue.pendingCloses()).toEqual([]);
  });

  test("grep: context-pack.ts and the stage seam call no model", () => {
    const src = readFileSync(new URL("../../hub/core/context-pack.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]).filter((m) => /adapter|model|claude|anthropic/i.test(m))).toEqual([]);
  });
});
