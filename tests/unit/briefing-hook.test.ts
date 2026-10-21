import { describe, expect, test } from "bun:test";
import { briefingSignature, createBriefingBuilder } from "../../hub/core/briefing";
import { createBriefingDispatcher } from "../../hub/core/briefing-dispatcher";
import type { HubCapabilities, KindModule } from "../../hub/core/types";

const alice = { name: "alice", color: "#000", room: "r1" };
const fakeAgents = (queued: unknown[] = []) =>
  ({
    get: (n: string) => (n === "alice" ? alice : null),
    entries: () => new Map([["alice", alice]]).entries(),
    isPermanent: () => false,
    connectionCount: () => 1,
    enqueueFor: (_n: string, e: unknown) => (queued.push(e), true),
  }) as any;

function kind(lines: () => string[] | undefined): KindModule {
  return {
    kind: "k", routes: [], migrate() {}, pendingFor: () => [], toolNames: [],
    ...(lines ? { briefingLines: () => lines()! } : {}),
  } as KindModule;
}

function builder(kinds: KindModule[], agents = fakeAgents()) {
  return createBriefingBuilder({
    agents, kinds, ledgerDb: null, ledgerEnabled: true, roomSummariser: null,
    defaultRoom: "r1", attachmentsDir: "/a", humanName: "human",
    buildCap: () => ({}) as HubCapabilities,
  });
}

describe("briefingLines hook", () => {
  test("collects lines in KINDS order and kinds without the hook add none", () => {
    const b = builder([kind(() => ["a"]), kind(undefined as any), kind(() => ["b", "c"])]);
    expect(b.build("alice").kind_lines).toEqual(["a", "b", "c"]);
    expect(builder([kind(undefined as any)]).build("alice").kind_lines).toEqual([]);
  });

  test("a throwing hook does not break the briefing", () => {
    const b = builder([kind(() => { throw new Error("x"); }), kind(() => ["ok"])]);
    expect(b.build("alice").kind_lines).toEqual(["ok"]);
  });

  test("a change in lines changes the signature; the dispatcher re-sends once, not twice", async () => {
    let lines = ["t1"];
    const queued: unknown[] = [];
    const agents = fakeAgents(queued);
    const b = builder([kind(() => lines)], agents);
    const d = createBriefingDispatcher({
      agents, buildBriefing: (a) => b.build(a), briefingSignature, debounceMs: 5,
    });
    d.seedSignature("alice", b.build("alice"));
    d.scheduleFanout();
    await Bun.sleep(20);
    expect(queued.length).toBe(0); // same lines → dedup
    lines = ["t1", "t2"];
    d.scheduleFanout();
    await Bun.sleep(20);
    expect(queued.length).toBe(1);
    d.scheduleFanout();
    await Bun.sleep(20);
    expect(queued.length).toBe(1); // unchanged again → no replay
    d.dispose();
  });
});
