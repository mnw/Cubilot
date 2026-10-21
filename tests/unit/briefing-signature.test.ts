import { describe, expect, test } from "bun:test";
import { briefingSignature, createBriefingBuilder, type BriefingPayload } from "../../hub/core/briefing";
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
});
