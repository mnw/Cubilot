// P6-04b: GET /tickets/:id/merge-message names the result handoff of each Validator PASS.
// In-process hub kinds, like tests/integration/high-ticket-two-validators.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { HubCapabilities } from "../../hub/core/types";

function makeEnv() {
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
    const e = makeEnv();
    const id = e.ticket("high");
    e.pass(id, "h_first");
    e.pass(id, "h_second");
    expect(await e.get(id)).toEqual({ status: 200, text: `Merge ticket/${id}: The title (validator PASS h_first, second review PASS h_second)` });
  });

  test("Low format", async () => {
    const e = makeEnv();
    const id = e.ticket("low");
    e.pass(id, "h_only");
    expect(await e.get(id)).toEqual({ status: 200, text: `Merge ticket/${id}: The title (validator PASS h_only)` });
  });

  test("Missing PASS 409", async () => {
    const e = makeEnv();
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
    const e = makeEnv();
    const id = e.ticket("low");
    e.pass(id, null);
    const r = await e.get(id);
    expect(r.status).toBe(409);
    expect(r.text).toContain("result handoff of stage");
  });

  test("unknown ticket 404", async () => {
    expect((await makeEnv().get("t_00000000000000ff")).status).toBe(404);
  });
});
