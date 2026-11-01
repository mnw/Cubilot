import { describe, expect, test } from "bun:test";
import type { DeliveryMode, Host } from "../../hub/channel/host";
import { DIGEST_MS, renderEvent, resultSummary, startBridge, type BridgeEvent } from "../../hub/channel/core";

const FINDING_TEXT = "SECRET-FINDING-TEXT the lead must not see";
const resultEvent = (over: Partial<BridgeEvent> = {}, context: Record<string, unknown> = {}): BridgeEvent => ({
  id: 7,
  from: "validator-1",
  to: "Orchestrator",
  room: "r1",
  kind: "handoff.new",
  handoff_id: "h_0123456789abcdef",
  lead: "Orchestrator",
  text: JSON.stringify({
    id: "h_0123456789abcdef",
    task: "result t_0123456789abcdef",
    context: {
      ticket_id: "t_0123456789abcdef",
      verdict: "FAIL",
      notes: "long notes",
      findings: [
        ...Array.from({ length: 4 }, (_, i) => ({ ticket_id: "t_0123456789abcdef", severity: "blocking", text: `${FINDING_TEXT} ${i}` })),
        ...Array.from({ length: 2 }, (_, i) => ({ ticket_id: "t_0123456789abcdef", severity: "suggestion", text: `${FINDING_TEXT} s${i}` })),
      ],
      ...context,
    },
  }),
  ...over,
});

describe("result summary for the lead", () => {
  test("FAIL result", () => {
    const text = renderEvent(resultEvent(), "Orchestrator", "r1");
    expect(text).toContain("t_0123456789abcdef");
    expect(text).toContain("FAIL");
    expect(text).toContain("6 findings (4 blocking, 2 suggestion)");
    expect(text).toContain("h_0123456789abcdef");
    expect(text).not.toContain("SECRET-FINDING-TEXT");
    expect(text).not.toContain("long notes");
  });

  test("a spec review result names the request id", () => {
    const text = renderEvent(resultEvent({}, { ticket_id: undefined, request_id: "r-1", verdict: "PASS", findings: [] }), "Orchestrator", "r1");
    expect(text).toContain("request r-1, PASS, 0 findings");
  });

  test("findings without a severity are counted without a split", () => {
    const text = renderEvent(resultEvent({}, { findings: [{ ticket_id: "t_0123456789abcdef", text: "x" }] }), "Orchestrator", "r1");
    expect(text).toContain("1 findings.");
  });

  test("an agent that is not the lead gets the full result", () => {
    const evt = resultEvent({ to: "bob" });
    expect(resultSummary(evt, "bob")).toBeNull();
    expect(renderEvent(evt, "bob", "r1")).toContain(FINDING_TEXT);
  });

  test("the lead gets the full text of a handoff with no verdict", () => {
    const evt = resultEvent({}, { verdict: undefined });
    expect(resultSummary(evt, "Orchestrator")).toBeNull();
    expect(renderEvent(evt, "Orchestrator", "r1")).toContain(FINDING_TEXT);
  });

  test("a handoff update and a handoff to someone else are not summarised", () => {
    expect(resultSummary(resultEvent({ kind: "handoff.update" }), "Orchestrator")).toBeNull();
    expect(resultSummary(resultEvent({ to: "bob" }), "Orchestrator")).toBeNull();
  });
});

type Delivery = { id: number | null; text: string; mode: DeliveryMode };

// Fake Host for the lead (or not): scripted SSE in, deliveries out, a sleep the test ends by hand.
function setup(lead: string | null) {
  const delivered: Delivery[] = [];
  const sleeps: Array<{ ms: number; end: () => void }> = [];
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  const host: Host = {
    readText: async (p) => (p.endsWith("hub.url") ? "http://hub.test" : p.endsWith("hub.token") ? "tok" : null),
    request: async (url) => ({ status: 200, text: url.endsWith("/lead") ? JSON.stringify({ room: "r1", lead }) : "{}" }),
    upload: async () => ({ status: 200, text: "{}" }),
    async *stream(_u, _t, signal) {
      while (!signal.aborted) {
        while (pending.length) yield pending.shift()!;
        await new Promise<void>((r) => {
          wake = r;
          signal.addEventListener("abort", () => r(), { once: true });
        });
      }
    },
    deliver: async (d) => {
      delivered.push({ id: d.id, text: d.text, mode: d.mode });
    },
    reload: async () => {},
    exec: async () => ({ code: 0, stderr: "", timedOut: false }),
    handoffGate: async () => null,
    stageId: async () => null,
    log: () => {},
  };
  const bridge = startBridge(host, {
    agent: "Orchestrator",
    room: "r1",
    hubEnv: "",
    sleep: (ms) => new Promise<void>((end) => sleeps.push({ ms, end })),
  });
  const push = (evt: BridgeEvent) => {
    pending.push(`data: ${JSON.stringify(evt)}\n\n`);
    wake?.();
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(fn()).toBe(true);
  };
  const settle = () => new Promise((r) => setTimeout(r, 40));
  return { bridge, delivered, sleeps, push, until, settle };
}

const ticket = (n: number, snap: Record<string, unknown> = {}, over: Partial<BridgeEvent> = {}): BridgeEvent => ({
  id: n, from: "worker-1", to: "all", room: "r1", kind: "ticket.update", text: "{}",
  snapshot: { id: `t_${n}`, title: `Ticket ${n}`, status: "in_progress", assignee: "worker-1", ...snap } as BridgeEvent["snapshot"],
  ...over,
});

describe("ticket digest for the room lead", () => {
  test("Three ticket events: one digest that lists the three tickets", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1));
    t.push(ticket(2));
    t.push(ticket(3));
    await t.until(() => t.sleeps.length === 1);
    await t.settle();
    expect(t.delivered).toHaveLength(0);
    expect(t.sleeps[0].ms).toBe(DIGEST_MS);
    t.sleeps[0].end();
    await t.until(() => t.delivered.length === 1);
    const d = t.delivered[0];
    expect(d.mode).toBe("context");
    expect(d.text).toContain("3 ticket events, 3 tickets");
    for (const id of ["t_1", "t_2", "t_3"]) expect(d.text).toContain(id);
    t.bridge.stop();
  });

  test("a ticket with several events is one line with the newest state", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1, { status: "claimed" }));
    t.push(ticket(2, { id: "t_1", status: "in_review" }));
    await t.until(() => t.sleeps.length === 1);
    await t.settle();
    t.sleeps[0].end();
    await t.until(() => t.delivered.length === 1);
    const lines = t.delivered[0].text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(2x)");
    expect(lines[0]).toContain("status=in_review");
    t.bridge.stop();
  });

  test("Escalation: a decision entry comes at once, with the held digest before it", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1));
    await t.until(() => t.sleeps.length === 1);
    await t.settle();
    expect(t.delivered).toHaveLength(0);
    t.push({ id: 9, from: "system", to: "Orchestrator", room: "r1", kind: "decision.new", text: "decision opens" });
    await t.until(() => t.delivered.length === 2);
    expect(t.delivered[0].text).toContain("t_1");
    expect(t.delivered[1].text).toContain("decision opens");
    expect(t.delivered[1].mode).toBe("wake");
    t.bridge.stop();
  });

  test("a decision entry with no held ticket is delivered at once", async () => {
    const t = setup("Orchestrator");
    t.push({ id: 9, from: "system", to: "Orchestrator", room: "r1", kind: "decision.new", text: "decision opens" });
    await t.until(() => t.delivered.length === 1);
    expect(t.delivered[0].mode).toBe("wake");
    t.bridge.stop();
  });

  test("a waking ticket entry (a new unassigned ticket) flushes the digest with it", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1));
    await t.until(() => t.sleeps.length === 1);
    await t.settle();
    t.push(ticket(2, { assignee: null, status: "queued" }, { kind: "ticket.new", lead: "Orchestrator" }));
    await t.until(() => t.delivered.length === 2);
    expect(t.delivered[0].text).toContain("[Cubilot ticket digest]");
    expect(t.delivered[1].mode).toBe("wake");
    t.bridge.stop();
  });

  test("a ticket.held entry has no snapshot: it comes at once with its full text", async () => {
    const t = setup("Orchestrator");
    const text = "These tickets stayed draft because their role has no hub stage chain:\n- t_aaaaaaaaaaaaaaaa (role writer)";
    t.push({ id: 11, from: "system", to: "Orchestrator", room: "r1", kind: "ticket.held", text });
    await t.until(() => t.delivered.length === 1);
    expect(t.delivered[0].text).toContain("t_aaaaaaaaaaaaaaaa");
    expect(t.delivered[0].text).toContain("no hub stage chain");
    expect(t.delivered[0].text).not.toContain("digest");
    t.bridge.stop();
  });

  test("a FAIL count of 2 or more comes at once; a count of 1 waits", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1, {}, { fail_count: 1 }));
    t.push(ticket(2, {}, { fail_count: 2 }));
    await t.until(() => t.delivered.length === 1);
    expect(t.delivered[0].id).toBe(2);
    expect(t.delivered[0].text).not.toContain("digest");
    t.bridge.stop();
  });

  test("a request that waits for approval comes at once", async () => {
    const t = setup("Orchestrator");
    t.push(ticket(1, { status: "in_review", approval_request_id: "p_1" }));
    await t.until(() => t.delivered.length === 1);
    expect(t.delivered[0].text).not.toContain("digest");
    t.bridge.stop();
  });

  test("an agent that is not the lead gets ticket entries at once", async () => {
    const t = setup("someone-else");
    t.push(ticket(1));
    t.push(ticket(2));
    await t.until(() => t.delivered.length === 2);
    expect(t.sleeps).toHaveLength(0);
    t.bridge.stop();
  });
});
