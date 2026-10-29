// L4: a high ticket closes on two Validator PASSes on one commit, with no human Allow. A low ticket closes on one.
// In-process hub kinds, like tests/unit/stage-final-pass.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const C1 = "a".repeat(40);
const C2 = "b".repeat(40);

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
  let n = 0;
  /** An in_review ticket with a Tester handoff to the Validator on C1 and a running first Validator stage. */
  const ticket = (radius: "low" | "high") => {
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
      [hid, JSON.stringify({ ticket_id: id, commit: C1 })],
    );
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'tester-1', '{}', 1)", [hid]);
    const first = rt.api.create({ ticket_id: id, role: "validator" }, "system", cap);
    db.run("UPDATE stage SET status = 'running', session = 'validator-1' WHERE id = ?", [first.id]);
    return { id, first: first.id };
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
  return { db, rt, cap, ticket, row, validators, doneEvents, startSecond };
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

  test("second PASS closes with no Allow", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    expect(e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C1 }, e.cap)).toEqual([]);
    e.rt.hooks.onResult("validator-2", { stage_id: second, verdict: "PASS" }, e.cap);
    expect(e.row(t.id).status).toBe("done");
    expect(e.doneEvents(t.id)).toEqual([{ actor: "system" }]);
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

  test("second PASS on other commit refused", () => {
    const e = makeEnv();
    const t = e.ticket("high");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    const second = e.startSecond(t.id);
    const errors = e.rt.hooks.checkResult("validator-2", { stage_id: second, ticket_id: t.id, verdict: "PASS", findings: [], notes: "ok", commit: C2 }, e.cap);
    expect(errors!.join(" ")).toContain(C1);
    expect(e.row(t.id).status).toBe("in_review");
  });

  test("low ticket closes on one PASS", () => {
    const e = makeEnv();
    const t = e.ticket("low");
    e.rt.hooks.onResult("validator-1", { stage_id: t.first, verdict: "PASS" }, e.cap);
    expect(e.row(t.id).status).toBe("done");
    expect(e.validators(t.id)).toHaveLength(1);
  });
});
