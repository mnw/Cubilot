import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { briefingSignature, createBriefingBuilder, liveStageSessions, type BriefingPayload } from "../../hub/core/briefing";
import { createBriefingDispatcher } from "../../hub/core/briefing-dispatcher";
import { renderBriefing } from "../../hub/channel/core";

// The signature decides when a briefing is re-sent; renderBriefing decides what the agent
// reads. They must agree: a change the agent cannot see must not re-send, and a change it
// can see must.

const base = (): BriefingPayload => ({
  type: "briefing",
  ts: "00:00:00",
  room: "r1",
  tools: ["post"],
  peers: [{ name: "bob", online: true, room: "r1" }],
  attachments_dir: "/a",
  human_name: "human",
  nutshell: "goal",
  factory_version: "v-1",
  kind_lines: ["Your open tickets:", "- t_1 [claimed] x"],
  room_summary: null,
});
const render = (b: BriefingPayload) => renderBriefing(b as any, "alice", "r1");

describe("briefing signature agrees with renderBriefing", () => {
  test("a summary layer that is not rendered changes neither the text nor the signature", () => {
    const a = base();
    const b = { ...base(), room_summary: { rollups: [], recent_blocks: [{ start_line: 1, end_line: 5, model: "m", summary: "- s" }] } };
    const c = { ...b, room_summary: { rollups: [{ start_line: 1, end_line: 9, model: "m", summary: "- r" }], recent_blocks: b.room_summary.recent_blocks } };
    expect(render(b)).toBe(render(a));
    expect(render(c)).toBe(render(a));
    expect(briefingSignature(b)).toBe(briefingSignature(a));
    expect(briefingSignature(c)).toBe(briefingSignature(a));
  });

  test("every runtime change the agent can see changes the signature", () => {
    const a = base();
    const variants: Record<string, BriefingPayload> = {
      nutshell: { ...base(), nutshell: "new goal" },
      "peer goes offline": { ...base(), peers: [{ name: "bob", online: false, room: "r1" }] },
      "peer joins": { ...base(), peers: [...base().peers, { name: "cy", online: true, room: "r1" }] },
      "kind lines": { ...base(), kind_lines: ["Your open tickets:", "- t_1 [in_progress] x"] },
    };
    for (const [what, v] of Object.entries(variants)) {
      expect(render(v), what).not.toBe(render(a));
      expect(briefingSignature(v), what).not.toBe(briefingSignature(a));
    }
  });

  test("a new factory version changes the signature but not the text: it re-briefs so the bridge can reload", () => {
    const v2 = { ...base(), factory_version: "v-2" };
    expect(render(v2)).toBe(render(base()));
    expect(briefingSignature(v2)).not.toBe(briefingSignature(base()));
  });

  test("the dispatcher does not re-send when only a summary layer is added", async () => {
    const queued: unknown[] = [];
    const alice = { name: "alice", color: "#000", room: "r1" };
    const agents = {
      get: (n: string) => (n === "alice" ? alice : null),
      entries: () => new Map([["alice", alice]]).entries(),
      isPermanent: () => false,
      connectionCount: () => 1,
      enqueueFor: (_n: string, e: unknown) => (queued.push(e), true),
    } as any;
    let layers = 0;
    const row = { start_line: 1, end_line: 2, model: "m", summary: "- s" };
    const roomSummariser = {
      listL2: () => [],
      listUnrolledL1: () => Array.from({ length: layers }, () => row),
    } as any;
    const builder = createBriefingBuilder({
      agents, kinds: [], ledgerDb: null, ledgerEnabled: false, roomSummariser,
      defaultRoom: "r1", attachmentsDir: "/a", humanName: "human",
    });
    const d = createBriefingDispatcher({
      agents, buildBriefing: (a) => builder.build(a), briefingSignature, debounceMs: 5,
    });
    d.seedSignature("alice", builder.build("alice"));
    layers = 2; // a new summary layer appears
    d.scheduleFanout();
    await Bun.sleep(25);
    expect(queued.length).toBe(0);
  });

  describe("room lead", () => {
    const lead = (): BriefingPayload => ({ ...base(), stage_peers: ["worker-3"], peers: [...base().peers, { name: "worker-3", online: true, room: "r1" }] });

    test("Stage session joins: the lead's signature does not change", () => {
      const before = { ...base(), stage_peers: [] as string[] };
      const joined = lead();
      expect(briefingSignature(joined)).toBe(briefingSignature(before));
      const left = { ...joined, peers: joined.peers.map((p) => (p.name === "worker-3" ? { ...p, online: false } : p)) };
      expect(briefingSignature(left)).toBe(briefingSignature(before));
    });

    test("a non-stage agent joining still changes the lead's signature", () => {
      const joined = { ...lead(), peers: [...lead().peers, { name: "cy", online: true, room: "r1" }] };
      expect(briefingSignature(joined)).not.toBe(briefingSignature(lead()));
    });

    test("the builder marks stage sessions for a lead only", () => {
      const mk = (isLead: boolean) => {
        const agents = {
          get: (n: string) => ({ name: n, color: "#000", room: "r1" }),
          entries: () => new Map([["Orchestrator", {}], ["worker-3", { room: "r1" }], ["cy", { room: "r1" }]]).entries(),
          isPermanent: () => false,
          connectionCount: () => 1,
        } as any;
        return createBriefingBuilder({
          agents, kinds: [], ledgerDb: null, ledgerEnabled: false, roomSummariser: null,
          defaultRoom: "r1", attachmentsDir: "/a", humanName: "human",
          isLead: () => isLead, stageSessions: () => new Set(["worker-3"]),
        }).build("Orchestrator");
      };
      expect(mk(true).stage_peers).toEqual(["worker-3"]);
      expect(mk(false).stage_peers).toBeUndefined();
    });

    test("an ordinary agent named like a finished stage session still re-briefs the lead", () => {
      const db = new Database(":memory:");
      db.run("CREATE TABLE stage (id TEXT, session TEXT, status TEXT)");
      db.run("INSERT INTO stage VALUES ('s1', 'worker-3', 'passed'), ('s2', 'worker-4', 'running'), ('s3', 'worker-5', 'launching'), ('s4', 'worker-6', 'failed')");
      const live = liveStageSessions(db);
      expect([...live].sort()).toEqual(["worker-4", "worker-5"]);
      const mk = (names: string[]) => {
        const agents = {
          get: (n: string) => ({ name: n, color: "#000", room: "r1" }),
          entries: () => new Map([["Orchestrator", {}], ...names.map((n) => [n, { room: "r1" }] as [string, object])]).entries(),
          isPermanent: () => false,
          connectionCount: () => 1,
        } as any;
        return createBriefingBuilder({
          agents, kinds: [], ledgerDb: null, ledgerEnabled: false, roomSummariser: null,
          defaultRoom: "r1", attachmentsDir: "/a", humanName: "human",
          isLead: () => true, stageSessions: () => live,
        }).build("Orchestrator");
      };
      const before = mk([]);
      const after = mk(["worker-3"]);
      expect(after.stage_peers).toEqual([]);
      expect(briefingSignature(after)).not.toBe(briefingSignature(before));
      expect(mk(["worker-4"]).stage_peers).toEqual(["worker-4"]);
      expect(briefingSignature(mk(["worker-4"]))).toBe(briefingSignature(before));
    });
  });
});
