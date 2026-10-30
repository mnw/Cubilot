// The retrospective stage role (Part 21 group 1): a stage role that only the hub starts. Agent refusals go through a real hub;
// the launch goes through the stage runtime in process (no route creates a retro stage: group 4 does it from the sweep).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/repo"; // sets CUBILOT_DATA_DIR to a temp folder
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { postJson, registerAgent } from "../helpers/fetch";
import { DEFAULT_ROLE_LIMITS, STAGE_ROLES, migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { READ_ONLY_ROLES } from "../../hub/core/worktrees";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

describe("retrospective is a stage role only", () => {
  let hub: HubHandle;
  let alice: { close: () => void };
  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "rt");
    alice = await registerAgent(hub, "rt-alice", { room: "rt" });
  });
  afterAll(async () => {
    alice.close();
    await hub.kill();
  });

  test("the ledger knows the role with a default limit of 1", () => {
    expect(STAGE_ROLES).toContain("retrospective");
    expect(DEFAULT_ROLE_LIMITS.retrospective).toBe(1);
    expect(READ_ONLY_ROLES.has("retrospective")).toBe(true);
  });

  test("a ticket with role retrospective is refused, create and edit", async () => {
    const r = await postJson(hub, "/tickets", { by: "rt-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: "retrospective" });
    expect(r.status).toBe(400);
    const ok = await postJson(hub, "/tickets", { by: "rt-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", status: "draft" });
    expect(ok.status).toBe(201);
    const id = (ok.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, `/tickets/${id}/edit`, { by: "rt-alice", role: "retrospective" })).status).toBe(400);
  });

  test("a handoff with to_role retrospective is refused", async () => {
    const r = await postJson(hub, "/handoffs", { from: "rt-alice", to_role: "retrospective", task: "x", context: { ticket_id: "t_0000000000000000" } });
    expect(r.status).toBe(400);
  });

  test("the chatbridge tool schema lists no retrospective role", async () => {
    const text = await Bun.file(join(import.meta.dir, "../../hub/channel/tools.ts")).text();
    expect(text).not.toContain("retrospective");
  });
});

describe("a retrospective stage launches read-only on Claude", () => {
  const sh = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const env = () => {
    const project = mkdtempSync(join(tmpdir(), "retro-proj-"));
    sh(project, "git", "init", "-q", "-b", "main");
    sh(project, "git", "config", "user.email", "t@t");
    sh(project, "git", "config", "user.name", "t");
    writeFileSync(join(project, "a.txt"), "1");
    sh(project, "git", "add", ".");
    sh(project, "git", "commit", "-qm", "one");
    sh(project, "git", "branch", "staging");
    // main moves on; the worktree must sit on the staging head.
    writeFileSync(join(project, "a.txt"), "2");
    sh(project, "git", "commit", "-qam", "two");
    const staging = sh(project, "git", "rev-parse", "staging");
    const db = new Database(":memory:");
    migrateLedger(db);
    createTicketKind(db).migrate(db);
    const rt = createStageRuntime(db, { ackMs: 60_000 });
    rt.module.migrate(db);
    setRoomSettings(db, "A", { project_folder: project });
    const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
    const sent: LaunchRequest[] = [];
    rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
    /** Creates a retro stage and starts it through the queue; returns its launch request. */
    const launch = () => {
      const stage = rt.api.create({ review: "retro", role: "retrospective", room: "A" }, "system", cap);
      rt.module.onRoomLimitsChanged!("A", cap); // starts the oldest waiting stage of each role, with a hub-chosen session name
      return { stage, r: { ok: rt.api.load(stage.id)?.status === "launching" } };
    };
    return { project, staging, db, rt, cap, sent, launch };
  };
  const noConfig = () => rmSync(join(process.env.CUBILOT_DATA_DIR!, "config.yml"), { force: true });
  const config = (text: string) => writeFileSync(join(process.env.CUBILOT_DATA_DIR!, "config.yml"), text);

  const first = (e: ReturnType<typeof env>) => e.sent.filter((x): x is Extract<LaunchRequest, { kind: "launch" }> => x.kind === "launch");

  test("the worktree is detached, read-only and at the staging head", () => {
    noConfig();
    const e = env();
    expect(e.launch().r.ok).toBe(true);
    const req = first(e)[0];
    expect(req.cwd).toBeTruthy();
    expect(sh(req.cwd!, "git", "rev-parse", "HEAD")).toBe(e.staging);
    expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: req.cwd! }).exitCode).toBe(1); // detached
    expect(() => writeFileSync(join(req.cwd!, "new.txt"), "x")).toThrow();
    expect(existsSync(join(req.cwd!, "a.txt"))).toBe(true);
    expect(req.cwd!).toContain("retro-");
  });

  test("the launch is Claude, opus, effort high by default", () => {
    noConfig();
    const e = env();
    e.launch();
    expect(first(e)[0]).toMatchObject({ role: "retrospective", harness: "claude", model: "opus", effort: "high" });
  });

  test("role_models.retrospective sets model and effort; a Pi value is refused with one log line", () => {
    config("role_models:\n  retrospective:\n    model: sonnet\n    effort: low\n");
    const e = env();
    e.launch();
    expect(first(e)[0]).toMatchObject({ harness: "claude", model: "sonnet", effort: "low" });

    config("role_models:\n  retrospective:\n    harness: pi\n    model: m1\n");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const e2 = env();
      e2.launch();
      expect(first(e2)[0]).toMatchObject({ harness: "claude", model: "opus", effort: "high" });
    } finally {
      console.log = log;
    }
    expect(lines.filter((l) => l.includes("role_models.retrospective"))).toHaveLength(1);
  });

  test("each retrospective launch is a new session", () => {
    noConfig();
    const e = env();
    const a = e.launch();
    const sessionA = e.db.query<{ session: string }, [string]>("SELECT session FROM stage WHERE id = ?").get(a.stage.id)!.session;
    e.rt.api.move(a.stage.id, { to: "running" }, "system", e.cap);
    e.rt.api.move(a.stage.id, { to: "passed" }, "system", e.cap);
    const b = e.launch();
    const sessionB = e.db.query<{ session: string }, [string]>("SELECT session FROM stage WHERE id = ?").get(b.stage.id)!.session;
    expect(sessionA).toMatch(/^retrospective-\d+$/);
    expect(sessionB).toMatch(/^retrospective-\d+$/);
    expect(sessionB).not.toBe(sessionA);
  });

  test("a retro stage needs the role and no ticket; the role needs review retro", () => {
    const e = env();
    expect(() => e.rt.api.create({ review: "retro", role: "worker", room: "A" }, "system", e.cap)).toThrow();
    expect(() => e.rt.api.create({ role: "retrospective", ticket_id: "t_0000000000000001" }, "system", e.cap)).toThrow();
  });
});
