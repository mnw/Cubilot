// Stage leases against a real tmux on a hermetic socket and the real launch executor (prepare replaced by a plan that runs
// `sleep`). No real claude, no real stage session, never <app data>/tmux.sock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { startLaunchExecutor } from "../../hub/core/launch-executor";
import type { prepareLaunch } from "../../hub/core/launch-role";
import { createTmux } from "../../hub/core/tmux";
import { resolveTmuxBin } from "../helpers/tmux";
import { disposeRuntimes, trackedRuntime } from "../helpers/stage-runtimes";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const bin = resolveTmuxBin();
const LEASE = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(25);
  }
  return false;
}

let root: string;
let socket: string;
let tmux: ReturnType<typeof createTmux>;
const stops: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cubilot-stage-lease-"));
  socket = join(root, "tmux.sock");
  tmux = createTmux({ bin, socket, env: { ...process.env, SHELL: "/bin/sh" } });
});

afterEach(() => {
  for (const s of stops.splice(0)) s();
  disposeRuntimes();
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  rmSync(root, { recursive: true, force: true });
});

/** A stage runtime on the real executor and the hermetic tmux. Sessions run `sleep 600`. */
function setup(role: "tester" | "worker") {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const failures: string[] = [];
  const rt = trackedRuntime(db, {
    ackMs: 60_000, leaseMs: LEASE, bootGraceMs: 1000,
    liveSessionNames: () => tmux.listSessionsSync(),
    onFinalFailure: (i) => failures.push(i.reason),
  });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const roster = new Set<string>();
  const cap = {
    db,
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
    agents: { get: (n: string) => (roster.has(n) ? { name: n } : null) },
  } as unknown as HubCapabilities;
  const prepare = (async (i: { agent: string; cwd: string; role: string }) => ({
    name: i.agent, cwd: i.cwd, command: "sleep 600", env: [], harness: "claude", role: i.role, choice: {}, spec: null,
  })) as unknown as typeof prepareLaunch;
  const ex = startLaunchExecutor(
    { attach: (send, signal) => rt.queue.attach(send, signal, cap), ack: (id, o) => rt.queue.ack(id, o, cap), resendCloses: () => rt.queue.resendCloses() },
    { tmux, env: process.env, prepare, ackPauseMs: 10, closeRetryMs: 30 },
  );
  stops.push(ex.stop);
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
     VALUES ('t_0000000000000001', 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', ?, 1, 1, 1)`,
    [role],
  );
  const start = () => rt.evaluateStages("t_0000000000000001", cap, [], { launch: true });
  const stage = () => rt.api.load(db.query<{ id: string }, []>("SELECT id FROM stage").get()!.id)!;
  return { db, rt, cap, roster, start, stage, failures };
}

describe("a launch never picks a name in use, and never closes an orphan", () => {
  test("tester-1 made by hand with no stage row: the tester stage launches as tester-2 and tester-1 still exists", async () => {
    const t = setup("tester");
    await tmux.newSession({ name: "tester-1", cwd: "/tmp", command: "sleep 600" });
    t.start();
    expect(await until(() => t.stage().status === "running")).toBe(true);
    expect(t.stage().session).toBe("tester-2");
    expect((await tmux.listSessions()).sort()).toEqual(["tester-1", "tester-2"]);
    t.rt.sweep(t.cap, Date.now() + 60_000); // a long time later: the orphan has no lease, so it is not closed
    expect(await tmux.hasSession("tester-1")).toBe(true);
  });
});

describe("an expired lease closes the session and the stage launches again", () => {
  test("a session that stops renewing: the tmux session is closed, the name is free, the stage relaunches on it", async () => {
    const t = setup("worker");
    t.start();
    expect(await until(() => t.stage().status === "running")).toBe(true);
    expect(t.stage().session).toBe("worker-1");
    t.roster.add("worker-1");
    const idOf = async () => (await tmux.run(["display-message", "-p", "-t", "=worker-1:", "#{pane_pid}"])).trim();
    const first = await idOf();
    t.rt.sweep(t.cap, Date.now() + 5 * LEASE); // no renewal for longer than the lease
    t.roster.delete("worker-1"); // the stream of the closed session ends before the close is acked
    expect(t.stage().status).toBe("retrying");
    expect(await until(() => t.stage().status === "running" && t.stage().attempt === 2)).toBe(true);
    expect(t.stage().session).toBe("worker-1"); // the name was free again
    expect(await until(async () => (await tmux.hasSession("worker-1")) && (await idOf()) !== first)).toBe(true); // a new tmux session
    expect(t.failures).toEqual([]);
  });

  test("a session that never renews fails the stage after the existing limit", async () => {
    const t = setup("worker");
    t.start();
    expect(await until(() => t.stage().status === "running")).toBe(true);
    t.rt.sweep(t.cap, Date.now() + 5 * LEASE);
    expect(await until(() => t.stage().status === "running" && t.stage().attempt === 2)).toBe(true);
    t.rt.sweep(t.cap, Date.now() + 10 * LEASE);
    expect(t.stage().status).toBe("failed");
    expect(t.failures).toHaveLength(1);
    expect(await until(async () => !(await tmux.hasSession("worker-1")))).toBe(true);
    await sleep(300);
    expect(t.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stage").get()!.n).toBe(1);
    expect(await tmux.listSessions()).toEqual([]);
  });
});
