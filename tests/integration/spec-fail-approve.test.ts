// The human's Approve starts the spec FAIL count again (spec-fail-gate), read from the request Kind's row id.
// In-process: the real approve route and the real stage runtime run against an in-memory ledger.

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createRequestKind } from "../../hub/kinds/request";
import { createStageRuntime, specFailState } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, KindModule, Scope } from "../../hub/core/types";

const HUMAN = "human";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  const kinds: KindModule[] = [createPermissionKind(db), createTicketKind(db), createRequestKind(db)];
  for (const k of kinds) k.migrate(db);
  rt.module.migrate(db);
  for (const room of ["r1", "r2"]) giveProject(db, room);
  const roster: Record<string, string | null> = { [HUMAN]: null, alice: "r1", carol: "r2" };
  const cap = {
    db,
    agents: {
      get: (n: string) => (n in roster ? { name: n, room: roster[n]!, permanent: n === HUMAN } : null),
      isPermanent: (n: string) => n === HUMAN,
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    sse: { emit: (_entry: Entry, _scope: Scope) => {} },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: HUMAN, attachmentsDir: "/tmp", defaultRoom: "default", allowedExtensions: new Set(["md"]) },
    briefing: { refresh: () => {} },
  } as unknown as HubCapabilities;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const url = new URL(`http://hub.test${path}`);
    for (const k of kinds) {
      for (const r of k.routes) {
        if (r.method !== method) continue;
        let params: Record<string, string> | null = null;
        if (typeof r.path === "string") {
          if (r.path === url.pathname) params = {};
        } else {
          const m = url.pathname.match(r.path);
          if (m) params = { id: m[1] };
        }
        if (!params) continue;
        const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
        const res = await r.handler(req, cap, params);
        return { status: res.status, json: await res.json().catch(() => null) };
      }
    }
    throw new Error(`no route ${method} ${path}`);
  }
  return { db, rt, cap, call };
}

let e: ReturnType<typeof makeEnv>;
beforeEach(async () => {
  e = makeEnv();
  expect((await e.call("POST", "/rooms/r1/lead", { by: HUMAN, agent: "alice" })).status).toBe(200);
  expect((await e.call("POST", "/rooms/r2/lead", { by: HUMAN, agent: "carol" })).status).toBe(200);
});

const request = async (by: string, id: string) => expect((await e.call("POST", "/requests", { by, request_id: id })).status).toBe(201);
const approve = async (room: string, id: string) => expect((await e.call("POST", `/requests/${room}/${id}/approve`, { by: HUMAN })).status).toBe(200);
/** A spec review of the request in the lead's room that ended with verdict FAIL. The room of a spec stage comes from its scope ticket. */
const specFail = async (by: string, id: string) => {
  const t = await e.call("POST", "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: id, status: "draft" });
  expect(t.status).toBe(201);
  const s = e.rt.api.create({ request_id: id, review: "spec", role: "validator" }, "system", e.cap, (ctx) => {
    ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t.json.snapshot.id]);
  });
  e.rt.api.move(s.id, { to: "launching", session: `validator-${s.id}` }, "system", e.cap);
  e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
  e.rt.api.move(s.id, { to: "passed", verdict: "FAIL" }, "system", e.cap);
};
const fails = (room: string, id: string) => specFailState(e.db, room, id).fails;

describe("the Approve starts the spec FAIL count again", () => {
  test("Approve resets the count", async () => {
    await request("alice", "r-1");
    await specFail("alice", "r-1");
    await specFail("alice", "r-1");
    expect(fails("r1", "r-1")).toBe(2);
    await approve("r1", "r-1");
    expect(fails("r1", "r-1")).toBe(0);
  });

  test("One FAIL after the Approve", async () => {
    await request("alice", "r-1");
    await specFail("alice", "r-1");
    await specFail("alice", "r-1");
    await approve("r1", "r-1");
    await specFail("alice", "r-1");
    const state = specFailState(e.db, "r1", "r-1");
    expect(state.fails).toBe(1);
    expect(state.latest).not.toBeNull();
  });

  test("Other room", async () => {
    await request("alice", "r-1");
    await request("carol", "r-1");
    await specFail("alice", "r-1");
    await specFail("alice", "r-1");
    await approve("r2", "r-1");
    expect(fails("r1", "r-1")).toBe(2);
  });

  test("Migrated Approve", async () => {
    await request("alice", "r-1");
    await specFail("alice", "r-1");
    await specFail("alice", "r-1");
    const id = e.db.query<{ id: string }, []>("SELECT id FROM requests WHERE request_id = 'r-1'").get()!.id;
    insertEvent(e.db, id, "request.approved", "system", { actor: "system", scope: { features: [], tickets: [] }, migrated: true }, Date.now());
    expect(fails("r1", "r-1")).toBe(0);
  });
});
