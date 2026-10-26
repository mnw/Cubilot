// Read route for the requests that wait for approval (spec-review-stage 3.4b): GET /requests/<room>/waiting.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("GET /requests/<room>/waiting", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "wa-alice", { room: "wa" }));
    open.push(await registerAgent(hub, "wa-bob", { room: "wb" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const draft = async (request_id: string, over: Record<string, unknown> = {}, by = "wa-alice") => {
    const t = await postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  let n = 0;
  /** A passed spec stage with its scope. A real hub cannot run a spec stage to PASS yet (spec-review 2.4), so the rows are written directly. */
  const passedSpecStage = (request: string, scope: string[], verdict = "PASS") => {
    const id = `s_${(++n).toString(16).padStart(16, "0")}`;
    const db = new Database(hub.ledgerPath);
    try {
      db.run(
        `INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, session, slot_seq, created_seq, updated_seq, version)
         VALUES (?, NULL, ?, 'spec', ?, 'validator', 1, 'passed', 'validator-1', NULL, ?, ?, ?)`,
        [id, request, verdict, n, n, n],
      );
      for (const t of scope) db.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [id, t]);
    } finally {
      db.close();
    }
    return id;
  };
  const waiting = async (room: string) => (await getJson(hub, `/requests/${room}/waiting`)).json as { room: string; waiting: any[] };

  test("a request with a PASS stage, a draft scope ticket and a high ticket is listed with the stage and the tickets", async () => {
    const a = await draft("wr-1");
    const hi = await draft("wr-1", { blast_radius: "high", title: "Risky" });
    const stage = passedSpecStage("wr-1", [a]);
    const r = await waiting("wa");
    expect(r.room).toBe("wa");
    expect(r.waiting).toEqual([
      { request_id: "wr-1", stage_id: stage, high_tickets: [{ id: hi, title: "Risky", status: "draft" }], draft_tickets: [a] },
    ]);
  });

  test("a request with no high ticket is not listed; neither is a FAIL stage or a queued scope", async () => {
    const a = await draft("wr-2");
    passedSpecStage("wr-2", [a]); // no high ticket
    const b = await draft("wr-3");
    await draft("wr-3", { blast_radius: "high" });
    passedSpecStage("wr-3", [b], "FAIL");
    const c = await draft("wr-4", { status: undefined }); // queued
    await draft("wr-4", { blast_radius: "high" });
    passedSpecStage("wr-4", [c]);
    const ids = (await waiting("wa")).waiting.map((w) => w.request_id);
    expect(ids).toEqual(["wr-1"]);
  });

  test("only the requested room is returned", async () => {
    const x = await draft("wr-5", {}, "wa-bob");
    await draft("wr-5", { blast_radius: "high" }, "wa-bob");
    passedSpecStage("wr-5", [x]);
    expect((await waiting("wb")).waiting.map((w) => w.request_id)).toEqual(["wr-5"]);
    expect((await waiting("wa")).waiting.map((w) => w.request_id)).toEqual(["wr-1"]);
    expect((await waiting("empty-room")).waiting).toEqual([]);
  });

  test("after the human approves, the request is no longer waiting", async () => {
    const r = await postJson(hub, "/requests/wb/wr-5/approve", { by: hub.humanName });
    expect(r.status).toBe(200);
    expect((await waiting("wb")).waiting).toEqual([]);
  });

  test("the token is required (401), a query token works, a bad room is 400", async () => {
    expect((await fetch(`${hub.url}/requests/wa/waiting`)).status).toBe(401);
    expect((await fetch(`${hub.url}/requests/wa/waiting?token=${hub.token}`)).status).toBe(200);
    expect((await getJson(hub, "/requests/bad room!/waiting")).status).toBe(400);
  });

  test("a mutating call to the path is not a route", async () => {
    const r = await postJson(hub, "/requests/wa/waiting", {});
    expect([404, 405]).toContain(r.status);
  });
});
