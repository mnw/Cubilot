import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson } from "../helpers/fetch";

describe("GET /requests/<room>/needs-you", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("needs a token, rejects a bad room, and lists nothing for a room with no failed review", async () => {
    expect((await fetch(`${hub.url}/requests/r1/needs-you`)).status).toBe(401);
    expect((await fetch(`${hub.url}/requests/r1/needs-you?token=wrong`)).status).toBe(401);
    expect((await getJson(hub, "/requests/bad%20room%21/needs-you")).status).toBe(400);
    const ok = await getJson(hub, "/requests/r1/needs-you");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ room: "r1", requests: [] });
  });

  test("the same auth as the other read routes: the Bearer header or ?token=", async () => {
    const bearer = await fetch(`${hub.url}/requests/r1/needs-you`, { headers: { Authorization: `Bearer ${hub.token}` } });
    expect(bearer.status).toBe(200);
    const query = await fetch(`${hub.url}/requests/r1/needs-you?token=${hub.token}`);
    expect(query.status).toBe(200);
    // the other read route of this area answers the same way without a token
    expect((await fetch(`${hub.url}/requests/r1/waiting`)).status).toBe(401);
  });
});
