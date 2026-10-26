// A spec FAIL moves no ticket and launches no session (spec-review-stage 4.1), through the real hub.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: string; stage_id?: string; session: string; prompt?: string };

describe("spec FAIL", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: Req[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "sf");
    open.push(await registerAgent(hub, "Orchestrator", { room: "sf" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) reqs.push(e as Req); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("the stage passes with verdict FAIL, the tickets stay draft, no new launch; the close comes at the turn end", async () => {
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-1", status: "draft" });
    const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-1", task: "review", context: { request_text: "X" } })).status).toBe(201);
    for (let i = 0; i < 60 && reqs.length < 1; i++) await sleep(50);
    const launch = reqs[0];
    expect(launch.kind).toBe("launch");
    expect((await postJson(hub, `/launches/${launch.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, launch.session, { room: "sf" }));

    const fail = await postJson(hub, "/handoffs", {
      from: launch.session, to: "Orchestrator", task: "spec verdict",
      context: {
        stage_id: launch.stage_id, review: "spec", request_id: "req-1", verdict: "FAIL",
        findings: [{ ticket_id: ticket, severity: "blocking", text: "no criteria" }], questions_for_human: [],
      },
    });
    expect(fail.status, JSON.stringify(fail.json)).toBe(201);
    await sleep(300);
    expect(((await getJson(hub, `/stages/${launch.stage_id}`)).json as { status: string; verdict: string })).toMatchObject({ status: "passed", verdict: "FAIL" });
    const tickets = (await getJson(hub, "/tickets?room=sf&status=all")).json as { items?: Array<{ id: string; status: string }> } | Array<{ id: string; status: string }>;
    const list = Array.isArray(tickets) ? tickets : tickets.items!;
    expect(list.find((x) => x.id === ticket)!.status).toBe("draft");
    expect(((await getJson(hub, "/stages?status=all")).json as unknown[])).toHaveLength(1); // no relaunch, no second stage
    expect(reqs).toHaveLength(1);

    expect((await postJson(hub, `/stages/${launch.stage_id}/turn-end`, { agent: launch.session })).json).toEqual({ action: "close" });
    for (let i = 0; i < 40 && reqs.length < 2; i++) await sleep(50);
    expect(reqs.map((r) => [r.kind, r.session])).toEqual([["launch", launch.session], ["close", launch.session]]);
  });

  // spec-review 2.5, brief test 12: a second spec review gets the findings of the first.
  test("a second spec review of the request gets the FAIL findings of the first in its first message", async () => {
    const first = reqs[0];
    const close = reqs.find((r) => r.kind === "close")!;
    expect((await postJson(hub, `/launches/${close.id}/ack`, { result: "spawned" })).status).toBe(200);
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-1", task: "review again", context: { request_text: "X again" } })).status).toBe(201);
    for (let i = 0; i < 60 && reqs.filter((r) => r.kind === "launch").length < 2; i++) await sleep(50);
    const second = reqs.filter((r) => r.kind === "launch")[1];
    expect(second.stage_id).not.toBe(first.stage_id);
    expect(second.prompt).toContain("## Findings of earlier reviews of this request");
    expect(second.prompt).toContain("(blocking): no criteria");
    expect(second.prompt).toContain("Blocked by: none");
    expect(second.prompt).not.toContain("software factory"); // no role prompt text
  });
});
