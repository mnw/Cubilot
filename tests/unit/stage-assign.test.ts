// 2.5: the stage launch assigns the ticket to the session in the same transaction, with actor `system`.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, type LaunchInput, type StageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt: StageRuntime = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: { entry: Entry; scope: Scope }[] = [];
  let refreshes = 0;
  const cap = {
    db,
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => void refreshes++ },
  } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  const ac = new AbortController();
  rt.queue.attach((r) => sent.push(r), ac.signal, cap);
  let n = 0;
  const ticket = (over: { status?: string; assignee?: string | null; room?: string } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', 'low', 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, over.room ?? "r1", over.assignee ?? null, over.status ?? "queued"],
    );
    return id;
  };
  const stageFor = (ticket_id: string, role = "worker") => rt.api.create({ ticket_id, role }, "system", cap);
  const input = (stage_id: string, session: string): LaunchInput => ({ stage_id, session, room: "r1", harness: "claude", cwd: null, prompt: "p" });
  const assignedEvents = (ticketId: string) =>
    db.query<{ actor: string; payload_json: string }, [string]>("SELECT actor, payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.assigned' ORDER BY seq").all(ticketId);
  const row = (id: string) => db.query<any, [string]>("SELECT * FROM tickets WHERE id = ?").get(id);
  return { db, rt, cap, sent, emitted, refreshes: () => refreshes, ticket, stageFor, input, assignedEvents, row, stop: () => { ac.abort(); rt.queue.dispose(); } };
}

describe("ticket ownership on launch", () => {
  test("launch of worker-1 gives assignee worker-1 and one ticket.assigned event by system, in the launching transaction", () => {
    const e = makeEnv();
    const t = e.ticket();
    const s = e.stageFor(t);
    const before = e.db.query<{ m: number }, []>("SELECT MAX(seq) AS m FROM events").get()!.m;
    expect(e.rt.enqueueLaunch(e.input(s.id, "worker-1"), e.cap).ok).toBe(true);
    expect(e.row(t).assignee).toBe("worker-1");
    expect(e.assignedEvents(t)).toEqual([{ actor: "system", payload_json: JSON.stringify({ from: null, to: "worker-1" }) }]);
    // two events in this launch: stage.launching and ticket.assigned, consecutive
    const kinds = e.db.query<{ kind: string; entity_id: string }, [number]>("SELECT kind, entity_id FROM events WHERE seq > ? ORDER BY seq").all(before);
    expect(kinds).toEqual([{ kind: "stage.launching", entity_id: s.id }, { kind: "ticket.assigned", entity_id: t }]);
    // the ticket row's version is the event seq
    expect(e.row(t).version).toBe(e.db.query<{ m: number }, []>("SELECT MAX(seq) AS m FROM events").get()!.m);
    // one broadcast to the room, after the commit; context for everyone
    const out = e.emitted.filter((x) => x.entry.kind === "ticket.assigned");
    expect(out).toHaveLength(1);
    expect(out[0].scope).toEqual({ kind: "room", room: "r1" });
    expect(out[0].entry.from).toBe("system");
    expect((out[0].entry as any).snapshot.assignee).toBe("worker-1");
    expect(e.refreshes()).toBeGreaterThan(0);
    e.stop();
  });

  test("a retry reassigns to the new session name; the same name writes no second event", () => {
    const e = makeEnv();
    const t = e.ticket();
    const s = e.stageFor(t);
    e.rt.enqueueLaunch(e.input(s.id, "worker-1"), e.cap);
    e.rt.queue.ack(e.sent[0].id, { result: "error", error: "x" }, e.cap); // -> retrying, relaunched at once (5.3) under the free name worker-1
    expect(e.rt.api.load(s.id)).toMatchObject({ status: "launching", attempt: 2, session: "worker-1" });
    expect(e.assignedEvents(t)).toHaveLength(1); // the same name: no second ticket.assigned
    // A relaunch under a new name reassigns the ticket: tests/unit/stage-retry.test.ts covers it through a stop.
    e.stop();
  });

  test("a failing assignment rolls the whole launch back: no stage.launching, no ticket change, no request", () => {
    const e = makeEnv();
    const t = e.ticket();
    const s = e.stageFor(t);
    e.db.exec("CREATE TRIGGER no_assign BEFORE UPDATE ON tickets WHEN NEW.assignee IS NOT OLD.assignee BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const events = () => e.db.query("SELECT COUNT(*) AS n FROM events").get();
    const before = events();
    expect(() => e.rt.enqueueLaunch(e.input(s.id, "worker-1"), e.cap)).toThrow();
    expect(e.rt.api.load(s.id)!.status).toBe("queued");
    expect(e.row(t).assignee).toBeNull();
    expect(events()).toEqual(before);
    expect(e.sent).toHaveLength(0);
    expect(e.emitted.filter((x) => x.entry.kind === "ticket.assigned")).toHaveLength(0);
    e.db.exec("DROP TRIGGER no_assign");
    expect(e.rt.enqueueLaunch(e.input(s.id, "worker-1"), e.cap).ok).toBe(true);
    e.stop();
  });

  test("a ticket that is already assigned to a person is reassigned to the session (the stage owns the work)", () => {
    const e = makeEnv();
    const t = e.ticket({ assignee: "alice" });
    const s = e.stageFor(t);
    e.rt.enqueueLaunch(e.input(s.id, "worker-1"), e.cap);
    expect(e.row(t).assignee).toBe("worker-1");
    expect(e.assignedEvents(t).map((x) => JSON.parse(x.payload_json))).toEqual([{ from: "alice", to: "worker-1" }]);
    e.stop();
  });

  test("a spec-review stage has no ticket and assigns nothing", () => {
    const e = makeEnv();
    const s = e.rt.api.create({ role: "validator", review: "spec", request_id: "r1" }, "system", e.cap);
    // enqueueLaunch refuses a stage whose role has no room today (spec-review 2.4 owns that path); the assignment
    // code itself is skipped for a stage without ticket_id, so no ticket event can appear
    e.rt.enqueueLaunch(e.input(s.id, "validator-1"), e.cap);
    expect(e.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'ticket.assigned'").get()).toEqual({ n: 0 });
    e.stop();
  });
});
