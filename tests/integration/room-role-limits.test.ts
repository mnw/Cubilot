// Stage-session role limits and stage timeout live on room_settings (stage-sessions 3.1). The columns hold only what was set;
// NULL means the defaults, which GET always shows.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch } from "../helpers/fetch";

const DEFAULTS = { worker: 2, tester: 2, validator: 1, writer: 1, editor: 1, reviewer: 1 };

async function put(hub: HubHandle, room: string, body: unknown) {
  const r = await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function get(hub: HubHandle, room: string) {
  const r = await authedFetch(hub, `/rooms/${room}/settings`);
  return { status: r.status, json: (await r.json()) as any };
}
function rawRow(hub: HubHandle, room: string) {
  const db = new Database(hub.ledgerPath, { readonly: true });
  const row = db.query("SELECT role_limits, stage_timeout_min FROM room_settings WHERE room = ?").get(room) as any;
  db.close();
  return row;
}

describe("room role limits and stage timeout", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("a new room has the defaults", async () => {
    const g = await get(hub, "fresh");
    expect(g.json.settings.role_limits).toEqual(DEFAULTS);
    expect(g.json.settings.stage_timeout_min).toBe(30);
  });

  test("a room with a row but no stage settings has the defaults, and stores NULL", async () => {
    const p = await put(hub, "rowonly", { persist_transcript: false });
    expect(p.json.settings.role_limits).toEqual(DEFAULTS);
    expect(p.json.settings.stage_timeout_min).toBe(30);
    expect(rawRow(hub, "rowonly")).toEqual({ role_limits: null, stage_timeout_min: null });
  });

  test("PUT sets listed roles only, GET shows them over the defaults, a later PUT keeps the rest", async () => {
    const p = await put(hub, "acme", { role_limits: { worker: 5, validator: 0 }, stage_timeout_min: 45 });
    expect(p.status).toBe(200);
    expect(p.json.settings.role_limits).toEqual({ ...DEFAULTS, worker: 5, validator: 0 });
    expect(p.json.settings.stage_timeout_min).toBe(45);
    const q = await put(hub, "acme", { role_limits: { tester: 10 } });
    expect(q.json.settings.role_limits).toEqual({ ...DEFAULTS, worker: 5, validator: 0, tester: 10 });
    const r = await put(hub, "acme", { persist_transcript: false });
    expect(r.json.settings.role_limits.worker).toBe(5);
    expect(r.json.settings.stage_timeout_min).toBe(45);
  });

  test("null restores the defaults", async () => {
    await put(hub, "reset", { role_limits: { worker: 7 }, stage_timeout_min: 10 });
    const p = await put(hub, "reset", { role_limits: null, stage_timeout_min: null });
    expect(p.json.settings.role_limits).toEqual(DEFAULTS);
    expect(p.json.settings.stage_timeout_min).toBe(30);
    expect(rawRow(hub, "reset")).toEqual({ role_limits: null, stage_timeout_min: null });
  });

  test("11 is 400 and nothing is written", async () => {
    await put(hub, "bad", { role_limits: { worker: 3 } });
    const before = rawRow(hub, "bad");
    for (const body of [
      { role_limits: { worker: 11 } },
      { role_limits: { worker: -1 } },
      { role_limits: { worker: 1.5 } },
      { role_limits: { worker: "2" } },
      { role_limits: { chef: 1 } },
      { role_limits: [1] },
      { role_limits: 3 },
      { stage_timeout_min: 0 },
      { stage_timeout_min: "30" },
      { role_limits: { tester: 4 }, stage_timeout_min: 0 }, // the valid key must not be written either
    ]) {
      const p = await put(hub, "bad", body);
      expect(p.status).toBe(400);
    }
    expect(rawRow(hub, "bad")).toEqual(before);
    expect((await get(hub, "bad")).json.settings.role_limits).toEqual({ ...DEFAULTS, worker: 3 });
  });
});
