// Lean flow L2: a launch request that the shell has not received yet carries the edited criteria. Real hub, fake shell.

import { describe, test, expect, afterEach } from "bun:test";
import { spawnHub } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("a criteria edit reaches a launch the shell has not received", () => {
  test("edit after the launch request and before the delivery: the prompt holds the new criteria, not the old", async () => {
    const hub = await spawnHub();
    cleanup.push(() => hub.kill());
    await giveProjectHttp(hub, "pl");
    const orch = await registerAgent(hub, "Orchestrator", { room: "pl" });
    cleanup.push(() => orch.close());
    // No shell is connected: the launch request waits in the queue.
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "OLDCRITERIA-1", blast_radius: "low", role: "worker" });
    expect(t.status).toBe(201);
    const id = (t.json as { snapshot: { id: string } }).snapshot.id;
    await sleep(300);

    const e = await postJson(hub, `/tickets/${id}/edit`, { by: "Orchestrator", acceptance_criteria: "NEWCRITERIA-2" });
    expect(e.status).toBe(200);

    const reqs: Array<{ kind: string; prompt?: string }> = [];
    const sse = openLaunchStream(hub);
    cleanup.push(() => sse.close());
    void (async () => { try { for await (const r of sse.events) reqs.push(r as { kind: string; prompt?: string }); } catch { /* closed */ } })();
    for (let i = 0; i < 120 && !reqs.some((r) => r.kind === "launch"); i++) await sleep(25);

    const launch = reqs.find((r) => r.kind === "launch");
    expect(launch).toBeDefined();
    expect(launch!.prompt).toContain("NEWCRITERIA-2");
    expect(launch!.prompt).not.toContain("OLDCRITERIA-1");
  });
});
