// A result handoff that names a completed stage (passed or failed) is refused with 409 and records nothing.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: string; stage_id?: string; session: string };

describe("a result for a completed stage", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: Req[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "cs");
    open.push(await registerAgent(hub, "Orchestrator", { room: "cs" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) reqs.push(e as Req); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const handoffCount = () => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return (db.query("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }).n; } finally { db.close(); }
  };

  test("the first result passes the stage; a second one for it gets 409, no row and no stage.rejected; an ordinary handoff is accepted", async () => {
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id: "req-1", status: "draft" });
    const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-1", task: "review", context: { request_text: "X" } })).status).toBe(201);
    for (let i = 0; i < 60 && reqs.length < 1; i++) await sleep(50);
    const launch = reqs[0];
    expect((await postJson(hub, `/launches/${launch.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, launch.session, { room: "cs" }));
    const events: Array<{ kind?: string }> = [];
    const agentStream = openSSE(hub, `/agent-stream?agent=${launch.session}&room=cs`);
    void (async () => { try { for await (const e of agentStream.events) events.push(e as { kind?: string }); } catch { /* closed */ } })();
    const result = {
      from: launch.session, to: "Orchestrator", task: "spec verdict",
      context: { stage_id: launch.stage_id, review: "spec", request_id: "req-1", verdict: "FAIL", findings: [{ ticket_id: ticket, severity: "blocking", text: "x" }], questions_for_human: [] },
    };
    expect((await postJson(hub, "/handoffs", result)).status).toBe(201);
    expect(((await getJson(hub, `/stages/${launch.stage_id}`)).json as { status: string }).status).toBe("passed");
    const before = handoffCount();

    const again = await postJson(hub, "/handoffs", result);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.json)).toContain(`stage ${launch.stage_id} is already passed; it takes no more results`);
    expect(handoffCount()).toBe(before);
    await sleep(200);
    expect(events.some((e) => e.kind === "stage.rejected")).toBe(false);
    agentStream.close();

    // an ordinary handoff from the same session, with no stage_id, still works
    expect((await postJson(hub, "/handoffs", { from: launch.session, to: "Orchestrator", task: "a question" })).status).toBe(201);
    expect(handoffCount()).toBe(before + 1);
  });
});
