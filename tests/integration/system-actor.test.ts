// 2.5: the actor `system` belongs to the hub. Every HTTP route that changes something refuses it, and writes nothing.
// A route that gets the name as `by`, `from`, `agent` and so on answers 400, whether or not the route reads an actor. The hub itself uses `system` only inside the stage launch (tests/unit/stage-assign.test.ts).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

const T = "t_0123456789abcdef";
const H = "h_0123456789abcdef";
const I = "i_0123456789abcdef";
const L = "l_0123456789abcdef";
const SYS = "system";
// Every field a route may read an actor from, all set to `system`.
const actors = { by: SYS, from: SYS, agent: SYS, actor: SYS, voter: SYS, requester: SYS, name: SYS, creator: SYS };

type R = { method: "POST" | "PUT"; path: string; body?: Record<string, unknown>; expect?: number };
const ROUTES: R[] = [
  { method: "POST", path: "/send", body: { text: "x", to: "all" } },
  { method: "POST", path: "/post", body: { text: "x", to: "all" } },
  { method: "POST", path: "/agents/sw-alice/pause", body: { paused: true } },
  { method: "POST", path: "/agents/sw-alice/reload", body: {} },
  { method: "POST", path: "/remove", body: {} },
  { method: "POST", path: "/upload", body: {} },
  { method: "POST", path: "/sessions", body: {} },
  { method: "POST", path: "/factory/relink", body: {} },
  { method: "POST", path: "/factory/applied", body: {} },
  { method: "POST", path: "/handoffs", body: { to: "sw-alice", task: "x" } },
  { method: "POST", path: "/handoffs", body: { to_role: "tester", task: "x", context: { ticket_id: T } } },
  { method: "POST", path: `/handoffs/${H}/accept`, body: {} },
  { method: "POST", path: `/handoffs/${H}/decline`, body: { reason: "x" } },
  { method: "POST", path: `/handoffs/${H}/cancel`, body: { reason: "x" } },
  { method: "POST", path: "/interrupts", body: { to: "sw-alice", text: "x" } },
  { method: "POST", path: `/interrupts/${I}/ack`, body: {} },
  { method: "POST", path: "/permissions", body: { tool_name: "Bash", description: "x" } },
  { method: "POST", path: "/permissions/p_0123456789abcdef/verdict", body: { behavior: "allow" } },
  { method: "POST", path: "/permissions/p_0123456789abcdef/dismiss", body: {} },
  { method: "POST", path: "/tickets", body: { title: "t", acceptance_criteria: "c", blast_radius: "low" } },
  { method: "POST", path: `/tickets/${T}/claim`, body: {} },
  { method: "POST", path: `/tickets/${T}/assign`, body: { assignee: "sw-alice" } },
  { method: "POST", path: `/tickets/${T}/edit`, body: { title: "x" } },
  { method: "POST", path: `/tickets/${T}/transition`, body: { to: "in_progress" } },
  { method: "POST", path: `/tickets/${T}/approval`, body: {} },
  { method: "POST", path: `/tickets/${T}/notes`, body: { text: "x" } },
  { method: "POST", path: `/tickets/${T}/archive`, body: {} },
  { method: "POST", path: `/tickets/${T}/attachments`, body: { name: "x", url: "x" } },
  { method: "POST", path: `/tickets/${T}/attachments/1/remove`, body: {} },
  { method: "POST", path: "/rooms/sw/lead", body: { agent: SYS } },
  { method: "PUT", path: "/rooms/sw/settings", body: { persist_transcript: true } },
  { method: "POST", path: "/rooms/sw/clear-transcript", body: {} },
  { method: "POST", path: `/launches/${L}/ack`, body: {} },
  { method: "POST", path: "/requests/sw/req-1/approve", body: {} },
  { method: "POST", path: "/stages/s_0123456789abcdef/turn-end", body: {} },
  // spec-review-stage 3.5: the spec-review handoff (a role handoff with review spec) and every field a PASS path could read an actor from
  { method: "POST", path: "/handoffs", body: { to_role: "validator", review: "spec", request_id: "req-1", task: "x", context: { request_text: "x" } } },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return /\/(channel|summariser)$/.test(p) ? [] : sourceFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

describe("the system actor is refused on every route", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "sw-alice", { room: "sw" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const snapshot = () => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return Object.fromEntries(tables.map((t) => [t.name, (db.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n]));
    } finally {
      db.close();
    }
  };

  test("the route list in this test is the list of routes in the source", () => {
    const src = sourceFiles(join(import.meta.dir, "../../hub")).map((p) => readFileSync(p, "utf8")).join("\n");
    const defined = [...src.matchAll(/method:\s*"(POST|PUT)"/g)].length;
    // A new mutating route must be added to ROUTES above (and so be checked for the system actor).
    // The ticket 4.1 ack route and the five stage routes of other changes are counted too.
    expect(defined).toBe(ROUTES.length - 2); // /handoffs is listed three times (plain, role, spec)
  });

  test.each(ROUTES.map((r, i) => [`${r.method} ${r.path}${r.body && "to_role" in r.body ? " (to_role)" : ""}`, i] as const))(
    "%s refuses the actor system and writes nothing",
    async (_name, i) => {
      const r = ROUTES[i];
      const before = snapshot();
      const res = await authedFetch(hub, r.path, { method: r.method, body: JSON.stringify({ ...(r.body ?? {}), ...actors }) });
      const text = await res.text();
      expect(res.status, `${r.method} ${r.path}: ${text}`).toBe(r.expect ?? 400);
      expect(snapshot()).toEqual(before);
      const roster = (await getJson(hub, "/agents")).json as Array<{ name: string }>;
      expect(roster.some((a) => a.name === SYS)).toBe(false);
    },
  );

  // 2.5b: the guard must not depend on the Content-Type header. A route parses its body as JSON whatever the header says.
  describe("whatever the Content-Type header", () => {
    const raw = (path: string, method: string, body: string | Uint8Array, headers: Record<string, string>) =>
      fetch(`${hub.url}${path}`, { method, body, headers: { Authorization: `Bearer ${hub.token}`, ...headers } });
    const probe = JSON.stringify({ by: SYS, persist_transcript: true });
    const persist = async () => ((await getJson(hub, "/rooms/sw/settings")).json as { settings: { persist_transcript: boolean } }).settings.persist_transcript;

    // Each case starts from persist_transcript = false, so one vulnerable case cannot make the next one fail.
    beforeEach(async () => {
      await authedFetch(hub, "/rooms/sw/settings", { method: "PUT", body: JSON.stringify({ persist_transcript: false }) });
    });

    test.each([
      ["text/plain", { "Content-Type": "text/plain" }],
      ["text/plain;charset=UTF-8", { "Content-Type": "text/plain;charset=UTF-8" }],
      ["application/x-www-form-urlencoded", { "Content-Type": "application/x-www-form-urlencoded" }],
      ["multipart/form-data", { "Content-Type": "multipart/form-data; boundary=x" }],
      ["an empty value", { "Content-Type": "" }],
      ["upper case JSON", { "Content-Type": "APPLICATION/JSON" }],
      ["lower case json", { "Content-Type": "application/json" }],
    ])("PUT /rooms/<room>/settings with by system and Content-Type %s gets 400 and writes nothing", async (_n, headers) => {
      const before = snapshot();
      const res = await raw("/rooms/sw/settings", "PUT", probe, headers as Record<string, string>);
      expect(res.status, await res.text()).toBe(400);
      expect(snapshot()).toEqual(before);
      expect(await persist()).toBe(false);
    });

    test("with no Content-Type header at all it gets 400 and writes nothing", async () => {
      const before = snapshot();
      const res = await raw("/rooms/sw/settings", "PUT", new TextEncoder().encode(probe), {});
      expect(res.status, await res.text()).toBe(400);
      expect(snapshot()).toEqual(before);
      expect(await persist()).toBe(false);
    });

    test("the other ways to name the actor, with text/plain, are refused too", async () => {
      for (const [path, body] of [
        ["/tickets", { by: SYS, title: "t", acceptance_criteria: "c", blast_radius: "low" }],
        ["/handoffs", { from: SYS, to: "sw-alice", task: "x" }],
        ["/rooms/sw/lead", { by: "human", agent: SYS }],
      ] as const) {
        const before = snapshot();
        const res = await raw(path, "POST", JSON.stringify(body), { "Content-Type": "text/plain" });
        expect(res.status, `${path}: ${await res.text()}`).toBe(400);
        expect(snapshot()).toEqual(before);
      }
    });

    test("control: text/plain with a real actor reaches the route, so the 400 is about the name", async () => {
      const res = await raw("/rooms/sw/settings", "PUT", JSON.stringify({ by: "sw-alice", persist_transcript: false }), { "Content-Type": "text/plain" });
      expect(res.status).toBe(200);
    });

    test("a body that is not JSON is left to its route and does not crash the guard", async () => {
      const res = await raw("/rooms/sw/settings", "PUT", "not json at all", { "Content-Type": "text/plain" });
      expect(res.status).toBeLessThan(500);
    });
  });

  test("control: the same routes work for a real actor, so the 400 above is about the name", async () => {
    const created = await postJson(hub, "/tickets", { by: "sw-alice", title: "t", acceptance_criteria: "c", blast_radius: "low" });
    expect(created.status).toBe(201);
    const id = (created.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, `/tickets/${id}/notes`, { by: "sw-alice", text: "n" })).status).not.toBe(400);
    expect((await postJson(hub, "/handoffs", { from: "sw-alice", to: "sw-alice", task: "x" })).status).toBe(201);
    expect((await postJson(hub, "/handoffs", { from: SYS, to: "sw-alice", task: "x" })).status).toBe(400);
  });
});
