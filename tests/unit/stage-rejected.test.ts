// A refused result wakes the session, and the turn end that follows the refusal is not a stop (human decision 2026-10-24).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { modeFor } from "../../hub/channel/core";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, RouteDef, Scope } from "../../hub/core/types";

describe("delivery mode of stage.rejected", () => {
  test("a refused result wakes the session; the reminder and the other kinds are unchanged", () => {
    expect(modeFor({ kind: "stage.rejected", from: "system" }, "worker-1")).toBe("wake");
    expect(modeFor({ kind: "stage.reminder", from: "system" }, "worker-1")).toBe("wake");
    expect(modeFor({ kind: "ticket.update", from: "bob", snapshot: { assignee: "x", creator: "y" } }, "worker-1")).toBe("context");
    expect(modeFor({ kind: "interrupt.new", from: "bob" }, "worker-1")).toBe("steer");
  });
});

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
     VALUES ('t_0000000000000001', 'r1', 'T', 'c', 'low', 'medium', 'a', 'in_progress', 'req-1', 1, 1, 1)`,
  );
  const s = rt.api.create({ ticket_id: "t_0000000000000001", role: "worker" }, "system", cap);
  rt.api.move(s.id, { to: "launching", session: "worker-1" }, "system", cap);
  rt.api.move(s.id, { to: "running" }, "system", cap);
  const route = rt.module.routes.find((r: RouteDef) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  const turnEnd = async () => {
    const res = await route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: "worker-1" }) }), cap, { id: s.id });
    return ((await res.json()) as { action?: string }).action;
  };
  const bad = { stage_id: s.id }; // no ticket_id: refused
  const good = { stage_id: s.id, ticket_id: "t_0000000000000001" };
  const kinds = (k: string) => emitted.filter((x) => x.e.kind === k);
  return { rt, cap, stage: s.id, turnEnd, bad, good, kinds, load: () => rt.api.load(s.id)! };
}

describe("the turn end after a refused result", () => {
  test("(a) the refusal goes to the same session as stage.rejected", () => {
    const e = makeEnv();
    expect(e.rt.hooks.checkResult("worker-1", e.bad, e.cap)!.length).toBeGreaterThan(0);
    expect(e.kinds("stage.rejected")).toHaveLength(1);
    expect(e.kinds("stage.rejected")[0].s).toEqual({ kind: "to-agents", agents: ["worker-1"] });
  });

  test("(c) the turn end that follows the refusal sends no reminder and counts nothing; the stage stays running", async () => {
    const e = makeEnv();
    e.rt.hooks.checkResult("worker-1", e.bad, e.cap);
    expect(await e.turnEnd()).toBe("none");
    expect(e.kinds("stage.reminder")).toHaveLength(0);
    expect(e.load().status).toBe("running");
    // the next end without a result counts as the first: one reminder, still running; the one after it is the stop
    expect(await e.turnEnd()).toBe("reminder");
    expect(e.load().status).toBe("running");
    expect(await e.turnEnd()).toBe("stop");
    expect(e.load().status).toBe("retrying");
  });

  test("(b) the corrected result passes the stage after a refusal and its turn end", async () => {
    const e = makeEnv();
    e.rt.hooks.checkResult("worker-1", e.bad, e.cap);
    expect(await e.turnEnd()).toBe("none");
    expect(e.rt.hooks.checkResult("worker-1", e.good, e.cap)).toEqual([]);
    e.rt.hooks.onResult("worker-1", e.good, e.cap);
    expect(e.load().status).toBe("passed");
    expect(e.kinds("stage.reminder")).toHaveLength(0);
  });

  test("two refusals in one turn are one turn end; a valid check sets no flag; a later turn end counts as usual", async () => {
    const e = makeEnv();
    e.rt.hooks.checkResult("worker-1", e.bad, e.cap);
    e.rt.hooks.checkResult("worker-1", e.bad, e.cap);
    expect(await e.turnEnd()).toBe("none");
    expect(await e.turnEnd()).toBe("reminder"); // not "stop": the second refusal did not count a second turn end
    const f = makeEnv();
    expect(f.rt.hooks.checkResult("worker-1", f.good, f.cap)).toEqual([]); // valid: no refusal
    expect(await f.turnEnd()).toBe("reminder");
  });

  test("a refusal sets no flag for a sender that is not a stage session", async () => {
    const e = makeEnv();
    expect(e.rt.hooks.checkResult("bob", e.bad, e.cap)).toBeNull();
    expect(await e.turnEnd()).toBe("reminder");
  });
});
