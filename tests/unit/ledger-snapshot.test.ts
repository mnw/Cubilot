import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../hub/core/ledger";

const columns = (d: Database, t: string) =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const version = (d: Database) =>
  Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value);

// A ledger one version behind: v13 columns dropped, schema_version back at 12.
function oldLedger(path: string) {
  const r = openLedger(path, join(path, "..", "unused"));
  const db = r.db!;
  db.exec("ALTER TABLE room_settings DROP COLUMN worker_limit; ALTER TABLE room_settings DROP COLUMN tester_limit;");
  db.run("UPDATE meta SET value='12' WHERE key='schema_version'");
  db.run("INSERT INTO room_settings (room, updated_at) VALUES ('keep', 1)");
  db.close();
}

describe("ledger snapshot before migration", () => {
  test("snapshot exists, is 0600 and holds the old schema; then the schema migrates", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    oldLedger(path);
    const r = openLedger(path, snaps);
    expect(r.enabled).toBe(true);
    expect(version(r.db!)).toBe(LEDGER_SCHEMA_VERSION);
    const files = readdirSync(snaps);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^ledger-\\d{8}T\\d{6}Z-12to${LEDGER_SCHEMA_VERSION}\\.db$`));
    expect(statSync(join(snaps, files[0])).mode & 0o777).toBe(0o600);
    const snap = new Database(join(snaps, files[0]));
    expect(version(snap)).toBe(12);
    expect(columns(snap, "room_settings")).not.toContain("worker_limit");
    expect(snap.query("SELECT room FROM room_settings WHERE room='keep'").get()).toBeTruthy();
  });

  test("a failed copy leaves the schema unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const path = join(dir, "ledger.db");
    const blocked = join(dir, "snapshots");
    writeFileSync(blocked, "not a directory");
    oldLedger(path);
    const r = openLedger(path, blocked);
    expect(r.enabled).toBe(false);
    const db = new Database(path);
    expect(version(db)).toBe(12);
    expect(columns(db, "room_settings")).not.toContain("worker_limit");
  });

  test("a copy failure leaves the schema unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    oldLedger(path);
    mkdirSync(snaps);
    chmodSync(snaps, 0o500); // directory exists, so only the copy step fails
    try {
      const r = openLedger(path, snaps);
      expect(r.enabled).toBe(false);
    } finally {
      chmodSync(snaps, 0o700);
    }
    const db = new Database(path);
    expect(version(db)).toBe(12);
    expect(columns(db, "room_settings")).not.toContain("worker_limit");
    expect(readdirSync(snaps)).toEqual([]);
  });

  test("the snapshot holds rows that are only in the WAL, with a reader open", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    oldLedger(path);
    const writer = new Database(path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    const reader = new Database(path, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM room_settings").get(); // read mark taken before the writes below
    for (let i = 0; i < 50; i++) writer.run("INSERT INTO room_settings (room, updated_at) VALUES (?, 1)", [`wal-${i}`]);
    // the reader pins the WAL: a TRUNCATE checkpoint is busy and a plain file copy would miss these rows
    const r = openLedger(path, snaps);
    expect(r.enabled).toBe(true);
    const snap = new Database(join(snaps, readdirSync(snaps)[0]));
    expect(snap.query("SELECT count(*) AS n FROM room_settings WHERE room LIKE 'wal-%'").get()).toEqual({ n: 50 });
    reader.exec("COMMIT");
  });

  test("a fresh ledger and a current ledger write no snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const path = join(dir, "ledger.db");
    openLedger(path, join(dir, "snapshots")).db!.close();
    openLedger(path, join(dir, "snapshots")).db!.close();
    expect(() => readdirSync(join(dir, "snapshots"))).toThrow();
  });
});
