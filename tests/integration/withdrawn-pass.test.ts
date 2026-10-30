// A withdrawn Validator PASS and an open Validator interrupt do not let a ticket close (done, merge-message,
// validator_passes, delivery report). The hub sets an interrupt's ticket_id from the launch record at send time.
// In-process hub kinds, like tests/integration/high-ticket-two-validators.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject, projectRepo } from "../helpers/repo";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createLaunchRecord } from "../../hub/core/launch-record";
import { buildDeliveryReport } from "../../hub/core/delivery-report";
import { createInterruptKind } from "../../hub/kinds/interrupt";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createRequestKind } from "../../hub/kinds/request";
import { createStageRuntime } from "../../hub/kinds/stage";
import { createTicketKind } from "../../hub/kinds/ticket";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
git("branch", "-f", "staging", "main");
const C1 = git("rev-parse", "main");

const AGENTS = ["lead-1", "validator-1", "validator-2", "tester-1", "worker-1", "human"];

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  const launchRecord = createLaunchRecord();
  const tk = createTicketKind(db);
  tk.migrate(db);
  const interrupts = createInterruptKind(db, launchRecord);
  interrupts.migrate(db);
  createRequestKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000, launchRecord });
  rt.module.migrate(db);
  giveProject(db, "r1");
  db.run("INSERT OR REPLACE INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('r1', 'lead-1', 1)");
  const cap = {
    db,
    sse: { emit: (_entry: Entry, _scope: Scope) => {} },
    briefing: { refresh: () => {} },
    agents: {
      get: (n: string) => (AGENTS.includes(n) ? { name: n, permanent: n === "human", room: "r1" } : undefined),
      isPermanent: () => false,
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human", defaultRoom: "r1" },
  } as unknown as HubCapabilities;

  let n = 0;
  let seq = 100;
  /** An in_review ticket (assignee lead-1). */
  const ticket = (radius: "low" | "high") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version, request_id)
       VALUES (?, 'r1', 'Title', 'c', ?, 'medium', 'a', 'lead-1', 'in_review', 1, 1, 1, 'req-1')`,
      [id, radius],
    );
    if (radius === "high") {
      const ts = `s_tester${n}`;
      db.run(
        "INSERT INTO stage (id, ticket_id, role, status, verdict, session, attempt, created_seq, updated_seq, version) VALUES (?, ?, 'tester', 'passed', 'PASS', 'tester-1', 1, ?, ?, 1)",
        [ts, id, ++seq, seq],
      );
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'lead-1', 'result', ?, 'accepted', 1, 9999999999999)",
        [`h_t${n}`, JSON.stringify({ stage_id: ts, ticket_id: id, commit: C1, full_suite: { command: "./scripts/test.sh", exit_code: 0, pass: 1, fail: 0, log_path: "/tmp/l.log" } })],
      );
    }
    return id;
  };
  /** A Validator stage of the ticket. `passed` stages hold a PASS and a result handoff. Returns both ids. */
  const stage = (ticketId: string, session: string, o: { passed: boolean }) => {
    const sid = `s_val${++n}`;
    db.run(
      "INSERT INTO stage (id, ticket_id, role, status, verdict, session, attempt, created_seq, updated_seq, version) VALUES (?, ?, 'validator', ?, ?, ?, 1, ?, ?, 1)",
      [sid, ticketId, o.passed ? "passed" : "running", o.passed ? "PASS" : null, session, ++seq, seq],
    );
    const hid = `h_val${n}`;
    if (o.passed) {
      // The input handoff that started the stage: it names the commit.
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
        [`h_in${n}`, JSON.stringify({ ticket_id: ticketId, commit: C1 })],
      );
      db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'tester-1', '{}', 1)", [`h_in${n}`]);
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, ?, 'lead-1', 'result', ?, 'accepted', 1, 9999999999999)",
        [hid, session, JSON.stringify({ stage_id: sid, verdict: "PASS", suggestions: [] })],
      );
    }
    return { sid, hid };
  };
  /** The Validator cancels its own result handoff. */
  const cancelResult = (hid: string, by: string) => db.run("UPDATE handoffs SET status = 'cancelled', cancelled_by = ? WHERE id = ?", [by, hid]);

  const call = async (routes: typeof tk.routes, method: string, path: string, body: unknown, params: Record<string, string> = {}) => {
    const route = routes.find((r) => r.method === method && (typeof r.path === "string" ? r.path === path.split("?")[0] : r.path.test(path)))!;
    const res = await route.handler(
      new Request(`http://hub.test${path}`, { method, ...(method === "GET" ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }),
      cap,
      params,
    );
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, text, json, error: (json?.error ?? "") as string };
  };
  const transition = (id: string, by: string, to = "done") => call(tk.routes, "POST", `/tickets/${id}/transition`, { by, to }, { id });
  const mergeMessage = (id: string) => call(tk.routes, "GET", `/tickets/${id}/merge-message`, null, { id });
  const sendInterrupt = (from: string) => call(interrupts.routes, "POST", "/interrupts", { from, to: "lead-1", text: "stop" });
  const ackInterrupt = (id: string) => call(interrupts.routes, "POST", `/interrupts/${id}/ack`, { by: "lead-1" }, { id });
  const interruptRow = (id: string) => db.query<{ ticket_id: string | null; stage_id: string | null; status: string }, [string]>("SELECT ticket_id, stage_id, status FROM interrupts WHERE id = ?").get(id)!;
  const status = (id: string) => db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(id)!.status;
  const listPasses = async (id: string) => {
    const r = await call(tk.routes, "GET", "/tickets?room=r1&status=all", null);
    return (r.json as { id: string; validator_passes: number }[]).find((t) => t.id === id)?.validator_passes;
  };
  return { db, cap, launchRecord, ticket, stage, cancelResult, transition, mergeMessage, sendInterrupt, ackInterrupt, interruptRow, status, listPasses };
}

describe("withdrawn Validator PASS", () => {
  test("cancelled PASS handoff does not count for done", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    expect((await e.transition(t, "lead-1")).status).toBe(200);
    const u = e.ticket("low");
    const v = e.stage(u, "validator-1", { passed: true });
    e.cancelResult(v.hid, "validator-1");
    const r = await e.transition(u, "lead-1");
    expect(r.status).toBe(409);
    expect(r.error).toContain("needs a Validator PASS");
    expect(e.status(u)).toBe("in_review");
    expect(s.sid).not.toBe(v.sid);
  });

  test("cancelled PASS handoff does not count for merge-message", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    expect((await e.mergeMessage(t)).text).toContain(s.hid);
    e.cancelResult(s.hid, "validator-1");
    expect((await e.mergeMessage(t)).status).toBe(409);
  });

  test("cancelled PASS handoff does not count for validator_passes on GET /tickets", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    expect(await e.listPasses(t)).toBe(1);
    e.cancelResult(s.hid, "validator-1");
    expect(await e.listPasses(t)).toBe(0);
  });

  test("cancelled PASS handoff does not count in the delivery report", () => {
    const e = makeEnv();
    e.db.run("INSERT INTO requests (id, room, request_id, origin, status, created_by, created_at_ms, version) VALUES ('rq1', 'r1', 'req-1', 'human', 'open', 'human', 1, 1)");
    const t = e.ticket("high");
    const a = e.stage(t, "validator-1", { passed: true });
    const b = e.stage(t, "validator-2", { passed: true });
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [t]);
    const ids = () => (buildDeliveryReport(e.db, "r1", "req-1") as any).report.checks.high_radius[0].pass_handoffs;
    expect(ids()).toEqual([a.hid, b.hid]);
    e.cancelResult(a.hid, "validator-1");
    expect(ids()).toEqual([b.hid]);
  });

  test("a handoff cancelled by someone else is not a withdrawal", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    e.cancelResult(s.hid, "lead-1");
    expect(await e.listPasses(t)).toBe(1);
  });
});

describe("interrupt ticket binding", () => {
  test("interrupt from a stage session gets its ticket id at send time", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: false });
    e.launchRecord.bind("validator-1", s.sid);
    const r = await e.sendInterrupt("validator-1");
    expect(r.status).toBe(201);
    expect(e.interruptRow(r.json.id)).toMatchObject({ ticket_id: t, stage_id: s.sid, status: "pending" });
    // A session that the launch record does not hold gets no ticket id.
    const h = await e.sendInterrupt("worker-1");
    expect(e.interruptRow(h.json.id)).toMatchObject({ ticket_id: null, stage_id: null });
  });

  test("nothing in the body sets ticket_id or stage_id", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const res = await (async () => {
      const route = createInterruptKind(e.db, e.launchRecord).routes.find((r) => r.method === "POST" && r.path === "/interrupts")!;
      return route.handler(
        new Request("http://hub.test/interrupts", { method: "POST", body: JSON.stringify({ from: "worker-1", to: "lead-1", text: "x", ticket_id: t, stage_id: "s_x" }), headers: { "Content-Type": "application/json" } }),
        e.cap,
        {},
      );
    })();
    const id = ((await res.json()) as { id: string }).id;
    expect(e.interruptRow(id)).toMatchObject({ ticket_id: null, stage_id: null });
  });

  test("reused session name: the later interrupt binds to the later ticket", async () => {
    const e = makeEnv();
    const t1 = e.ticket("low");
    const s1 = e.stage(t1, "validator-1", { passed: true });
    e.launchRecord.bind("validator-1", s1.sid);
    e.launchRecord.release("validator-1", s1.sid);
    const t2 = e.ticket("low");
    const s2 = e.stage(t2, "validator-1", { passed: false });
    e.launchRecord.bind("validator-1", s2.sid);
    const r = await e.sendInterrupt("validator-1");
    expect(e.interruptRow(r.json.id)).toMatchObject({ ticket_id: t2, stage_id: s2.sid });
    // The earlier ticket is not blocked.
    expect((await e.transition(t1, "lead-1")).status).toBe(200);
    expect((await e.transition(t2, "lead-1")).status).toBe(409);
  });
});

describe("open Validator interrupt", () => {
  test("pending Validator interrupt blocks done and merge-message with 409", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    e.launchRecord.bind("validator-1", s.sid);
    const i = await e.sendInterrupt("validator-1");
    const d = await e.transition(t, "lead-1");
    expect(d.status).toBe(409);
    expect(d.error).toContain(i.json.id);
    const m = await e.mergeMessage(t);
    expect(m.status).toBe(409);
    expect(m.error).toContain(i.json.id);
    expect(e.status(t)).toBe("in_review");
  });

  test("acknowledged interrupt no longer blocks", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    const s = e.stage(t, "validator-1", { passed: true });
    e.launchRecord.bind("validator-1", s.sid);
    const i = await e.sendInterrupt("validator-1");
    expect((await e.transition(t, "lead-1")).status).toBe(409);
    expect((await e.ackInterrupt(i.json.id)).status).toBe(200);
    expect((await e.mergeMessage(t)).status).toBe(200);
    expect((await e.transition(t, "lead-1")).status).toBe(200);
  });

  test("an interrupt of a worker stage does not block", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    e.stage(t, "validator-1", { passed: true });
    e.db.run("INSERT INTO stage (id, ticket_id, role, status, session, attempt, created_seq, updated_seq, version) VALUES ('s_w', ?, 'worker', 'running', 'worker-1', 1, 1, 1, 1)", [t]);
    e.launchRecord.bind("worker-1", "s_w");
    // The worker stage is older than the validator stage, so the PASS still counts.
    const i = await e.sendInterrupt("worker-1");
    expect(e.interruptRow(i.json.id).ticket_id).toBe(t);
    expect((await e.transition(t, "lead-1")).status).toBe(200);
  });

  test("s_cc42 case leaves the ticket in_review", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    const pass1 = e.stage(t, "validator-1", { passed: true });
    // PASS 1 passed, but the session is still bound: the close ack has not come yet.
    e.launchRecord.bind("validator-1", pass1.sid);
    e.cancelResult(pass1.hid, "validator-1");
    const stop = await e.sendInterrupt("validator-1");
    expect(e.interruptRow(stop.json.id)).toMatchObject({ ticket_id: t, stage_id: pass1.sid });
    e.stage(t, "validator-2", { passed: true });
    const d = await e.transition(t, "lead-1");
    expect(d.status).toBe(409);
    expect(d.error).toContain(stop.json.id);
    expect(e.status(t)).toBe("in_review");
    expect((await e.mergeMessage(t)).status).toBe(409);
    // After the answer the single PASS is still not enough for a high ticket.
    await e.ackInterrupt(stop.json.id);
    const after = await e.transition(t, "lead-1");
    expect(after.status).toBe(409);
    expect(after.error).toContain("second Validator PASS");
  });

  test("human completes the ticket directly", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    const s = e.stage(t, "validator-1", { passed: true });
    e.launchRecord.bind("validator-1", s.sid);
    e.cancelResult(s.hid, "validator-1");
    await e.sendInterrupt("validator-1");
    expect((await e.transition(t, "human")).status).toBe(200);
    expect(e.status(t)).toBe("done");
  });
});
