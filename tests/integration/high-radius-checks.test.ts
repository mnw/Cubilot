// Second Validator review of a high ticket: model pair from config.yml and a first message with no verdict of the first review.
// In-process hub kinds, like tests/integration/high-ticket-two-validators.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject, projectRepo } from "../helpers/repo";
import { renderFirstMessage } from "../../hub/core/first-message";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { HubCapabilities } from "../../hub/core/types";

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
git("branch", "-f", "staging", "main");
const C1 = git("rev-parse", "main");

const dataDir = mkdtempSync(join(tmpdir(), "cubilot-second-review-"));
const prevData = process.env.CUBILOT_DATA_DIR;
beforeAll(() => void (process.env.CUBILOT_DATA_DIR = dataDir));
afterAll(() => {
  if (prevData === undefined) delete process.env.CUBILOT_DATA_DIR;
  else process.env.CUBILOT_DATA_DIR = prevData;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp dir, the OS removes it */ }
});
const config = (yml: string) => writeFileSync(join(dataDir, "config.yml"), yml);

type Launch = Extract<LaunchRequest, { kind: "launch" }>;

/** A high ticket whose first Validator passed: returns the launch request of the second stage. */
async function secondLaunch(firstNotes: string): Promise<Launch> {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const cap = {
    db,
    sse: { emit: () => {} },
    briefing: { refresh: () => {} },
    agents: { get: () => undefined, isPermanent: () => false, isPaused: () => false, all: () => [], ensure: () => null },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  const id = "t_0000000000000001";
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'high', 'medium', 'a', 'validator-1', 'in_review', 1, 1, 1)`,
    [id],
  );
  db.run(
    "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES ('h_1', 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
    [JSON.stringify({ ticket_id: id, commit: C1 })],
  );
  db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES ('h_1', 'handoff.created', 'tester-1', '{}', 1)");
  const first = rt.api.create({ ticket_id: id, role: "validator" }, "system", cap);
  db.run("UPDATE stage SET status = 'running', session = 'validator-1' WHERE id = ?", [first.id]);
  // The result handoff of the first Validator, with its notes.
  db.run(
    "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES ('h_res', 'validator-1', 'Orchestrator', 'result', ?, 'accepted', 2, 9999999999999)",
    [JSON.stringify({ stage_id: first.id, ticket_id: id, verdict: "PASS", notes: firstNotes })],
  );
  rt.hooks.onResult("validator-1", { stage_id: first.id, verdict: "PASS" }, cap);
  // The first session closes, then the second stage launches.
  const turnEnd = rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  await turnEnd.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: "validator-1" }) }), cap, { id: first.id });
  for (const r of sent) if (r.kind === "close") rt.queue.ack(r.id, { result: "spawned" }, cap);
  const second = db.query<{ id: string }, [string, string]>("SELECT id FROM stage WHERE ticket_id = ? AND id != ? AND role = 'validator'").get(id, first.id)!;
  const launch = [...sent].reverse().find((r) => r.kind === "launch" && r.stage_id === second.id);
  if (!launch) throw new Error("the second stage did not launch");
  return launch as Launch;
}

describe("high radius: second review", () => {
  test("Second stage model from config", async () => {
    config("second_review:\n  harness: pi\n  model: big-model\n  provider: p1\n  effort: max\nrole_models:\n  validator:\n    model: small\n");
    const l = await secondLaunch("n");
    expect(l.harness).toBe("pi");
    expect(l.model).toBe("big-model");
    expect(l.provider).toBe("p1");
    expect(l.effort).toBe("max");
  });

  test("Second stage model default", async () => {
    config("role_models:\n  validator:\n    model: small\n");
    const l = await secondLaunch("n");
    expect(l.harness).toBe("claude");
    expect(l.model).toBe("opus");
    expect(l.effort).toBe("high");
  });

  test("a bad second_review gives the default", async () => {
    config("second_review: nope\n");
    const l = await secondLaunch("n");
    expect([l.harness, l.model, l.effort]).toEqual(["claude", "opus", "high"]);
  });

  test("No first-review verdict text", async () => {
    config("");
    const l = await secondLaunch("VERDICT-MARK PASS: first review found nothing. FAIL-MARK");
    expect(l.prompt.length).toBeGreaterThan(0);
    expect(l.prompt).not.toContain("VERDICT-MARK");
    expect(l.prompt).not.toContain("FAIL-MARK");
  });
});

const SHA = "a".repeat(40);
const SUITE = { command: "./scripts/test.sh", exit_code: 0, pass: 10, fail: 0, log_path: "/tmp/suite.log" };

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const cap = {
    db,
    sse: { emit: () => {} },
    briefing: { refresh: () => {} },
    agents: { get: () => undefined, isPermanent: () => false, isPaused: () => false, all: () => [], ensure: () => null },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (radius: "low" | "high") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', ?, 'medium', 'a', 'x', 'in_review', 1, 1, 1)`,
      [id, radius],
    );
    return id;
  };
  const running = (ticketId: string, role: string, session: string) => {
    const s = rt.api.create({ ticket_id: ticketId, role }, "system", cap);
    db.run("UPDATE stage SET status = 'running', session = ? WHERE id = ?", [session, s.id]);
    return s.id;
  };
  /** A Tester result already recorded as a handoff of the Tester session. */
  const testerResult = (ticketId: string, context: Record<string, unknown>) => {
    const sid = running(ticketId, "tester", `tester-${++n}`);
    const session = db.query<{ session: string }, [string]>("SELECT session FROM stage WHERE id = ?").get(sid)!.session;
    db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, ?, 'x', 'result', ?, 'accepted', 1, 9999999999999)",
      [`h_${++n}`, session, JSON.stringify({ stage_id: sid, ticket_id: ticketId, commit: SHA, ...context })],
    );
    db.run("UPDATE stage SET status = 'passed', verdict = 'PASS' WHERE id = ?", [sid]);
  };
  const testerCheck = (ticketId: string, extra: Record<string, unknown>) => {
    const sid = running(ticketId, "tester", `tester-${++n}`);
    const session = db.query<{ session: string }, [string]>("SELECT session FROM stage WHERE id = ?").get(sid)!.session;
    const errors = rt.hooks.checkResult(session, { stage_id: sid, ticket_id: ticketId, notes: "ok", commit: SHA, ...extra }, cap);
    return { sid, errors: errors ?? [] };
  };
  const validatorCheck = (ticketId: string, commit = SHA) => {
    const session = `validator-${++n}`;
    const sid = running(ticketId, "validator", session);
    return rt.hooks.checkResult(session, { stage_id: sid, ticket_id: ticketId, notes: "ok", verdict: "PASS", findings: [], commit }, cap) ?? [];
  };
  /** A Tester stage started by a handoff for `startCommit`; the result names `resultCommit`. */
  const testerFromHandoff = (ticketId: string, startCommit: string, resultCommit: string) => {
    const h = `h_${++n}`;
    db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'worker-1', 'role:tester', 'test', ?, 'accepted', 1, 9999999999999)",
      [h, JSON.stringify({ ticket_id: ticketId, commit: startCommit })],
    );
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'worker-1', '{}', 1)", [h]);
    const session = `tester-${++n}`;
    const sid = running(ticketId, "tester", session);
    return rt.hooks.checkResult(session, { stage_id: sid, ticket_id: ticketId, notes: "ok", commit: resultCommit, full_suite: SUITE }, cap) ?? [];
  };
  const status = (sid: string) => db.query<{ status: string }, [string]>("SELECT status FROM stage WHERE id = ?").get(sid)!.status;
  return { testerCheck, validatorCheck, testerResult, testerFromHandoff, ticket, status };
}

describe("high radius checks", () => {
  test("Missing full suite", () => {
    const e = makeEnv();
    const r = e.testerCheck(e.ticket("high"), {});
    expect(r.errors.join(" ")).toContain("context.full_suite is required");
    expect(e.status(r.sid)).toBe("running");
  });

  test("Partial full suite names each missing field", () => {
    const e = makeEnv();
    const r = e.testerCheck(e.ticket("high"), { full_suite: { command: "./scripts/test.sh", pass: 3 } });
    const text = r.errors.join("\n");
    for (const k of ["exit_code", "fail", "log_path"]) expect(text).toContain(`context.full_suite.${k}`);
    expect(text).not.toContain("full_suite.command");
    expect(text).not.toContain("full_suite.pass");
    expect(e.status(r.sid)).toBe("running");
  });

  test("Complete full suite accepted", () => {
    const e = makeEnv();
    expect(e.testerCheck(e.ticket("high"), { full_suite: SUITE }).errors).toEqual([]);
  });

  test("Suite failed", () => {
    const e = makeEnv();
    const bad = e.ticket("high");
    e.testerResult(bad, { full_suite: { ...SUITE, exit_code: 1, fail: 2 } });
    expect(e.validatorCheck(bad).join(" ")).toContain("a high-radius PASS needs a full suite with exit code 0");
    const none = e.ticket("high");
    e.testerResult(none, {});
    expect(e.validatorCheck(none).join(" ")).toContain("a high-radius PASS needs a full suite with exit code 0");
    const good = e.ticket("high");
    e.testerResult(good, { full_suite: SUITE });
    expect(e.validatorCheck(good)).toEqual([]);
  });

  test("Suite of another commit", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.testerResult(t, { full_suite: SUITE });
    expect(e.validatorCheck(t, "b".repeat(40)).join(" ")).toContain(`context.commit must be ${SHA}`);
    expect(e.validatorCheck(t)).toEqual([]);
  });

  test("Tester result for another commit than its stage", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    expect(e.testerFromHandoff(t, SHA, "b".repeat(40)).join(" ")).toContain(`context.commit must be ${SHA}`);
    expect(e.testerFromHandoff(e.ticket("high"), SHA, SHA)).toEqual([]);
  });

  test("Tester first message names test.sh", () => {
    const input = {
      stageId: "s_1",
      role: "tester",
      ticket: { id: "t_1", title: "T", acceptance_criteria: "c", blast_radius: "high", request_id: null },
      branch: "ticket/t_1",
      worktree: "/w",
    };
    expect(renderFirstMessage(input)).toContain("./scripts/test.sh");
    expect(renderFirstMessage({ ...input, ticket: { ...input.ticket, blast_radius: "low" } })).not.toContain("./scripts/test.sh");
  });

  test("Low ticket without full suite accepted", () => {
    const e = makeEnv();
    const t = e.ticket("low");
    expect(e.testerCheck(t, {}).errors).toEqual([]);
    e.testerResult(t, {});
    expect(e.validatorCheck(t)).toEqual([]);
  });
});
