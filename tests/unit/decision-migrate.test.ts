import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createDecisionKind } from "../../hub/kinds/decision";

const version = (d: Database) =>
  Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value);
const hasTable = (d: Database) => !!d.query("SELECT 1 FROM sqlite_master WHERE name='decisions'").get();
const schema = (d: Database) =>
  d.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => r.sql);

describe("decisions migration (P6-01)", () => {
  test("a version-17 ledger gets a snapshot first, then the decisions table; a second run changes nothing", () => {
    expect(LEDGER_SCHEMA_VERSION).toBe(19);
    const dir = mkdtempSync(join(tmpdir(), "dec-mig-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    const seed = openLedger(path, join(dir, "unused")).db!;
    createTicketKind(seed).migrate(seed);
    createDecisionKind(seed).migrate(seed);
    seed.exec("DROP TABLE decisions");
    seed.run("UPDATE meta SET value='17' WHERE key='schema_version'");
    seed.close();

    const r = openLedger(path, snaps);
    expect(r.enabled).toBe(true);
    const db = r.db!;
    expect(version(db)).toBe(LEDGER_SCHEMA_VERSION);
    const files = readdirSync(snaps);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^ledger-\d{8}T\d{6}Z-17to19\.db$/);
    const snap = new Database(join(snaps, files[0]));
    expect(version(snap)).toBe(17);
    expect(hasTable(snap)).toBe(false); // the copy is from before the new table
    createTicketKind(db).migrate(db);
    createDecisionKind(db).migrate(db);
    expect(hasTable(db)).toBe(true);
    const first = schema(db);
    createDecisionKind(db).migrate(db);
    db.close();
    const again = openLedger(path, snaps);
    expect(readdirSync(snaps)).toHaveLength(1); // no second snapshot
    expect(schema(again.db!)).toEqual(first);
  });
});
