// Stage queue and session names (3.2): a full role keeps the stage queued, a free slot starts the oldest queued
// stage of the role in that room, names are global (lowest free <role>-<n>) while limits are per room.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv(limits: Record<string, Record<string, number>> = {}) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  const cap = {
    db,
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
  } as unknown as HubCapabilities;
  for (const [room, role_limits] of Object.entries(limits)) {
    db.run("INSERT INTO room_settings (room, role_limits, updated_at) VALUES (?, ?, 1) ON CONFLICT(room) DO UPDATE SET role_limits = excluded.role_limits", [
      room,
      JSON.stringify(role_limits),
    ]);
  }
  let n = 0;
  const ticket = (room: string, role = "worker") => {
    giveProject(db, room);
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', 'low', 'medium', 'a', 'queued', ?, 1, 1, 1)`,
      [id, room, role],
    );
    return id;
  };
  /** Evaluates the ticket with launch and returns its stage. */
  const start = (ticketId: string) => {
    rt.evaluateStages(ticketId, cap, [], { launch: true });
    return db.query<{ id: string; status: string; session: string | null }, [string]>("SELECT id, status, session FROM stage WHERE ticket_id = ?").get(ticketId)!;
  };
  const row = (id: string) => db.query<{ status: string; session: string | null }, [string]>("SELECT status, session FROM stage WHERE id = ?").get(id)!;
  const finish = (id: string) => {
    rt.api.move(id, { to: "running" }, "system", cap);
    rt.api.move(id, { to: "passed" }, "system", cap);
  };
  return { db, rt, cap, ticket, start, row, finish };
}

describe("stage queue", () => {
  test("limit 1: the second stage waits and starts when the first one ends", () => {
    const e = makeEnv({ A: { worker: 1 } });
    const s1 = e.start(e.ticket("A"));
    const s2 = e.start(e.ticket("A"));
    expect(s1.status).toBe("launching");
    expect(s2.status).toBe("queued");
    e.finish(s1.id);
    expect(e.row(s2.id)).toEqual({ status: "launching", session: "worker-1" });
  });

  test("the oldest queued stage starts first", () => {
    const e = makeEnv({ A: { worker: 1 } });
    const s1 = e.start(e.ticket("A"));
    const s2 = e.start(e.ticket("A"));
    const s3 = e.start(e.ticket("A"));
    e.finish(s1.id);
    expect(e.row(s2.id).status).toBe("launching");
    expect(e.row(s3.id).status).toBe("queued");
  });

  test("a failed launch frees the slot too", () => {
    const e = makeEnv({ A: { worker: 1 } });
    const s1 = e.start(e.ticket("A"));
    const s2 = e.start(e.ticket("A"));
    e.rt.api.move(s1.id, { to: "retrying" }, "system", e.cap);
    // The stage that failed to launch relaunches first (5.3): it keeps the slot, the queued one waits.
    expect(e.row(s1.id).status).toBe("launching");
    expect(e.row(s2.id).status).toBe("queued");
    e.rt.api.move(s1.id, { to: "failed" }, "system", e.cap); // attempt 2 fails: the slot is free for the queued one
    expect(e.row(s2.id).status).toBe("launching");
  });

  test("a queued stage of a draft ticket is skipped; the next one starts", () => {
    const e = makeEnv({ A: { worker: 1 } });
    const s1 = e.start(e.ticket("A"));
    const t2 = e.ticket("A");
    const s2 = e.start(t2);
    const s3 = e.start(e.ticket("A"));
    e.db.run("UPDATE tickets SET status = 'draft' WHERE id = ?", [t2]);
    e.finish(s1.id);
    expect(e.row(s2.id).status).toBe("queued");
    expect(e.row(s3.id).status).toBe("launching");
  });

  test("a slot in room A starts nothing in room B", () => {
    const e = makeEnv({ A: { worker: 1 }, B: { worker: 1 } });
    const a1 = e.start(e.ticket("A"));
    e.start(e.ticket("B"));
    const b2 = e.start(e.ticket("B"));
    expect(b2.status).toBe("queued");
    e.finish(a1.id);
    expect(e.row(b2.id).status).toBe("queued");
  });
});

describe("session names", () => {
  test("a name is reused after its session ends", () => {
    const e = makeEnv();
    const s1 = e.start(e.ticket("A"));
    expect(s1.session).toBe("worker-1");
    e.finish(s1.id);
    expect(e.start(e.ticket("A")).session).toBe("worker-1");
  });

  test("numbering is global across rooms, limits count only the own room", () => {
    const e = makeEnv({ A: { worker: 1 }, B: { worker: 1 } });
    expect(e.start(e.ticket("A")).session).toBe("worker-1");
    const b = e.start(e.ticket("B"));
    expect(b.status).toBe("launching");
    expect(b.session).toBe("worker-2");
  });

  test("the lowest free number is taken", () => {
    const e = makeEnv({ A: { worker: 5 } });
    const s1 = e.start(e.ticket("A"));
    e.start(e.ticket("A"));
    e.finish(s1.id);
    expect(e.start(e.ticket("A")).session).toBe("worker-1");
  });
});
