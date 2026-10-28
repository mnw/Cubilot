// cancel-failure-trace scenarios 8(f)-(h): the routes on a real hub. Rows are seeded straight into the ledger (a cancel cannot fail on demand).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

describe("cancel traces on a real hub", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const X = "ct_" + "a".repeat(16);
  const Y = "ct_" + "b".repeat(16);
  const Z = "ct_" + "c".repeat(16);

  const db = <T>(fn: (d: Database) => T): T => {
    const d = new Database(hub.ledgerPath);
    try { return fn(d); } finally { d.close(); }
  };
  const seed = (id: string, room: string, ticket: string | null = "t_0000000000000001") =>
    db((d) => d.run(
      `INSERT INTO cancel_traces (id, status, room, stage_id, ticket_id, site, caller, status_at_failure, error, created_at, cleared_at, version)
       VALUES (?, 'open', ?, 's_1', ?, 'cancel', 'ticket_cancel', 'queued', 'boom', 1, NULL, 0)`,
      [id, room, ticket],
    ));
  const events = () => db((d) => d.query("SELECT kind FROM events WHERE kind LIKE 'cancel_trace.%'").all() as Array<{ kind: string }>);
  const ids = async (room: string) => ((await getJson(hub, `/rooms/${room}/cancel-traces`)).json as { traces: Array<{ id: string }> }).traces.map((t) => t.id).sort();
  const clear = (room: string, id: string, body: unknown) => postJson(hub, `/rooms/${room}/cancel-traces/${id}/clear`, body);

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "claude-a", { room: "ct" }));
    seed(X, "ct");
    seed(Y, "ct", null);
    seed(Z, "other");
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("(g) no token: 401 on GET and POST", async () => {
    expect((await fetch(`${hub.url}/rooms/ct/cancel-traces`)).status).toBe(401);
    const r = await fetch(`${hub.url}/rooms/ct/cancel-traces/${X}/clear`, { method: "POST", body: JSON.stringify({ by: hub.humanName }), headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(401);
  });

  test("GET lists the open rows of the room only; a null ticket stays null", async () => {
    expect(await ids("ct")).toEqual([X, Y]);
    const body = (await getJson(hub, "/rooms/ct/cancel-traces")).json as { traces: Array<{ id: string; ticket_id: string | null }> };
    expect(body.traces.find((t) => t.id === Y)!.ticket_id).toBeNull();
  });

  test("(g) refusals change nothing: agent 403, missing by 400, unknown by 400, unknown id 404, other room 404", async () => {
    expect((await clear("ct", X, { by: "claude-a" })).status).toBe(403);
    expect((await clear("ct", X, {})).status).toBe(400);
    expect((await clear("ct", X, { by: "nobody-here" })).status).toBe(400);
    expect((await clear("ct", "ct_" + "9".repeat(16), { by: hub.humanName })).status).toBe(404);
    expect((await clear("ct", Z, { by: hub.humanName })).status).toBe(404);
    expect((await clear("other", X, { by: hub.humanName })).status).toBe(404);
    expect(await ids("ct")).toEqual([X, Y]);
    expect(await ids("other")).toEqual([Z]);
    expect(events()).toEqual([]);
  });

  test("(h) an open row is still listed after an SSE reconnect", async () => {
    for (let i = 0; i < 2; i++) {
      const sse = openSSE(hub, "/stream");
      await sse.events.next();
      sse.close();
      expect(await ids("ct")).toEqual([X, Y]);
    }
  });

  test("(f) the human clears X: only X changes, X leaves GET, one cleared event; a second clear is 200 with no event", async () => {
    const r = await clear("ct", X, { by: hub.humanName });
    expect(r.status).toBe(200);
    expect((r.json as { snapshot: { status: string; cleared_at: number } }).snapshot).toMatchObject({ id: X, status: "cleared" });
    expect(await ids("ct")).toEqual([Y]);
    expect(await ids("other")).toEqual([Z]);
    expect(events()).toEqual([{ kind: "cancel_trace.cleared" }]);
    const again = await clear("ct", X, { by: hub.humanName });
    expect(again.status).toBe(200);
    expect(events()).toHaveLength(1);
  });
});
