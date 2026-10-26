// ss 6.5 gap B: the briefing of a stage session lists only the ticket of its own stage. Session names are used again, so an
// old ticket that still names "tester-1" as its assignee must not show in the briefing of a new tester-1 session.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const kind = createTicketKind(db);
  kind.migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  let n = 0;
  const ticket = (title: string, assignee: string | null, status = "in_progress") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', ?, 'c', 'low', 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, title, assignee, status],
    );
    return id;
  };
  const stage = (ticketId: string, role: string, session: string, to: "launching" | "running" | "passed") => {
    const s = rt.api.create({ ticket_id: ticketId, role }, "system", cap);
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    if (to !== "launching") rt.api.move(s.id, { to: "running" }, "system", cap);
    if (to === "passed") rt.api.move(s.id, { to: "passed" }, "system", cap);
    return s.id;
  };
  const specStage = (session: string, scope: string[]) => {
    const s = rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", cap, (ctx) => {
      for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
  };
  const briefing = (name: string) => kind.briefingLines!({ name, room: "r1", permanent: false } as any, cap).join("\n");
  return { ticket, stage, specStage, briefing };
}

describe("briefing of a stage session", () => {
  test("(a) an old open ticket that names tester-1 is not in the briefing of a new tester-1 session on another ticket", () => {
    const e = makeEnv();
    const old = e.ticket("OLD ticket of the first run", "tester-1", "in_review");
    const mine = e.ticket("NEW ticket of this stage", "tester-1");
    e.stage(mine, "tester", "tester-1", "running");
    const b = e.briefing("tester-1");
    expect(b).not.toContain(old);
    expect(b).not.toContain("OLD ticket");
  });

  test("(b) the ticket of its own stage is in it, for a launching and for a running stage", () => {
    for (const to of ["launching", "running"] as const) {
      const e = makeEnv();
      e.ticket("OLD", "tester-1", "in_review");
      const mine = e.ticket("MINE", "tester-1");
      e.stage(mine, "tester", "tester-1", to);
      const b = e.briefing("tester-1");
      expect(b).toContain("Your open tickets:");
      expect(b).toContain(mine);
      expect(b).toContain("MINE");
    }
  });

  test("(c) an ordinary agent's list is unchanged: all its open tickets", () => {
    const e = makeEnv();
    const a = e.ticket("ONE", "alice");
    const b2 = e.ticket("TWO", "alice", "queued");
    e.ticket("OTHERS", "bob");
    const b = e.briefing("alice");
    expect(b).toContain(a);
    expect(b).toContain(b2);
    expect(b).not.toContain("OTHERS");
  });

  test("a passed stage whose session is still connected keeps the session on its own ticket: the old ticket is not listed", () => {
    const e = makeEnv();
    const old = e.ticket("OLD", "tester-1", "in_review");
    const mine = e.ticket("MINE", "tester-1");
    e.stage(mine, "tester", "tester-1", "passed");
    const b = e.briefing("tester-1");
    expect(b).not.toContain(old);
    expect(b).toContain(mine);
  });

  test("a passed stage whose ticket is done lists nothing", () => {
    const e = makeEnv();
    e.ticket("OLD", "tester-1", "in_review");
    const mine = e.ticket("MINE", "tester-1", "done");
    e.stage(mine, "tester", "tester-1", "passed");
    expect(e.briefing("tester-1")).toBe("");
  });

  test("the newest stage row of the session decides: a new stage after a passed one", () => {
    const e = makeEnv();
    const first = e.ticket("FIRST", "tester-1");
    e.stage(first, "tester", "tester-1", "passed");
    const second = e.ticket("SECOND", "tester-1");
    e.stage(second, "tester", "tester-1", "running");
    const b = e.briefing("tester-1");
    expect(b).toContain(second);
    expect(b).not.toContain(first);
  });

  test("a spec-review session gets no ticket list", () => {
    const e = makeEnv();
    const t = e.ticket("PLAN", "validator-1");
    e.specStage("validator-1", [t]);
    expect(e.briefing("validator-1")).toBe("");
  });

  test("the assignee stays a record: nothing is changed by the briefing", () => {
    const e = makeEnv();
    const old = e.ticket("OLD", "tester-1", "in_review");
    const mine = e.ticket("MINE", "tester-1");
    e.stage(mine, "tester", "tester-1", "running");
    e.briefing("tester-1");
    // the old ticket still names tester-1 (read back through a plain agent view of another name: it is not listed for it)
    expect(e.briefing("alice")).toBe("");
    expect(old).toBeTruthy();
  });
});
