import { Database } from "bun:sqlite";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

type Hit = { kind: string; id: string; title: string; room: string | null; status: string };

describe("GET /search", () => {
  let hub: HubHandle;
  const closers: Array<() => void> = [];
  let alphaTicket = "";
  let betaTicket = "";
  let doneTicket = "";

  // Default caller is the human, so a test without a caller name sees all rooms.
  const search = async (q: string, agent: string | null = hub.humanName) => {
    const a = agent ? `&agent=${encodeURIComponent(agent)}` : "";
    return getJson(hub, `/search?q=${encodeURIComponent(q)}${a}`);
  };
  const mk = async (by: string, title: string, request_id: string) => {
    const r = await postJson(hub, "/tickets", { by, title, acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft" });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const ids = (j: unknown) => (j as Hit[]).map((h) => h.id);

  beforeAll(async () => {
    hub = await spawnHub();
    closers.push((await registerAgent(hub, "zelda-1", { room: "alpha" })).close);
    closers.push((await registerAgent(hub, "zelda-2", { room: "beta" })).close);
    alphaTicket = await mk("zelda-1", "Frobnicate the gizmo", "req-alpha-one");
    betaTicket = await mk("zelda-2", "Frobnicate the widget", "req-beta-one");
    doneTicket = await mk("zelda-1", "Frobnicate old thing", "req-alpha-one");
    const c = await postJson(hub, `/tickets/${doneTicket}/transition`, { by: "zelda-1", to: "cancelled" });
    expect(JSON.stringify(c)).toContain('"status":200');
  });
  afterAll(async () => { for (const c of closers) c(); await hub.kill(); });

  test("needs read auth", async () => {
    expect((await fetch(`${hub.url}/search?q=zelda`)).status).toBe(401);
    expect((await fetch(`${hub.url}/search?q=zelda&agent=${hub.humanName}`, { headers: { Authorization: `Bearer ${hub.token}` } })).status).toBe(200);
  });

  test("q shorter than 2 characters gives 200 and an empty list", async () => {
    for (const q of ["", "a", " z "]) {
      const r = await search(q);
      expect(r.status).toBe(200);
      expect(r.json).toEqual([]);
    }
  });

  test("a ticket matches by id prefix, with or without t_", async () => {
    const hex = alphaTicket.slice(2);
    for (const q of [alphaTicket, hex, hex.slice(0, 6), `t_${hex.slice(0, 6)}`]) {
      const r = await search(q);
      expect(ids(r.json)).toContain(alphaTicket);
    }
    const hit = ((await search(alphaTicket)).json as Hit[]).find((h) => h.id === alphaTicket)!;
    expect(hit).toEqual({ kind: "ticket", id: alphaTicket, title: "Frobnicate the gizmo", room: "alpha", status: "draft" });
  });

  test("a ticket matches by words in its title, all words needed", async () => {
    expect(ids((await search("gizmo")).json)).toEqual([alphaTicket]);
    expect(ids((await search("the GIZMO frob")).json)).toEqual([alphaTicket]);
    expect(ids((await search("gizmo widget")).json)).toEqual([]);
  });

  test("a request matches by request_id prefix", async () => {
    const r = (await search("req-alpha")).json as Hit[];
    const hit = r.find((h) => h.kind === "request")!;
    expect(hit.id).toBe("req-alpha-one");
    expect(hit.room).toBe("alpha");
  });

  test("an agent matches by name prefix, not by a middle part", async () => {
    const r = (await search("zeld")).json as Hit[];
    expect(r.filter((h) => h.kind === "agent").map((h) => h.id).sort()).toEqual(["zelda-1", "zelda-2"]);
    expect(((await search("elda")).json as Hit[]).some((h) => h.kind === "agent")).toBe(false);
  });

  test("the human sees all rooms, an agent sees only its own", async () => {
    const human = (await search("frobnicate", hub.humanName)).json as Hit[];
    expect(human.map((h) => h.room)).toContain("beta");
    expect(ids(human)).toEqual(expect.arrayContaining([alphaTicket, betaTicket]));
    const scoped = (await search("req-", "zelda-1")).json as Hit[];
    expect(scoped.every((h) => h.room === "alpha")).toBe(true);
    expect(ids(scoped)).toContain("req-alpha-one");
    expect(ids(scoped)).not.toContain("req-beta-one");
    const agents = ((await search("zelda", "zelda-1")).json as Hit[]).filter((h) => h.kind === "agent");
    expect(agents.map((h) => h.id)).toEqual(["zelda-1"]);
    expect((await search("zelda", "nobody-here")).status).toBe(400);
  });

  test("a request with no caller gives 400, never all rooms", async () => {
    for (const a of [null, "", " "]) {
      const r = await search("frobnicate", a);
      expect(r.status).toBe(400);
      expect(Array.isArray(r.json)).toBe(false);
    }
  });

  test("an agent that is not the human gets only its own room", async () => {
    const r = (await search("frobnicate", "zelda-2")).json as Hit[];
    expect(ids(r)).toEqual([betaTicket]);
    expect(r.every((h) => h.room === "beta")).toBe(true);
  });

  test("an archived ticket is hidden, even by exact id", async () => {
    const id = await mk("zelda-1", "Archivable thing", "req-alpha-one");
    expect(ids((await search(id)).json)).toEqual([id]);
    const db = new Database(hub.ledgerPath);
    db.query("UPDATE tickets SET archived_at_ms = ? WHERE id = ?").run(Date.now(), id);
    db.close();
    expect(ids((await search(id)).json)).toEqual([]);
    expect(ids((await search("archivable")).json)).toEqual([]);
  });

  test("order: exact id first, then open items, then the newest", async () => {
    const r = (await search("frobnicate")).json as Hit[];
    // two open tickets (newest first), then the cancelled one
    expect(ids(r)).toEqual([betaTicket, alphaTicket, doneTicket]);
    const exact = (await search(doneTicket)).json as Hit[];
    expect(exact[0].id).toBe(doneTicket);
    // an agent named like an exact request id ranks by exact match too
    const req = (await search("req-beta-one")).json as Hit[];
    expect(req[0]).toMatchObject({ kind: "request", id: "req-beta-one" });
  });

  test("at most 20 results, SQL wildcards are plain text, and nothing is written", async () => {
    for (let i = 0; i < 22; i++) await postJson(hub, "/tickets", { by: "zelda-1", title: `bulkword ${i}`, acceptance_criteria: "c", blast_radius: "low", request_id: "req-alpha-one", status: "draft" });
    expect(((await search("bulkword")).json as Hit[]).length).toBe(20);
    expect((await search("%%")).json).toEqual([]);
    expect((await search("' OR 1=1 --")).json).toEqual([]);
    const counts = () => {
      const db = new Database(hub.ledgerPath, { readonly: true });
      try {
        const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        return Object.fromEntries(tables.map((t) => [t.name, db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t.name}"`).get()!.n]));
      } finally { db.close(); }
    };
    const before = counts();
    expect(before.events).toBeGreaterThan(0);
    await search("zelda"); await search(alphaTicket); await search("req-alpha");
    expect(counts()).toEqual(before);
  });
});
