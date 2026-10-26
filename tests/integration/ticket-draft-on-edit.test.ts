// spec-review-stage 5.1: an edit that changes a queued ticket's criteria, role or blockers sends it back to draft in the
// same transaction. In-process harness copied from ticket-kind.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const spec = (over: Record<string, unknown> = {}) => ({
  by: "alice",
  title: "Fix login",
  acceptance_criteria: "Login works with a valid token.",
  blast_radius: "low",
  ...over,
});

let t: Env;
beforeEach(() => {
  t = makeEnv();
  t.roster.alice = "r1";
  t.roster.bob = "r1";
  t.roster.carol = "r1";
  t.roster.dave = "r2";
});

async function create(over: Record<string, unknown> = {}): Promise<string> {
  const r = await t.call("POST", "/tickets", spec(over));
  expect(r.status).toBe(201);
  return r.json.snapshot.id;
}
// An agent's move to in_review needs a note (the audit trail); tests that are about something else get a default one.
const as = (id: string, by: string, to: string, note?: string) =>
  t.call("POST", `/tickets/${id}/transition`, { by, to, ...(note !== undefined ? { note } : to === "in_review" && by !== HUMAN ? { note: "built and tested" } : {}) });
const claim = (id: string, by: string) => t.call("POST", `/tickets/${id}/claim`, { by });

/** Drive a ticket to in_review owned by bob. */
async function toReview(over: Record<string, unknown> = {}): Promise<string> {
  const id = await create(over);
  expect((await claim(id, "bob")).status).toBe(200);
  expect((await as(id, "bob", "in_progress")).status).toBe(200);
  expect((await as(id, "bob", "in_review")).status).toBe(200);
  return id;
}

describe("queued ticket edited returns to draft", () => {
  const edit = (id: string, body: Record<string, unknown>, by = "alice") => t.call("POST", `/tickets/${id}/edit`, { by, ...body });
  const status = (id: string) => (t.row(id) as { status: string }).status;
  const editedEvents = (id: string) => t.events(id).filter((e) => e.kind === "ticket.edited");
  const blockers = (id: string) =>
    t.db.query<{ blocker_id: string }, [string]>("SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ?").all(id).map((r) => r.blocker_id);

  test("new criteria, a role change and a blocker change each move a queued ticket to draft with one ticket.edited event", async () => {
    const other = await create();
    for (const body of [{ acceptance_criteria: "Different criteria." }, { role: "tester" }, { blocked_by: [other] }]) {
      const id = await create();
      expect(status(id)).toBe("queued");
      const r = await edit(id, body);
      expect(r.status).toBe(200);
      expect(r.json.snapshot.status).toBe("draft");
      expect(status(id)).toBe("draft");
      expect(editedEvents(id)).toHaveLength(1);
      expect(t.db.query("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.edited'").get(id)).toMatchObject({
        payload_json: expect.stringContaining('"status":{"from":"queued","to":"draft"}'),
      });
    }
  });

  test("the room lead changes the role of another agent's ticket and gets 200; the assignee still gets 403", async () => {
    const id = await create({ role: "worker" }); // creator alice
    expect((await t.call("POST", "/rooms/r1/lead", { by: HUMAN, agent: "carol" })).status).toBe(200);
    expect((await edit(id, { role: "tester" }, "bob")).status).toBe(403); // bob is neither creator nor lead
    const r = await edit(id, { role: "tester" }, "carol");
    expect(r.status).toBe(200);
    expect(r.json.snapshot.role).toBe("tester");
    expect((t.row(id) as { role: string }).role).toBe("tester");
  });

  test("a title, priority or external_ref edit leaves a queued ticket queued", async () => {
    const id = await create();
    expect((await edit(id, { title: "New title", priority: "high", external_ref: "X-1" })).status).toBe(200);
    expect(status(id)).toBe("queued");
  });

  test("an edit that changes nothing leaves a queued ticket queued", async () => {
    const id = await create({ role: "worker" });
    const r = await edit(id, { role: "worker", acceptance_criteria: spec().acceptance_criteria });
    expect(r.json.idempotent).toBe(true);
    expect(status(id)).toBe("queued");
  });

  test("a draft ticket stays draft", async () => {
    const id = await create({ status: "draft" });
    expect((await edit(id, { role: "tester" })).json.snapshot.status).toBe("draft");
  });

  test("claimed, in_progress and in_review tickets do not move (the human edits them)", async () => {
    for (const stop of ["claimed", "in_progress", "in_review"]) {
      const id = await create();
      expect((await claim(id, "bob")).status).toBe(200);
      if (stop !== "claimed") expect((await as(id, "bob", "in_progress")).status).toBe(200);
      if (stop === "in_review") expect((await as(id, "bob", "in_review")).status).toBe(200);
      const r = await edit(id, { acceptance_criteria: "Changed after the claim.", role: "validator" }, HUMAN);
      expect(r.status).toBe(200);
      expect(status(id)).toBe(stop);
    }
  });

  test("the edit and the move roll back together on a forced failure", async () => {
    const blocker = await create();
    const id = await create();
    t.db.exec(`CREATE TRIGGER fail_blockers BEFORE INSERT ON ticket_blockers BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    const eventsBefore = t.events(id).length;
    await expect(edit(id, { acceptance_criteria: "Will not stick.", role: "tester", blocked_by: [blocker] })).rejects.toThrow();
    const row = t.row(id) as { status: string; acceptance_criteria: string; role: string | null };
    expect(row.status).toBe("queued");
    expect(row.acceptance_criteria).toBe(spec().acceptance_criteria);
    expect(row.role).toBeNull();
    expect(blockers(id)).toEqual([]);
    expect(t.events(id)).toHaveLength(eventsBefore);
  });
});
