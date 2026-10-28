// cancel-failure-trace scenarios 8(a)-(f2), (i), (j), (k): a failed stage cancel or sweep leaves one row, on a real ledger.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { cancelTraceId, createCancelTraceKind } from "../../hub/kinds/cancel-trace";
import type { Entry, HubCapabilities, RouteDef, Scope } from "../../hub/core/types";

type Row = Record<string, any>;

function makeEnv(o: { launch?: boolean; ticketStatus?: string; withTrace?: boolean } = {}) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const trace = createCancelTraceKind(db);
  const rt = createStageRuntime(db, {
    ackMs: 60_000,
    bootGraceMs: 1000,
    traceFailure: o.withTrace === false ? undefined : (i, cap) => trace.record(i, cap),
  });
  rt.module.migrate(db);
  trace.migrate(db);
  giveProject(db, "r1");
  const emitted: Array<{ entry: Entry; scope: Scope }> = [];
  const cap = {
    db,
    config: { humanName: "human", defaultRoom: "r1" },
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => {} },
    agents: { get: (n: string) => (n === "human" ? { name: n } : null), isPaused: () => false },
  } as unknown as HubCapabilities;
  rt.queue.attach(() => {}, new AbortController().signal, cap);
  const tid = "t_0000000000000001";
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', ?, 'worker', 1, 1, 1)`,
    [tid, o.ticketStatus ?? "queued"],
  );
  rt.evaluateStages(tid, cap, [], { launch: o.launch ?? false });
  const stageId = db.query<{ id: string }, []>("SELECT id FROM stage").get()!.id;
  const traces = () => db.query("SELECT * FROM cancel_traces ORDER BY rowid").all() as Row[];
  const events = () => db.query("SELECT kind FROM events WHERE kind LIKE 'cancel_trace.%'").all() as Row[];
  const stageStatus = () => db.query<{ status: string }, [string]>("SELECT status FROM stage WHERE id = ?").get(stageId)!.status;
  const breakStage = (to: string) =>
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON stage WHEN NEW.status IN (${to}) BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  return { db, rt, trace, cap, tid, stageId, traces, events, stageStatus, breakStage, emitted };
}

let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());
const lines = () => errors.mock.calls.map((c: any[]) => c.map(String).join(" "));

describe("a failed cancel leaves one row", () => {
  test("(a) ticket cancel: one row with the fields of 1, stage unchanged, one created event", () => {
    const e = makeEnv();
    e.breakStage("'cancelled'");
    e.rt.hooks.onTicketCancelled(e.tid, e.cap);
    const rows = e.traces();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: cancelTraceId(e.stageId, "cancel", "queued"),
      status: "open",
      room: "r1",
      stage_id: e.stageId,
      ticket_id: e.tid,
      site: "cancel",
      caller: "ticket_cancel",
      status_at_failure: "queued",
      cleared_at: null,
    });
    expect(rows[0].id).toMatch(/^ct_[0-9a-f]{16}$/);
    expect(rows[0].error).toContain("boom");
    expect(rows[0].created_at).toBeGreaterThan(0);
    expect(e.stageStatus()).toBe("queued");
    expect(e.events().map((r) => r.kind)).toEqual(["cancel_trace.created"]);
    const sent = e.emitted.filter((x) => x.entry.kind === "cancel_trace.created");
    expect(sent).toHaveLength(1);
    expect(sent[0].scope).toEqual({ kind: "ui-only" });
    expect(sent[0].entry.snapshot).toMatchObject({ id: rows[0].id, status: "open" });
    // 6: the existing line only.
    expect(lines().filter((l) => l.includes("[stage]"))).toHaveLength(1);
    expect(lines()[0]).toContain(`[stage] cancelling ${e.stageId} failed:`);
  });

  test("(b) draft, done and start sweep: one row each with its caller", () => {
    for (const [caller, run] of [
      ["ticket_draft", (e: ReturnType<typeof makeEnv>) => e.rt.hooks.onTicketParked(e.tid, "draft", e.cap)],
      ["ticket_done", (e: ReturnType<typeof makeEnv>) => e.rt.hooks.onTicketParked(e.tid, "done", e.cap)],
      [
        "start_sweep",
        (e: ReturnType<typeof makeEnv>) => {
          e.db.run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", [e.tid]);
          e.rt.module.start!(e.cap);
        },
      ],
    ] as const) {
      const e = makeEnv();
      e.breakStage("'cancelled'");
      run(e);
      expect(e.traces().map((r) => [r.caller, r.site, r.status_at_failure, r.ticket_id])).toEqual([[caller, "cancel", "queued", e.tid]]);
      expect(e.events()).toHaveLength(1);
      expect(e.stageStatus()).toBe("queued");
    }
  });

  test("(c) a sweep that throws leaves one row", () => {
    const e = makeEnv({ launch: true });
    e.db.run("UPDATE stage SET status = 'running', session = 'worker-1' WHERE id = ?", [e.stageId]);
    e.breakStage("'retrying', 'failed'");
    e.rt.sweep(e.cap, 1_000);
    e.rt.sweep(e.cap, 10_000); // past the boot grace, agent not in the roster: a stop, and the move throws
    expect(e.traces().map((r) => [r.site, r.caller, r.status_at_failure])).toEqual([["sweep", "sweep", "running"]]);
    expect(e.stageStatus()).toBe("running");
    expect(lines().filter((l) => l.startsWith(`[stage] sweep of ${e.stageId} failed:`))).toHaveLength(1);
  });

  test("(d) three ticks with the same status: one row, one event. (d2) another status: a second row", () => {
    const e = makeEnv();
    e.breakStage("'cancelled'");
    for (let i = 0; i < 3; i++) e.rt.hooks.onTicketCancelled(e.tid, e.cap);
    expect(e.traces()).toHaveLength(1);
    expect(e.events()).toHaveLength(1);
    e.db.run("UPDATE stage SET status = 'retrying' WHERE id = ?", [e.stageId]);
    e.rt.hooks.onTicketCancelled(e.tid, e.cap);
    expect(e.traces().map((r) => r.status_at_failure)).toEqual(["queued", "retrying"]);
    expect(e.events()).toHaveLength(2);
  });

  test("(e) the trace write throws: exactly 2 lines, nothing leaves the catch, stage unchanged", () => {
    const e = makeEnv();
    e.breakStage("'cancelled'");
    e.db.exec("DROP TABLE cancel_traces");
    expect(() => e.rt.hooks.onTicketCancelled(e.tid, e.cap)).not.toThrow();
    const mine = lines().filter((l) => l.startsWith("[stage]"));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toContain(`[stage] cancelling ${e.stageId} failed:`);
    expect(mine[1]).toMatch(new RegExp(`^\\[stage\\] trace for ${e.stageId} failed: .*cancel_traces`));
    expect(e.stageStatus()).toBe("queued");
  });

  test("no traceFailure hook: the cancel only logs, as before", () => {
    const e = makeEnv({ withTrace: false });
    e.breakStage("'cancelled'");
    e.rt.hooks.onTicketCancelled(e.tid, e.cap);
    expect(e.traces()).toHaveLength(0);
    expect(lines().filter((l) => l.startsWith("[stage]"))).toHaveLength(1);
  });

  test("a cancel that works writes no row", () => {
    const e = makeEnv();
    e.rt.hooks.onTicketCancelled(e.tid, e.cap);
    expect(e.stageStatus()).toBe("cancelled");
    expect(e.traces()).toHaveLength(0);
    expect(e.events()).toHaveLength(0);
  });
});

describe("the error text", () => {
  const record = (e: ReturnType<typeof makeEnv>, error: string) =>
    e.trace.record({ room: "r1", stage_id: e.stageId, ticket_id: null, site: "cancel", caller: "ticket_cancel", status_at_failure: "queued", error }, e.cap);

  test("(i) <private> parts are removed", () => {
    const e = makeEnv();
    record(e, "bad <private>secret</private> end");
    expect(e.traces()[0].error).toBe("bad  end");
    expect(JSON.stringify(e.emitted.map((x) => x.entry))).not.toContain("secret");
  });

  test("(j) a 2,000-character error is stored as 500 characters with one ...", () => {
    const e = makeEnv();
    record(e, "x".repeat(2000));
    const err = e.traces()[0].error as string;
    expect(err).toHaveLength(500);
    expect(err.endsWith("...")).toBe(true);
    expect(err.match(/\.\.\./g)).toHaveLength(1);
  });

  test("an error of 500 characters is stored as it is", () => {
    const e = makeEnv();
    record(e, "y".repeat(500));
    expect(e.traces()[0].error).toBe("y".repeat(500));
  });

  test("(k) a null ticket_id is stored as null", () => {
    const e = makeEnv();
    record(e, "boom");
    expect(e.traces()[0].ticket_id).toBeNull();
  });
});

describe("clear", () => {
  const clearRoute = (e: ReturnType<typeof makeEnv>) =>
    e.trace.routes.find((r: RouteDef) => r.method === "POST" && String(r.path).includes("clear"))!;
  const clear = async (e: ReturnType<typeof makeEnv>, id: string, by: string | null = "human", room = "r1") =>
    clearRoute(e).handler(
      new Request(`http://x/rooms/${room}/cancel-traces/${id}/clear`, { method: "POST", body: JSON.stringify(by === null ? {} : { by }) }),
      e.cap,
      { id: room },
    );

  test("(f) the human clears row X: only X changes, one cleared event, X not listed. (f2) the same key after clear: no new row", async () => {
    const e = makeEnv();
    const mk = (status: string) =>
      e.trace.record({ room: "r1", stage_id: e.stageId, ticket_id: e.tid, site: "cancel", caller: "ticket_cancel", status_at_failure: status, error: "boom" }, e.cap);
    mk("queued");
    mk("running");
    const x = cancelTraceId(e.stageId, "cancel", "queued");
    const y = cancelTraceId(e.stageId, "cancel", "running");
    const res = await clear(e, x);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(e.traces().map((r) => [r.id, r]));
    expect(byId[x]).toMatchObject({ status: "cleared" });
    expect(byId[x].cleared_at).toBeGreaterThan(0);
    expect(byId[y]).toMatchObject({ status: "open", cleared_at: null });
    expect(e.events().filter((r) => r.kind === "cancel_trace.cleared")).toHaveLength(1);
    const list = e.trace.routes.find((r: RouteDef) => r.method === "GET")!;
    const body = (await list.handler(new Request("http://x/"), e.cap, { id: "r1" }).json()) as { traces: Row[] };
    expect(body.traces.map((t) => t.id)).toEqual([y]);
    // Again: 200, no event. The same failure again: no row, no reopen.
    expect((await clear(e, x)).status).toBe(200);
    mk("queued");
    expect(e.traces()).toHaveLength(2);
    expect(byId[x].status).toBe("cleared");
    expect(e.traces().find((r) => r.id === x)!.status).toBe("cleared");
    expect(e.events().map((r) => r.kind)).toEqual(["cancel_trace.created", "cancel_trace.created", "cancel_trace.cleared"]);
  });

  test("refusals change nothing: unknown id 404, other room 404, no by 400, an agent 403", async () => {
    const e = makeEnv();
    e.trace.record({ room: "r1", stage_id: e.stageId, ticket_id: null, site: "cancel", caller: "ticket_cancel", status_at_failure: "queued", error: "b" }, e.cap);
    const id = cancelTraceId(e.stageId, "cancel", "queued");
    e.cap.agents.get = ((n: string) => ({ name: n })) as any;
    expect((await clear(e, "ct_" + "0".repeat(16))).status).toBe(404);
    expect((await clear(e, id, "human", "r2")).status).toBe(404);
    expect((await clear(e, id, null)).status).toBe(400);
    expect((await clear(e, id, "worker-1")).status).toBe(403);
    expect(e.traces()[0].status).toBe("open");
    expect(e.events().map((r) => r.kind)).toEqual(["cancel_trace.created"]);
  });
});
