// Second Validator review of a high ticket: model pair from config.yml and a first message with no verdict of the first review.
// In-process hub kinds, like tests/integration/high-ticket-two-validators.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject, projectRepo } from "../helpers/repo";
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

// P6-04b: GET /tickets/:id/merge-message names the result handoff of each Validator PASS.
function makeMergeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  const tk = createTicketKind(db);
  tk.migrate(db);
  createStageRuntime(db, { ackMs: 60_000 }).module.migrate(db);
  const cap = { db, config: { humanName: "human" } } as unknown as HubCapabilities;
  const route = tk.routes.find((r) => r.method === "GET" && String(r.path).includes("merge-message"))!;
  let n = 0;
  let seq = 0;
  const ticket = (radius: "low" | "high") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'The title', 'c', ?, 'medium', 'a', 'w', 'in_review', 1, 1, 1)`,
      [id, radius],
    );
    return id;
  };
  /** A passed Validator stage; withResult also records the result handoff of its session. */
  const pass = (ticketId: string, handoffId: string | null) => {
    const sid = `s_${++seq}`;
    db.run("INSERT INTO stage (id, ticket_id, role, status, verdict, session, created_seq) VALUES (?, ?, 'validator', 'passed', 'PASS', ?, ?)", [sid, ticketId, `validator-${seq}`, seq]);
    if (handoffId) {
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, ?, 'Orchestrator', 'PASS', ?, 'pending', 1, 9999999999999)",
        [handoffId, `validator-${seq}`, JSON.stringify({ stage_id: sid, ticket_id: ticketId })],
      );
    }
  };
  const get = async (id: string) => {
    const res = await route.handler(new Request(`http://hub.test/tickets/${id}/merge-message`), cap, { id });
    return { status: res.status, text: await res.text() };
  };
  return { ticket, pass, get };
}

describe("merge message", () => {
  test("High-radius message", async () => {
    const e = makeMergeEnv();
    const id = e.ticket("high");
    e.pass(id, "h_first");
    e.pass(id, "h_second");
    expect(await e.get(id)).toEqual({ status: 200, text: `Merge ticket/${id}: The title (validator PASS h_first, second review PASS h_second)` });
  });

  test("Low format", async () => {
    const e = makeMergeEnv();
    const id = e.ticket("low");
    e.pass(id, "h_only");
    expect(await e.get(id)).toEqual({ status: 200, text: `Merge ticket/${id}: The title (validator PASS h_only)` });
  });

  test("Missing PASS 409", async () => {
    const e = makeMergeEnv();
    const none = e.ticket("low");
    const r0 = await e.get(none);
    expect(r0.status).toBe(409);
    expect(r0.text).toContain("needs a Validator PASS");
    const high = e.ticket("high");
    e.pass(high, "h_first");
    const r1 = await e.get(high);
    expect(r1.status).toBe(409);
    expect(r1.text).toContain("second Validator PASS");
  });

  test("a PASS without a result handoff is named 409", async () => {
    const e = makeMergeEnv();
    const id = e.ticket("low");
    e.pass(id, null);
    const r = await e.get(id);
    expect(r.status).toBe(409);
    expect(r.text).toContain("result handoff of stage");
  });

  test("unknown ticket 404", async () => {
    expect((await makeMergeEnv().get("t_00000000000000ff")).status).toBe(404);
  });
});
