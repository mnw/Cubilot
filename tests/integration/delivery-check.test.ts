// Delivery checks (Part 14 H3): the human marks a check of a delivery as works or problem. A problem writes the ticket
// note and files and moves the ticket from done to queued in the same transaction. Real hub, no mocks.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "dc";
const CRITERIA = "Story: s\nAcceptance criteria:\n  1. first check\n  2. second check";

describe("delivery checks", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const sql = <T>(fn: (db: Database) => T, h: HubHandle = hub): T => {
    const db = new Database(h.ledgerPath);
    try { return fn(db); } finally { db.close(); }
  };
  let n = 0;
  /** A delivered request: one done ticket with two numbered criteria. */
  const delivered = async (status = "done") => {
    const request_id = `dc-r${++n}`;
    expect((await postJson(hub, "/requests", { by: "dc-lead", request_id })).status).toBe(201);
    const t = await postJson(hub, "/tickets", { by: "dc-lead", title: "T", acceptance_criteria: CRITERIA, blast_radius: "low", request_id, status: "draft" });
    expect(t.status).toBe(201);
    const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
    sql((db) => void db.run("UPDATE tickets SET status = ? WHERE id = ?", [status, ticket]));
    return { request_id, ticket };
  };
  const mark = (request_id: string, body: Record<string, unknown>) => postJson(hub, `/requests/${ROOM}/${request_id}/delivery/checks`, { by: hub.humanName, ...body });
  const upload = (name: string): string => {
    writeFileSync(join(hub.attachmentsDir, name), "x");
    return name;
  };
  const ticketRow = (id: string) => sql((db) => db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(id)!);
  const events = (entity: string, kind: string) => sql((db) => db.query<{ seq: number }, [string, string]>("SELECT seq FROM events WHERE entity_id = ? AND kind = ? ORDER BY seq").all(entity, kind));

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "dc-lead", { room: ROOM }));
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: "dc-lead" })).status).toBe(200);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("a human works mark is stored with one event and shows in the delivery report", async () => {
    const { request_id, ticket } = await delivered();
    const r = await mark(request_id, { check_id: `${ticket}#1`, mark: "works", note: "fine" });
    expect(r.status).toBe(200);
    const snap = (r.json as any).snapshot;
    expect(snap).toMatchObject({ status: "works", note: "fine", check_id: `${ticket}#1`, ticket_id: ticket, marked_by: hub.humanName });
    expect(events(snap.id, "delivery_check.marked")).toHaveLength(1);
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE id = ?").get(snap.id))).toEqual({ n: 1 });
    expect(ticketRow(ticket).status).toBe("done");
    const rep = (await getJson(hub, `/requests/${ROOM}/${request_id}/delivery`)).json as any;
    const by = Object.fromEntries(rep.checks.marks.map((m: any) => [m.check_id, m]));
    expect(by[`${ticket}#1`]).toMatchObject({ mark: "works", note: "fine", text: "first check", attachments: [] });
    expect(typeof by[`${ticket}#1`].marked_at_ms).toBe("number");
    expect(by[`${ticket}#2`]).toMatchObject({ mark: null, note: null, attachments: [], marked_at_ms: null });
  });

  test("a human mark with no by field is stored with by = the human name", async () => {
    const { request_id, ticket } = await delivered();
    const r = await postJson(hub, `/requests/${ROOM}/${request_id}/delivery/checks`, { check_id: `${ticket}#1`, mark: "works", note: "no by" });
    expect(r.status).toBe(200);
    const snap = (r.json as any).snapshot;
    expect(snap).toMatchObject({ status: "works", note: "no by", check_id: `${ticket}#1`, marked_by: hub.humanName });
    expect(events(snap.id, "delivery_check.marked")).toHaveLength(1);
  });

  test("a problem mark adds the note and files to the ticket and moves it from done to queued in one transaction", async () => {
    const { request_id, ticket } = await delivered();
    const file = upload("dc-shot-1.png");
    const r = await mark(request_id, { check_id: `${ticket}#2`, mark: "problem", note: "button is gone", attachment_ids: [file] });
    expect(r.status).toBe(200);
    expect((r.json as any).reopened).toBe(true);
    expect(ticketRow(ticket).status).toBe("queued");
    const notes = (await getJson(hub, `/tickets/${ticket}/notes`)).json as any[];
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("button is gone");
    expect(notes[0].text).toContain(`${ticket}#2`);
    expect(notes[0].author).toBe(hub.humanName);
    const files = (await getJson(hub, `/tickets/${ticket}/attachments`)).json as any[];
    expect(files.map((f) => f.url)).toEqual([`/image/${file}`]);
    const queued = sql((db) => db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.queued'").all(ticket));
    expect(queued.map((e) => JSON.parse(e.payload_json))).toEqual([expect.objectContaining({ from: "done", to: "queued" })]);
    // The request has an open ticket again: no delivery report until it is done.
    expect((await getJson(hub, `/requests/${ROOM}/${request_id}/delivery`)).status).toBe(409);
  });

  test("the mark, the note, the file and the reopen commit or roll back together", async () => {
    const { request_id, ticket } = await delivered();
    // A trigger makes the ticket update fail: nothing of the mark may stay.
    sql((db) => void db.exec(`CREATE TRIGGER dc_fail BEFORE UPDATE ON tickets WHEN NEW.id = '${ticket}' BEGIN SELECT RAISE(ABORT, 'dc forced'); END`));
    const r = await authedFetch(hub, `/requests/${ROOM}/${request_id}/delivery/checks`, {
      method: "POST",
      body: JSON.stringify({ by: hub.humanName, check_id: `${ticket}#1`, mark: "problem", note: "x", attachment_ids: [upload("dc-shot-2.png")] }),
    });
    expect(r.status).toBe(500);
    sql((db) => void db.exec("DROP TRIGGER dc_fail"));
    expect(ticketRow(ticket).status).toBe("done");
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE request_id = ?").get(request_id))).toEqual({ n: 0 });
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?").get(ticket))).toEqual({ n: 0 });
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?").get(ticket))).toEqual({ n: 0 });
    expect(events(ticket, "ticket.noted")).toHaveLength(0);
  });

  test("an agent and a body that names another sender get 403", async () => {
    const { request_id, ticket } = await delivered();
    for (const by of ["dc-lead", "someone-else", "system"]) {
      const r = await postJson(hub, `/requests/${ROOM}/${request_id}/delivery/checks`, { by, check_id: `${ticket}#1`, mark: "problem", note: "n" });
      expect(r.status).toBe(by === "system" ? 400 : 403);
    }
    expect(ticketRow(ticket).status).toBe("done");
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE request_id = ?").get(request_id))).toEqual({ n: 0 });
  });

  test("an agent token gets 403, also when the body names the human or has no sender", async () => {
    const { request_id, ticket } = await delivered();
    const path = `/requests/${ROOM}/${request_id}/delivery/checks`;
    for (const body of [{ by: hub.humanName }, {}, { by: "dc-lead" }]) {
      const r = await authedFetch(hub, path, {
        method: "POST",
        headers: { Authorization: `Bearer ${hub.token}` },
        body: JSON.stringify({ ...body, check_id: `${ticket}#1`, mark: "problem", note: "n" }),
      });
      expect(r.status).toBe(403);
    }
    expect(ticketRow(ticket).status).toBe("done");
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE request_id = ?").get(request_id))).toEqual({ n: 0 });
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "works" })).status).toBe(200);
  });

  test("a problem mark with an empty note gets 400, a bad mark, check or file gets 400, an unknown check gets 404", async () => {
    const { request_id, ticket } = await delivered();
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "" })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "  " })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "problem" })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "maybe", note: "n" })).status).toBe(400);
    expect((await mark(request_id, { check_id: "nope", mark: "works" })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "works", attachment_ids: ["nofile.png"] })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "works", attachment_ids: ["../x.png"] })).status).toBe(400);
    expect((await mark(request_id, { check_id: `${ticket}#3`, mark: "works" })).status).toBe(404);
    expect((await mark(request_id, { check_id: "t_0000000000000000#1", mark: "works" })).status).toBe(404);
    expect((await postJson(hub, `/requests/${ROOM}/dc-nope/delivery/checks`, { by: hub.humanName, check_id: `${ticket}#1`, mark: "works" })).status).toBe(404);
    expect(ticketRow(ticket).status).toBe("done");
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE request_id = ?").get(request_id))).toEqual({ n: 0 });
  });

  test("a second mark for the same check replaces the first with a new event", async () => {
    const { request_id, ticket } = await delivered();
    const a = await mark(request_id, { check_id: `${ticket}#1`, mark: "works", note: "ok" });
    const id = (a.json as any).snapshot.id;
    const b = await mark(request_id, { check_id: `${ticket}#1`, mark: "works", note: "still ok" });
    expect(b.status).toBe(200);
    expect((b.json as any).snapshot.id).toBe(id);
    expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks WHERE request_id = ?").get(request_id))).toEqual({ n: 1 });
    expect(events(id, "delivery_check.marked")).toHaveLength(2);
    const rep = (await getJson(hub, `/requests/${ROOM}/${request_id}/delivery`)).json as any;
    expect(rep.checks.marks.find((m: any) => m.check_id === `${ticket}#1`)).toMatchObject({ mark: "works", note: "still ok" });
    // works -> problem replaces too, and reopens the ticket.
    const c = await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "broke later" });
    expect(c.status).toBe(200);
    expect(events(id, "delivery_check.marked")).toHaveLength(3);
    expect((c.json as any).snapshot.status).toBe("problem");
    expect(ticketRow(ticket).status).toBe("queued");
  });

  test("a problem mark on a ticket that is already reopened adds the note and does not move it again", async () => {
    const { request_id, ticket } = await delivered();
    await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "one" });
    const r = await mark(request_id, { check_id: `${ticket}#2`, mark: "problem", note: "two" });
    expect(r.status).toBe(200);
    expect((r.json as any).reopened).toBe(false);
    expect(((await getJson(hub, `/tickets/${ticket}/notes`)).json as any[]).map((x) => x.text.includes("two") || x.text.includes("one"))).toEqual([true, true]);
    expect(events(ticket, "ticket.queued")).toHaveLength(1);
    // A works mark needs a done ticket; a cancelled ticket takes no mark.
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "works" })).status).toBe(409);
    sql((db) => void db.run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", [ticket]));
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "three" })).status).toBe(409);
  });

  test("a problem mark needs new work: old Worker and Validator stages do not carry over", async () => {
    const { request_id, ticket } = await delivered();
    const old = sql((db) => {
      db.run("UPDATE tickets SET role = 'worker' WHERE id = ?", [ticket]);
      const base = db.query<{ m: number }, []>("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get()!.m;
      const ins = (id: string, role: string, verdict: string | null, seq: number) =>
        db.run(
          "INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, session, slot_seq, created_seq, updated_seq, version) VALUES (?, ?, NULL, NULL, ?, ?, 1, 'passed', ?, NULL, ?, ?, ?)",
          [id, ticket, verdict, role, `${role}-old`, seq, seq, seq],
        );
      ins("s_00000000000000d1", "worker", null, base);
      ins("s_00000000000000d2", "validator", "PASS", base + 1);
      ins("s_00000000000000d3", "validator", "PASS", base + 2);
      return base + 2;
    });
    const passes = async () => ((await getJson(hub, `/tickets?room=${ROOM}&status=all`)).json as any[]).find((t) => t.id === ticket).validator_passes;
    expect(await passes()).toBe(2);
    expect((await mark(request_id, { check_id: `${ticket}#1`, mark: "problem", note: "broken" })).status).toBe(200);
    const fresh = sql((db) => db.query<{ role: string; status: string }, [string, number]>("SELECT role, status FROM stage WHERE ticket_id = ? AND created_seq > ?").all(ticket, old));
    expect(fresh.filter((s) => s.role === "worker")).toHaveLength(1);
    expect(await passes()).toBe(0);
  });

  test("an old ledger without the delivery_checks table opens without loss", async () => {
    const h = await spawnHub();
    try {
      const c = await registerAgent(h, "dc-lead", { room: ROOM });
      await postJson(h, "/requests", { by: "dc-lead", request_id: "dc-old" });
      const t = await postJson(h, "/tickets", { by: "dc-lead", title: "Old", acceptance_criteria: CRITERIA, blast_radius: "low", request_id: "dc-old", status: "draft" });
      const ticket = (t.json as any).snapshot.id as string;
      c.close();
      await h.kill();
      // The ledger of a hub before H3: no delivery_checks table.
      const before = sql((db) => {
        db.exec("DROP TABLE delivery_checks");
        return { tickets: db.query("SELECT COUNT(*) AS n FROM tickets").get(), events: db.query("SELECT COUNT(*) AS n FROM events").get(), requests: db.query("SELECT COUNT(*) AS n FROM requests").get() };
      }, h);
      const h2 = await spawnHub({ restartOf: h });
      try {
        const after = sql((db) => ({ tickets: db.query("SELECT COUNT(*) AS n FROM tickets").get(), events: db.query("SELECT COUNT(*) AS n FROM events").get(), requests: db.query("SELECT COUNT(*) AS n FROM requests").get() }), h2);
        expect(after).toEqual(before);
        expect(sql((db) => db.query("SELECT COUNT(*) AS n FROM delivery_checks").get(), h2)).toEqual({ n: 0 });
        expect(((await getJson(h2, `/tickets/${ticket}/notes`)).json as any[])).toEqual([]);
        // The restarted hub takes a mark.
        sql((db) => void db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [ticket]), h2);
        const r = await postJson(h2, `/requests/${ROOM}/dc-old/delivery/checks`, { by: h2.humanName, check_id: `${ticket}#1`, mark: "works" });
        expect(r.status).toBe(200);
      } finally {
        await h2.kill();
      }
    } finally {
      await h.kill().catch(() => {});
    }
  });
});
