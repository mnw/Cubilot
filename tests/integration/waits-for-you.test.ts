// "Waits for you" (P6-15c): GET /requests/<room>/needs-you returns `waiting`, one item per ticket that waits for the human.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("needs-you route: waiting", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "wf-a", { room: "wfa" }));
    open.push(await registerAgent(hub, "wf-b", { room: "wfb" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const ticket = async (request_id: string, over: Record<string, unknown> = {}, by = "wf-a") => {
    const t = await postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  const sql = (fn: (db: Database) => void) => {
    const db = new Database(hub.ledgerPath);
    try { fn(db); } finally { db.close(); }
  };
  const list = async (room: string) => ((await getJson(hub, `/requests/${room}/needs-you`)).json as { waiting: any[] }).waiting;
  let n = 0;
  const pass = (ticketId: string, commit: string, at: number, verdict = "PASS") => {
    const sid = `s_${(++n).toString(16).padStart(16, "0")}`;
    sql((db) => {
      db.run(
        `INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, session, slot_seq, created_seq, updated_seq, version)
         VALUES (?, ?, NULL, NULL, ?, 'tester', 1, 'passed', 'tester-1', NULL, ?, ?, ?)`,
        [sid, ticketId, verdict, n, n, n],
      );
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'x', 'r', ?, 'accepted', ?, ?)",
        [`h_${sid}`, JSON.stringify({ stage_id: sid, verdict, commit }), at, at + 1000],
      );
    });
  };
  const pendingAllow = (ticketId: string, permId: string) =>
    sql((db) => {
      db.run(
        "INSERT INTO permissions (id, agent, tool_name, description, input_preview, status, created_at_ms, room) VALUES (?, 'wf-a', 'ticket:done', 'd', 'p', 'pending', ?, 'wfa')",
        [permId, Date.now()],
      );
      db.run("UPDATE tickets SET approval_request_id = ? WHERE id = ?", [permId, ticketId]);
    });

  test("approve: a draft ticket of a request with a high ticket and no Approve, exact question, case and commit", async () => {
    const d = await ticket("wfr-1", { title: "Plan A" });
    await ticket("wfr-1", { blast_radius: "high" });
    const c1 = "1".repeat(40), c2 = "2".repeat(40);
    pass(d, c1, 1000);
    pass(d, c2, 2000);
    pass(d, "3".repeat(40), 3000, "FAIL");
    const w = (await list("wfa")).filter((x) => x.request_id === "wfr-1");
    const item = w.find((x) => x.ticket_id === d);
    expect(item).toEqual({ ticket_id: d, title: "Plan A", request_id: "wfr-1", case: "approve", commit: c2, permission_id: null, question: "Approve request wfr-1?" });
  });

  test("allow: a high ticket with a pending ticket:done permission, exact question and permission id", async () => {
    const h = await ticket("wfr-2", { blast_radius: "high", title: "Risky", status: "in_review" });
    pendingAllow(h, "perm-wf-1");
    const item = (await list("wfa")).find((x) => x.ticket_id === h);
    expect(item).toEqual({ ticket_id: h, title: "Risky", request_id: "wfr-2", case: "allow", commit: null, permission_id: "perm-wf-1", question: `Allow done of ${h}?` });
  });

  test("a done or queued ticket is not listed; a request with no high ticket is not listed", async () => {
    const q = await ticket("wfr-3", { status: "queued" });
    await ticket("wfr-3", { blast_radius: "high", status: "queued" });
    const qh = await ticket("wfr-3", { blast_radius: "high", status: "queued" });
    pendingAllow(qh, "perm-wf-q");
    const lone = await ticket("wfr-4"); // draft, no high ticket in its request
    const hd = await ticket("wfr-5", { blast_radius: "high", status: "queued" });
    pendingAllow(hd, "perm-wf-2");
    sql((db) => db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [hd]));
    const ids = (await list("wfa")).map((x) => x.ticket_id);
    for (const id of [q, qh, lone, hd]) expect(ids).not.toContain(id);
  });

  test("a resolved permission is not listed; a high draft of a request counts as approve", async () => {
    const h = await ticket("wfr-6", { blast_radius: "high", status: "queued" });
    pendingAllow(h, "perm-wf-3");
    sql((db) => db.run("UPDATE permissions SET status = 'allowed' WHERE id = 'perm-wf-3'"));
    expect((await list("wfa")).map((x) => x.ticket_id)).not.toContain(h);
  });

  test("room scoping: the items of another room never show", async () => {
    const d = await ticket("wfr-7", {}, "wf-b");
    await ticket("wfr-7", { blast_radius: "high" }, "wf-b");
    expect((await list("wfa")).map((x) => x.ticket_id)).not.toContain(d);
    expect((await list("wfb")).map((x) => x.ticket_id)).toContain(d);
  });
});
