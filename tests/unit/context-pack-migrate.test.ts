import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";

const schema = (d: Database) =>
  d.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => r.sql);
const columns = (d: Database, t: string) =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const version = (d: Database) =>
  Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value);
// The hub's order: openLedger (versioned steps), then each kind's migrate.
const open = (path: string, snaps: string) => {
  const r = openLedger(path, snaps);
  if (r.db) createTicketKind(r.db).migrate(r.db);
  return r;
};
// A ledger one version behind: no stage_metrics, no tickets.planning_note, schema_version 16.
function oldLedger(path: string, snaps: string) {
  const db = open(path, snaps).db!;
  db.exec(`DROP TABLE stage_metrics; ALTER TABLE tickets DROP COLUMN planning_note;`);
  db.run("UPDATE meta SET value='16' WHERE key='schema_version'");
  db.run(`INSERT INTO tickets (id,room,title,acceptance_criteria,blast_radius,priority,creator,status,created_at_ms,updated_at_ms,version)
          VALUES ('t_1','r','T','c','low',3,'a','queued',1,1,1)`);
  db.close();
}

describe("context-pack migration (1.1)", () => {
  test("a fresh ledger gets the table and the column; a second run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-"));
    const path = join(dir, "ledger.db");
    const db = open(path, join(dir, "snaps")).db!;
    expect(version(db)).toBe(LEDGER_SCHEMA_VERSION);
    expect(columns(db, "stage_metrics")).toEqual([
      "stage_id", "attempt", "role", "first_message_bytes", "first_message_tokens_est",
      "prompt_tokens_first", "cache_read_tokens", "tokens_before_action", "source", "created_seq",
    ]);
    expect(columns(db, "tickets")).toContain("planning_note");
    const first = schema(db);
    db.close();
    const again = open(path, join(dir, "snaps")).db!;
    expect(schema(again)).toEqual(first);
  });

  test("a current ledger with rows gains both, keeps its rows, and a second run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snaps");
    oldLedger(path, snaps);
    const once = open(path, snaps).db!;
    expect(columns(once, "stage_metrics")).toContain("tokens_before_action");
    expect(columns(once, "tickets")).toContain("planning_note");
    expect(once.query("SELECT planning_note FROM tickets WHERE id='t_1'").get()).toEqual({ planning_note: null });
    expect(readdirSync(snaps).filter((f) => /-16to\d+\.db$/.test(f))).toHaveLength(1);
    const first = schema(once);
    once.close();
    const twice = open(path, snaps).db!;
    expect(schema(twice)).toEqual(first);
  });

  test("the stage_metrics primary key is (stage_id, attempt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-"));
    const db = open(join(dir, "ledger.db"), join(dir, "snaps")).db!;
    const ins = (s: string, a: number) =>
      db.run("INSERT INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, source, created_seq) VALUES (?,?,?,?,?,?,?)", [s, a, "worker", 4, 1, "none", 1]);
    ins("s_1", 1);
    ins("s_1", 2);
    expect(() => ins("s_1", 1)).toThrow();
  });

  test("a forced snapshot failure leaves the schema unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snaps");
    oldLedger(path, snaps);
    mkdirSync(snaps);
    chmodSync(snaps, 0o500); // the folder exists: only the copy fails
    try {
      expect(open(path, snaps).enabled).toBe(false);
    } finally {
      chmodSync(snaps, 0o700);
    }
    const db = new Database(path);
    expect(version(db)).toBe(16);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='stage_metrics'").get()).toBeNull();
    expect(columns(db, "tickets")).not.toContain("planning_note");
  });
});
