// A final validator or reviewer PASS closes the ticket: low radius goes to done, high radius goes to the room lead.
// `stage.passed` and the ticket event are one transaction (the third cross-kind transaction).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, KindModule, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const perm = createPermissionKind(db);
  const ticketKind = createTicketKind(db);
  perm.migrate(db);
  ticketKind.migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = {
    db,
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    briefing: { refresh: () => {} },
    agents: {
      get: (n: string) => (n === "lead-1" ? { name: n, permanent: false, room: "r1" } : n === "human" ? { name: n, permanent: true, room: null } : undefined),
      isPermanent: (n: string) => n === "human",
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: "human" },
  } as unknown as HubCapabilities;
  let n = 0;
  const running = (o: { role?: string; status?: string; radius?: string; review?: string; lead?: boolean } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, assignee, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', ?, 'medium', 'a', ?, ?, 1, 1, 1)`,
      [id, o.radius ?? "low", `${o.role ?? "validator"}-1`, o.status ?? "in_review"],
    );
    if (o.lead !== false) db.run("INSERT OR REPLACE INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('r1', 'lead-1', 1)");
    const s = rt.api.create({ ticket_id: id, role: o.role ?? "validator" }, "system", cap);
    db.run("UPDATE stage SET status = 'running', session = ? WHERE id = ?", [`${o.role ?? "validator"}-1`, s.id]);
    return { id, stage: s.id, session: `${o.role ?? "validator"}-1` };
  };
  const ticket = (id: string) => db.query<{ status: string; assignee: string | null }, [string]>("SELECT status, assignee FROM tickets WHERE id = ?").get(id)!;
  const events = (id: string) => db.query<{ kind: string; actor: string }, [string]>("SELECT kind, actor FROM events WHERE entity_id = ? ORDER BY seq").all(id);
  // The HTTP routes of the permission and ticket kinds, called in-process like tests/integration/ticket-kind.test.ts.
  const kinds: KindModule[] = [perm, ticketKind];
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const url = new URL(`http://hub.test${path}`);
    for (const k of kinds) {
      for (const r of k.routes) {
        if (r.method !== method) continue;
        const m = typeof r.path === "string" ? (r.path === url.pathname ? [] : null) : url.pathname.match(r.path);
        if (!m) continue;
        const params = typeof r.path === "string" ? {} : { id: m[1] };
        const res = await r.handler(new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }), cap, params);
        return { status: res.status, json: await res.json().catch(() => null) };
      }
    }
    throw new Error(`no route ${method} ${path}`);
  }
  return { db, rt, cap, emitted, running, ticket, events, call };
}

describe("final validator PASS closes the ticket", () => {
  test("low ticket, validator PASS: the ticket is done, actor system, and the stage is passed", () => {
    const e = makeEnv();
    const t = e.running();
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.rt.api.load(t.stage)!.status).toBe("passed");
    expect(e.ticket(t.id).status).toBe("done");
    expect(e.events(t.id).at(-1)).toEqual({ kind: "ticket.done", actor: "system" });
    const ev = e.emitted.find((x) => x.entry.ticket_id === t.id && (x.entry as { kind?: string }).kind === "ticket.update");
    expect(ev).toBeTruthy();
    expect(ev!.scope).toEqual({ kind: "room", room: "r1" });
  });

  test("a reviewer PASS closes the ticket too", () => {
    const e = makeEnv();
    const t = e.running({ role: "reviewer" });
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.ticket(t.id).status).toBe("done");
  });

  test("high ticket: assigned to the room lead, not done", () => {
    const e = makeEnv();
    const t = e.running({ radius: "high" });
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.rt.api.load(t.stage)!.status).toBe("passed");
    expect(e.ticket(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    expect(e.events(t.id).at(-1)).toEqual({ kind: "ticket.assigned", actor: "system" });
    expect(e.events(t.id).some((x) => x.kind === "ticket.done")).toBe(false);
    const ev = e.emitted.find((x) => x.entry.ticket_id === t.id && (x.entry as { kind?: string }).kind === "ticket.assigned")!;
    expect((ev.entry as { from?: string }).from).toBe("system");
    expect(ev.scope).toEqual({ kind: "room", room: "r1" });
  });

  test("high ticket: the lead asks the approval, the human allows, and done succeeds (the gate is unchanged)", async () => {
    const e = makeEnv();
    const t = e.running({ radius: "high" });
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.ticket(t.id)).toEqual({ status: "in_review", assignee: "lead-1" });
    // the hub never wrote done: without an Allow the lead's move is refused
    expect((await e.call("POST", `/tickets/${t.id}/transition`, { by: "lead-1", to: "done" })).status).toBe(409);
    const ask = await e.call("POST", `/tickets/${t.id}/approval`, { by: "lead-1" });
    expect(ask.status).toBe(200);
    const rid = ask.json.request_id as string;
    // an Allow from the lead does not open the gate; the human's does
    expect((await e.call("POST", `/tickets/${t.id}/transition`, { by: "lead-1", to: "done" })).status).toBe(409);
    expect((await e.call("POST", `/permissions/${rid}/verdict`, { by: "human", behavior: "allow" })).status).toBe(200);
    const done = await e.call("POST", `/tickets/${t.id}/transition`, { by: "lead-1", to: "done" });
    expect(done.status).toBe(200);
    expect(e.ticket(t.id).status).toBe("done");
    expect(e.events(t.id).at(-1)).toEqual({ kind: "ticket.done", actor: "lead-1" });
  });

  test("high ticket in a room with no lead: nothing changes on the ticket, the stage still passes", () => {
    const e = makeEnv();
    const t = e.running({ radius: "high", lead: false });
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.rt.api.load(t.stage)!.status).toBe("passed");
    expect(e.ticket(t.id)).toEqual({ status: "in_review", assignee: "validator-1" });
  });

  test("verdict FAIL: the ticket is unchanged", () => {
    const e = makeEnv();
    const t = e.running();
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "FAIL", findings: [] }, e.cap);
    expect(e.ticket(t.id)).toEqual({ status: "in_review", assignee: "validator-1" });
  });

  test("tester, worker and writer stages: the ticket is unchanged", () => {
    for (const role of ["tester", "worker", "writer"]) {
      const e = makeEnv();
      const t = e.running({ role });
      e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
      expect(e.ticket(t.id).status).toBe("in_review");
    }
  });

  test("a ticket that is not in_review is unchanged", () => {
    for (const status of ["in_progress", "queued"]) {
      const e = makeEnv();
      const t = e.running({ status });
      e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
      expect(e.rt.api.load(t.stage)!.status).toBe("passed");
      expect(e.ticket(t.id).status).toBe(status);
    }
  });

  test("a failed ticket write rolls back stage.passed", () => {
    const e = makeEnv();
    const t = e.running();
    e.db.run("CREATE TRIGGER no_ticket_update BEFORE UPDATE ON tickets BEGIN SELECT RAISE(ABORT, 'boom'); END");
    e.rt.hooks.onResult(t.session, { stage_id: t.stage, verdict: "PASS" }, e.cap);
    expect(e.rt.api.load(t.stage)!.status).toBe("running");
    expect(e.events(t.stage).some((x) => x.kind === "stage.passed")).toBe(false);
    expect(e.events(t.id).some((x) => x.kind === "ticket.done")).toBe(false);
  });
});
