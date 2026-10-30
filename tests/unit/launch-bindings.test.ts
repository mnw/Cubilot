import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../hub/core/ledger";
import { buildKinds } from "../../hub/kinds";
import { createLaunchRecord, loadLaunchBindings } from "../../hub/core/launch-record";

const cols = (db: Database) => db.query<{ name: string }, []>("PRAGMA table_info(stage)").all().map((c) => c.name);
const migrate = (db: Database) => buildKinds(db).find((k) => k.kind === "stage")!.migrate(db);

describe("stage session bindings in the ledger", () => {
  test("only an unreleased session of a launching, running or retrying stage is bound", () => {
    const db = new Database(":memory:");
    migrate(db);
    const ins = db.prepare("INSERT INTO stage (id, role, attempt, status, session, session_released_at_ms) VALUES (?, 'worker', 1, ?, ?, ?)");
    ins.run("s_1", "launching", "worker-1", null);
    ins.run("s_2", "running", "worker-2", null);
    ins.run("s_3", "retrying", "worker-3", null);
    ins.run("s_4", "retrying", "worker-4", 5);
    ins.run("s_5", "passed", "worker-5", null);
    ins.run("s_6", "queued", null, null);
    const rec = createLaunchRecord(loadLaunchBindings(db));
    expect([...rec.sessions()].sort()).toEqual(["worker-1", "worker-2", "worker-3"]);
  });

  test("migration adds the nullable columns, twice gives the same schema, old rows get a release time", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE stage (id TEXT PRIMARY KEY, ticket_id TEXT, request_id TEXT, review TEXT, verdict TEXT, role TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, session TEXT, slot_seq INTEGER, version INTEGER NOT NULL DEFAULT 0)`);
    db.run("INSERT INTO stage (id, role, attempt, status, session) VALUES ('s_old', 'worker', 1, 'running', 'worker-1')");
    const before = cols(db);
    migrate(db);
    const once = cols(db);
    expect(once.filter((c) => !before.includes(c))).toEqual(["session_released_at_ms", "start_commit"]);
    const stamp = db.query<{ v: number | null }, []>("SELECT session_released_at_ms AS v FROM stage WHERE id = 's_old'").get()!.v;
    expect(stamp).not.toBeNull();
    db.run("INSERT INTO stage (id, role, attempt, status, session) VALUES ('s_new', 'worker', 1, 'running', 'worker-2')");
    migrate(db);
    expect(cols(db)).toEqual(once);
    expect(db.query<{ v: number | null }, []>("SELECT session_released_at_ms AS v FROM stage WHERE id = 's_old'").get()!.v).toBe(stamp);
    expect(db.query<{ v: number | null }, []>("SELECT session_released_at_ms AS v FROM stage WHERE id = 's_new'").get()!.v).toBeNull();
    expect([...loadLaunchBindings(db)]).toEqual([["worker-2", "s_new"]]);
  });

  test("a version-18 ledger is copied before the column is added; the copy has the old schema; a second start changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-rel-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snapshots");
    const seed = openLedger(path, join(dir, "unused")).db!;
    const kinds = buildKinds(seed);
    for (const k of kinds) k.migrate(seed);
    seed.exec("ALTER TABLE stage DROP COLUMN session_released_at_ms");
    seed.run("UPDATE meta SET value='18' WHERE key='schema_version'");
    seed.close();

    const db = openLedger(path, snaps).db!;
    const files = readdirSync(snaps);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/18to20\.db$/);
    const snap = new Database(join(snaps, files[0]));
    expect(cols(snap)).not.toContain("session_released_at_ms");
    snap.close();
    expect(cols(db)).not.toContain("session_released_at_ms"); // the kind migrate adds it, after the copy
    for (const k of buildKinds(db)) k.migrate(db);
    expect(cols(db)).toContain("session_released_at_ms");
    const first = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    db.close();

    const again = openLedger(path, snaps).db!;
    for (const k of buildKinds(again)) k.migrate(again);
    expect(readdirSync(snaps)).toHaveLength(1);
    expect(again.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).toEqual(first);
  });
});
