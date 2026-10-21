import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../../hub/core/agents";
import { createStreamHandlers } from "../../hub/features/streams";

// In-process, so the ordering that matters is exact: a removed agent's stream ends in a microtask, and a
// new stream of the same name can register in the same turn, before that cleanup runs.
function world(staleMs = 60_000) {
  const registry = createAgentRegistry({
    defaultRoom: "d", staleMs, queueMax: 10,
    resolveRoom: (r) => r ?? "d", onRosterChange() {}, onPresenceChange() {},
  });
  const handlers = createStreamHandlers({
    sessionId: "s", uiQueueMax: 10, defaultRoom: "d", ledgerEnabled: () => false,
    chatLog: [], uiSubscribers: new Set(), agents: registry, ensureAgent: registry.ensure,
    broadcastPresence() {}, roomHydrator: null, roomSummariser: null,
    buildBriefing: () => ({ type: "briefing" }) as any, seedBriefingSignature() {},
    kinds: [], buildCap: () => ({}) as any,
  });
  const open: Response[] = [];
  const stream = (name: string) => { const r = handlers.handleAgentStream(name, "r"); open.push(r); return r; };
  const closeAll = async () => { for (const r of open) await r.body?.cancel().catch(() => {}); };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  return { registry, stream, closeAll, tick };
}

describe("agent stream accounting follows the Agent object", () => {
  test("a removed agent's stream ends, and its late cleanup leaves the successor's count alone", async () => {
    const w = world();
    w.stream("x");
    expect(w.registry.connectionCount("x")).toBe(1);
    // All in one turn: the removal aborts the old stream, whose cleanup is a microtask away, and the
    // bridge's reconnect registers the same name again first.
    w.registry.remove("x", "manual");
    w.stream("x");
    expect(w.registry.connectionCount("x")).toBe(1);
    await w.tick();                                   // the old stream's cleanup has run now
    expect(w.registry.connectionCount("x")).toBe(1);  // it did not decrement the successor
    expect(w.registry.get("x")).not.toBeNull();
    await w.closeAll();
  });

  test("the successor stays registered past the stale timer", async () => {
    const w = world(80);
    w.stream("x");
    w.registry.remove("x", "manual");
    w.stream("x");
    await new Promise((r) => setTimeout(r, 300));    // several stale periods
    expect(w.registry.get("x")).not.toBeNull();
    expect(w.registry.connectionCount("x")).toBe(1);
    await w.closeAll();
  });

  test("a plain takeover (no removal) still leaves exactly one connection", async () => {
    const w = world();
    w.stream("x");
    w.stream("x");
    await w.tick();
    expect(w.registry.connectionCount("x")).toBe(1);
    await w.closeAll();
    await w.tick();
    expect(w.registry.connectionCount("x")).toBe(0);
  });

  const entry = (text: string) => ({ from: "human", to: "x", text, ts: "", image: null, room: "r" });

  test("a pull resolved just before the abort is handed back: the aborted reader ends, the successor gets the item first", async () => {
    const w = world();
    w.registry.ensure("x", "r");
    const ac = new AbortController();
    const next = w.registry.subscribe("x", ac.signal).next();    // the old reader waits
    w.registry.enqueueFor("x", entry("queued"));                  // resolves its pull at once...
    ac.abort();                                                   // ...and the takeover lands before it continues
    expect((await next).done).toBe(true);                         // it does not yield the item
    w.registry.enqueueFor("x", entry("later"));
    const fresh = w.registry.subscribe("x", new AbortController().signal);
    expect((await fresh.next()).value?.text).toBe("queued");      // kept, and still first
    expect((await fresh.next()).value?.text).toBe("later");
  });

  test("end to end: an event that reaches the old stream's pull in the same turn as the takeover reaches the new stream", async () => {
    const w = world();
    w.stream("x");                                                // the old bridge's stream, waiting
    w.registry.enqueueFor("x", entry("in-flight"));               // resolves its pull
    const second = w.stream("x");                                 // the restarted bridge connects in the same turn
    const reader = second.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 1000;
    while (!seen.includes("in-flight") && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((res) => setTimeout(() => res({ done: true }), 300))]);
      if (r.done) break;
      seen += decoder.decode(r.value);
    }
    expect(seen).toContain("in-flight");
    await w.closeAll();
  });

  test("queue order survives a takeover: the successor starts before the old reader's cleanup and still gets first, then second", async () => {
    const w = world();
    w.registry.ensure("x", "r");
    const ac = new AbortController();
    const next = w.registry.subscribe("x", ac.signal).next();
    w.registry.enqueueFor("x", entry("first"));                   // resolves the old reader's pull
    w.registry.enqueueFor("x", entry("second"));                  // queued behind it
    ac.abort();
    const fresh = w.registry.subscribe("x", new AbortController().signal);
    const got = fresh.next();                                      // the new stream starts before the old cleanup runs
    expect((await next).done).toBe(true);
    expect((await got).value?.text).toBe("first");
    expect((await fresh.next()).value?.text).toBe("second");
  });

  test("a takeover between the queue's hand-over and the SSE send keeps the unsent item for the new stream", async () => {
    const w = world();
    const old = w.stream("x");
    w.registry.enqueueFor("x", entry("send-boundary"));
    await Promise.resolve();                                      // the old reader holds the item, the consumer has not sent it yet
    const fresh = w.stream("x");                                  // the takeover lands in that gap
    w.registry.enqueueFor("x", entry("after-takeover"));
    const oldText = await old.text();                             // the old stream ends
    const reader = fresh.body!.getReader();
    let text = "";
    for (let i = 0; i < 8 && !text.includes("after-takeover"); i++) {
      const r = await reader.read();
      if (r.done) break;
      text += new TextDecoder().decode(r.value);
    }
    await reader.cancel();
    await w.closeAll();
    expect(oldText).not.toContain("send-boundary");
    expect(text).toContain("send-boundary");
    expect(text.indexOf("send-boundary")).toBeLessThan(text.indexOf("after-takeover"));
  });

  test("subscribeLeased: an entry is committed by take(); an abort before it hands the entry back in order", async () => {
    const w = world();
    w.registry.ensure("x", "r");
    const ac = new AbortController();
    const leased = w.registry.subscribeLeased("x", ac.signal);
    const next = leased.next();
    w.registry.enqueueFor("x", entry("one"));
    w.registry.enqueueFor("x", entry("two"));
    const got = await next;                                       // delivered to the consumer, not yet taken
    ac.abort();                                                   // the takeover lands before take()
    expect(got.value!.take()).toBe(false);                        // handed back already
    const fresh = w.registry.subscribeLeased("x", new AbortController().signal);
    const a = (await fresh.next()).value!;
    expect(a.item.text).toBe("one");
    expect(a.take()).toBe(true);
    const b = (await fresh.next()).value!;
    expect(b.item.text).toBe("two");
  });
});

