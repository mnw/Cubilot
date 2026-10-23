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
