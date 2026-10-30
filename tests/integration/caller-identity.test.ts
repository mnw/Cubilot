// A human action takes its identity from the caller (hub-first-browser group 11, specs caller-identity and hub-request-safety).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { registerAgent, openSSE } from "../helpers/fetch";

describe("caller identity", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "w1", { room: "ci" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const call = (token: string, path: string, body: unknown, method = "POST") =>
    fetch(`${hub.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };

  // A draft ticket in room ci under a request the human made first.
  const draft = async (request_id: string): Promise<string> => {
    const q = await call(hub.humanToken, "/requests", { by: hub.humanName, room: "ci", request_id, origin: "factory" });
    expect(q.status).toBeLessThan(300);
    const t = await call(hub.token, "/tickets", { by: "w1", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft" });
    expect(t.status).toBe(201);
    return ((await t.json()) as { snapshot: { id: string } }).snapshot.id;
  };

  test("Agent sends by the human (brief test 6): the Approve route gives 403 and the request stays not approved", async () => {
    const id = await draft("ci-1");
    const r = await call(hub.token, "/requests/ci/ci-1/approve", { by: hub.humanName });
    expect(r.status).toBe(403);
    expect(rows("SELECT status FROM tickets WHERE id = ?", id)[0].status).toBe("draft");
  });

  test("Agent sends a chat as the human: /send with from = the human gives 403 and writes no entry", async () => {
    const before = rows("SELECT COUNT(*) AS n FROM events")[0].n;
    const r = await call(hub.token, "/send", { from: hub.humanName, to: "w1", text: "forged" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "the human acts only from the UI" });
    expect(rows("SELECT COUNT(*) AS n FROM events")[0].n).toBe(before);
  });

  test("every actor field of an agent request that names the human gets 403, case and spaces ignored", async () => {
    for (const f of ["by", "from", "actor", "voter", "requester", "agent", "creator"]) {
      expect((await call(hub.token, "/send", { [f]: ` ${hub.humanName.toUpperCase()} `, to: "w1", text: "x" })).status).toBe(403);
    }
  });

  test("Agent and human tokens are different callers: both upload, and the human is the actor of a human request", async () => {
    for (const token of [hub.humanToken, hub.token]) {
      const form = new FormData();
      form.append("file", new File(["hi"], "a.txt", { type: "text/plain" }));
      const r = await fetch(`${hub.url}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      expect(r.status).toBe(200);
    }
    const id = await draft("ci-2");
    const ok = await call(hub.humanToken, "/requests/ci/ci-2/approve", { by: hub.humanName });
    expect(ok.status).toBe(200);
    expect(rows("SELECT actor FROM events WHERE entity_id = ? AND kind = 'ticket.queued'", id)[0].actor).toBe(hub.humanName);
  });

  test("a human caller acts as the human whatever by holds; a target field keeps its value", async () => {
    const id = await draft("ci-3");
    // by names an agent, yet the human token makes the human the actor: the Approve is allowed.
    expect((await call(hub.humanToken, "/requests/ci/ci-3/approve", { by: "w1" })).status).toBe(200);
    expect(rows("SELECT actor FROM events WHERE entity_id = ? AND kind = 'ticket.queued'", id)[0].actor).toBe(hub.humanName);
    // The target `agent` of /remove is not rewritten.
    const gone = await call(hub.humanToken, "/remove", { agent: "w1" });
    expect(gone.status).toBe(200);
    const roster = (await (await fetch(`${hub.url}/agents`, { headers: { Authorization: `Bearer ${hub.humanToken}` } })).json()) as Array<{ name: string }>;
    expect(roster.map((a) => a.name)).not.toContain("w1");
  });

  test("a chat from the human token carries the human as sender", async () => {
    const sse = openSSE(hub, "/agent-stream?agent=w2&room=ci");
    await sse.events.next(); // the briefing: w2 is registered
    const r = await call(hub.humanToken, "/send", { from: "someone-else", to: "w2", room: "ci", text: "hello-sender" });
    expect(r.status).toBe(200);
    let got: any = null;
    const timer = setTimeout(() => sse.close(), 5000);
    for await (const e of sse.events) {
      if (JSON.stringify(e).includes("hello-sender")) { got = e; break; }
    }
    clearTimeout(timer);
    sse.close();
    // The hub labels the human "you" on delivery; the forged "someone-else" is gone.
    expect(got?.from).toBe("you");
  });
});
