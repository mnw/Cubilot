import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTicketKind } from "../../hub/kinds/ticket";

const schema = (d: Database) =>
  d.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => r.sql);
const columns = (d: Database, t: string) =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);

describe("ticket migrate: request_id and ticket_blockers", () => {
  test("a fresh ledger gets both, and a second run changes nothing", () => {
    const d = new Database(":memory:");
    const kind = createTicketKind(d);
    kind.migrate(d);
    const first = schema(d);
    expect(columns(d, "tickets")).toContain("request_id");
    expect(columns(d, "ticket_blockers")).toEqual(["ticket_id", "blocker_id"]);
    expect(first.some((s) => s.includes("idx_ticket_blockers_blocker"))).toBe(true);
    kind.migrate(d);
    expect(schema(d)).toEqual(first);
  });

  test("an existing ledger with rows keeps them and gains the column", () => {
    const d = new Database(":memory:");
    const kind = createTicketKind(d);
    kind.migrate(d);
    // Rebuild the table as an older ledger had it: no request_id.
    d.exec(`ALTER TABLE "tickets" DROP COLUMN "request_id"`);
    d.exec(`DROP TABLE "ticket_blockers"`);
    d.exec(`INSERT INTO "tickets" ("id","room","title","acceptance_criteria","blast_radius","priority","creator","status","created_at_ms","updated_at_ms","version")
            VALUES ('t_1','r','T','c','low','medium','a','queued',1,1,1)`);
    kind.migrate(d);
    const once = schema(d);
    expect(columns(d, "tickets")).toContain("request_id");
    expect(d.query("SELECT request_id FROM tickets WHERE id='t_1'").get()).toEqual({ request_id: null });
    kind.migrate(d);
    expect(schema(d)).toEqual(once);
  });
});

import { migrateLedger } from "../../hub/core/ledger";
import { createRequestKind } from "../../hub/kinds/request";

describe("request migrate: one request for each request_id (plan-approval)", () => {
  const ledger = () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    createTicketKind(d).migrate(d);
    return d;
  };
  const ticket = (d: Database, id: string, status: string, over: { request?: string | null; room?: string; radius?: string } = {}) =>
    d.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', ?, 3, 'a', ?, ?, 1, 1, 1)`,
      [id, over.room ?? "r", over.radius ?? "low", status, over.request === undefined ? "r-0" : over.request],
    );
  const requests = (d: Database) => d.query<any, []>("SELECT * FROM requests ORDER BY room, request_id").all();
  const events = (d: Database) => d.query<{ kind: string; actor: string }, []>("SELECT kind, actor FROM events WHERE kind LIKE 'request.%' ORDER BY seq").all();

  test("a fresh ledger gets the table and a second run changes nothing", () => {
    const d = ledger();
    const kind = createRequestKind(d);
    kind.migrate(d);
    const first = schema(d);
    expect(columns(d, "requests")).toEqual(["id", "room", "request_id", "origin", "features", "parent_request_id", "source", "approved", "status", "created_by", "created_at_ms", "version"]);
    expect(first.some((s) => s.includes("idx_requests_room_request"))).toBe(true);
    kind.migrate(d);
    expect(schema(d)).toEqual(first);
    expect(requests(d)).toEqual([]);
  });

  test("Request in progress: r-0 has an in_progress ticket: origin human, no features, an Approve by system, scope not changed", async () => {
    const d = ledger();
    ticket(d, "t_1", "in_progress", { radius: "high" });
    ticket(d, "t_2", "draft");
    ticket(d, "t_3", "cancelled");
    const kind = createRequestKind(d);
    kind.migrate(d);
    const [r] = requests(d);
    expect(r).toMatchObject({ room: "r", request_id: "r-0", origin: "human", features: "[]", status: "approved", created_by: "system" });
    expect(JSON.parse(r.approved)).toEqual({ features: [], tickets: [{ id: "t_1", radius: "high" }, { id: "t_2", radius: "low" }] });
    expect(events(d)).toEqual([{ kind: "request.created", actor: "system" }, { kind: "request.approved", actor: "system" }]);
    const { scopeChange, heldForApprove } = await import("../../hub/kinds/request");
    expect(scopeChange(d, "r", "r-0")).toMatchObject({ changed: false, approved: true });
    expect(heldForApprove(d, "r", "r-0")).toBe(false);
  });

  test("a request whose tickets are all draft (or cancelled and draft) gets a request and no Approve", () => {
    const d = ledger();
    ticket(d, "t_1", "draft", { request: "r-d" });
    ticket(d, "t_2", "draft", { request: "r-d" });
    createRequestKind(d).migrate(d);
    expect(requests(d)).toHaveLength(1);
    expect(requests(d)[0]).toMatchObject({ request_id: "r-d", status: "open", approved: null });
    expect(events(d)).toEqual([{ kind: "request.created", actor: "system" }]);
  });

  test("the same label in two rooms gives two requests; a ticket without request_id gives none", () => {
    const d = ledger();
    ticket(d, "t_1", "queued", { room: "a" });
    ticket(d, "t_2", "queued", { room: "b" });
    ticket(d, "t_3", "queued", { request: null });
    createRequestKind(d).migrate(d);
    expect(requests(d).map((r) => `${r.room}/${r.request_id}`)).toEqual(["a/r-0", "b/r-0"]);
  });

  test("twice gives the same rows, the same events and the same schema; a request made later is not approved by a second run", () => {
    const d = ledger();
    ticket(d, "t_1", "in_progress");
    const kind = createRequestKind(d);
    kind.migrate(d);
    const rows = requests(d);
    const ev = events(d);
    const sch = schema(d);
    // A request created through the hub after the first run, with a started ticket (e.g. queued by the human): left alone.
    d.run(`INSERT INTO requests (id, room, request_id, origin, features, status, created_by, created_at_ms, version) VALUES ('rq_x', 'r', 'r-new', 'human', '[]', 'open', 'alice', 1, 1)`);
    ticket(d, "t_9", "in_progress", { request: "r-new" });
    kind.migrate(d);
    expect(requests(d).filter((r) => r.request_id === "r-0")).toEqual(rows);
    expect(requests(d).find((r) => r.request_id === "r-new")).toMatchObject({ status: "open", approved: null });
    expect(events(d)).toEqual(ev);
    expect(schema(d)).toEqual(sch);
  });
});
