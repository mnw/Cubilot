// Stage kind through the real hub: registration, auth, read routes. The kind has no write route yet (2.2+).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson } from "../helpers/fetch";

describe("stage kind over HTTP", () => {
  let hub: HubHandle;
  beforeAll(async () => {
    hub = await spawnHub();
  });
  afterAll(async () => {
    await hub.kill();
  });

  test("the kind routes are mounted: an empty list, 404 for a missing stage, 400 for bad input", async () => {
    const list = await getJson(hub, "/stages");
    expect(list.status).toBe(200);
    expect(list.json).toEqual([]);
    expect((await getJson(hub, "/stages?status=all")).json).toEqual([]);
    expect((await getJson(hub, "/stages/s_0123456789abcdef")).status).toBe(404);
    expect((await getJson(hub, "/stages/nope")).status).toBe(400);
    expect((await getJson(hub, "/stages?status=bogus")).status).toBe(400);
    expect((await getJson(hub, "/stages?limit=0")).status).toBe(400);
    expect((await getJson(hub, "/stages?limit=1.5")).status).toBe(400);
    expect((await getJson(hub, "/stages?limit=abc")).status).toBe(400);
    expect((await getJson(hub, "/stages?limit=1001")).status).toBe(400);
    expect((await getJson(hub, "/stages?limit=5")).status).toBe(200);
  });

  test("a read route needs auth", async () => {
    const res = await fetch(`${hub.url}/stages`);
    expect(res.status).toBe(401);
  });

  test("no write route exists for a stage", async () => {
    for (const method of ["POST", "PUT"]) {
      const res = await authedFetch(hub, "/stages", { method, body: "{}", headers: { "content-type": "application/json" } });
      expect([404, 405]).toContain(res.status);
    }
  });
});
