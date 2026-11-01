import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LEDGER_SCHEMA_VERSION, migrateLedger } from "../../hub/core/ledger";
import { createInterruptKind } from "../../hub/kinds/interrupt";

const columns = (d: Database) => d.query<{ name: string }, []>("PRAGMA table_info(interrupts)").all().map((c) => c.name);

describe("v20: interrupts.ticket_id and interrupts.stage_id", () => {
  test("a v19 ledger keeps its interrupts rows; the new columns are null", () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    // A ledger as v19 left it: no ticket_id, no stage_id, no index.
    d.exec("DROP INDEX idx_interrupts_ticket; ALTER TABLE interrupts DROP COLUMN ticket_id; ALTER TABLE interrupts DROP COLUMN stage_id");
    d.run("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
    d.run("INSERT INTO interrupts (id, from_agent, to_agent, text, status, created_at_ms, room, version) VALUES ('i_old1', 'a', 'b', 'stop', 'pending', 1, 'r1', 5)");
    d.run("INSERT INTO interrupts (id, from_agent, to_agent, text, status, created_at_ms, acknowledged_at_ms, acknowledged_by, room, version) VALUES ('i_old2', 'a', 'b', 'x', 'acknowledged', 2, 3, 'b', 'r1', 6)");
    expect(columns(d)).not.toContain("ticket_id");

    migrateLedger(d);

    expect(Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value)).toBe(LEDGER_SCHEMA_VERSION);
    expect(columns(d)).toEqual(expect.arrayContaining(["ticket_id", "stage_id"]));
    const kind = createInterruptKind(d);
    kind.migrate(d);
    const rows = d.query<Record<string, unknown>, []>("SELECT id, status, ticket_id, stage_id FROM interrupts ORDER BY id").all();
    expect(rows).toEqual([
      { id: "i_old1", status: "pending", ticket_id: null, stage_id: null },
      { id: "i_old2", status: "acknowledged", ticket_id: null, stage_id: null },
    ]);
  });

  test("a second run changes nothing", () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    const before = d.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    migrateLedger(d);
    expect(d.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });
});
