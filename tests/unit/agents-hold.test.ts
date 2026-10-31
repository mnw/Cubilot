// Hold list for an agent under human control (hub-first-browser, group 9.3, design decision 4).
import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../../hub/core/agents";

function world(queueMax = 3) {
  let roster = 0;
  let presence = 0;
  const registry = createAgentRegistry({
    defaultRoom: "r", staleMs: 60_000, queueMax,
    resolveRoom: (r) => r ?? "r", onRosterChange: () => { roster++; }, onPresenceChange: () => { presence++; },
  });
  registry.ensure("w1", "r");
  const msg = (text: string) => ({ from: "orch", to: "w1", text, ts: "", image: null, room: "r" }) as any;
  const drain = async (n: number) => {
    const ac = new AbortController();
    const got: string[] = [];
    try {
      for await (const e of registry.subscribe("w1", ac.signal)) {
        got.push(e.text as string);
        if (got.length >= n) break;
      }
    } finally { ac.abort(); }
    return got;
  };
  return { registry, msg, drain, counts: () => ({ roster, presence }) };
}

describe("Held message", () => {
  test("a held agent gets nothing, /agents data and presence show held: 1, hand back delivers in order", async () => {
    const w = world(10);
    expect(w.registry.setHeld("w1", true)).toBe(true);
    expect(w.registry.setHeld("w1", true)).toBe(false); // no change
    w.registry.enqueueFor("w1", w.msg("one"));
    w.registry.enqueueFor("w1", w.msg("two"));
    expect(w.registry.heldCount("w1")).toBe(2);
    expect(w.registry.isHeld("w1")).toBe(true);
    expect((w.registry.presenceSnapshot() as any).held).toEqual({ w1: 2 });
    const row = (w.registry.rosterSnapshot() as any).agents.find((a: any) => a.name === "w1");
    expect(row.held).toBe(2);
    expect(w.registry.get("w1")).toEqual(expect.objectContaining({ name: "w1" }));
    const ac = new AbortController();
    const early: string[] = [];
    const reader = (async () => { for await (const e of w.registry.subscribe("w1", ac.signal)) early.push(e.text as string); })();
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await reader;
    expect(early).toEqual([]);
    w.registry.setHeld("w1", false);
    expect(w.registry.heldCount("w1")).toBe(0);
    expect((w.registry.presenceSnapshot() as any).held).toEqual({});
    expect(await w.drain(2)).toEqual(["one", "two"]);
  });

  test("an entry queued before the hold waits in the hold list when it is claimed", async () => {
    const w = world(10);
    w.registry.enqueueFor("w1", w.msg("before"));
    w.registry.setHeld("w1", true);
    const ac = new AbortController();
    const it = w.registry.subscribe("w1", ac.signal);
    const first = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r("none"), 80))]);
    expect(first).toBe("none");
    ac.abort();
    expect(w.registry.heldCount("w1")).toBe(1);
  });

  test("the hold list drops its oldest entry at the queue cap", async () => {
    const w = world(3);
    w.registry.setHeld("w1", true);
    for (const t of ["a", "b", "c", "d", "e"]) w.registry.enqueueFor("w1", w.msg(t));
    expect(w.registry.heldCount("w1")).toBe(3);
    w.registry.setHeld("w1", false);
    expect(await w.drain(3)).toEqual(["c", "d", "e"]);
  });

  test("hand back re-applies the pause policy", async () => {
    const w = world(10);
    w.registry.setHeld("w1", true);
    w.registry.enqueueFor("w1", w.msg("peer"));
    w.registry.setPaused("w1", true);
    w.registry.setHeld("w1", false);
    expect(w.registry.heldCount("w1")).toBe(0);
    w.registry.enqueueFor("w1", { from: "you", to: "w1", text: "human", ts: "", image: null, room: "r" } as any);
    expect(await w.drain(1)).toEqual(["human"]);
  });

  test("agent removal releases the hold: the new agent of that name starts empty", () => {
    const w = world(10);
    w.registry.setHeld("w1", true);
    w.registry.enqueueFor("w1", w.msg("x"));
    w.registry.remove("w1", "test");
    expect(w.registry.heldCount("w1")).toBe(0);
    expect(w.registry.isHeld("w1")).toBe(false);
    w.registry.ensure("w1", "r");
    expect(w.registry.heldCount("w1")).toBe(0);
    expect(w.registry.isHeld("w1")).toBe(false);
  });

  test("a change of the hold or of the count fires the presence callback", () => {
    const w = world(10);
    const p0 = w.counts().presence;
    w.registry.setHeld("w1", true);
    expect(w.counts().presence).toBe(p0 + 1);
    w.registry.enqueueFor("w1", w.msg("x"));
    expect(w.counts().presence).toBe(p0 + 2);
  });

  test("an unknown agent cannot be held", () => {
    const w = world(10);
    expect(w.registry.setHeld("ghost", true)).toBe(false);
    expect(w.registry.heldCount("ghost")).toBe(0);
  });
});
