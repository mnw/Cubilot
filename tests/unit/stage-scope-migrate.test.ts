import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, migrateLedger, openLedger } from "../../hub/core/ledger";

const schema = (d: Database) =>
  d.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((r) => r.sql);
const columns = (d: Database, t: string) =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const version = (d: Database) =>
  Number(d.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value);

// The lookup the waiting-for-approval query starts with: the latest spec stage of one request.
const LATEST_SPEC_STAGE = "SELECT id, verdict FROM stage WHERE request_id = ? AND review = 'spec' ORDER BY created_seq DESC LIMIT 1";

// A ledger as v14 left it: no stage_scope, no stage index.
function downgradeToV14(d: Database) {
  d.exec("DROP TABLE stage_scope; DROP INDEX idx_stage_request_review");
  d.run("UPDATE meta SET value='14' WHERE key='schema_version'");
}

describe("spec-review-stage migration (1.1)", () => {
  test("a fresh ledger gets stage_scope and the index; a second run changes nothing", () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    const first = schema(d);
    expect(LEDGER_SCHEMA_VERSION).toBe(LEDGER_SCHEMA_VERSION);
    expect(version(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(columns(d, "stage_scope")).toEqual(["stage_id", "ticket_id"]);
    expect(first.some((s) => s.includes("idx_stage_request_review"))).toBe(true);
    migrateLedger(d);
    expect(schema(d)).toEqual(first);
  });

  test("a v14 ledger keeps its rows and ends with the same schema as a fresh one", () => {
    const fresh = new Database(":memory:");
    migrateLedger(fresh);
    const d = new Database(":memory:");
    migrateLedger(d);
    d.run("INSERT INTO stage (id, request_id, review, role, status) VALUES ('s1', 'r1', 'spec', 'validator', 'queued')");
    downgradeToV14(d);
    migrateLedger(d);
    expect(version(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(schema(d)).toEqual(schema(fresh));
    expect(d.query("SELECT id FROM stage").all()).toEqual([{ id: "s1" }]);
    const once = schema(d);
    migrateLedger(d);
    expect(schema(d)).toEqual(once);
  });

  test("stage_scope refuses a duplicate (stage, ticket) pair", () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    d.run("INSERT INTO stage_scope VALUES ('s1', 't1')");
    d.run("INSERT INTO stage_scope VALUES ('s1', 't2')");
    expect(() => d.run("INSERT INTO stage_scope VALUES ('s1', 't1')")).toThrow();
  });

  test("EXPLAIN QUERY PLAN of the per-request spec-stage lookup uses the index", () => {
    const d = new Database(":memory:");
    migrateLedger(d);
    const plan = d.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${LATEST_SPEC_STAGE}`).all("r1");
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_stage_request_review");
  });

  test("a v14 ledger gets a 14-to-current snapshot before stage_scope exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-snap-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    const seed = openLedger(path, join(dir, "unused")).db!;
    downgradeToV14(seed);
    seed.close();
    const r = openLedger(path, snaps);
    expect(r.enabled).toBe(true);
    expect(version(r.db!)).toBe(LEDGER_SCHEMA_VERSION);
    const files = readdirSync(snaps);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`-14to${LEDGER_SCHEMA_VERSION}\\.db$`));
    const snap = new Database(join(snaps, files[0]));
    expect(version(snap)).toBe(14);
    expect(snap.query("SELECT 1 FROM sqlite_master WHERE name='stage_scope'").get()).toBeNull();
  });
});
