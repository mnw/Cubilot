// Decision kind (P6-01): the state machine in process (every move, every refusal), the routes through the real hub.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { createDecisionKind, parseEscalation, type DecisionStatus } from "../../hub/kinds/decision";
import { deliverEntry } from "../../hub/features/streams";
import { createTicketKind } from "../../hub/kinds/ticket";
import { LedgerConflict } from "../../hub/core/types";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const T1 = "t_00000000000000a1";
const STATUSES: DecisionStatus[] = ["recorded", "applied", "escalated", "open", "answered", "overruled"];
const LEGAL: Array<[DecisionStatus, DecisionStatus]> = [
  ["recorded", "applied"], ["recorded", "escalated"], ["escalated", "answered"], ["open", "answered"], ["applied", "overruled"],
];

// ---- in-process harness ----
function setup() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const tickets = createTicketKind(db);
  tickets.migrate(db);
  const kind = createDecisionKind(db);
  kind.migrate(db);
  db.run("INSERT INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('r1', 'boss', 0)");
  const emitted: Array<{ entry: any; scope: any }> = [];
  const cap: any = {
    db,
    agents: { get: (n: string) => (n === "boss" ? { name: "boss", room: "r1", permanent: false } : null), isPaused: () => false, all: () => [], isPermanent: () => false },
    sse: { emit: (entry: any, scope: any) => emitted.push({ entry, scope }) },
    events: { insert: insertEvent },
    config: { humanName: "human", defaultRoom: "r1" },
  };
  const events = (id: string) => db.query<{ kind: string; payload_json: string }, [string]>("SELECT kind, payload_json FROM events WHERE entity_id = ? ORDER BY seq").all(id);
  const create = (status: "recorded" | "open", extra: Record<string, unknown> = {}) =>
    kind.api.create(cap, { status, room: "r1", ticket_id: null, request_id: "req-1", decider: status === "open" ? "human" : "arbiter", fail_count: 2, ...extra } as any, "boss");
  return { db, kind, cap, emitted, events, create };
}

const OPTIONS = [
  { id: "A", label: "Keep the scope", effect: "No change.", recommended: true },
  { id: "B", label: "Widen the scope", effect: "One more ticket." },
];
const escalation = (over: Record<string, unknown> = {}) => ({
  reason: "irreversible",
  block: "A delete outside the factory stops the work.",
  facts: ["1. Commit 9e2250b holds the plan."],
  options: OPTIONS,
  human_actions: [{ ticket_id: T1, action: "Tell the Orchestrator A or B." }],
  next: "The Orchestrator applies the answer.",
  request_id: "req-1",
  ...over,
});

// What the agent stream does with entries: it sends an entry unless its claim() refuses.
const sentByStream = (entries: Array<{ claim?: () => boolean }>) => entries.filter((e) => e.claim?.() !== false);
const leadEntries = (emitted: Array<{ entry: any; scope: any }>) => emitted.filter((e) => e.scope.kind === "to-agents").map((e) => e.entry);

describe("decision kind: state machine (R5)", () => {
  for (const [from, to] of LEGAL) {
    test(`legal move ${from} -> ${to} writes one event and one row update`, () => {
      const s = setup();
      const d = s.create(from === "recorded" || from === "applied" || from === "escalated" ? "recorded" : "open");
      // walk to `from`
      if (from === "applied") s.kind.api.move(s.cap, d.id, "applied", "boss");
      if (from === "escalated") s.kind.api.move(s.cap, d.id, "escalated", "boss");
      const before = s.events(d.id).length;
      const r = s.kind.api.move(s.cap, d.id, to, to === "answered" ? "human" : "boss", to === "answered" ? { option: "A", text: "go" } : {});
      expect(r.emitted).toBe(true);
      expect(r.snapshot.status).toBe(to);
      const ev = s.events(d.id);
      expect(ev.length).toBe(before + 1);
      expect(ev.at(-1)!.kind).toBe(`decision.${to}`);
      expect(s.db.query<{ status: string }, [string]>("SELECT status FROM decisions WHERE id = ?").get(d.id)!.status).toBe(to);
    });
  }

  test("a decision starts recorded or open, with one creation event", () => {
    const s = setup();
    expect(s.create("recorded").status).toBe("recorded");
    const o = s.create("open");
    expect(o.status).toBe("open");
    expect(s.events(o.id).map((e) => e.kind)).toEqual(["decision.open"]);
  });

  test("every other pair gets 409 and writes nothing", () => {
    // Each starting status is reached by its legal path.
    const reach: Record<DecisionStatus, (s: ReturnType<typeof setup>) => string> = {
      recorded: (s) => s.create("recorded").id,
      applied: (s) => { const d = s.create("recorded"); s.kind.api.move(s.cap, d.id, "applied", "boss"); return d.id; },
      escalated: (s) => { const d = s.create("recorded"); s.kind.api.move(s.cap, d.id, "escalated", "boss"); return d.id; },
      open: (s) => s.create("open").id,
      answered: (s) => { const d = s.create("open"); s.kind.api.move(s.cap, d.id, "answered", "human", { option: "A" }); return d.id; },
      overruled: (s) => { const d = s.create("recorded"); s.kind.api.move(s.cap, d.id, "applied", "boss"); s.kind.api.move(s.cap, d.id, "overruled", "human"); return d.id; },
    };
    let checked = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to || LEGAL.some(([f, t]) => f === from && t === to)) continue;
        const s = setup();
        const id = reach[from](s);
        const events = s.events(id).length;
        let err: unknown;
        try { s.kind.api.move(s.cap, id, to, "human"); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(LedgerConflict);
        expect((err as LedgerConflict).httpStatus).toBe(409);
        expect(s.events(id).length).toBe(events);
        expect(s.db.query<{ status: string }, [string]>("SELECT status FROM decisions WHERE id = ?").get(id)!.status).toBe(from);
        checked++;
      }
    }
    expect(checked).toBe(6 * 5 - LEGAL.length);
  });

  test("answered is final: answered -> overruled gets 409", () => {
    const s = setup();
    const d = s.create("open");
    s.kind.api.move(s.cap, d.id, "answered", "human", { option: "A" });
    expect(() => s.kind.api.move(s.cap, d.id, "overruled", "human")).toThrow(/illegal move answered -> overruled/);
  });

  test("a same-status retry is idempotent: no event", () => {
    const s = setup();
    const d = s.create("open");
    s.kind.api.move(s.cap, d.id, "answered", "human", { option: "A" });
    const n = s.events(d.id).length;
    expect(s.kind.api.move(s.cap, d.id, "answered", "human", { option: "B" }).emitted).toBe(false);
    expect(s.events(d.id).length).toBe(n);
  });

  test("a missing decision gets 404", () => {
    const s = setup();
    expect(() => s.kind.api.move(s.cap, "d_ffffffffffffffff", "applied", "boss")).toThrow(/not found/);
  });

  test("a second migrate changes nothing", () => {
    const s = setup();
    const dump = () => s.db.query("SELECT sql FROM sqlite_master WHERE name LIKE '%decisions%' ORDER BY name").all();
    const before = dump();
    s.kind.migrate(s.db);
    expect(dump()).toEqual(before);
  });
});

describe("decision kind: answer route in process", () => {
  const answerRoute = (s: ReturnType<typeof setup>) => s.kind.routes.find((r) => r.path instanceof RegExp && String(r.path).includes("answer"))!;
  const answer = (s: ReturnType<typeof setup>, id: string, body: Record<string, unknown>) =>
    answerRoute(s).handler(new Request("http://x/", { method: "POST", body: JSON.stringify(body) }), s.cap, { id });

  test("an escalated decision is answered by the human", async () => {
    const s = setup();
    const d = s.create("recorded");
    s.kind.api.move(s.cap, d.id, "escalated", "boss");
    const res = await answer(s, d.id, { by: "human", option: "B", text: "widen" });
    expect(res.status).toBe(200);
    expect(s.events(d.id).filter((e) => e.kind === "decision.answered")).toHaveLength(1);
  });

  test("a request-only answer: no ticket note, one decision.answered, one lead entry", async () => {
    const s = setup();
    const d = s.create("open", { ticket_id: null, request_id: "req-9" });
    const res = await answer(s, d.id, { by: "human", option: "A", text: "ok" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ticket_note).toBe(false);
    expect(s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'ticket.noted'").get()!.n).toBe(0);
    expect(s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ticket_notes").get()!.n).toBe(0);
    expect(s.events(d.id).filter((e) => e.kind === "decision.answered")).toHaveLength(1);
    expect(JSON.parse(s.events(d.id).at(-1)!.payload_json)).toMatchObject({ actor: "human", option: "A", text: "ok" });
    const toLead = s.emitted.filter((e) => e.scope.kind === "to-agents" && e.scope.agents[0] === "boss");
    expect(toLead).toHaveLength(1);
    expect(toLead[0].entry.from).toBe("human");
  });

  test("a retry of an answered decision sends no second entry", async () => {
    const s = setup();
    const d = s.create("open");
    await answer(s, d.id, { by: "human", option: "A" });
    expect(sentByStream(leadEntries(s.emitted))).toHaveLength(1);   // the stream claims the first copy
    const n = s.emitted.length;
    const again = await answer(s, d.id, { by: "human", option: "A" });
    expect(again.status).toBe(200);
    expect(sentByStream(leadEntries(s.emitted.slice(n)))).toHaveLength(0);
  });

  test("an answer on a decision that cannot be answered gets 409", async () => {
    const s = setup();
    const d = s.create("recorded");
    expect((await answer(s, d.id, { by: "human", option: "A" })).status).toBe(409);
  });
});

describe("decision kind: routes through the real hub", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let ticket: string;

  beforeAll(async () => {
    hub = await spawnHub();
    open.push(await registerAgent(hub, "boss", { room: "r1" }));
    open.push(await registerAgent(hub, "worker", { room: "r1" }));
    expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
    const t = await postJson(hub, "/tickets", { by: "boss", title: "Ship", acceptance_criteria: "Tests pass.", blast_radius: "low", priority: "high", status: "draft" });
    ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("Install question: the lead opens a decision and the human sees one Needs-you line", async () => {
    const r = await postJson(hub, "/decisions", { by: "boss", ...escalation({ ticket_id: ticket }) });
    expect(r.status).toBe(201);
    const id = (r.json as { id: string }).id;
    const list = await getJson(hub, `/decisions?room=r1&token=${hub.token}`);
    const lines = (list.json as { decisions: Array<{ id: string; status: string }> }).decisions;
    expect(lines.filter((d) => d.id === id)).toHaveLength(1);
    expect(lines.find((d) => d.id === id)!.status).toBe("open");
  });

  test("Missing option: one option gets 400", async () => {
    const r = await postJson(hub, "/decisions", { by: "boss", ...escalation({ options: [OPTIONS[0]] }) });
    expect(r.status).toBe(400);
  });

  test("each missing part of the escalation format gets 400", async () => {
    const bad: Array<Record<string, unknown>> = [
      { reason: "other" }, { block: "" }, { block: "Two\nlines" }, { block: "One. Two." }, { facts: [] },
      { facts: ["unchecked prose"] }, { facts: ["1. Commit 9e2250b holds the plan.", "unchecked prose"] },
      { options: [...OPTIONS, { id: "C", label: "c", effect: "e" }, { id: "D", label: "d", effect: "e" }] },
      { options: OPTIONS.map((o) => ({ ...o, recommended: false })) },
      { options: OPTIONS.map((o) => ({ ...o, recommended: true })) },
      { human_actions: [] }, { human_actions: [{ ticket_id: "t_1", action: "Do it." }] }, { next: "" },
      { request_id: undefined }, { ticket_id: "t_ffffffffffffffff" },
    ];
    for (const over of bad) {
      expect((await postJson(hub, "/decisions", { by: "boss", ...escalation(over) })).status).toBe(400);
    }
  });

  test("another agent and the human get 403; no token gets 401", async () => {
    expect((await postJson(hub, "/decisions", { by: "worker", ...escalation() })).status).toBe(403);
    expect((await postJson(hub, "/decisions", { by: hub.humanName, ...escalation() })).status).toBe(403);
    const raw = await fetch(`${hub.url}/decisions`, { method: "POST", body: JSON.stringify({ by: "boss", ...escalation() }), headers: { "Content-Type": "application/json" } });
    expect(raw.status).toBe(401);
  });

  test("Human answers: answered, the lead gets the answer once, the ticket gets one note; an agent gets 403", async () => {
    const r = await postJson(hub, "/decisions", { by: "boss", ...escalation({ ticket_id: ticket }) });
    const id = (r.json as { id: string }).id;
    expect((await postJson(hub, `/decisions/${id}/answer`, { by: "worker", option: "B" })).status).toBe(403);
    expect((await postJson(hub, `/decisions/${id}/answer`, { by: "boss", option: "B" })).status).toBe(403);
    expect((await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "Z" })).status).toBe(400);
    const ok = await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "B", text: "widen it" });
    expect(ok.status).toBe(200);
    expect((ok.json as { snapshot: { status: string; option: string } }).snapshot).toMatchObject({ status: "answered", option: "B" });
    expect((ok.json as { ticket_note: boolean }).ticket_note).toBe(true);
    const notes = (await getJson(hub, `/tickets/${ticket}/notes?token=${hub.token}`)).json as Array<{ author: string; text: string }>;
    expect(notes.filter((n) => n.text.includes(id))).toHaveLength(1);
    expect(notes.find((n) => n.text.includes(id))!.author).toBe(hub.humanName);
    // answered leaves the Needs-you list
    const list = (await getJson(hub, `/decisions?room=r1&token=${hub.token}`)).json as { decisions: Array<{ id: string }> };
    expect(list.decisions.some((d) => d.id === id)).toBe(false);
    // a retry is idempotent and adds no second note
    expect((await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "B" })).status).toBe(200);
    const again = (await getJson(hub, `/tickets/${ticket}/notes?token=${hub.token}`)).json as Array<{ text: string }>;
    expect(again.filter((n) => n.text.includes(id))).toHaveLength(1);
  });

  test("a request without a bearer token cannot read the list", async () => {
    expect((await fetch(`${hub.url}/decisions?room=r1`)).status).toBe(401);
    expect((await authedFetch(hub, "/decisions?room=bad%20/room")).status).toBe(400);
  });
});

describe("decision kind: fan-out (1.3)", () => {
  test("a second agent in the room gets no decision entry; the lead gets exactly one on the answer", async () => {
    const hub = await spawnHub();
    try {
      const got: Record<string, any[]> = { boss: [], worker: [] };
      const streams = ["boss", "worker"].map((n) => {
        const sse = openSSE(hub, `/agent-stream?agent=${n}&room=r1`);
        (async () => { for await (const e of sse.events) got[n].push(e); })().catch(() => {});
        return sse;
      });
      await Bun.sleep(300);
      expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
      const r = await postJson(hub, "/decisions", { by: "boss", ...escalation() });
      expect(r.status).toBe(201);
      const id = (r.json as { id: string }).id;
      expect((await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "A" })).status).toBe(200);
      await Bun.sleep(400);
      const mentions = (n: string) => got[n].filter((e) => JSON.stringify(e).includes(id));
      expect(mentions("worker")).toHaveLength(0);
      expect(got.worker.some((e) => JSON.stringify(e).includes("decision.answered"))).toBe(false);
      expect(mentions("boss")).toHaveLength(1);
      expect(JSON.stringify(mentions("boss")[0])).toContain("answered");
      for (const s of streams) s.close();
    } finally {
      await hub.kill();
    }
  });
});

describe("decision kind: rework 3 (h_0b38ad1b593d35f4)", () => {
  test("(a) parser: a full stop before a closing quote still ends the sentence", () => {
    for (const block of ['The log says "Stop." Another action waits.', "The log says (Stop.) Another action waits.", "Did it end?' Another action waits."]) {
      const r = parseEscalation(escalation({ block }) as any);
      expect("error" in r).toBe(true);
    }
    expect("error" in parseEscalation(escalation({ block: 'The log says "Stop."' }) as any)).toBe(false);
  });

  test("(a) route: two sentences with a quote gets 400", async () => {
    const hub = await spawnHub();
    try {
      const c = await registerAgent(hub, "boss", { room: "r1" });
      expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
      const r = await postJson(hub, "/decisions", { by: "boss", ...escalation({ block: 'The log says "Stop." Another action waits.' }) });
      expect(r.status).toBe(400);
      c.close();
    } finally {
      await hub.kill();
    }
  });

  test("(b) lead offline at answer time: one entry when the lead connects; a retry adds none", async () => {
    const s = setup();
    const kindRoutes = s.kind.routes;
    const answerRoute = kindRoutes.find((r) => r.path instanceof RegExp && String(r.path).includes("answer"))!;
    const d = s.create("open");
    let leadHere = false;
    s.cap.agents.get = (n: string) => (n === "boss" && leadHere ? { name: "boss", room: "r1", permanent: false } : null);
    const ans = () => answerRoute.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ by: "human", option: "A" }) }), s.cap, { id: d.id });
    expect((await ans()).status).toBe(200);
    expect(s.emitted.filter((e) => e.scope.kind === "to-agents")).toHaveLength(0);
    leadHere = true;
    const first = s.kind.pendingFor({ name: "boss", room: "r1", permanent: false }, s.cap);
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain(d.id);
    expect(sentByStream(first)).toHaveLength(1);                    // the stream sends it and so claims it
    expect(s.kind.pendingFor({ name: "boss", room: "r1", permanent: false }, s.cap)).toHaveLength(0);
    expect((await ans()).status).toBe(200);
    expect(s.emitted.filter((e) => e.scope.kind === "to-agents")).toHaveLength(0);
    expect(s.events(d.id).filter((e) => e.kind === "decision.answered")).toHaveLength(1);
  });

  test("(b) lead offline: a retry delivers the undelivered answer once", async () => {
    const s = setup();
    const answerRoute = s.kind.routes.find((r) => r.path instanceof RegExp && String(r.path).includes("answer"))!;
    const d = s.create("open");
    const realGet = s.cap.agents.get;
    s.cap.agents.get = () => null;
    const ans = () => answerRoute.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ by: "human", option: "A" }) }), s.cap, { id: d.id });
    await ans();
    s.cap.agents.get = realGet;
    await ans();
    expect(sentByStream(leadEntries(s.emitted))).toHaveLength(1);   // the stream sends it once
    await ans();
    expect(sentByStream(leadEntries(s.emitted))).toHaveLength(0);   // a retry after the send adds no second copy
    expect(s.kind.pendingFor({ name: "boss", room: "r1", permanent: false }, s.cap)).toHaveLength(0);
  });

  test("(c) a failed ticket note gives 500; the retry writes it once; a second retry adds none", async () => {
    const hub = await spawnHub();
    try {
      const boss = await registerAgent(hub, "boss", { room: "r1" });
      expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
      const t = await postJson(hub, "/tickets", { by: "boss", title: "Ship", acceptance_criteria: "Tests pass.", blast_radius: "low", priority: "high", status: "draft" });
      const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
      const id = ((await postJson(hub, "/decisions", { by: "boss", ...escalation({ ticket_id: ticket }) })).json as { id: string }).id;
      const side = new Database(hub.ledgerPath);
      side.run("CREATE TRIGGER fail_note BEFORE INSERT ON ticket_notes BEGIN SELECT RAISE(ABORT, 'injected'); END");
      const bad = await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "B" });
      expect(bad.status).toBe(500);
      expect(JSON.stringify(bad.json)).toContain("note");
      const notes = async () => ((await getJson(hub, `/tickets/${ticket}/notes?token=${hub.token}`)).json as Array<{ text: string }>).filter((n) => n.text.includes(id));
      expect(await notes()).toHaveLength(0);
      side.run("DROP TRIGGER fail_note");
      expect((await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "B" })).status).toBe(200);
      expect(await notes()).toHaveLength(1);
      expect((await postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "B" })).status).toBe(200);
      expect(await notes()).toHaveLength(1);
      const n = side.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE entity_id = ? AND kind = 'decision.answered'").get(id)!.n;
      expect(n).toBe(1);
      side.close();
      boss.close();
    } finally {
      await hub.kill();
    }
  });
});

// Rework 4 (h_c2ab8c6ffcb98087): an answer counts as delivered only when a lead stream receives it.
describe("decision kind: rework 4, delivery needs a lead stream", () => {
  const STALE_MS = 400;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function staleHub() {
    const orig = process.env.CUBILOT_STALE_AGENT_MS;
    process.env.CUBILOT_STALE_AGENT_MS = String(STALE_MS);
    try { return await spawnHub(); } finally {
      if (orig === undefined) delete process.env.CUBILOT_STALE_AGENT_MS; else process.env.CUBILOT_STALE_AGENT_MS = orig;
    }
  }
  function lead(hub: HubHandle) {
    const sse = openSSE(hub, "/agent-stream?agent=boss&room=r1");
    const texts: string[] = [];
    (async () => { try { for await (const e of sse.events) if (typeof e.text === "string") texts.push(e.text); } catch {} })();
    return { texts, close: sse.close };
  }
  const roster = async (hub: HubHandle) => ((await getJson(hub, "/agents")).json as Array<{ name: string }>).map((a) => a.name);

  test("(i) answer while the lead is disconnected, lead removed as stale: a new session gets it once", async () => {
    const hub = await staleHub();
    try {
      const first = lead(hub);
      await sleep(250);
      expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" })).status).toBe(200);
      const id = ((await postJson(hub, "/decisions", { by: "boss", ...escalation() })).json as { id: string }).id;
      first.close();
      await sleep(100);
      expect(await roster(hub)).toContain("boss");                 // away, not yet stale
      const ans = () => postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "A" });
      expect((await ans()).status).toBe(200);
      await sleep(STALE_MS * 3);
      expect(await roster(hub)).not.toContain("boss");             // removed as stale, queue gone
      const second = lead(hub);
      await sleep(400);
      expect(second.texts.filter((t) => t.includes(`Decision ${id} answered`))).toHaveLength(1);
      second.close();
    } finally {
      await hub.kill();
    }
  });

  test("(ii) no second delivery after a reconnect or a retry of the answer", async () => {
    const hub = await staleHub();
    try {
      const first = lead(hub);
      await sleep(250);
      await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: "boss" });
      const id = ((await postJson(hub, "/decisions", { by: "boss", ...escalation() })).json as { id: string }).id;
      const ans = () => postJson(hub, `/decisions/${id}/answer`, { by: hub.humanName, option: "A" });
      expect((await ans()).status).toBe(200);
      await sleep(300);
      expect(first.texts.filter((t) => t.includes(`Decision ${id} answered`))).toHaveLength(1);
      first.close();
      const again = lead(hub);
      await sleep(300);
      expect((await ans()).status).toBe(200);
      await sleep(300);
      expect(again.texts.filter((t) => t.includes(`Decision ${id} answered`))).toHaveLength(0);
      again.close();
    } finally {
      await hub.kill();
    }
  });
});

describe("decision kind: claim-to-send", () => {
  test("a send that fails after the claim leaves the answer undelivered; the next stream gets it once", () => {
    const { kind, cap, emitted, create, db } = setup();
    const id = create("open").id;
    kind.api.move(cap, id, "answered", "human", { option: "A" } as any);
    const entry = () => kind.pendingFor({ name: "boss", room: "r1", permanent: false } as any, cap)[0] as any;
    const first = entry();
    expect(first).toBeDefined();
    let sends = 0;
    deliverEntry(first, () => { sends++; return false; });            // claim passed, enqueue failed
    expect(sends).toBe(1);
    expect(db.query("SELECT 1 FROM decision_deliveries WHERE decision_id = ?").get(id)).toBeNull();
    const got: unknown[] = [];
    const ok = (o: unknown) => { got.push(o); return true; };
    const second = entry();
    expect(second).toBeDefined();
    deliverEntry(second, ok);
    expect(got).toHaveLength(1);
    expect(kind.pendingFor({ name: "boss", room: "r1", permanent: false } as any, cap)).toHaveLength(0);
    deliverEntry(second, ok);                                          // a second copy is skipped
    expect(got).toHaveLength(1);
    void emitted;
  });
});
