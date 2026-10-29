// P6-04: the old Allow step for done is gone. A pending ticket:done permission is dismissed once at start,
// and neither the route nor the tool asks for a done approval any more.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, postJson, registerAgent } from "../helpers/fetch";
import { insertEvent } from "../../hub/core/events";
import { migrateLedger } from "../../hub/core/ledger";
import { createPermissionKind, createPermissionWithSideEffect } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { nodeHost } from "../../hub/channel/node-host";
import { findTool } from "../../hub/channel/tools";
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
