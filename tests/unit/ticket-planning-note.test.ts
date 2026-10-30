// context-pack 1.2: tickets.planning_note through the real hub. Same edit rule as request_id.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

type Snap = { id: string; planning_note: string | null };
type Seen = { kind?: string; snapshot?: Snap };

describe("ticket planning_note", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const seen: Seen[] = [];
  let sse: { close: () => void };
  const make = (extra: Record<string, unknown> = {}, by = "alice") =>
    postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", ...extra });
  const edit = (id: string, by: string, planning_note: unknown) => postJson(hub, `/tickets/${id}/edit`, { by, planning_note });
  const snapOf = (r: { json: unknown }) => (r.json as { snapshot: Snap }).snapshot;
  const stored = (id: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    const row = db.query("SELECT planning_note FROM tickets WHERE id = ?").get(id) as { planning_note: string | null };
    db.close();
    return row.planning_note;
  };
  const ledger = <T>(sql: string, ...p: string[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    const rows = db.query(sql).all(...p) as T[];
    db.close();
    return rows;
  };

  beforeAll(async () => {
    hub = await spawnHub();
    for (const n of ["alice", "bob", "carol", "dave"]) open.push(await registerAgent(hub, n, { room: "r1" }));
    expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "carol" })).status).toBe(200);
    const s = openSSE(hub, "/agent-stream?agent=bob&room=r1");
    sse = s;
    (async () => { try { for await (const e of s.events) if (e.kind) seen.push(e as Seen); } catch {} })();
    await new Promise((r) => setTimeout(r, 200));
  });
  afterAll(async () => {
    sse.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("the creator stores it trimmed; no note reads as null; GET /tickets returns it", async () => {
    const a = await make({ planning_note: "  plan A \n" });
    expect(a.status).toBe(201);
    const id = snapOf(a).id;
    expect(snapOf(a).planning_note).toBe("plan A");
    expect(stored(id)).toBe("plan A");
    const list = await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`);
    expect((list.json as Snap[]).find((t) => t.id === id)!.planning_note).toBe("plan A");
    expect(snapOf(await make()).planning_note).toBeNull();
    expect(snapOf(await make({ planning_note: null })).planning_note).toBeNull();
  });

  test("the creator and the room lead edit it; null clears it", async () => {
    const id = snapOf(await make({ planning_note: "one" })).id;
    expect((await edit(id, "alice", " two ")).status).toBe(200);
    expect(stored(id)).toBe("two");
    expect((await edit(id, "carol", "three")).status).toBe(200);
    expect(stored(id)).toBe("three");
    expect(snapOf(await edit(id, "alice", null)).planning_note).toBeNull();
    expect(stored(id)).toBeNull();
  });

  test("assignee edits agent notes", async () => {
    const id = snapOf(await make({ planning_note: "keep", assignee: "bob" })).id;
    const r = await edit(id, "bob", "mine");
    expect(r.status).toBe(200);
    expect(stored(id)).toBe("mine");
  });

  test("assignee edit of the grouping fields still 403, with or without agent notes", async () => {
    const id = snapOf(await make({ planning_note: "keep", assignee: "bob" })).id;
    // The request exists, so the refusal is the 403 of the grouping rule, not the 400 of an unknown request.
    expect((await postJson(hub, "/requests", { by: hub.humanName, room: "r1", request_id: "r-9" })).status).toBe(201);
    for (const extra of [{ request_id: "r-9" }, { role: "worker" }, { blocked_by: [] }]) {
      expect((await postJson(hub, `/tickets/${id}/edit`, { by: "bob", ...extra })).status).toBe(403);
      expect((await postJson(hub, `/tickets/${id}/edit`, { by: "bob", planning_note: "sneaky", ...extra })).status).toBe(403);
    }
    expect(stored(id)).toBe("keep");
  });

  test("other agent edit of agent notes 403", async () => {
    const id = snapOf(await make({ planning_note: "keep", assignee: "bob" })).id;
    expect((await edit(id, "dave", "mine")).status).toBe(403);
    expect(stored(id)).toBe("keep");
  });

  test("existing planning_note shows unchanged", async () => {
    const id = snapOf(await make({ planning_note: "old text" })).id;
    const list = await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`);
    expect((list.json as Snap[]).find((t) => t.id === id)!.planning_note).toBe("old text");
    expect(stored(id)).toBe("old text");
  });

  test("a number, an empty string, blanks and 4001 characters get 400 on create and edit; 4000 passes", async () => {
    const id = snapOf(await make({ planning_note: "keep" })).id;
    const count = () => ledger<{ n: number }>("SELECT COUNT(*) AS n FROM tickets")[0]!.n;
    const before = count();
    for (const bad of [5, "", "   ", "x".repeat(4001), true, ["a"], {}]) {
      expect((await make({ planning_note: bad })).status).toBe(400);
      expect((await edit(id, "alice", bad)).status).toBe(400);
    }
    expect(count()).toBe(before);
    expect(stored(id)).toBe("keep");
    expect((await edit(id, "alice", "y".repeat(4000))).status).toBe(200);
  });

  test("ticket.new and ticket.update carry it; ticket.edited lists it in fields; ticket.created does not carry it", async () => {
    seen.length = 0;
    const id = snapOf(await make({ planning_note: "n1" })).id;
    await edit(id, "alice", "n2");
    await edit(id, "alice", "n2"); // same value: no event
    await postJson(hub, `/tickets/${id}/edit`, { by: "alice", title: "T2" });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.find((e) => e.kind === "ticket.new" && e.snapshot?.id === id)!.snapshot!.planning_note).toBe("n1");
    const updates = seen.filter((e) => e.kind === "ticket.update" && e.snapshot?.id === id);
    expect(updates.map((u) => u.snapshot!.planning_note)).toEqual(["n2", "n2"]);
    const edited = ledger<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'ticket.edited' AND entity_id = ? ORDER BY seq", id)
      .map((r) => (JSON.parse(r.payload_json) as { fields: string[] }).fields);
    expect(edited).toEqual([["planning_note"], ["title"]]);
    const created = ledger<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'ticket.created' AND entity_id = ?", id);
    expect(Object.keys(JSON.parse(created[0]!.payload_json))).not.toContain("planning_note");
  });

  // Regression for validator FAIL h_0b441b3f0e2f4468: the length counts code points; the body cap fits worst-case JSON encoding.
  test("4000 emoji are stored and 4001 get 400, on create and edit", async () => {
    const id = snapOf(await make({ planning_note: "keep" })).id;
    const ok = await make({ planning_note: "😀".repeat(4000) });
    expect(ok.status).toBe(201);
    expect(stored(snapOf(ok).id)).toBe("😀".repeat(4000));
    expect((await edit(id, "alice", "😀".repeat(4000))).status).toBe(200);
    expect(stored(id)).toBe("😀".repeat(4000));
    expect((await make({ planning_note: "😀".repeat(4001) })).status).toBe(400);
    expect((await edit(id, "alice", "😀".repeat(4001))).status).toBe(400);
    expect(stored(id)).toBe("😀".repeat(4000));
  });

  test("4000 x U+0001 sent as escaped JSON (24000 bytes) is not 413: stored, since U+0001 is not trimmed", async () => {
    const note = "\u0001".repeat(4000);
    const esc = '"' + "\\u0001".repeat(4000) + '"';
    const raw = (path: string, fields: string) =>
      authedFetch(hub, path, { method: "POST", body: `{"by":"alice",${fields}}` });
    const c = await raw("/tickets", `"title":"T","acceptance_criteria":"c","blast_radius":"low","status":"draft","planning_note":${esc}`);
    expect(c.status).toBe(201);
    const id = ((await c.json()) as { snapshot: Snap }).snapshot.id;
    expect(stored(id)).toBe(note);
    await edit(id, "alice", null);
    const e = await raw(`/tickets/${id}/edit`, `"planning_note":${esc}`);
    expect(e.status).toBe(200);
    expect(stored(id)).toBe(note);
  });

  test("worst-case emoji escaped as surrogate pairs (48000 bytes) reaches validation", async () => {
    const esc = '"' + "\\ud83d\\ude00".repeat(4000) + '"';
    const c = await authedFetch(hub, "/tickets", {
      method: "POST",
      body: `{"by":"alice","title":"T","acceptance_criteria":"c","blast_radius":"low","status":"draft","planning_note":${esc}}`,
    });
    expect(c.status).toBe(201);
  });
});
