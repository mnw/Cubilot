// spec-review-stage 4.1b through the real hub: the spec first message names the Orchestrator as the recipient of the
// result, and a spec result handoff to anyone else gets an error back to the same session while the stage stays running.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a spec result goes to the Orchestrator", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;
  let stageId = "";
  let ticketId = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "sr");
    open.push(await registerAgent(hub, "Orchestrator", { room: "sr" }));
    open.push(await registerAgent(hub, "sr-bob", { room: "sr" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Plan item", acceptance_criteria: "It is planned.", blast_radius: "low", request_id: "req-9", status: "draft" });
    ticketId = (t.json as any).snapshot.id;
    const h = await postJson(hub, "/handoffs", {
      from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-9", task: "review the plan",
      context: { request_text: "Build the thing", spec_paths: ["openspec/x.md"] },
    });
    expect(h.status).toBe(201);
    await sleep(500);
    const stages = (await getJson(hub, "/stages?status=all")).json as any[];
    stageId = stages.find((s) => s.review === "spec").id;
    // The shell acks the launch; the Validator session joins the room under its session name.
    const req = launches.at(-1);
    open.push(await registerAgent(hub, req.session, { room: "sr" }));
    const ack = await authedFetch(hub, `/launches/${req.id}/ack`, { method: "POST", body: JSON.stringify({ result: "spawned" }) });
    expect(ack.status).toBe(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const result = (to: string) => ({
    stage_id: stageId, review: "spec", request_id: "req-9", verdict: "PASS",
    findings: [{ ticket_id: ticketId, severity: "suggestion", text: "ok" }], suggestions: [], questions_for_human: [],
  } as Record<string, unknown>);
  const stage = async () => ((await getJson(hub, `/stages/${stageId}`)).json as any);
  const send = (to: string) => postJson(hub, "/handoffs", { from: launches.at(-1).session, to, task: "result", context: result(to) });

  test("the spec first message holds the request, the scope ticket and the recipient", () => {
    const p = launches.at(-1).prompt as string;
    expect(p).toContain("Send ONE result handoff to Orchestrator");
    expect(p).toContain("- Result goes to: Orchestrator");
    expect(p).toContain("Build the thing");
    expect(p).toContain("openspec/x.md");
    expect(p).toContain(`### ${ticketId}: Plan item`);
    expect(p).toContain("It is planned.");
    expect(p).toContain(stageId);
  });

  test("a result to another agent gets the error and the stage stays running; the error reaches the same session", async () => {
    const r = await send("sr-bob");
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain("must be sent to Orchestrator, not to sr-bob");
    expect((await stage()).status).toBe("running");
  });

  test("a result to the Orchestrator passes", async () => {
    const r = await send("Orchestrator");
    expect(r.status).toBe(201);
    await sleep(300);
    expect((await stage()).verdict).toBe("PASS");
  });
});
