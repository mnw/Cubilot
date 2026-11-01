// cancel-failure-trace 9: the table comes from the Kind decl through the Store migrate. No core DDL, no other table changes.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../hub/core/ledger";
import { cancelTraceId, createCancelTraceKind } from "../../hub/kinds/cancel-trace";
import { createTicketKind } from "../../hub/kinds/ticket";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const schema = (d: Database) =>
  d.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
const without = (rows: Array<{ name: string; sql: string }>) => rows.filter((r) => !/cancel_traces/.test(r.name));
const open = (path: string, snaps: string, withTrace: boolean) => {
  const db = openLedger(path, snaps).db!;
  createTicketKind(db).migrate(db);
  if (withTrace) createCancelTraceKind(db).migrate(db);
  return db;
};

describe("cancel_traces migration", () => {
  test("a fresh ledger gets the table; a second migrate changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-"));
    const path = join(dir, "ledger.db");
    const db = open(path, join(dir, "snaps"), true);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(cancel_traces)").all().map((c) => c.name)).toEqual([
      "id", "status", "room", "stage_id", "ticket_id", "site", "caller", "status_at_failure", "error", "created_at", "cleared_at", "version",
    ]);
    const first = schema(db);
    createCancelTraceKind(db).migrate(db);
    expect(schema(db)).toEqual(first);
    db.close();
    const again = open(path, join(dir, "snaps"), true);
    expect(schema(again)).toEqual(first);
    again.close();
  });

  test("a current ledger with rows gains only the table and its index, keeps its rows, and a second run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-"));
    const path = join(dir, "ledger.db");
    const snaps = join(dir, "snaps");
    const before = open(path, snaps, false);
    before.run(
      `INSERT INTO tickets (id,room,title,acceptance_criteria,blast_radius,priority,creator,status,created_at_ms,updated_at_ms,version)
       VALUES ('t_1','r','T','c','low',3,'a','queued',1,1,1)`,
    );
    const old = schema(before);
    expect(old.some((r) => /cancel_traces/.test(r.name))).toBe(false);
    before.close();
    const once = open(path, snaps, true);
    const after = schema(once);
    expect(without(after)).toEqual(old);
    expect(after.filter((r) => /cancel_traces/.test(r.name)).map((r) => r.name).sort()).toEqual(["cancel_traces", "idx_cancel_traces_status"]);
    expect(once.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    once.close();
    const twice = open(path, snaps, true);
    expect(schema(twice)).toEqual(after);
    twice.close();
  });

  test("(h) an open row is listed again by a new runtime on the same ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-"));
    const path = join(dir, "ledger.db");
    const cap = {
      config: { humanName: "human" },
      sse: { emit: (_e: Entry, _s: Scope) => {} },
    } as unknown as HubCapabilities;
    const db = open(path, join(dir, "snaps"), true);
    createCancelTraceKind(db).record(
      { room: "r1", stage_id: "s_1", ticket_id: null, site: "cancel", caller: "ticket_cancel", status_at_failure: "queued", error: "boom" },
      cap,
    );
    db.close();
    const db2 = open(path, join(dir, "snaps"), true);
    const list = createCancelTraceKind(db2).routes.find((r) => r.method === "GET")!;
    return Promise.resolve(list.handler(new Request("http://x/"), cap, { id: "r1" }))
      .then((r) => r.json())
      .then((body: any) => {
        expect(body.traces.map((t: any) => t.id)).toEqual([cancelTraceId("s_1", "cancel", "queued")]);
        db2.close();
      });
  });
});
