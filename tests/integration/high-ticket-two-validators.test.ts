// L4: a PASS never closes a ticket. A high ticket needs two Validator PASSes on one commit. The lead moves it to done
// after the merge into staging, with no human Allow.
// In-process hub kinds, like tests/unit/stage-final-pass.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject, projectRepo } from "../helpers/repo";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// C1 is on staging (merged). C2 is a commit that staging does not hold.
git("branch", "-f", "staging", "main");
const C1 = git("rev-parse", "main");
const C2 = git("commit-tree", `${C1}^{tree}`, "-p", C1, "-m", "unmerged");

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createPermissionKind(db).migrate(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = {
    db,
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => {} },
    agents: {
      get: (n: string) => (n === "lead-1" ? { name: n, permanent: false, room: "r1" } : undefined),
      isPermanent: () => false,
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  // A fake shell: reads every request the hub queues.
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  let n = 0;
  /** An in_review ticket with a Tester handoff to the Validator on C1 and a running first Validator stage. */
  const ticket = (radius: "low" | "high", commit = C1) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', ?, 'medium', 'a', 'validator-1', 'in_review', 1, 1, 1)`,
      [id, radius],
    );
    db.run("INSERT OR REPLACE INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('r1', 'lead-1', 1)");
    const hid = `h_${n}`;
    db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
      [hid, JSON.stringify({ ticket_id: id, commit })],
    );
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'tester-1', '{}', 1)", [hid]);
    const first = rt.api.create({ ticket_id: id, role: "validator" }, "system", cap);
    db.run("UPDATE stage SET status = 'running', session = 'validator-1' WHERE id = ?", [first.id]);
    return { id, first: first.id };
  };
  /** The lead's move to done, through the ticket route. Returns the status and the error text. */
  const tk = createTicketKind(db);
  const leadDone = async (id: string): Promise<{ status: number; error?: string }> => {
    const route = tk.routes.find((r) => r.method === "POST" && String(r.path).includes("transition"))!;
    const res = await route.handler(
      new Request("http://hub.test/tickets/x/transition", { method: "POST", body: JSON.stringify({ by: "lead-1", to: "done" }), headers: { "Content-Type": "application/json" } }),
      cap,
      { id },
    );
    return { status: res.status, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error };
  };
  const row = (id: string) => db.query<{ status: string; assignee: string | null }, [string]>("SELECT status, assignee FROM tickets WHERE id = ?").get(id)!;
  const validators = (id: string) =>
    db.query<{ id: string; status: string; verdict: string | null }, [string]>("SELECT id, status, verdict FROM stage WHERE ticket_id = ? AND role = 'validator' ORDER BY created_seq").all(id);
  const doneEvents = (id: string) => db.query<{ actor: string }, [string]>("SELECT actor FROM events WHERE entity_id = ? AND kind = 'ticket.done'").all(id);
  /** The hub's second Validator stage runs in another session. */
  const startSecond = (id: string) => {
    const second = validators(id)[1];
    db.run("UPDATE stage SET status = 'running', session = 'validator-2' WHERE id = ?", [second.id]);
    return second.id;
  };
  return { db, rt, cap, sent, ticket, leadDone, row, validators, doneEvents, startSecond };
}

describe("high ticket: two Validator PASSes", () => {
  test("first PASS starts a second validator", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    expect(e.row(t.id).status).toBe("in_review");
    expect(e.doneEvents(t.id)).toHaveLength(0);
    const v = e.validators(t.id);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ status: "passed", verdict: "PASS" });
    expect(v[1].status).not.toBe("passed");
    // another session name than the first Validator
    const second = e.db.query<{ session: string | null }, [string]>("SELECT session FROM stage WHERE id = ?").get(v[1].id)!.session;
    if (second) expect(second).not.toBe("validator-1");
  });

  test("second validator gets another session name after the first session closes", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const turnEnd = e.rt.module.routes.find((r) => r.method === "POST" && String(r.path).includes("turn-end"))!;
    await turnEnd.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: "validator-1" }) }), e.cap, { id: t.first });
    for (const r of e.sent) if (r.kind === "close") e.rt.queue.ack(r.id, { result: "spawned" }, e.cap);
    const second = e.validators(t.id)[1];
    const launch = [...e.sent].reverse().find((r) => r.kind === "launch" && r.stage_id === second.id) as { session: string } | undefined;
    expect(launch).toBeDefined();
    expect(launch!.session).not.toBe("validator-1");
  });

  test("second PASS keeps in_review and hands the ticket to the lead", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    expect(e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C1 }, e.cap)).toEqual([]);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("FAIL in first goes to worker", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "FAIL", findings: [] }, e.cap);
    expect(e.row(t.id).status).toBe("in_review");
    expect(e.validators(t.id)).toHaveLength(1);
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("FAIL in second goes to worker", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "FAIL", findings: [] }, e.cap);
    expect(e.row(t.id).status).toBe("in_review");
    expect(e.validators(t.id)).toHaveLength(2);
    expect(e.validators(t.id)[1]).toMatchObject({ status: "passed", verdict: "FAIL" });
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("a later Validator handoff does not change the commit of the second PASS", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    // A later handoff on C2 arrives while the first stage runs.
    e.db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES ('h_late', 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
      [JSON.stringify({ ticket_id: t.id, commit: C2 })],
    );
    e.db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES ('h_late', 'handoff.created', 'tester-1', '{}', 1)");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    const bad = e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C2 }, e.cap);
    expect(bad!.join(" ")).toContain(C1);
    expect(e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C1 }, e.cap)).toEqual([]);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
    expect((await e.leadDone(t.id)).status).toBe(200);
  });

  test("second PASS on other commit refused", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    const errors = e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C2 }, e.cap);
    expect(errors!.join(" ")).toContain(C1);
    expect(e.row(t.id).status).toBe("in_review");
  });
});

describe("L4: PASS leaves in_review, the lead closes after the merge", () => {
  const pass = (e: ReturnType<typeof makeEnv>, t: { first: string }) => e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
  const passSecond = (e: ReturnType<typeof makeEnv>, id: string) => {
    const second = e.startSecond(id);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
  };

  test("low PASS leaves in_review", () => {
    const e = makeEnv();
    const t = e.ticket("low");
    pass(e, t);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect(e.validators(t.id)).toHaveLength(1);
    expect(e.doneEvents(t.id)).toHaveLength(0);
  });

  test("low done after merge", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    pass(e, t);
    expect((await e.leadDone(t.id)).status).toBe(200);
    expect(e.row(t.id).status).toBe("done");
  });

  test("low done before merge 409", async () => {
    const e = makeEnv();
    const t = e.ticket("low", C2);
    pass(e, t);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("merged into staging");
    expect(e.row(t.id).status).toBe("in_review");
  });

  test("low done with no PASS 409", async () => {
    const e = makeEnv();
    const t = e.ticket("low");
    e.db.run("UPDATE tickets SET assignee = 'lead-1' WHERE id = ?", [t.id]);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("Validator PASS");
  });

  test("high done with one PASS 409", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    pass(e, t);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("second Validator PASS");
  });

  test("high done with two PASSes on the merged commit, no Allow", async () => {
    const e = makeEnv();
    const t = e.ticket("high");
    pass(e, t);
    passSecond(e, t.id);
    expect(e.row(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect((await e.leadDone(t.id)).status).toBe(200);
    expect(e.row(t.id).status).toBe("done");
  });

  test("high done with two PASSes before the merge 409", async () => {
    const e = makeEnv();
    const t = e.ticket("high", C2);
    pass(e, t);
    passSecond(e, t.id);
    const r = await e.leadDone(t.id);
    expect(r.status).toBe(409);
    expect(r.error).toContain("merged into staging");
  });
});
