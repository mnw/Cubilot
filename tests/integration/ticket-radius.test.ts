// Radius by rule: the stored blast_radius is never below the rule radius; the lead and the creator raise it; an agent
// cannot lower it below the rule. In-process kind routes over an in-memory ledger (no mocks).

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import type { Entry, HubCapabilities, KindModule, Scope } from "../../hub/core/types";

const HUMAN = "human";
const ATT_DIR = mkdtempSync(join(tmpdir(), "cubilot-ticket-att-"));
const APPROVAL_TOOL = "ticket:done";

type Env = ReturnType<typeof makeEnv>;

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const kinds: KindModule[] = [createPermissionKind(db), createTicketKind(db)];
  for (const k of kinds) k.migrate(db);
  const roster: Record<string, string | null> = { [HUMAN]: null };
  const emitted: { entry: Entry; scope: Scope }[] = [];
  let refreshes = 0;
  const paused = new Set<string>();
  const cap = {
    db,
    agents: {
      get: (n: string) => (n in roster ? { name: n, room: roster[n]!, permanent: n === HUMAN } : null),
      isPermanent: (n: string) => n === HUMAN,
      isPaused: (n: string) => paused.has(n),
      all: () => [],
      ensure: () => null,
    },
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    auth: {},
    events: { insert: insertEvent },
    config: { humanName: HUMAN, attachmentsDir: ATT_DIR, defaultRoom: "default", allowedExtensions: new Set(["jpg", "jpeg", "png", "pdf", "md", "txt"]) },
    briefing: { refresh: () => void refreshes++ },
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
        const req = new Request(url, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
        const res = await r.handler(req, cap, params);
        return { status: res.status, json: await res.json().catch(() => null) };
      }
    }
    throw new Error(`no route ${method} ${path}`);
  }

  return {
    db,
    kinds,
    roster,
    paused,
    emitted,
    cap,
    call,
    refreshes: () => refreshes,
    events: (id: string) =>
      db.query<{ kind: string; actor: string }, [string]>("SELECT kind, actor FROM events WHERE entity_id = ? ORDER BY seq").all(id),
    row: (id: string) => db.query<any, [string]>("SELECT * FROM tickets WHERE id = ?").get(id),
  };
}


let t: Env;
beforeEach(() => {
  t = makeEnv();
  t.roster.alice = "r1";   // the creator
  t.roster.bob = "r1";     // the room lead
  t.roster.carol = "r1";   // the assignee
});
const lead = () => t.call("POST", "/rooms/r1/lead", { by: HUMAN, agent: "bob" });
const create = async (over: Record<string, unknown> = {}) => {
  const r = await t.call("POST", "/tickets", { by: "alice", title: "Fix login", acceptance_criteria: "Login works.", blast_radius: "low", status: "draft", ...over });
  expect(r.status).toBe(201);
  return r.json.snapshot;
};
const edit = (id: string, by: string, body: Record<string, unknown>) => t.call("POST", `/tickets/${id}/edit`, { by, ...body });

describe("radius by rule", () => {
  test("Low requested, rule high", async () => {
    const s = await create({ by: "bob", acceptance_criteria: "Change hub/core/worktrees.ts." });
    expect(s).toMatchObject({ blast_radius: "high", radius_rule: "high", radius_source: "rule", radius_reasons: ["hub/core/worktrees.ts"] });
    expect(t.row(s.id)).toMatchObject({ blast_radius: "high", radius_rule: "high", radius_source: "rule", radius_reasons: '["hub/core/worktrees.ts"]' });
  });

  test("a low ticket with no term stays low with source rule", async () => {
    const s = await create();
    expect(s).toMatchObject({ blast_radius: "low", radius_rule: "low", radius_source: "rule", radius_reasons: [] });
  });

  test("an edit that adds a term raises the ticket in the same event", async () => {
    const s = await create();
    const r = await edit(s.id, "alice", { acceptance_criteria: "The launch queue refuses a stage." });
    expect(r.status).toBe(200);
    expect(r.json.snapshot).toMatchObject({ blast_radius: "high", radius_rule: "high", radius_source: "rule" });
    expect(t.events(s.id).map((e) => e.kind)).toEqual(["ticket.created", "ticket.edited"]);
  });

  test("Lead raises", async () => {
    await lead();
    const s = await create();
    const r = await edit(s.id, "bob", { blast_radius: "high" });
    expect(r.status).toBe(200);
    expect(r.json.snapshot).toMatchObject({ blast_radius: "high", radius_rule: "low", radius_source: "raised" });
  });

  test("the creator raises; the assignee is refused", async () => {
    await lead();
    const s = await create({ assignee: "carol" });
    expect((await edit(s.id, "carol", { blast_radius: "high" })).status).toBe(403);
    expect((await edit(s.id, "alice", { blast_radius: "high" })).json.snapshot.radius_source).toBe("raised");
  });

  test("Lead lowers", async () => {
    await lead();
    const s = await create({ acceptance_criteria: "The launch queue refuses a stage." });
    const r = await edit(s.id, "bob", { blast_radius: "low" });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("a radius below the rule needs an arbiter ruling");
    expect(t.row(s.id).blast_radius).toBe("high");
  });

  test("Raised ticket lowered by its raiser", async () => {
    await lead();
    const s = await create();
    await edit(s.id, "bob", { blast_radius: "high" });
    const r = await edit(s.id, "bob", { blast_radius: "low" });
    expect(r.status).toBe(200);
    expect(r.json.snapshot).toMatchObject({ blast_radius: "low", radius_source: "rule" });
  });

  test("the human sets any radius with source human", async () => {
    const s = await create({ acceptance_criteria: "The launch queue refuses a stage." });
    const r = await edit(s.id, HUMAN, { blast_radius: "low" });
    expect(r.status).toBe(200);
    expect(r.json.snapshot).toMatchObject({ blast_radius: "low", radius_rule: "high", radius_source: "human" });
  });
});
