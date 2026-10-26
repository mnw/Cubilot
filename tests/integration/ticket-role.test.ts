// stage-sessions 1.3: a ticket carries the stage role that picks its first stage. It is set by create_ticket and edit_ticket,
// validated against the six roles, and edited under the same rule as request_id.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

type Snap = { id: string; role: string | null };

describe("ticket role", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const make = (extra: Record<string, unknown> = {}) =>
    postJson(hub, "/tickets", { by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", ...extra });
  const rowRole = (id: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    const row = db.query("SELECT role FROM tickets WHERE id = ?").get(id) as { role: string | null } | null;
    db.close();
    return row;
  };
  const count = () => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    const n = (db.query("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    db.close();
    return n;
  };

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    open.push(await registerAgent(hub, "bob", { room: "r1" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("create with tester stores it and every read route returns it; no role reads as null", async () => {
    const a = await make({ role: "tester" });
    expect(a.status).toBe(201);
    const id = (a.json as { snapshot: Snap }).snapshot.id;
    expect((a.json as { snapshot: Snap }).snapshot.role).toBe("tester");
    expect(rowRole(id)).toEqual({ role: "tester" });
    const list = await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`);
    expect((list.json as Snap[]).find((t) => t.id === id)!.role).toBe("tester");
    const none = await make();
    expect((none.json as { snapshot: Snap }).snapshot.role).toBeNull();
  });

  test("all six roles are accepted", async () => {
    for (const role of ["worker", "tester", "validator", "writer", "editor", "reviewer"]) {
      expect((await make({ role })).status).toBe(201);
    }
  });

  test("an unknown role gets 400 on create and edit, and nothing is persisted", async () => {
    const before = count();
    for (const role of ["chef", "Tester", "", 3, ["tester"]]) {
      expect((await make({ role })).status).toBe(400);
    }
    expect(count()).toBe(before);
    const id = ((await make({ role: "worker" })).json as { snapshot: Snap }).snapshot.id;
    for (const role of ["chef", 3, ""]) {
      expect((await postJson(hub, `/tickets/${id}/edit`, { by: "alice", role })).status).toBe(400);
    }
    expect(rowRole(id)).toEqual({ role: "worker" });
  });

  test("the creator edits the role while draft or queued; null clears it; the same value is idempotent", async () => {
    const id = ((await make({ role: "worker" })).json as { snapshot: Snap }).snapshot.id;
    const e = await postJson(hub, `/tickets/${id}/edit`, { by: "alice", role: "validator" });
    expect(e.status).toBe(200);
    expect((e.json as { snapshot: Snap }).snapshot.role).toBe("validator");
    const same = await postJson(hub, `/tickets/${id}/edit`, { by: "alice", role: "validator" });
    expect((same.json as { idempotent?: boolean }).idempotent).toBe(true);
    const cleared = await postJson(hub, `/tickets/${id}/edit`, { by: "alice", role: null });
    expect((cleared.json as { snapshot: Snap }).snapshot.role).toBeNull();
  });

  test("an agent that is not the creator or lead cannot change it; the human can, at any time", async () => {
    const id = ((await make({ role: "worker" })).json as { snapshot: Snap }).snapshot.id;
    const denied = await postJson(hub, `/tickets/${id}/edit`, { by: "bob", role: "tester" });
    expect(denied.status).toBe(403);
    expect(rowRole(id)).toEqual({ role: "worker" });

    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "bob" })).status).toBe(200);
    // the assignee is not the creator or lead either, and after the claim the creator is frozen out
    expect((await postJson(hub, `/tickets/${id}/edit`, { by: "bob", role: "tester" })).status).toBe(403);
    expect((await postJson(hub, `/tickets/${id}/edit`, { by: "alice", role: "tester" })).status).toBe(409);
    expect(rowRole(id)).toEqual({ role: "worker" });

    const human = await postJson(hub, `/tickets/${id}/edit`, { by: hub.humanName, role: "reviewer" });
    expect(human.status).toBe(200);
    expect(rowRole(id)).toEqual({ role: "reviewer" });
  });
});
