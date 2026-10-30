// Part 14 H7: GET /rooms/<room>/decisions through the real hub. Rows the hub cannot make by route are seeded into its ledger.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

type Card = Record<string, any>;
const OPTIONS = [
  { id: "A", label: "Keep the scope", effect: "No change.", recommended: true },
  { id: "B", label: "Widen the scope", effect: "One more ticket." },
];
const escalation = (over: Record<string, unknown> = {}) => ({
  reason: "scope",
  block: "A scope change stops the work.",
  facts: ["1. Commit 9e2250b holds the plan."],
  options: OPTIONS,
  human_actions: [{ ticket_id: "t_00000000000000a1", action: "Tell the Orchestrator A or B." }],
  next: "The Orchestrator applies the answer.",
  ...over,
});

let hub: HubHandle;
let db: Database;
const open: Array<{ close: () => void }> = [];
const list = async (qs = "", room = "r1") => (await getJson(hub, `/rooms/${room}/decisions${qs}${qs ? "&" : "?"}token=${hub.token}`));
const cards = async (qs = "") => ((await list(qs)).json as { decisions: Card[] }).decisions;
const ticket = async (extra: Record<string, unknown> = {}) =>
  ((await postJson(hub, "/tickets", { by: "boss", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", status: "draft", ...extra })).json as { snapshot: { id: string } }).snapshot.id;
const lead = async (over: Record<string, unknown>) => ((await postJson(hub, "/decisions", { by: "boss", ...escalation(over) })).json as { id: string }).id;
let hseq = 0;
function seedDecision(id: string, over: Record<string, unknown>) {
  const row = { id, room: "r1", ticket_id: null, request_id: null, decider: "arbiter", fail_count: 2, option: "A", text: "Arbiter kept the scope.", reason: null, body: null, status: "applied", created_by: "boss", created_at_ms: 1000, version: 1, ...over };
  db.run(
    "INSERT INTO decisions (id, room, ticket_id, request_id, decider, fail_count, option, text, reason, body, status, created_by, created_at_ms, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [row.id, row.room, row.ticket_id, row.request_id, row.decider, row.fail_count, row.option, row.text, row.reason, row.body, row.status, row.created_by, row.created_at_ms, row.version] as any,
  );
}
const seedEvent = (id: string, kind: string, at: number) => db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?,?,?,?,?)", [id, kind, "boss", "{}", at]);
function seedFail(ticketId: string, findings: number, role = "validator", from = "validator-1") {
  const sid = `s_h7${++hseq}`;
  db.run("INSERT INTO stage (id, ticket_id, role, attempt, status, verdict, session, created_seq, updated_seq, version) VALUES (?,?,?,?,?,?,?,?,?,?)", [sid, ticketId, role, 1, "failed", "FAIL", "validator-1", 900 + hseq, 900 + hseq, 1]);
  const hid = `h_h7${hseq}`;
  db.run(
    "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
    [hid, from, "Orchestrator", "result", JSON.stringify({ stage_id: sid, ticket_id: ticketId, verdict: "FAIL", findings: Array.from({ length: findings }, (_, i) => ({ severity: "blocking", text: `f${i}` })) }), "accepted", 1, 9999999999999],
  );
  return hid;
}

beforeAll(async () => {
  hub = await spawnHub();
  open.push(await registerAgent(hub, "boss", { room: "r1" }));
  expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
  db = new Database(hub.ledgerPath);
  db.exec("PRAGMA busy_timeout = 5000");
});
afterAll(async () => {
  db.close();
  for (const c of open) c.close();
  await hub.kill();
});

describe("GET /rooms/<room>/decisions", () => {
  test("a human decision on a ticket: choose card with options, facts, radius, waiting tickets and FAIL history", async () => {
    const t = await ticket({ blast_radius: "high" });
    const waiter = await ticket({ blocked_by: [t] });
    const failA = seedFail(t, 2);
    const failB = seedFail(t, 0);
    const id = await lead({ ticket_id: t, request_id: undefined });
    const c = (await cards()).find((x) => x.id === id)!;
    expect(c).toMatchObject({
      card_kind: "choose", ticket_id: t, request_id: null, radius: "high", waiting_tickets: [waiter],
      block: "A scope change stops the work.", summary: "A scope change stops the work.", decider: "human", state: "open",
      facts: ["1. Commit 9e2250b holds the plan."],
    });
    expect(c.options.filter((o: any) => o.recommended).map((o: any) => o.id)).toEqual(["A"]);
    expect(c.fail_history).toEqual([{ handoff_id: failA, findings: 2 }, { handoff_id: failB, findings: 0 }]);
    expect(typeof c.asked_at_ms).toBe("number");
  });

  test("FAIL history counts only result handoffs sent by the session of a validator stage", async () => {
    const t = await ticket();
    const ok = seedFail(t, 1);
    seedFail(t, 3, "validator", "someone-else");
    seedFail(t, 3, "worker");
    const id = await lead({ ticket_id: t, request_id: undefined });
    const c = (await cards()).find((x) => x.id === id)!;
    expect(c.fail_history).toEqual([{ handoff_id: ok, findings: 1 }]);
  });

  test("a feature decision is an approve card", async () => {
    const id = await lead({ reason: "feature", request_id: "req-feature" });
    const c = (await cards()).find((x) => x.id === id)!;
    expect(c.card_kind).toBe("approve");
    expect(c.radius).toBeNull();
    expect(c.waiting_tickets).toEqual([]);
  });

  test("an arbiter ruling is a review card with its text as summary and no block", async () => {
    const t = await ticket();
    seedDecision("d_00000000000000e1", { ticket_id: t, status: "escalated", created_at_ms: Date.now() + 5000 });
    const c = (await cards()).find((x) => x.id === "d_00000000000000e1")!;
    expect(c).toMatchObject({ card_kind: "review", decider: "arbiter", state: "escalated", block: null, summary: "Arbiter kept the scope.", options: [], facts: [], radius: "low" });
  });

  test("without state: open and escalated only, newest first", async () => {
    seedDecision("d_00000000000000e2", { status: "applied", created_at_ms: Date.now() + 9000 });
    seedDecision("d_00000000000000e3", { status: "answered", decider: "human", created_at_ms: Date.now() + 9000 });
    const rows = await cards();
    expect(rows.map((r) => r.id)).not.toContain("d_00000000000000e2");
    expect(rows.map((r) => r.id)).not.toContain("d_00000000000000e3");
    expect(rows.every((r) => r.state === "open" || r.state === "escalated")).toBe(true);
    const times = rows.map((r) => r.asked_at_ms);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("state=applied&since returns the decisions applied since then, newest applied first", async () => {
    seedDecision("d_00000000000000f1", { status: "applied", created_at_ms: 10 });
    seedDecision("d_00000000000000f2", { status: "applied", created_at_ms: 20 });
    seedDecision("d_00000000000000f3", { status: "applied", created_at_ms: 30 });
    seedEvent("d_00000000000000f1", "decision.applied", 5_000_000);
    seedEvent("d_00000000000000f2", "decision.applied", 7_000_000);
    seedEvent("d_00000000000000f3", "decision.applied", 1_000_000);
    const rows = await cards("?state=applied&since=4000000");
    expect(rows.map((r) => r.id)).toEqual(["d_00000000000000f2", "d_00000000000000f1"]);
    expect(rows.every((r) => r.state === "applied" && r.decider === "arbiter")).toBe(true);
  });

  test("a room with no decision gets 200 and an empty list", async () => {
    const r = await list("", "empty-room");
    expect(r.status).toBe(200);
    expect((r.json as { decisions: unknown[] }).decisions).toEqual([]);
  });

  test("an invalid room, state or since gets 400", async () => {
    expect((await list("", "bad%20room!")).status).toBe(400);
    expect((await list("", "%")).status).toBe(400);
    expect((await list("", "bad%E0%A4%A")).status).toBe(400);
    expect((await list("?state=nope")).status).toBe(400);
    expect((await list("?state=applied&since=abc")).status).toBe(400);
  });

  test("the existing GET /decisions?room= is unchanged: raw snapshots, open and escalated", async () => {
    const r = (await getJson(hub, `/decisions?room=r1&token=${hub.token}`)).json as { room: string; decisions: Card[] };
    expect(r.room).toBe("r1");
    expect(r.decisions.length).toBeGreaterThan(0);
    for (const d of r.decisions) {
      expect(d).toHaveProperty("status");
      expect(d).not.toHaveProperty("card_kind");
    }
  });

  test("no token gets 401", async () => {
    expect((await fetch(`${hub.url}/rooms/r1/decisions`)).status).toBe(401);
  });
});
