// Final failure of a stage (stage-sessions 5.3) through the real hub: two failed attempts, then one handoff to the Orchestrator.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a stage that fails twice", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "ff");
    open.push(await registerAgent(hub, "Orchestrator", { room: "ff" }));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("each launch gets an error ack; attempt 2 fails the stage and the Orchestrator gets one handoff from the hub", async () => {
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", role: "tester" });
    expect(t.status).toBe(201);
    const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
    const sse = openSSE(hub, "/launches/stream");
    let acked = 0;
    void (async () => {
      try {
        for await (const req of sse.events) {
          if (req.kind !== "launch") continue;
          acked++;
          await postJson(hub, `/launches/${req.id}/ack`, { result: "error", error: "tmux failed" });
        }
      } catch { /* closed */ }
    })();
    for (let i = 0; i < 60 && acked < 2; i++) await sleep(50);
    await sleep(200);
    sse.close();
    expect(acked).toBe(2); // one relaunch, no third launch
    const stages = (await getJson(hub, "/stages?status=all")).json as Array<{ status: string; attempt: number; ticket_id: string }>;
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ status: "failed", attempt: 2, ticket_id: ticket });
    const hand = (await getJson(hub, "/handoffs?for=Orchestrator")).json as Array<{ from_agent: string; task: string; context: { stage_id: string; reason: string } }>;
    expect(hand).toHaveLength(1);
    expect(hand[0].from_agent).toBe("system");
    expect(hand[0].task).toContain("failed twice");
    expect(hand[0].context.reason).toContain("tmux failed");
  });
});
