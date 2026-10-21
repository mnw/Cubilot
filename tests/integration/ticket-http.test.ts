// Ticket kind through the real hub: KINDS registration, auth, routes, SSE room scope.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

describe("ticket kind over HTTP", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    open.push(await registerAgent(hub, "bob", { room: "r1" }));
  });

  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("create → claim → work → human-gated done → list", async () => {
    const created = await postJson(hub, "/tickets", {
      by: "alice", title: "Ship it", acceptance_criteria: "Tests pass.", blast_radius: "high", priority: "highest",
    });
    expect(created.status).toBe(201);
    expect((created.json as { snapshot: { priority: string } }).snapshot.priority).toBe("highest");
    expect((await postJson(hub, "/tickets", {
      by: "alice", title: "x", acceptance_criteria: "y", blast_radius: "low", priority: 3,
    })).status).toBe(400);
    const id = (created.json as { snapshot: { id: string } }).snapshot.id;

    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "bob" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_progress" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_review", note: "built and tested" })).status).toBe(200);

    const blocked = await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "done" });
    expect(blocked.status).toBe(409);
    expect((blocked.json as { approval_request_id: unknown }).approval_request_id).toBeNull();

    const ask = await postJson(hub, `/tickets/${id}/approval`, { by: "bob" });
    expect(ask.status).toBe(200);
    const rid = (ask.json as { request_id: string; created: boolean }).request_id;
    expect((ask.json as { created: boolean }).created).toBe(true);

    const pending = await getJson(hub, `/permissions?status=pending&token=${hub.token}`);
    expect((pending.json as Array<{ id: string; tool_name: string }>).some((p) => p.id === rid && p.tool_name === "ticket:done")).toBe(true);

    const verdict = await postJson(hub, `/permissions/${rid}/verdict`, { by: hub.humanName, behavior: "allow" });
    expect(verdict.status).toBe(200);
    const verdictVersion = (verdict.json as { version?: number; snapshot?: { version?: number } }).snapshot?.version
      ?? (verdict.json as { version?: number }).version;
    expect(typeof verdictVersion).toBe("number");
    const done = await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "done" });
    expect(done.status).toBe(200);

    const all = await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`);
    const item = (all.json as Array<{ id: string; status: string; approval: unknown }>).find((t) => t.id === id)!;
    expect(item.status).toBe("done");
    // version = the permission's events.seq, so the board can order it against live events
    expect(item.approval).toEqual({ id: rid, status: "allowed", resolved_by: hub.humanName, version: verdictVersion });
  });

  test("auth: mutating routes need the bearer token; list needs room", async () => {
    const noAuth = await fetch(`${hub.url}/tickets`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(noAuth.status).toBe(401);
    expect((await getJson(hub, "/tickets")).status).toBe(400);
    expect((await authedFetch(hub, "/tickets?room=r1")).status).toBe(200);
  });

  // What a reconnecting agent is replayed: the permission.new events of its pending requests.
  async function replayedRequests(agent: string): Promise<string[]> {
    const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=r1`);
    const ids: string[] = [];
    (async () => {
      try { for await (const e of sse.events) if (e.kind === "permission.new" && e.permission_id) ids.push(e.permission_id); } catch {}
    })();
    await new Promise((r) => setTimeout(r, 400));
    sse.close();
    return ids;
  }

  test("a request made moot by rework, cancel or a human done is not replayed on reconnect", async () => {
    const mkReview = async () => {
      const id = ((await postJson(hub, "/tickets", {
        by: "alice", title: "x", acceptance_criteria: "y", blast_radius: "high",
      })).json as { snapshot: { id: string } }).snapshot.id;
      await postJson(hub, `/tickets/${id}/claim`, { by: "bob" });
      for (const to of ["in_progress", "in_review"]) await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to, ...(to === "in_review" ? { note: "built and tested" } : {}) });
      return id;
    };
    const ask = async (id: string) => ((await postJson(hub, `/tickets/${id}/approval`, { by: "bob" })).json as { request_id: string }).request_id;
    const a = await mkReview(), ra = await ask(a);
    const b = await mkReview(), rb = await ask(b);
    const c = await mkReview(), rc = await ask(c);
    expect(await replayedRequests("bob")).toEqual(expect.arrayContaining([ra, rb, rc]));

    await postJson(hub, `/tickets/${a}/transition`, { by: "bob", to: "in_progress" });          // rework
    await postJson(hub, `/tickets/${b}/transition`, { by: hub.humanName, to: "cancelled" });    // cancel
    await postJson(hub, `/tickets/${c}/transition`, { by: hub.humanName, to: "done" });         // human done
    const after = await replayedRequests("bob");
    for (const rid of [ra, rb, rc]) expect(after).not.toContain(rid);
  });

  test("assign over the real hub: the creator assigns, the room's agents see ticket.assigned, auth is required", async () => {
    const sse = openSSE(hub, "/agent-stream?agent=bob&room=r1");
    const seen: Array<{ kind?: string; snapshot?: { assignee?: string | null; status?: string } }> = [];
    (async () => { try { for await (const e of sse.events) if (e.kind) seen.push(e); } catch {} })();
    await new Promise((r) => setTimeout(r, 200));

    const id = ((await postJson(hub, "/tickets", {
      by: "alice", title: "assign me", acceptance_criteria: "c", blast_radius: "low",
    })).json as { snapshot: { id: string } }).snapshot.id;
    const noAuth = await fetch(`${hub.url}/tickets/${id}/assign`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(noAuth.status).toBe(401);
    expect((await postJson(hub, `/tickets/${id}/assign`, { by: "bob", assignee: "alice" })).status).toBe(403);   // not the creator
    const ok = await postJson(hub, `/tickets/${id}/assign`, { by: "alice", assignee: "bob" });
    expect(ok.status).toBe(200);
    expect((ok.json as { snapshot: { assignee: string; status: string } }).snapshot).toMatchObject({ assignee: "bob", status: "queued" });
    await new Promise((r) => setTimeout(r, 300));
    sse.close();
    const assigned = seen.filter((e) => e.kind === "ticket.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.snapshot).toMatchObject({ assignee: "bob", status: "queued" });
    // The assignee claims; another agent's claim on an assigned ticket is 409.
    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "alice" })).status).toBe(409);
    expect((await postJson(hub, `/tickets/${id}/claim`, { by: "bob" })).status).toBe(200);
  });

  test("room lead over the real hub: the human sets it, the lead's stream gets an unassigned ticket.new carrying lead", async () => {
    const noAuth = await fetch(`${hub.url}/rooms/r1/lead`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(noAuth.status).toBe(401);
    expect((await getJson(hub, `/rooms/r1/lead?token=${hub.token}`)).json).toEqual({ room: "r1", lead: null });
    expect((await postJson(hub, "/rooms/r1/lead", { by: "bob", agent: "bob" })).status).toBe(403);   // an agent may not
    const set = await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "bob" });
    expect(set.status).toBe(200);
    expect((await getJson(hub, `/rooms/r1/lead?token=${hub.token}`)).json).toEqual({ room: "r1", lead: "bob" });

    const sse = openSSE(hub, "/agent-stream?agent=bob&room=r1");
    const seen: Array<{ kind?: string; lead?: unknown; snapshot?: { status?: string; assignee?: unknown } }> = [];
    (async () => { try { for await (const e of sse.events) if (e.kind) seen.push(e); } catch {} })();
    await new Promise((r) => setTimeout(r, 250));
    const made = await postJson(hub, "/tickets", {
      by: "alice", title: "floating", acceptance_criteria: "c", blast_radius: "low", status: "in_progress",
    });
    expect(made.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    sse.close();
    const created = seen.find((e) => e.kind === "ticket.new" && e.snapshot?.status === "in_progress");
    expect(created).toBeDefined();
    expect(created!.lead).toBe("bob");
    expect(created!.snapshot!.assignee).toBeNull();
    // The lead assigns it; the agent it names moves it.
    const id = (made.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, `/tickets/${id}/assign`, { by: "bob", assignee: "alice" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "alice", to: "in_review", note: "built and tested" })).status).toBe(200);
    expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: null })).json).toEqual({ room: "r1", lead: null });
  });

  test("a lead change reaches the UI stream, and no agent stream", async () => {
    const ui = openSSE(hub, "/stream");
    const agent = openSSE(hub, "/agent-stream?agent=alice&room=r1");
    const uiSeen: Array<{ kind?: string; lead?: unknown }> = [];
    const agentSeen: Array<{ kind?: string }> = [];
    (async () => { try { for await (const e of ui.events) if (e.kind) uiSeen.push(e); } catch {} })();
    (async () => { try { for await (const e of agent.events) if (e.kind) agentSeen.push(e); } catch {} })();
    await new Promise((r) => setTimeout(r, 250));
    await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "alice" });
    await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: null });
    await new Promise((r) => setTimeout(r, 300));
    ui.close(); agent.close();
    expect(uiSeen.filter((e) => e.kind === "room.lead").map((e) => e.lead)).toEqual(["alice", null]);
    expect(agentSeen.some((e) => e.kind === "room.lead")).toBe(false);
  });

  test("notes over the real hub: the move needs one, GET lists them, the board hears of a later one, no agent does", async () => {
    const id = ((await postJson(hub, "/tickets", {
      by: "alice", title: "n", acceptance_criteria: "c", blast_radius: "low", assignee: "bob",
    })).json as { snapshot: { id: string } }).snapshot.id;
    await postJson(hub, `/tickets/${id}/claim`, { by: "bob" });
    await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_progress" });
    const noNote = await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_review" });
    expect(noNote.status).toBe(400);
    expect((noNote.json as { error: string }).error).toContain("note is required");

    const ui = openSSE(hub, "/stream");
    const agent = openSSE(hub, "/agent-stream?agent=alice&room=r1");
    const uiSeen: Array<{ kind?: string; note?: { text?: string } }> = [];
    const agentSeen: Array<{ kind?: string; note?: unknown; notes_count?: number }> = [];
    (async () => { try { for await (const e of ui.events) if (e.kind) uiSeen.push(e); } catch {} })();
    (async () => { try { for await (const e of agent.events) if (e.kind) agentSeen.push(e); } catch {} })();
    await new Promise((r) => setTimeout(r, 250));
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: "bob", to: "in_review", note: "added the route, ran bun test" })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${id}/notes`, { by: "bob", text: "second note" })).status).toBe(201);
    expect((await postJson(hub, `/tickets/${id}/notes`, { by: "alice", text: "not the assignee" })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 300));
    ui.close(); agent.close();

    const notes = (await getJson(hub, `/tickets/${id}/notes?token=${hub.token}`)).json as Array<{ author: string; text: string }>;
    expect(notes.map((n) => [n.author, n.text])).toEqual([["bob", "added the route, ran bun test"], ["bob", "second note"]]);
    const listed = ((await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`)).json as Array<{ id: string; notes_count: number }>).find((t) => t.id === id)!;
    expect(listed.notes_count).toBe(2);
    expect(uiSeen.filter((e) => e.kind === "ticket.noted").map((e) => e.note?.text)).toEqual(["second note"]);
    expect(agentSeen.some((e) => e.kind === "ticket.noted")).toBe(false);          // never to an agent
    const move = agentSeen.find((e) => e.kind === "ticket.update" && e.notes_count === 1);
    expect(move).toBeDefined();                                                      // the room hears THAT a note exists
    expect(JSON.stringify(agentSeen)).not.toContain("added the route");              // never what it says
  });

  test("attachments over the real hub: upload a txt, link it, list it, serve it; a type outside the allowlist is refused", async () => {
    const id = ((await postJson(hub, "/tickets", {
      by: "alice", title: "att", acceptance_criteria: "c", blast_radius: "low", assignee: "bob",
    })).json as { snapshot: { id: string } }).snapshot.id;
    const upload = async (name: string, body: string) => {
      const form = new FormData();
      form.append("file", new File([body], name));
      const r = await fetch(`${hub.url}/upload`, { method: "POST", headers: { Authorization: `Bearer ${hub.token}` }, body: form });   // no JSON content type
      return { status: r.status, json: (await r.json()) as { url?: string; path?: string } };
    };
    const up = await upload("notes.txt", "hello from a txt");
    expect(up.status).toBe(200);
    const bad = await upload("run.exe", "x");
    expect(bad.status).toBe(400);

    const peer = await registerAgent(hub, "att-peer", { room: "r1" });
    expect((await postJson(hub, `/tickets/${id}/attachments`, { by: "att-peer", url: up.json.url, name: "notes" })).status).toBe(403);   // a peer
    peer.close();
    const linked = await postJson(hub, `/tickets/${id}/attachments`, { by: "bob", url: up.json.url, name: "notes" });
    expect(linked.status).toBe(201);
    expect((linked.json as { attachments_count: number }).attachments_count).toBe(1);
    expect((await postJson(hub, `/tickets/${id}/attachments`, { by: "bob", url: "/image/nope.pdf", name: "x" })).status).toBe(400);

    const list = (await getJson(hub, `/tickets/${id}/attachments?token=${hub.token}`)).json as Array<{ name: string; url: string; path: string }>;
    expect(list.map((a) => [a.name, a.url])).toEqual([["notes", up.json.url]]);
    expect(list[0]!.path).toBe(up.json.path);                                   // where an agent reads it
    const served = await fetch(`${hub.url}${up.json.url}?token=${hub.token}`);
    expect(await served.text()).toBe("hello from a txt");
    expect(served.headers.get("content-type")).toContain("text/plain");
    const counted = ((await getJson(hub, `/tickets?room=r1&status=all&token=${hub.token}`)).json as Array<{ id: string; attachments_count: number }>).find((t) => t.id === id)!;
    expect(counted.attachments_count).toBe(1);
  });
});
