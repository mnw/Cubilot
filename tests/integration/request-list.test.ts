// Part 14 H1: GET /rooms/<room>/requests lists the requests of a room with status, progress and the newest event time.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "rl";
type Row = { request_id: string; origin: string; status: string; tickets_done: number; tickets_total: number; high_radius_count: number; last_event_ms: number };

describe("request list", () => {
  let hub: HubHandle;
  let repo: string;
  const open: Array<{ close: () => void }> = [];

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const sql = <T>(fn: (db: Database) => T): T => {
    const db = new Database(hub.ledgerPath);
    try { return fn(db); } finally { db.close(); }
  };
  const mkRequest = async (request_id: string, extra: Record<string, unknown> = {}) => {
    expect((await postJson(hub, "/requests", { by: "rl-lead", request_id, ...extra })).status).toBe(201);
  };
  const mkTicket = async (request_id: string, over: Record<string, unknown> = {}) => {
    const t = await postJson(hub, "/tickets", { by: "rl-lead", title: "T", acceptance_criteria: "c1", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  const setStatus = (id: string, status: string) => sql((db) => void db.run("UPDATE tickets SET status = ? WHERE id = ?", [status, id]));
  const list = async (): Promise<Row[]> => ((await getJson(hub, `/rooms/${ROOM}/requests`)).json as { requests: Row[] }).requests;
  const row = async (id: string) => (await list()).find((r) => r.request_id === id)!;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "rl-repo-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1");
    git("add", ".");
    git("commit", "-qm", "one");
    git("branch", "staging");
    hub = await spawnHub();
    open.push(await registerAgent(hub, "rl-lead", { room: ROOM }));
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: "rl-lead" })).status).toBe(200);
    const put = await fetch(`${hub.url}/rooms/${ROOM}/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project_folder: repo }),
    });
    expect(put.ok).toBe(true);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("a bad room is 400 and a room with no request is 200 with an empty list", async () => {
    expect((await authedFetch(hub, "/rooms/bad%2Froom/requests")).status).toBe(400);
    const empty = await getJson(hub, "/rooms/rl-empty/requests");
    expect(empty.status).toBe(200);
    expect((empty.json as { requests: Row[] }).requests).toEqual([]);
  });

  const humanRequest = async (request_id: string, extra: Record<string, unknown> = {}) => {
    expect((await postJson(hub, "/requests", { by: hub.humanName, room: ROOM, request_id, ...extra })).status).toBe(201);
  };
  const approve = async (request_id: string) => {
    const r = await postJson(hub, `/requests/${ROOM}/${request_id}/approve`, { by: hub.humanName });
    expect(r.status).toBe(200);
  };

  test("no ticket is draft and a request with only cancelled tickets is cancelled", async () => {
    await mkRequest("rl-none");
    expect(await row("rl-none")).toMatchObject({ origin: "human", status: "draft", tickets_done: 0, tickets_total: 0, high_radius_count: 0 });
    await mkRequest("rl-cancel");
    setStatus(await mkTicket("rl-cancel"), "cancelled");
    expect(await row("rl-cancel")).toMatchObject({ status: "cancelled", tickets_total: 0 });
  });

  test("waiting_for_approve, then building after the Approve", async () => {
    await mkRequest("rl-wait");
    await mkTicket("rl-wait");
    await mkTicket("rl-wait", { blast_radius: "high" });
    expect(await row("rl-wait")).toMatchObject({ status: "waiting_for_approve", tickets_total: 2, high_radius_count: 1 });
    await approve("rl-wait");
    expect((await row("rl-wait")).status).toBe("building");
  });

  test("a draft ticket of a request that needs no Approve is draft, a queued one is building", async () => {
    await humanRequest("rl-factory", { origin: "factory" });
    const a = await mkTicket("rl-factory");
    expect((await row("rl-factory")).status).toBe("draft");
    setStatus(a, "queued");
    expect((await row("rl-factory")).status).toBe("building");
  });

  test("ready_for_test, then merged once the merge commit is an ancestor of main", async () => {
    await humanRequest("rl-done", { origin: "factory" });
    const a = await mkTicket("rl-done");
    const b = await mkTicket("rl-done");
    setStatus(a, "done");
    setStatus(b, "cancelled");
    expect(await row("rl-done")).toMatchObject({ status: "ready_for_test", tickets_done: 1, tickets_total: 1 });
    git("checkout", "-q", "-b", "work", "staging");
    writeFileSync(join(repo, "w.txt"), "w");
    git("add", ".");
    git("commit", "-qm", "work");
    git("checkout", "-q", "staging");
    git("merge", "--no-ff", "-q", "-m", `Merge ticket/${a}: T (validator PASS h_1)`, "work");
    expect((await row("rl-done")).status).toBe("ready_for_test");
    git("checkout", "-q", "main");
    git("merge", "--ff-only", "-q", "staging");
    git("checkout", "-q", "staging");
    expect((await row("rl-done")).status).toBe("merged");
  });

  test("last_event_ms is the newest event of the request or of one of its tickets", async () => {
    await mkRequest("rl-time");
    const t = await mkTicket("rl-time");
    const reqId = sql((db) => db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE room = 'rl' AND request_id = ?").get("rl-time")!.id);
    const maxOf = (id: string) => sql((db) => db.query<{ n: number }, [string]>("SELECT MAX(at_ms) AS n FROM events WHERE entity_id = ?").get(id)!.n);
    expect((await row("rl-time")).last_event_ms).toBe(Math.max(maxOf(reqId), maxOf(t)));
    const far = Date.now() + 10_000_000;
    const addEvent = (id: string, at: number) => sql((db) => void db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'test.event', 'x', '{}', ?)", [id, at]));
    addEvent(reqId, far);
    expect((await row("rl-time")).last_event_ms).toBe(far);
    addEvent(t, far + 5);
    expect((await row("rl-time")).last_event_ms).toBe(far + 5);
  });

  test("the route writes no event", async () => {
    const before = sql((db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n);
    await list();
    expect(sql((db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n)).toBe(before);
  });
});
