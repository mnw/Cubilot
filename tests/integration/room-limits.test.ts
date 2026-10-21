// Factory-room worker and tester limits live on room_settings (task 6.4): set through PUT /rooms/:room/settings,
// read back through GET, validated, and kept across a partial update.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch } from "../helpers/fetch";

async function put(hub: HubHandle, room: string, body: unknown) {
  const r = await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function get(hub: HubHandle, room: string) {
  const r = await authedFetch(hub, `/rooms/${room}/settings`);
  return { status: r.status, json: (await r.json()) as any };
}

describe("room worker and tester limits", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("a room without a row has null limits", async () => {
    const g = await get(hub, "fresh");
    expect(g.status).toBe(200);
    expect(g.json.settings.worker_limit).toBeNull();
    expect(g.json.settings.tester_limit).toBeNull();
  });

  test("PUT stores both limits and GET returns them", async () => {
    const p = await put(hub, "acme", { worker_limit: 3, tester_limit: 2 });
    expect(p.status).toBe(200);
    expect(p.json.settings.worker_limit).toBe(3);
    expect(p.json.settings.tester_limit).toBe(2);
    const g = await get(hub, "acme");
    expect(g.json.settings).toMatchObject({ worker_limit: 3, tester_limit: 2 });
    // the limits are in the ledger row, not only in the response
    const db = new Database(hub.ledgerPath, { readonly: true });
    const row = db.query("SELECT worker_limit, tester_limit FROM room_settings WHERE room = 'acme'").get() as any;
    db.close();
    expect(row).toEqual({ worker_limit: 3, tester_limit: 2 });
  });

  test("a partial update keeps the other limit and the other settings", async () => {
    await put(hub, "partial", { worker_limit: 4, tester_limit: 5, persist_transcript: false, room_summary_enabled: true });
    const p = await put(hub, "partial", { worker_limit: 6 });
    expect(p.json.settings).toMatchObject({ worker_limit: 6, tester_limit: 5, room_summary_enabled: true });
    // and a settings update that names no limit keeps both
    const q = await put(hub, "partial", { room_summary_enabled: false });
    expect(q.json.settings).toMatchObject({ worker_limit: 6, tester_limit: 5 });
  });

  test("null clears a limit", async () => {
    await put(hub, "clear", { worker_limit: 2, tester_limit: 2 });
    const p = await put(hub, "clear", { worker_limit: null });
    expect(p.json.settings.worker_limit).toBeNull();
    expect(p.json.settings.tester_limit).toBe(2);
  });

  test("bad limits are 400 and nothing is written", async () => {
    await put(hub, "bad", { worker_limit: 1, tester_limit: 1 });
    for (const v of [0, 21, -1, 1.5, "3", true, [], {}]) {
      const p = await put(hub, "bad", { worker_limit: v });
      expect(p.status).toBe(400);
      const q = await put(hub, "bad", { tester_limit: v });
      expect(q.status).toBe(400);
    }
    // a good limit next to a bad one must not be half-applied
    const mixed = await put(hub, "bad", { worker_limit: 9, tester_limit: 99 });
    expect(mixed.status).toBe(400);
    expect((await get(hub, "bad")).json.settings).toMatchObject({ worker_limit: 1, tester_limit: 1 });
    // the edges are fine
    expect((await put(hub, "bad", { worker_limit: 1, tester_limit: 20 })).status).toBe(200);
  });

  test("a body that is not a JSON object is 400, not 500, and writes nothing", async () => {
    await put(hub, "shape", { worker_limit: 7, tester_limit: 8 });
    for (const raw of ["null", "[]", "5", '"x"', "true", "[1,2]", "{bad json"]) {
      const r = await authedFetch(hub, "/rooms/shape/settings", { method: "PUT", body: raw });
      expect(r.status).toBe(400);
    }
    expect((await get(hub, "shape")).json.settings).toMatchObject({ worker_limit: 7, tester_limit: 8 });
    // an empty object is a valid no-op
    expect((await put(hub, "shape", {})).status).toBe(200);
  });

  test("an invalid room label is still refused", async () => {
    const r = await authedFetch(hub, "/rooms/bad%20%2F%20label/settings", {
      method: "PUT",
      body: JSON.stringify({ worker_limit: 2 }),
    });
    expect(r.status).toBe(400);
  });

  test("PUT needs the token", async () => {
    const r = await fetch(`${hub.url}/rooms/acme/settings`, { method: "PUT", body: JSON.stringify({ worker_limit: 2 }) });
    expect(r.status).toBe(401);
  });
});
