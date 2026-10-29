// The Approve rule (plan-approval, work-tickets): the approved scope, the spec PASS gate and the lead's queue.
// In-process: route handlers and the stage runtime run against an in-memory ledger with a fake HubCapabilities.

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { createPermissionKind } from "../../hub/kinds/permission";
import { createTicketKind } from "../../hub/kinds/ticket";
import { approveRequest, createRequestKind } from "../../hub/kinds/request";
import { createStageRuntime, waitingForApproval } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, KindModule, Scope } from "../../hub/core/types";

const HUMAN = "human";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  const kinds: KindModule[] = [createPermissionKind(db), createTicketKind(db), createRequestKind(db)];
  for (const k of kinds) k.migrate(db);
  rt.module.migrate(db);
  giveProject(db, "r1");
  const roster: Record<string, string | null> = { [HUMAN]: null, alice: "r1", bob: "r1" };
  const emitted: Array<{ entry: Entry; scope: Scope }> = [];
  const cap = {
    db,
    agents: {
      get: (n: string) => (n in roster ? { name: n, room: roster[n]!, permanent: n === HUMAN } : null),
      isPermanent: (n: string) => n === HUMAN,
      isPaused: () => false,
      all: () => [],
      ensure: () => null,
    },
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
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
  return { db, rt, cap, call, emitted };
}

let e: ReturnType<typeof makeEnv>;
beforeEach(async () => {
  e = makeEnv();
  expect((await e.call("POST", "/rooms/r1/lead", { by: HUMAN, agent: "alice" })).status).toBe(200);
});

const request = async (id: string, over: Record<string, unknown> = {}) => {
  const r = await e.call("POST", "/requests", { by: "alice", request_id: id, ...over });
  expect(r.status).toBe(201);
};
// The human may create a factory request without a source (the source rule stops an agent, see request-kind.test.ts).
const factory = async (id: string, over: Record<string, unknown> = {}) => {
  const r = await e.call("POST", "/requests", { by: HUMAN, room: "r1", request_id: id, origin: "factory", ...over });
  expect(r.status).toBe(201);
};
const ticket = async (requestId: string, over: Record<string, unknown> = {}): Promise<string> => {
  const r = await e.call("POST", "/tickets", { by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: requestId, status: "draft", ...over });
  expect(r.status).toBe(201);
  return r.json.snapshot.id;
};
const status = (id: string) => e.db.query<{ status: string }, [string]>("SELECT status FROM tickets WHERE id = ?").get(id)!.status;
const move = (id: string, by: string, to: string) => e.call("POST", `/tickets/${id}/transition`, { by, to });
const approve = (requestId: string, by = HUMAN) => e.call("POST", `/requests/r1/${requestId}/approve`, { by });
const kinds = (entity: string) => e.db.query<{ kind: string; actor: string }, [string]>("SELECT kind, actor FROM events WHERE entity_id = ? ORDER BY seq").all(entity).map((x) => `${x.kind}:${x.actor}`);
const rowId = (requestId: string) => e.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE request_id = ?").get(requestId)!.id;
const approved = (requestId: string) => JSON.parse(e.db.query<{ approved: string }, [string]>("SELECT approved FROM requests WHERE request_id = ?").get(requestId)!.approved);

// A spec stage for the request over the given scope, running; the PASS goes through the real passSpecStage.
let stageN = 0;
const specPass = (requestId: string, scope: string[]) => {
  const s = e.rt.api.create({ request_id: requestId, review: "spec", role: "validator" }, "system", e.cap, (ctx) => {
    for (const t of scope) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
  });
  e.rt.api.move(s.id, { to: "launching", session: `validator-${++stageN}` }, "system", e.cap);
  e.rt.api.move(s.id, { to: "running" }, "system", e.cap);
  return e.rt.passSpecStage(s.id, e.cap);
};

describe("the Approve writes the approved scope", () => {
  test("Approve a plan: the scope holds the features, t1 low and t2 high; the event comes before the queue events", async () => {
    await request("r-1", { features: ["Export"] });
    const t1 = await ticket("r-1");
    const t2 = await ticket("r-1", { blast_radius: "high" });
    const cancelled = await ticket("r-1");
    expect((await move(cancelled, HUMAN, "cancelled")).status).toBe(200);
    const r = await approve("r-1");
    expect(r.status).toBe(200);
    expect(approved("r-1")).toEqual({ features: ["Export"], tickets: [t1, t2].sort().map((id) => ({ id, radius: id === t2 ? "high" : "low" })) });
    expect(e.db.query<{ status: string }, []>("SELECT status FROM requests").get()!.status).toBe("approved");
    expect(kinds(rowId("r-1"))).toEqual(["request.created:alice", `request.approved:${HUMAN}`]);
    expect([status(t1), status(t2)]).toEqual(["queued", "queued"]);
    const seqs = e.db.query<{ kind: string; seq: number }, []>("SELECT kind, seq FROM events WHERE kind IN ('request.approved', 'ticket.queued') ORDER BY seq").all();
    expect(seqs[0]!.kind).toBe("request.approved");
  });

  test("Agent approves: the lead gets 403 and nothing is written", async () => {
    await request("r-1");
    const t1 = await ticket("r-1");
    const before = e.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
    expect((await approve("r-1", "alice")).status).toBe(403);
    expect((await approve("r-1", "bob")).status).toBe(403);
    expect(status(t1)).toBe("draft");
    expect(e.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(before);
    expect(e.db.query<{ approved: string | null }, []>("SELECT approved FROM requests").get()!.approved).toBeNull();
  });

  test("a repeated Approve queues the drafts that are left and writes no second request.approved event", async () => {
    await request("r-1");
    const t1 = await ticket("r-1");
    // A crash between the two transactions: the Approve is written, the drafts are not queued.
    approveRequest(e.db, e.cap, "r1", "r-1", HUMAN);
    expect(status(t1)).toBe("draft");
    const r = await approve("r-1");
    expect(r.status).toBe(200);
    expect(r.json.queued).toEqual([t1]);
    expect(status(t1)).toBe("queued");
    expect(kinds(rowId("r-1")).filter((k) => k.startsWith("request.approved"))).toHaveLength(1);
  });

  test("a second Approve after a scope change writes a new request.approved event with the new scope", async () => {
    await request("r-1");
    const t1 = await ticket("r-1");
    await approve("r-1");
    const t3 = await ticket("r-1");
    await approve("r-1");
    expect(approved("r-1").tickets.map((t: { id: string }) => t.id).sort()).toEqual([t1, t3].sort());
    expect(kinds(rowId("r-1")).filter((k) => k.startsWith("request.approved"))).toHaveLength(2);
    expect(status(t3)).toBe("queued");
  });

  test("an unknown request gets 404", async () => {
    expect((await approve("r-none")).status).toBe(404);
  });
});

describe("the spec PASS follows the Approve rule", () => {
  test("Human request, low radius: the tickets stay draft and the request waits for approval", async () => {
    await request("r-1");
    const a = await ticket("r-1");
    const r = specPass("r-1", [a]);
    expect(r.queued).toEqual([]);
    expect(r.waitingForApproval).toBe(true);
    expect(status(a)).toBe("draft");
    expect(waitingForApproval(e.db, "r1", "r-1")).toBe(true);
  });

  test("Factory request, low radius: the ticket is queued and the human did nothing", async () => {
    await factory("r-1-fu-1");
    const a = await ticket("r-1-fu-1");
    const r = specPass("r-1-fu-1", [a]);
    expect(r.queued).toEqual([a]);
    expect(r.waitingForApproval).toBe(false);
    expect(status(a)).toBe("queued");
    expect(e.db.query<{ actor: string }, [string]>("SELECT actor FROM events WHERE entity_id = ? AND kind = 'ticket.queued'").get(a)!.actor).toBe("system");
    expect(waitingForApproval(e.db, "r1", "r-1-fu-1")).toBe(false);
  });

  test("Factory request, high radius: the tickets stay draft and the request waits for approval", async () => {
    await factory("f-1");
    const hi = await ticket("f-1", { blast_radius: "high" });
    const r = specPass("f-1", [hi]);
    expect(r.queued).toEqual([]);
    expect(r.waitingForApproval).toBe(true);
    expect(status(hi)).toBe("draft");
    expect(waitingForApproval(e.db, "r1", "f-1")).toBe(true);
  });

  test("PASS with a high ticket: a high ticket outside the scope holds the low scope tickets", async () => {
    await factory("f-1");
    const a = await ticket("f-1");
    const hi = await ticket("f-1", { blast_radius: "high" });
    const r = specPass("f-1", [a]);
    expect(r.queued).toEqual([]);
    expect([status(a), status(hi)]).toEqual(["draft", "draft"]);
  });

  test("Factory request with low tickets: every scope ticket is queued", async () => {
    await factory("f-1");
    const ids = [await ticket("f-1"), await ticket("f-1"), await ticket("f-1")];
    const r = specPass("f-1", ids);
    expect(r.queued.sort()).toEqual([...ids].sort());
    expect(ids.map(status)).toEqual(["queued", "queued", "queued"]);
  });

  test("a factory request with a feature waits for approval, also with low tickets", async () => {
    await factory("f-1", { features: ["New thing"] });
    const a = await ticket("f-1");
    expect(specPass("f-1", [a]).waitingForApproval).toBe(true);
    expect(status(a)).toBe("draft");
  });

  test("Edit and new spec PASS: an approved request, a ticket back to draft after a criteria edit: the PASS queues it", async () => {
    await request("r-1");
    const t1 = await ticket("r-1");
    await approve("r-1");
    expect(status(t1)).toBe("queued");
    const edit = await e.call("POST", `/tickets/${t1}/edit`, { by: "alice", acceptance_criteria: "New criteria." });
    expect(edit.status).toBe(200);
    expect(status(t1)).toBe("draft");
    const r = specPass("r-1", [t1]);
    expect(r.queued).toEqual([t1]);
    expect(r.waitingForApproval).toBe(false);
    expect(status(t1)).toBe("queued");
  });

  test("New ticket needs a new Approve: a ticket added after the Approve stays draft after its spec PASS", async () => {
    await request("r-1");
    await ticket("r-1");
    await approve("r-1");
    const t3 = await ticket("r-1");
    const r = specPass("r-1", [t3]);
    expect(r.queued).toEqual([]);
    expect(r.waitingForApproval).toBe(true);
    expect(status(t3)).toBe("draft");
    expect(waitingForApproval(e.db, "r1", "r-1")).toBe(true);
    // The human approves again: the ticket is queued and the waiting ends.
    await approve("r-1");
    expect(status(t3)).toBe("queued");
    expect(waitingForApproval(e.db, "r1", "r-1")).toBe(false);
  });
});

describe("the lead's queue follows the Approve rule", () => {
  test("A high request needs the human: the lead gets 403 and the human succeeds", async () => {
    await request("r-1");
    const low = await ticket("r-1");
    const hi = await ticket("r-1", { blast_radius: "high" });
    const r = await move(low, "alice", "queued");
    expect(r.status).toBe(403);
    expect(r.json.error).toContain("Approve");
    expect((await move(hi, "alice", "queued")).status).toBe(403);
    expect((await move(low, HUMAN, "queued")).status).toBe(200);
  });

  test("a factory request with a high ticket: the lead gets 403; with low tickets only the lead queues", async () => {
    await factory("f-1");
    const low = await ticket("f-1");
    const hi = await ticket("f-1", { blast_radius: "high" });
    expect((await move(low, "alice", "queued")).status).toBe(403);
    expect((await move(hi, HUMAN, "cancelled")).status).toBe(200);
    expect((await move(low, "alice", "queued")).status).toBe(200);
  });

  test("An approved request is queued by the lead: a ticket back to draft after a criteria edit", async () => {
    await request("r-1");
    const t1 = await ticket("r-1");
    await approve("r-1");
    await e.call("POST", `/tickets/${t1}/edit`, { by: "alice", acceptance_criteria: "Other." });
    expect(status(t1)).toBe("draft");
    expect((await move(t1, "alice", "queued")).status).toBe(200);
  });

  test("an approved request whose scope changed holds the lead again", async () => {
    await request("r-1");
    await ticket("r-1");
    await approve("r-1");
    const t3 = await ticket("r-1");
    expect((await move(t3, "alice", "queued")).status).toBe(403);
    await approve("r-1");
    expect(status(t3)).toBe("queued");
  });

  test("the old high-radius check is gone: a human request with only low tickets also needs the Approve", async () => {
    await request("r-1");
    const low = await ticket("r-1");
    expect((await move(low, "alice", "queued")).status).toBe(403);
  });
});
