// Stage leases: a launching or running stage holds its session through a lease; a renewal writes nothing; an expiry stops the
// stage like any other stop (close, then retry, then the existing final failure); a launch never takes a name in use.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, DEFAULT_LEASE_MS } from "../../hub/kinds/stage";
import { makeSSE } from "../../hub/core/sse";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";
import type { LaunchRequest } from "../../hub/core/launch-queue";

const LEASE = 1000;

function makeEnv(o: { role?: string; roster?: string[]; live?: string[] } = {}) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const failures: string[] = [];
  const live = o.live ?? [];
  const rt = createStageRuntime(db, {
    ackMs: 60_000, bootGraceMs: 1000, leaseMs: LEASE, liveSessionNames: () => live,
    onFinalFailure: (i) => failures.push(i.reason),
  });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const roster = new Set(o.roster ?? []);
  const cap = {
    db,
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
    agents: { get: (n: string) => (roster.has(n) ? { name: n } : null) },
  } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  const role = o.role ?? "worker";
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
     VALUES ('t_0000000000000001', 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', ?, 1, 1, 1)`,
    [role],
  );
  rt.evaluateStages("t_0000000000000001", cap, [], { launch: true });
  const stageId = db.query<{ id: string }, []>("SELECT id FROM stage").get()!.id;
  const launches = () => sent.filter((r) => r.kind === "launch") as Array<Extract<LaunchRequest, { kind: "launch" }>>;
  const spawn = () => {
    const l = launches().at(-1)!;
    expect(rt.queue.ack(l.id, { result: "spawned" }, cap).status).toBe("ok");
    return l;
  };
  const ackCloses = () => {
    for (const r of sent) if (r.kind === "close") rt.queue.ack(r.id, { result: "spawned" }, cap);
  };
  const stage = () => rt.api.load(stageId)!;
  const closes = () => sent.filter((r) => r.kind === "close").map((r) => (r as { session: string }).session);
  const events = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
  return { db, rt, cap, roster, live, sent, stageId, spawn, ackCloses, stage, launches, closes, events, failures };
}

afterEach(() => {});

describe("the lease", () => {
  test("the default lease time is 120 s", () => {
    expect(DEFAULT_LEASE_MS).toBe(120_000);
  });

  test("a launching stage holds a lease on its session, and it keeps it when running", () => {
    const e = makeEnv();
    const t0 = Date.now();
    expect(e.stage().status).toBe("launching");
    const l = e.rt.leaseOf(e.stageId)!;
    expect(l.session).toBe("worker-1");
    expect(l.expires_at_ms).toBeGreaterThanOrEqual(t0 - 50 + LEASE);
    expect(l.expires_at_ms).toBeLessThanOrEqual(Date.now() + LEASE);
    e.spawn();
    expect(e.stage().status).toBe("running");
    expect(e.rt.leaseOf(e.stageId)!.session).toBe("worker-1");
  });

  test("a renewal moves the expiry, writes no event and no stage row change", () => {
    const e = makeEnv();
    e.spawn();
    const before = e.events();
    const row = JSON.stringify(e.db.query("SELECT * FROM stage").get());
    const later = Date.now() + 5000;
    expect(e.rt.renewLease("worker-1", later)).toBe(true);
    expect(e.rt.leaseOf(e.stageId)!.expires_at_ms).toBe(later + LEASE);
    expect(e.events()).toBe(before);
    expect(JSON.stringify(e.db.query("SELECT * FROM stage").get())).toBe(row);
    expect(e.rt.renewLease("worker-9", later)).toBe(false);
  });

  test("the agent stream beat of the session renews the lease (kind hook)", () => {
    const e = makeEnv();
    e.spawn();
    const first = e.rt.leaseOf(e.stageId)!.expires_at_ms;
    const wait = Date.now() + 20;
    while (Date.now() < wait);
    e.rt.module.onAgentBeat!("worker-1");
    expect(e.rt.leaseOf(e.stageId)!.expires_at_ms).toBeGreaterThan(first);
  });

  test("a session with no tool call for longer than the lease, but with renewals, stays running", () => {
    const e = makeEnv();
    e.roster.add("worker-1");
    e.spawn();
    const t0 = Date.now();
    // One long foreground tool call: no tool event, only beats every 15 s (here: every 800 ms of the fake clock).
    for (let t = t0 + 800; t <= t0 + 6400; t += 800) {
      e.rt.renewLease("worker-1", t);
      e.rt.sweep(e.cap, t + 1);
      expect(e.stage().status).toBe("running");
    }
    expect(e.closes()).toEqual([]);
  });

  test("a session that stops renewing: after the lease time the session is closed, the name is freed and the stage retries", () => {
    const e = makeEnv();
    e.roster.add("worker-1");
    e.spawn();
    const t0 = Date.now();
    e.rt.renewLease("worker-1", t0 + 800);
    e.rt.sweep(e.cap, t0 + 1700); // 900 ms after the last renewal: inside the lease
    expect(e.stage().status).toBe("running");
    const before = e.events();
    e.rt.sweep(e.cap, t0 + 2000); // 1200 ms after the renewal: expired
    expect(e.closes()).toEqual(["worker-1"]);
    expect(e.stage().status).toBe("retrying");
    expect(e.events()).toBe(before + 1); // one event for the expiry
    const ev = e.db.query<{ payload_json: string }, []>("SELECT payload_json FROM events WHERE kind = 'stage.retrying'").get()!;
    expect(JSON.parse(ev.payload_json).reason).toContain("lease expired");
    expect(e.launches()).toHaveLength(1); // the relaunch waits for the close ack
    e.roster.delete("worker-1"); // the closed session leaves the roster
    e.ackCloses();
    expect(e.launches()).toHaveLength(2);
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2, session: "worker-1" });
    expect(e.rt.renewLease("worker-1")).toBe(true); // the new attempt holds a new lease on the freed name
  });

  test("lease expiries are bounded by the launch retry rules: the second expiry fails the stage", () => {
    const e = makeEnv();
    e.roster.add("worker-1");
    e.spawn();
    const t0 = Date.now();
    e.rt.sweep(e.cap, t0 + 5000);
    expect(e.stage().status).toBe("retrying");
    e.ackCloses();
    e.spawn();
    e.rt.sweep(e.cap, t0 + 10_000);
    expect(e.stage().status).toBe("failed");
    expect(e.failures).toHaveLength(1);
    expect(e.failures[0]).toContain("lease expired");
    e.ackCloses();
    expect(e.launches()).toHaveLength(2); // no third launch
    expect(e.rt.leaseOf(e.stageId)).toBeNull();
  });

  test("a closed session that is still in the roster keeps its name: the relaunch takes the next one", () => {
    const e = makeEnv();
    e.roster.add("worker-1");
    e.spawn();
    e.rt.sweep(e.cap, Date.now() + 5000);
    e.ackCloses();
    expect(e.stage()).toMatchObject({ status: "launching", attempt: 2, session: "worker-2" });
  });

  test("a stage with no lease entry (hub restart) gets a fresh lease and is not stopped at once", () => {
    const e = makeEnv();
    e.roster.add("worker-1");
    e.spawn();
    const t0 = Date.now();
    e.rt.sweep(e.cap, t0 + 50_000); // seen first at this time: the lease of the launch is long past
    expect(e.stage().status).toBe("retrying"); // the launch lease ran out: expected
    const f = makeEnv();
    f.roster.add("worker-1");
    f.spawn();
    f.rt.sweep(f.cap, Date.now() + 1);
    expect(f.stage().status).toBe("running");
  });
});

describe("a launch never picks a name in use", () => {
  test("a live tmux session with no stage row keeps its name: the launch takes the next one", () => {
    const e = makeEnv({ role: "tester", live: ["tester-1"] });
    expect(e.launches().map((l) => l.session)).toEqual(["tester-2"]);
    expect(e.stage().session).toBe("tester-2");
    expect(e.closes()).toEqual([]); // the orphan is not closed
  });

  test("a connected roster agent keeps its name", () => {
    const e = makeEnv({ role: "tester", roster: ["tester-1", "tester-2"] });
    expect(e.launches().map((l) => l.session)).toEqual(["tester-3"]);
  });

  test("a name of another role is not used by this role", () => {
    const e = makeEnv({ role: "tester", live: ["worker-1", "validator-1"] });
    expect(e.launches().map((l) => l.session)).toEqual(["tester-1"]);
  });
});

describe("the heartbeat hook of the stream", () => {
  test("makeSSE calls the hook after each heartbeat it accepted, and not after the stream closed", async () => {
    const realSet = globalThis.setInterval;
    const fns: Array<() => void> = [];
    globalThis.setInterval = ((fn: () => void) => {
      fns.push(fn);
      return { unref() {} };
    }) as unknown as typeof setInterval;
    let beats = 0;
    let release!: () => void;
    const res = makeSSE(() => new Promise<void>((r) => (release = r)), () => void beats++);
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    globalThis.setInterval = realSet;
    expect(fns).toHaveLength(1);
    fns[0]();
    fns[0]();
    expect(beats).toBe(2);
    await reader.cancel();
    fns[0]();
    expect(beats).toBe(2);
    release();
  });
});
