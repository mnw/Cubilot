// ledger.ts — SQLite ledger + versioned migrations. Frozen append-only history; never edit prior.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomId } from "./ids";

export const LEDGER_SCHEMA_VERSION = 16;

export type LedgerOpenResult =
  | { db: Database; enabled: true }
  | { db: null; enabled: false };

/**
 * Copies the ledger to `<snapshotDir>/ledger-<utc>-<from>to<to>.db` (mode 0600) before a
 * schema migration. Throws on any failure: the caller must not migrate without the copy.
 */
export function snapshotLedger(db: Database, path: string, from: number, to: number, snapshotDir: string): string {
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  const utc = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dest = join(snapshotDir, `ledger-${utc}-${from}to${to}.db`);
  const tmp = `${dest}.tmp`;
  // VACUUM INTO reads one consistent snapshot, WAL rows included, even with open readers.
  db.run("VACUUM INTO ?", [tmp]);
  chmodSync(tmp, 0o600);
  renameSync(tmp, dest);
  return dest;
}

export function openLedger(path: string, snapshotDir: string = join(dirname(path), "snapshots")): LedgerOpenResult {
  if (!path) return { db: null, enabled: false };
  try {
    const db = new Database(path, { create: true });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      console.error(`[ledger] chmod 0600 on ${path} failed:`, e);
    }
    // A new ledger (no schema_version yet) has nothing to lose; an existing one is copied first.
    const from = storedSchemaVersion(db);
    if (from > 0 && from < LEDGER_SCHEMA_VERSION) {
      const dest = snapshotLedger(db, path, from, LEDGER_SCHEMA_VERSION, snapshotDir);
      console.log(`[ledger] snapshot ${dest}`);
    }
    migrateLedger(db);
    // -wal/-shm are created with umask default; tighten to 0600.
    for (const suffix of ["-wal", "-shm"]) {
      const sidePath = `${path}${suffix}`;
      try {
        chmodSync(sidePath, 0o600);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          console.error(`[ledger] chmod 0600 on ${sidePath} failed:`, e);
        }
      }
    }
    console.log(`[ledger] ready at ${path}`);
    return { db, enabled: true };
  } catch (e) {
    console.error(`[ledger] open failed, protocol routes disabled:`, e);
    return { db: null, enabled: false };
  }
}

function storedSchemaVersion(db: Database): number {
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return 0;
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

export function migrateLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  const current = row ? Number(row.value) : 0;
  if (current > LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `ledger schema_version=${current} is newer than this binary (${LEDGER_SCHEMA_VERSION}); refusing to downgrade`,
    );
  }
  if (current < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE events (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          handoff_id   TEXT    NOT NULL,
          kind         TEXT    NOT NULL,
          actor        TEXT    NOT NULL,
          payload_json TEXT    NOT NULL,
          at_ms        INTEGER NOT NULL
        );
        CREATE INDEX idx_events_handoff ON events(handoff_id, seq);
        CREATE INDEX idx_events_actor   ON events(actor, at_ms);

        CREATE TABLE handoffs (
          id             TEXT PRIMARY KEY,
          from_agent     TEXT    NOT NULL,
          to_agent       TEXT    NOT NULL,
          task           TEXT    NOT NULL,
          context_json   TEXT,
          status         TEXT    NOT NULL
                          CHECK(status IN ('pending','accepted','declined','cancelled','expired')),
          decline_reason TEXT,
          comment        TEXT,
          cancel_reason  TEXT,
          cancelled_by   TEXT,
          created_at_ms  INTEGER NOT NULL,
          expires_at_ms  INTEGER NOT NULL,
          resolved_at_ms INTEGER
        );
        CREATE INDEX idx_handoffs_status  ON handoffs(status, expires_at_ms);
        CREATE INDEX idx_handoffs_to      ON handoffs(to_agent, status);
        CREATE INDEX idx_handoffs_from    ON handoffs(from_agent, status);
        CREATE INDEX idx_handoffs_created ON handoffs(created_at_ms);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')");
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('ledger_id', ?)", [
        randomId(16),
      ]);
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at_ms', ?)", [
        String(Date.now()),
      ]);
    })();
    console.log(`[ledger] applied migration v1`);
  }
  if (current < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE interrupts (
          id                TEXT PRIMARY KEY,
          from_agent        TEXT    NOT NULL,
          to_agent          TEXT    NOT NULL,
          text              TEXT    NOT NULL,
          status            TEXT    NOT NULL
                              CHECK(status IN ('pending','acknowledged')),
          created_at_ms     INTEGER NOT NULL,
          acknowledged_at_ms INTEGER,
          acknowledged_by   TEXT
        );
        CREATE INDEX idx_interrupts_status ON interrupts(status, created_at_ms);
        CREATE INDEX idx_interrupts_to     ON interrupts(to_agent, status);
        CREATE INDEX idx_interrupts_from   ON interrupts(from_agent, status);

        CREATE TABLE nutshell (
          id             INTEGER PRIMARY KEY CHECK(id = 0),
          text           TEXT    NOT NULL DEFAULT '',
          version        INTEGER NOT NULL DEFAULT 0,
          updated_at_ms  INTEGER NOT NULL,
          updated_by     TEXT
        );
      `);
      db.run(
        "INSERT OR IGNORE INTO nutshell (id, text, version, updated_at_ms, updated_by) VALUES (0, '', 0, ?, NULL)",
        [Date.now()],
      );
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
    })();
    console.log(`[ledger] applied migration v2`);
  }
  if (current < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE claude_sessions (
          agent          TEXT    NOT NULL,
          cwd            TEXT    NOT NULL,
          resume_flag    TEXT    NOT NULL,
          captured_at_ms INTEGER NOT NULL,
          PRIMARY KEY (agent, cwd)
        );
        CREATE INDEX idx_claude_sessions_agent ON claude_sessions(agent);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
    })();
    console.log(`[ledger] applied migration v3`);
  }
  if (current < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
    })();
    console.log(`[ledger] applied migration v4`);
  }
  if (current < 5) {
    // v5: add 'dismissed' to permissions.status (CHECK can't ALTER → copy-drop-rename).
    db.transaction(() => {
      db.exec(`
        CREATE TABLE permissions_new (
          id              TEXT PRIMARY KEY,
          agent           TEXT    NOT NULL,
          tool_name       TEXT    NOT NULL,
          description     TEXT    NOT NULL,
          input_preview   TEXT    NOT NULL,
          status          TEXT    NOT NULL
                            CHECK(status IN ('pending','allowed','denied','dismissed')),
          created_at_ms   INTEGER NOT NULL,
          resolved_at_ms  INTEGER,
          resolved_by     TEXT,
          behavior        TEXT CHECK(behavior IS NULL OR behavior IN ('allow','deny'))
        );
        INSERT INTO permissions_new SELECT * FROM permissions;
        DROP TABLE permissions;
        ALTER TABLE permissions_new RENAME TO permissions;
        CREATE INDEX idx_permissions_status ON permissions(status, created_at_ms);
        CREATE INDEX idx_permissions_agent  ON permissions(agent, status);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    })();
    console.log(`[ledger] applied migration v5`);
  }
  if (current < 6) {
    // v6: rooms. Add `room` to events/handoffs/interrupts/permissions; restructure nutshell to per-room.
    db.transaction(() => {
      db.exec(`
        ALTER TABLE events     ADD COLUMN room TEXT;
        ALTER TABLE handoffs   ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE interrupts ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE permissions ADD COLUMN room TEXT NOT NULL DEFAULT 'default';
        CREATE INDEX idx_handoffs_room   ON handoffs(room, status, created_at_ms DESC);
        CREATE INDEX idx_interrupts_room ON interrupts(room, status, created_at_ms DESC);
        CREATE INDEX idx_permissions_room ON permissions(room, status);

        CREATE TABLE nutshell_new (
          room          TEXT PRIMARY KEY,
          text          TEXT    NOT NULL DEFAULT '',
          version       INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL,
          updated_by    TEXT
        );
        INSERT INTO nutshell_new (room, text, version, updated_at_ms, updated_by)
          SELECT 'default', text, version, updated_at_ms, updated_by FROM nutshell WHERE id = 0;
        DROP TABLE nutshell;
        ALTER TABLE nutshell_new RENAME TO nutshell;
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')");
    })();
    console.log(`[ledger] applied migration v6`);
  }
  if (current < 7) {
    // v7: rename events.handoff_id → events.entity_id (carries any kind's id since v2).
    db.transaction(() => {
      db.exec(`
        ALTER TABLE events RENAME COLUMN handoff_id TO entity_id;
        DROP INDEX IF EXISTS idx_events_handoff;
        CREATE INDEX idx_events_entity ON events(entity_id, seq);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')");
    })();
    console.log(`[ledger] applied migration v7`);
  }
  if (current < 8) {
    // v8: per-room transcript persistence opt-in flag.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_settings (
          room                TEXT    PRIMARY KEY,
          persist_transcript  INTEGER NOT NULL DEFAULT 0,
          updated_at          INTEGER NOT NULL
        );
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')");
    })();
    console.log(`[ledger] applied migration v8`);
  }
  if (current < 9) {
    // v9: (formerly added scraper columns; reverted in v10)
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9')");
    console.log(`[ledger] applied migration v9`);
  }
  if (current < 10) {
    // v10: scraper feature pulled. Drop the v9 columns if they exist.
    // ALTER TABLE DROP COLUMN requires SQLite 3.35+ (Bun bundles a recent version).
    db.transaction(() => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(permissions)")
        .all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (names.has("snapshot_path")) {
        db.exec("ALTER TABLE permissions DROP COLUMN snapshot_path");
      }
      if (names.has("dismissed_by_scraper")) {
        db.exec("ALTER TABLE permissions DROP COLUMN dismissed_by_scraper");
      }
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10')");
    })();
    console.log(`[ledger] applied migration v10`);
  }
  if (current < 11) {
    // v11: room_summary table (Phase 3 — hierarchical L1/L2 summaries) +
    // room_summary_enabled column on room_settings (per-Room opt-in toggle).
    db.transaction(() => {
      db.exec(`
        ALTER TABLE room_settings ADD COLUMN room_summary_enabled INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE room_summary (
          room              TEXT    NOT NULL,
          level             INTEGER NOT NULL,                -- 1 = block, 2 = rollup
          start_line        INTEGER NOT NULL,
          end_line          INTEGER NOT NULL,
          model             TEXT    NOT NULL,                -- e.g. 'gemma4:e2b', 'claude'
          summary           TEXT    NOT NULL,
          rolled_up_into    INTEGER,                         -- rowid of the L2 row, NULL while still active
          generated_at_ms   INTEGER NOT NULL,
          PRIMARY KEY (room, level, start_line)
        );
        CREATE INDEX idx_room_summary_room_level ON room_summary(room, level, end_line);
        CREATE INDEX idx_room_summary_unrolled   ON room_summary(room, level) WHERE rolled_up_into IS NULL;
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11')");
    })();
    console.log(`[ledger] applied migration v11`);
  }
  if (current < 12) {
    // v12: materialize `version = events.seq` as a column on the three Kind-derived
    // tables (handoffs, interrupts, permissions). Eliminates today's per-row
    // SELECT MAX(seq) FROM events WHERE entity_id = ? subquery in listByStatus
    // (the N+1 the architecture-cycle-2a LedgerEntity carve removes structurally).
    // Backfill from existing events; new rows write `version` inside the same
    // transaction as the event INSERT (see hub/core/store.ts).
    db.transaction(() => {
      db.exec(`
        ALTER TABLE handoffs    ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE interrupts  ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE permissions ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      `);
      db.run(
        "UPDATE handoffs SET version = COALESCE((SELECT MAX(seq) FROM events WHERE entity_id = handoffs.id), 0)",
      );
      db.run(
        "UPDATE interrupts SET version = COALESCE((SELECT MAX(seq) FROM events WHERE entity_id = interrupts.id), 0)",
      );
      db.run(
        "UPDATE permissions SET version = COALESCE((SELECT MAX(seq) FROM events WHERE entity_id = permissions.id), 0)",
      );
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12')");
    })();
    console.log(`[ledger] applied migration v12`);
  }
  if (current < 13) {
    // v13: factory-room worker and tester limits on room_settings. NULL = not set.
    db.transaction(() => {
      db.exec(`
        ALTER TABLE room_settings ADD COLUMN worker_limit INTEGER;
        ALTER TABLE room_settings ADD COLUMN tester_limit INTEGER;
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '13')");
    })();
    console.log(`[ledger] applied migration v13`);
  }
  if (current < 14) {
    // v14: stage-sessions. Per-room role limits (JSON, role -> 0..10) and stage time-out on room_settings,
    // and the `stage` table. Each step is guarded so a second run changes nothing. NULL role_limits /
    // stage_timeout_min mean "defaults"; the stage kind (not this migration) applies them.
    db.transaction(() => {
      const names = new Set(
        db.query<{ name: string }, []>("PRAGMA table_info(room_settings)").all().map((c) => c.name),
      );
      if (!names.has("role_limits")) db.exec("ALTER TABLE room_settings ADD COLUMN role_limits TEXT");
      if (!names.has("stage_timeout_min")) db.exec("ALTER TABLE room_settings ADD COLUMN stage_timeout_min INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS stage (
          id          TEXT    PRIMARY KEY,
          ticket_id   TEXT,                       -- NULL for a spec-review stage
          request_id  TEXT,                       -- set for a spec-review stage
          review      TEXT,                       -- NULL for a ticket stage, 'spec' for a spec-review stage
          verdict     TEXT,                       -- NULL until a result is recorded
          role        TEXT    NOT NULL,
          attempt     INTEGER NOT NULL DEFAULT 1,
          status      TEXT    NOT NULL,
          session     TEXT,
          slot_seq    INTEGER,
          created_seq INTEGER NOT NULL DEFAULT 0,
          updated_seq INTEGER NOT NULL DEFAULT 0,
          version     INTEGER NOT NULL DEFAULT 0,   -- managed by the Store (= events.seq of the last transition)
          CHECK (review IS NOT NULL OR ticket_id IS NOT NULL),
          CHECK (review IS NOT 'spec' OR request_id IS NOT NULL)
        );
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '14')");
    })();
    console.log(`[ledger] applied migration v14`);
  }
  if (current < 15) {
    // v15: spec-review-stage. The tickets a spec-review stage covers, and the index its per-request lookups use
    // (latest spec stage of a request, waiting-for-approval). Guarded so a second run changes nothing.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stage_scope (
          stage_id  TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          PRIMARY KEY (stage_id, ticket_id)
        );
        CREATE INDEX IF NOT EXISTS idx_stage_request_review ON stage(request_id, review, created_seq);
      `);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '15')");
    })();
    console.log(`[ledger] applied migration v15`);
  }
  if (current < 16) {
    // v16: stage-sessions 4.5. The room's project folder (the git repository its stage worktrees come from).
    // NULL = the room has none. Guarded so a second run changes nothing.
    db.transaction(() => {
      const names = new Set(db.query<{ name: string }, []>("PRAGMA table_info(room_settings)").all().map((c) => c.name));
      if (!names.has("project_folder")) db.exec("ALTER TABLE room_settings ADD COLUMN project_folder TEXT");
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '16')");
    })();
    console.log(`[ledger] applied migration v16`);
  }
}

export const STAGE_ROLES = ["worker", "tester", "validator", "writer", "editor", "reviewer"] as const;
export type StageRole = (typeof STAGE_ROLES)[number];
export type RoleLimits = Record<StageRole, number>;
/** Applied while room_settings.role_limits / stage_timeout_min are NULL: the columns store only what the human set. */
export const DEFAULT_ROLE_LIMITS: Readonly<RoleLimits> = { worker: 2, tester: 2, validator: 1, writer: 1, editor: 1, reviewer: 1 };
export const DEFAULT_STAGE_TIMEOUT_MIN = 30;

export type RoomSettings = {
  room: string;
  persist_transcript: boolean;
  room_summary_enabled: boolean;
  worker_limit: number | null;
  tester_limit: number | null;
  role_limits: RoleLimits;
  stage_timeout_min: number;
  project_folder: string | null;
  updated_at: number;
};

function resolveRoleLimits(raw: string | null): RoleLimits {
  let stored: Partial<RoleLimits> = {};
  try {
    if (raw) stored = JSON.parse(raw) as Partial<RoleLimits>;
  } catch { /* a corrupt value falls back to the defaults */ }
  const out = { ...DEFAULT_ROLE_LIMITS };
  for (const r of STAGE_ROLES) if (Number.isInteger(stored[r])) out[r] = stored[r] as number;
  return out;
}

export function getRoomSettings(db: Database, room: string): RoomSettings | null {
  const row = db
    .query<
      {
        room: string;
        persist_transcript: number;
        room_summary_enabled: number;
        worker_limit: number | null;
        tester_limit: number | null;
        role_limits: string | null;
        stage_timeout_min: number | null;
        project_folder: string | null;
        updated_at: number;
      },
      [string]
    >(
      "SELECT room, persist_transcript, room_summary_enabled, worker_limit, tester_limit, role_limits, stage_timeout_min, project_folder, updated_at FROM room_settings WHERE room = ?",
    )
    .get(room);
  if (!row) return null;
  return {
    room: row.room,
    persist_transcript: !!row.persist_transcript,
    room_summary_enabled: !!row.room_summary_enabled,
    worker_limit: row.worker_limit,
    tester_limit: row.tester_limit,
    role_limits: resolveRoleLimits(row.role_limits),
    stage_timeout_min: row.stage_timeout_min ?? DEFAULT_STAGE_TIMEOUT_MIN,
    project_folder: row.project_folder,
    updated_at: row.updated_at,
  };
}

export function setRoomSettings(
  db: Database,
  room: string,
  partial: {
    persist_transcript?: boolean;
    room_summary_enabled?: boolean;
    worker_limit?: number | null;
    tester_limit?: number | null;
    role_limits?: Partial<RoleLimits> | null;
    stage_timeout_min?: number | null;
    project_folder?: string | null;
  },
): void {
  const current = getRoomSettings(db, room);
  const persist = partial.persist_transcript ?? current?.persist_transcript ?? false;
  const summary = partial.room_summary_enabled ?? current?.room_summary_enabled ?? false;
  // `in`, not `??`: an explicit null clears a limit, an absent key keeps it.
  const workers = "worker_limit" in partial ? partial.worker_limit ?? null : current?.worker_limit ?? null;
  const testers = "tester_limit" in partial ? partial.tester_limit ?? null : current?.tester_limit ?? null;
  // The columns hold only what was set (NULL = defaults), so read them raw. null clears; an object
  // overrides the listed roles on top of the current limits.
  const raw = db
    .query<{ role_limits: string | null; stage_timeout_min: number | null }, [string]>(
      "SELECT role_limits, stage_timeout_min FROM room_settings WHERE room = ?",
    )
    .get(room);
  const roleLimits =
    "role_limits" in partial
      ? partial.role_limits == null
        ? null
        : JSON.stringify({ ...(current?.role_limits ?? DEFAULT_ROLE_LIMITS), ...partial.role_limits })
      : raw?.role_limits ?? null;
  const timeout = "stage_timeout_min" in partial ? partial.stage_timeout_min ?? null : raw?.stage_timeout_min ?? null;
  const folder = "project_folder" in partial ? partial.project_folder ?? null : current?.project_folder ?? null;
  db.run(
    `INSERT INTO room_settings (room, persist_transcript, room_summary_enabled, worker_limit, tester_limit, role_limits, stage_timeout_min, project_folder, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room) DO UPDATE SET
       persist_transcript = excluded.persist_transcript,
       room_summary_enabled = excluded.room_summary_enabled,
       worker_limit = excluded.worker_limit,
       tester_limit = excluded.tester_limit,
       role_limits = excluded.role_limits,
       stage_timeout_min = excluded.stage_timeout_min,
       project_folder = excluded.project_folder,
       updated_at = excluded.updated_at`,
    [room, persist ? 1 : 0, summary ? 1 : 0, workers, testers, roleLimits, timeout, folder, Date.now()],
  );
}

export function listOptedInRooms(db: Database): string[] {
  const rows = db
    .query<{ room: string }, []>(
      "SELECT room FROM room_settings WHERE persist_transcript = 1",
    )
    .all();
  return rows.map((r) => r.room);
}
