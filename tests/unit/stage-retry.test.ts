// Retry and final failure (stage-sessions 5.3, brief test 6).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, RouteDef, Scope } from "../../hub/core/types";
import type { LaunchRequest } from "../../hub/core/launch-queue";

function makeEnv(agents: string[] = [], o: { workerLimit?: number; closeGraceMs?: number; db?: Database } = {}) {
  const db = o.db ?? new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const failures: Array<{ stage: string; reason: string }> = [];
  const rt = createStageRuntime(db, { ackMs: 60_000, bootGraceMs: 1000, closeGraceMs: o.closeGraceMs, onFinalFailure: (i) => failures.push({ stage: i.stage.id, reason: i.reason }) });
  rt.module.migrate(db);
  giveProject(db, "r1");
  if (o.workerLimit !== undefined) {
    db.run("INSERT INTO room_settings (room, role_limits, updated_at) VALUES ('r1', ?, 1) ON CONFLICT(room) DO UPDATE SET role_limits = excluded.role_limits", [
      JSON.stringify({ worker: o.workerLimit, tester: 1, validator: 1, reviewer: 1, editor: 1, writer: 1 }),
    ]);
  }
  const roster = new Set(agents);
  const cap = {
    db,
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
    agents: { get: (n: string) => (roster.has(n) ? { name: n } : null) },
  } as unknown as HubCapabilities;
  // A fake shell: reads every request the hub queues.
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  const tid = "t_0000000000000001";
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 'worker', 1, 1, 1)`,
    [tid],
  );
  rt.evaluateStages(tid, cap, [], { launch: true });
  const stageId = db.query<{ id: string }, []>("SELECT id FROM stage").get()!.id;
  const spawn = (id: string) => {
    const l = [...sent].reverse().find((r) => r.kind === "launch" && r.stage_id === id)!;
    expect(rt.queue.ack(l.id, { result: "spawned" }, cap).status).toBe("ok");
    return l;
  };
  const route = rt.module.routes.find((r: RouteDef) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  const turnEnd = async (session: string) => {
    const res = await route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: session }) }), cap, { id: stageId });
    return ((await res.json()) as { action: string }).action;
  };
  // The shell closes every session the hub asked to close (5.3c: a relaunch of the stage waits for it).
  const ackCloses = () => {
    for (const r of sent) if (r.kind === "close") rt.queue.ack(r.id, { result: "spawned" }, cap);
  };
  const stage = () => rt.api.load(stageId)!;
  const launches = () => sent.filter((r) => r.kind === "launch") as Array<Extract<LaunchRequest, { kind: "launch" }>>;
  const closes = () => sent.filter((r) => r.kind === "close").map((r) => (r as { session: string }).session);
  return { db, rt, cap, roster, sent, stageId, spawn, turnEnd, stage, launches, closes, failures, tid, route, ackCloses };
}

describe("a stop ends the attempt", () => {
  test("a reminder then one more end of turn is a stop: close, then one relaunch with the reason (same ticket part, ticket reassigned)", async () => {
    const e = makeEnv();
    e.spawn(e.stageId);
    expect(await e.turnEnd("worker-1")).toBe("reminder");
    expect(e.stage().status).toBe("running");
    expect(await e.turnEnd("worker-1")).toBe("stop");
    expect(e.closes()).toEqual(["worker-1"]);
    expect(e.launches()).toHaveLength(1); // the relaunch waits for the close ack (5.3c)
    e.ackCloses();
    expect(e.launches()).toHaveLength(2);
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2, session: "worker-1" }); // the name is free again after the close ack
    expect(e.launches()[1].prompt).toContain("second end of turn without a result");
    expect(e.launches()[1].prompt).toContain(e.tid);
    expect(e.db.query<{ assignee: string }, [string]>("SELECT assignee FROM tickets WHERE id = ?").get(e.tid)!.assignee).toBe("worker-1");
    expect(e.failures).toEqual([]);
  });

  test("a second stop fails the stage and tells the Orchestrator once; no third launch", async () => {
    const e = makeEnv();
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1");
    e.ackCloses();
    e.spawn(e.stageId);
    expect(await e.turnEnd("worker-1")).toBe("reminder"); // the count starts again for attempt 2
    expect(await e.turnEnd("worker-1")).toBe("stop");
    expect(e.stage().status).toBe("failed");
    expect(e.launches()).toHaveLength(2);
    expect(e.failures).toHaveLength(1);
    expect(e.failures[0].stage).toBe(e.stageId);
  });

  test("a time-out is a stop; the clock starts at the first sweep that sees the stage running", () => {
    const e = makeEnv(["worker-1"]);
    e.spawn(e.stageId);
    e.rt.sweep(e.cap, 0);
    e.rt.sweep(e.cap, 29 * 60_000);
    expect(e.stage().status).toBe("running");
    e.rt.sweep(e.cap, 30 * 60_000);
    e.ackCloses();
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2 });
    expect(e.launches()[1].prompt).toContain("time-out of 30 minutes");
  });

  test("a session that left the roster for good is a stop; one still in the roster, or a young one, is not", () => {
    const e = makeEnv(["worker-1"]);
    e.spawn(e.stageId);
    e.rt.sweep(e.cap, 0);
    e.rt.sweep(e.cap, 5000);
    expect(e.stage().status).toBe("running"); // in the roster
    e.roster.delete("worker-1");
    e.rt.sweep(e.cap, 5000 + 1);
    e.ackCloses();
    expect(e.stage().status).toBe("launching");
    expect(e.stage().attempt).toBe(2);
    expect(e.launches()[1].prompt).toContain("left the room");
  });

  test("a young session that is not in the roster yet is left alone (boot grace)", () => {
    const e = makeEnv();
    e.spawn(e.stageId);
    e.rt.sweep(e.cap, 0);
    e.rt.sweep(e.cap, 500);
    expect(e.stage().status).toBe("running");
  });
});

describe("hub restart", () => {
  test("a passed stage whose session name no live stage holds gets one close at start; a live name gets none", async () => {
    const e = makeEnv();
    e.spawn(e.stageId);
    e.rt.api.move(e.stageId, { to: "passed" }, "system", e.cap);
    expect(e.closes()).toEqual([]); // the turn end has not come: nothing queued
    // A new hub process: its own runtime on the same ledger, start hook run.
    const rt2 = createStageRuntime(e.db, { ackMs: 60_000 });
    const seen: LaunchRequest[] = [];
    rt2.queue.attach((r) => seen.push(r), new AbortController().signal, e.cap);
    rt2.module.start!(e.cap);
    expect(seen.filter((r) => r.kind === "close").map((r) => (r as { session: string }).session)).toEqual(["worker-1"]);
    rt2.module.dispose!();
    // The same name held by a live stage: no close.
    const t2 = "t_0000000000000002";
    e.db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 'worker', 1, 1, 1)`,
      [t2],
    );
    e.rt.evaluateStages(t2, e.cap, [], { launch: true });
    expect(e.db.query<{ session: string }, []>("SELECT session FROM stage WHERE ticket_id = 't_0000000000000002'").get()!.session).toBe("worker-1");
    const rt3 = createStageRuntime(e.db, { ackMs: 60_000 });
    const seen3: LaunchRequest[] = [];
    rt3.queue.attach((r) => seen3.push(r), new AbortController().signal, e.cap);
    rt3.module.start!(e.cap);
    expect(seen3.filter((r) => r.kind === "close")).toEqual([]);
    rt3.module.dispose!();
  });
});

describe("the slot is held until the close is acked (5.3b)", () => {
  test("worker limit 1: a stop queues the close and no second launch starts before the close is acked; a failed close keeps holding", async () => {
    const e = makeEnv([], { workerLimit: 1 });
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1"); // a stop
    expect(e.closes()).toEqual(["worker-1"]);
    expect(e.launches()).toHaveLength(1); // no worker-2 next to the worker-1 that may still run
    expect(e.stage().status).toBe("retrying");
    const close = e.sent.find((r) => r.kind === "close")!;
    // The close fails (tmux error, session still there): the request stays pending and the slot stays held.
    expect(e.rt.queue.ack(close.id, { result: "error", error: "tmux down" }, e.cap).status).toBe("pending");
    expect(e.launches()).toHaveLength(1);
    // The close is done: the relaunch starts, with the reason, under the freed name.
    expect(e.rt.queue.ack(close.id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.launches()).toHaveLength(2);
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2 });
    expect(e.launches()[1].prompt).toContain("second end of turn without a result");
  });

  test("a close for a session that does not exist (absent) also frees the slot", async () => {
    const e = makeEnv([], { workerLimit: 1 });
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1");
    const close = e.sent.find((r) => r.kind === "close")!;
    expect(e.rt.queue.ack(close.id, { result: "error", error: "no such session", absent: true }, e.cap).status).toBe("ok");
    expect(e.launches()).toHaveLength(2);
  });
});

describe("a hub restart between the retry and the relaunch (5.3b)", () => {
  test("a stage persisted as retrying is relaunched once at start, with its reason", async () => {
    const e = makeEnv([], { workerLimit: 1 });
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1"); // retrying, close not acked: the relaunch is still waiting
    expect(e.stage().status).toBe("retrying");
    e.rt.module.dispose!();

    const rt2 = createStageRuntime(e.db, { ackMs: 60_000 });
    const seen: LaunchRequest[] = [];
    rt2.queue.attach((r) => seen.push(r), new AbortController().signal, e.cap);
    rt2.module.start!(e.cap);
    const launches = seen.filter((r) => r.kind === "launch") as Array<Extract<LaunchRequest, { kind: "launch" }>>;
    expect(launches).toHaveLength(1);
    expect(launches[0].prompt).toContain("second end of turn without a result");
    expect(rt2.api.load(e.stageId)).toMatchObject({ status: "launching", attempt: 2 });
    rt2.module.start!(e.cap); // a second start: the launching stage counts as an unacked launch, nothing else relaunches
    rt2.module.dispose!();
  });
});

describe("a lost turn-end report after a pass (5.3b)", () => {
  test("the sweep queues the close of a passed stage after the grace; before it, nothing; once", () => {
    const e = makeEnv([], { workerLimit: 1, closeGraceMs: 1000 });
    e.spawn(e.stageId);
    e.rt.hooks.onResult("worker-1", { stage_id: e.stageId }, e.cap); // passed; no turn-end report ever comes
    e.rt.sweep(e.cap, 0);
    e.rt.sweep(e.cap, 999);
    expect(e.closes()).toEqual([]);
    e.rt.sweep(e.cap, 1000);
    expect(e.closes()).toEqual(["worker-1"]);
    e.rt.sweep(e.cap, 5000);
    expect(e.closes()).toEqual(["worker-1"]);
  });
});

describe("the relaunch waits for the close of the previous session, with a free slot (5.3c)", () => {
  test("worker limit 2: no second launch of the stage until its close is acked; a failed close keeps it waiting", async () => {
    const e = makeEnv([], { workerLimit: 2 });
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1"); // a stop: close queued
    expect(e.closes()).toEqual(["worker-1"]);
    expect(e.stage().status).toBe("retrying");
    expect(e.launches()).toHaveLength(1); // a slot is free, but the old session may still run in this worktree
    const close = e.sent.find((r) => r.kind === "close")!;
    expect(e.rt.queue.ack(close.id, { result: "error", error: "tmux down" }, e.cap).status).toBe("pending");
    expect(e.launches()).toHaveLength(1);
    e.rt.sweep(e.cap, 0); // nothing else starts it either
    expect(e.launches()).toHaveLength(1);
    expect(e.rt.queue.ack(close.id, { result: "spawned" }, e.cap).status).toBe("ok");
    expect(e.launches()).toHaveLength(2);
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2 });
  });

  test("another stage of the same role still starts at once through the free slot", async () => {
    const e = makeEnv([], { workerLimit: 2 });
    e.spawn(e.stageId);
    await e.turnEnd("worker-1");
    await e.turnEnd("worker-1");
    const t2 = "t_0000000000000002";
    e.db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 'worker', 1, 1, 1)`,
      [t2],
    );
    e.rt.evaluateStages(t2, e.cap, [], { launch: true });
    expect(e.launches()).toHaveLength(2);
    expect(e.launches()[1].stage_id).not.toBe(e.stageId);
  });
});
