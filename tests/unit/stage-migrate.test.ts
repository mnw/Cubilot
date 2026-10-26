import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, migrateLedger, openLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";

const schema = (d: Database) =>
  d.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => r.sql);
// A fresh ledger creates `tickets` from the kind's column list; an older one gains `role` through ALTER, at the end.
// The tables are the same except for column order, so compare that table by its sorted columns.
const schemaNoTicketOrder = (d: Database) =>
  schema(d).map((sql) => {
    const m = sql.match(/^CREATE TABLE "?(tickets|room_settings)"?/);
    return m ? `${m[1]}(${columns(d, m[1]).sort().join(",")})` : sql;
  });
const columns = (d: Database, t: string) =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const version = (d: Database) =>
  Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value);

function migrate(d: Database) {
  migrateLedger(d);
  createTicketKind(d).migrate(d);
}

const insertStage = (d: Database, f: { ticket_id?: string | null; request_id?: string | null; review?: string | null }) =>
  d.run(
    `INSERT INTO stage (id, ticket_id, request_id, review, role, status)
     VALUES (?, ?, ?, ?, 'validator', 'queued')`,
    [`s_${Math.random()}`, f.ticket_id ?? null, f.request_id ?? null, f.review ?? null],
  );

describe("stage-sessions migration (1.2)", () => {
  test("a fresh ledger gets the columns and the stage table; a second run changes nothing", () => {
    const d = new Database(":memory:");
    migrate(d);
    const first = schema(d);
    expect(version(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(columns(d, "tickets")).toContain("role");
    expect(columns(d, "room_settings")).toEqual(expect.arrayContaining(["role_limits", "stage_timeout_min"]));
    expect(columns(d, "stage")).toEqual([
      "id", "ticket_id", "request_id", "review", "verdict", "role", "attempt", "status", "session", "slot_seq", "created_seq", "updated_seq", "version",
    ]);
    migrate(d);
    expect(schema(d)).toEqual(first);
  });

  test("a ledger from before v14 keeps its rows and ends with the same schema as a fresh one", () => {
    const fresh = new Database(":memory:");
    migrate(fresh);

    const d = new Database(":memory:");
    migrate(d);
    d.run("INSERT INTO room_settings (room, updated_at) VALUES ('keep', 1)");
    d.exec(`ALTER TABLE "tickets" DROP COLUMN "role"`);
    d.exec("ALTER TABLE room_settings DROP COLUMN role_limits; ALTER TABLE room_settings DROP COLUMN stage_timeout_min;");
    d.exec("DROP TABLE stage");
    d.run("UPDATE meta SET value='13' WHERE key='schema_version'");
    migrate(d);
    expect(version(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(d.query("SELECT role_limits, stage_timeout_min FROM room_settings WHERE room='keep'").get()).toEqual({
      role_limits: null,
      stage_timeout_min: null,
    });
    expect(schemaNoTicketOrder(d)).toEqual(schemaNoTicketOrder(fresh));
    const once = schema(d);
    migrate(d);
    expect(schema(d)).toEqual(once);
  });

  test("stage checks: a spec row needs request_id; a ticket row needs ticket_id; a spec row may have no ticket_id", () => {
    const d = new Database(":memory:");
    migrate(d);
    expect(() => insertStage(d, { review: "spec" })).toThrow();
    expect(() => insertStage(d, { review: null, ticket_id: null })).toThrow();
    insertStage(d, { review: "spec", request_id: "r1", ticket_id: null });
    insertStage(d, { review: null, ticket_id: "t_1" });
    expect(d.query("SELECT COUNT(*) AS n FROM stage").get()).toEqual({ n: 2 });
  });

  test("a ledger at version 13 gets a 13to<current> snapshot before the new columns and the stage table exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-snap-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    const seed = openLedger(path, join(dir, "unused")).db!;
    seed.exec("ALTER TABLE room_settings DROP COLUMN role_limits; ALTER TABLE room_settings DROP COLUMN stage_timeout_min;");
    seed.exec("DROP TABLE stage");
    seed.run("UPDATE meta SET value='13' WHERE key='schema_version'");
    seed.close();

    const r = openLedger(path, snaps);
    expect(r.enabled).toBe(true);
    expect(version(r.db!)).toBe(LEDGER_SCHEMA_VERSION);
    const files = readdirSync(snaps);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^ledger-\\d{8}T\\d{6}Z-13to${LEDGER_SCHEMA_VERSION}\\.db$`));
    const snap = new Database(join(snaps, files[0]));
    expect(version(snap)).toBe(13);
    expect(columns(snap, "room_settings")).not.toContain("role_limits");
    expect(columns(snap, "room_settings")).not.toContain("stage_timeout_min");
    expect(snap.query("SELECT 1 FROM sqlite_master WHERE name='stage'").get()).toBeNull();
    expect(columns(r.db!, "stage")).toContain("review");
  });
});
