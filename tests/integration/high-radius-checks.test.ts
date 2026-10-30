// P6-04: the old Allow step for done is gone. A pending ticket:done permission is dismissed once at start,
// and neither the route nor the tool asks for a done approval any more.

//
// Second Validator review of a high ticket: model pair from config.yml and a first message with no verdict of the first review.
// In-process hub kinds, like tests/integration/high-ticket-two-validators.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, postJson, registerAgent } from "../helpers/fetch";
import { giveProject, projectRepo } from "../helpers/repo";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind, createPermissionWithSideEffect } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { nodeHost } from "../../hub/channel/node-host";
import { findTool } from "../../hub/channel/tools";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  const ticket = createTicketKind(db);
  ticket.migrate(db);
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = {
    db,
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => {} },
    agents: { get: () => undefined, isPermanent: () => false, isPaused: () => false, all: () => [], ensure: () => null },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  const ask = (id: string, tool_name: string) =>
    createPermissionWithSideEffect(db, cap, { agent: "bob", request_id: id, tool_name, description: "d", input_preview: "{}", room: "r1" }, () => null);
  const status = (id: string) => (db.query("SELECT status FROM permissions WHERE id = ?").get(id) as { status: string }).status;
  const dismissedEvents = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'permission.dismissed'").get() as { n: number }).n;
  return { db, ticket, cap, emitted, ask, status, dismissedEvents };
}

describe("high-radius checks: the Allow step for done", () => {
  test("Pending Allow dismissed", () => {
    const e = makeEnv();
    e.ask("AAAAA", "ticket:done");
    e.ask("BBBBB", "ticket:done");
    e.ask("ccccc", "Bash");
    e.ticket.start!(e.cap);
    expect(e.status("AAAAA")).toBe("dismissed");
    expect(e.status("BBBBB")).toBe("dismissed");
    expect(e.status("ccccc")).toBe("pending");
    // One event for each permission, one transaction each.
    expect(e.dismissedEvents()).toBe(2);
    expect(e.emitted.filter((x) => x.entry.kind === "permission.dismissed")).toHaveLength(2);
  });

  test("Migration twice", () => {
    const e = makeEnv();
    e.ask("AAAAA", "ticket:done");
    e.ticket.start!(e.cap);
    const events = (e.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const row = JSON.stringify(e.db.query("SELECT * FROM permissions WHERE id = 'AAAAA'").get());
    const emittedBefore = e.emitted.length;
    e.ticket.start!(e.cap);
    expect((e.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(events);
    expect(JSON.stringify(e.db.query("SELECT * FROM permissions WHERE id = 'AAAAA'").get())).toBe(row);
    expect(e.emitted.length).toBe(emittedBefore);
  });

  describe("Old approval route gone", () => {
    let hub: HubHandle;
    let bob: Awaited<ReturnType<typeof registerAgent>>;
    beforeAll(async () => {
      hub = await spawnHub();
      bob = await registerAgent(hub, "bob", { room: "r1" });
    });
    afterAll(async () => { bob.close(); await hub.kill(); });

    test("POST /tickets/:id/approval does not exist", async () => {
      const id = ((await postJson(hub, "/tickets", { by: "bob", title: "t", acceptance_criteria: "c", blast_radius: "high" })).json as { snapshot: { id: string } }).snapshot.id;
      await postJson(hub, `/tickets/${id}/claim`, { by: "bob" });
      for (const to of ["in_progress", "in_review"]) await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to, ...(to === "in_review" ? { note: "n" } : {}) });
      const r = await postJson(hub, `/tickets/${id}/approval`, { by: "bob" });
      expect(r.status).toBe(404);
      const perms = await (await authedFetch(hub, `/permissions?status=all`)).json() as Array<{ tool_name: string }>;
      expect(perms.filter((p) => p.tool_name === "ticket:done")).toHaveLength(0);
    });

    test("transition_ticket done on a high ticket never asks for an approval", async () => {
      const id = ((await postJson(hub, "/tickets", { by: "bob", title: "t2", acceptance_criteria: "c", blast_radius: "high" })).json as { snapshot: { id: string } }).snapshot.id;
      await postJson(hub, `/tickets/${id}/claim`, { by: "bob" });
      for (const to of ["in_progress", "in_review"]) await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to, ...(to === "in_review" ? { note: "n" } : {}) });
      const real = nodeHost(async () => {}, async () => {});
      const urls: string[] = [];
      const host = {
        ...real,
        readText: async (p: string) => (p.endsWith("hub.token") ? hub.token : null),
        request: async (url: string, init: unknown) => { urls.push(url); return real.request(url, init as never); },
      };
      const tool = findTool("transition_ticket")!;
      await expect(tool.handler({ agent: "bob", hubEnv: hub.url, host, room: "r1" } as never, { ticket_id: id, to: "done" })).rejects.toThrow(/Validator PASS/);
      expect(urls.some((u) => u.endsWith("/approval"))).toBe(false);
      expect(tool.description).not.toMatch(/Allow|approval/i);
    });
  });
});


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
