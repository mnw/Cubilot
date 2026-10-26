// Result schema check (stage-sessions 5.1) through the real hub: a handoff from the session of a running stage.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

describe("result handoff schema", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let stageId = "";
  let ticketId = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    const t = await postJson(hub, "/tickets", {
      by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: "validator",
    });
    ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
    // The shell: read the launch request and ack it, so the stage is running.
    const sse = openSSE(hub, "/launches/stream");
    for await (const req of sse.events) {
      expect(req.session).toBe("validator-1");
      expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
      break;
    }
    sse.close();
    open.push(await registerAgent(hub, "validator-1", { room: "r1" }));
    const list = (await getJson(hub, "/stages?status=running")).json as Array<{ id: string }>;
    stageId = list[0].id;
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const send = (context: unknown, from = "validator-1") => postJson(hub, "/handoffs", { from, to: "alice", task: "result", context });
  const handoffCount = async () => ((await getJson(hub, "/handoffs?for=alice")).json as unknown[]).length;

  test("an invalid verdict is refused with the errors; the stage stays running; no handoff is recorded", async () => {
    const before = await handoffCount();
    for (const context of [
      { stage_id: stageId, ticket_id: ticketId, verdict: "pass", findings: [] },
      { stage_id: stageId, ticket_id: ticketId, findings: [] },
      { stage_id: stageId, ticket_id: ticketId, verdict: "FAIL" },
      { stage_id: stageId, ticket_id: ticketId, verdict: "FAIL", findings: [{ text: "x" }] },
      { stage_id: "s_0000000000000000", ticket_id: ticketId, verdict: "PASS", findings: [] },
      { stage_id: stageId, ticket_id: "t_0000000000000000", verdict: "PASS", findings: [] },
      null,
    ]) {
      const r = await send(context);
      expect(r.status).toBe(400);
      expect((r.json as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
    expect(await handoffCount()).toBe(before);
    expect(((await getJson(hub, `/stages/${stageId}`)).json as { status: string }).status).toBe("running");
  });

  test("the errors also reach the same session as a stage.rejected entry", async () => {
    const sse = openSSE(hub, "/agent-stream?agent=validator-1&room=r1");
    const seen: any[] = [];
    void (async () => { try { for await (const e of sse.events) seen.push(e); } catch { /* closed */ } })();
    await new Promise((r) => setTimeout(r, 150));
    await send({ stage_id: stageId, ticket_id: ticketId, verdict: "maybe", findings: [] });
    await new Promise((r) => setTimeout(r, 300));
    sse.close();
    const rej = seen.find((e) => e.kind === "stage.rejected");
    expect(rej).toBeTruthy();
    expect(JSON.parse(rej.text).errors[0]).toContain("verdict");
  });

  test("a valid result is recorded", async () => {
    const before = await handoffCount();
    const r = await send({ stage_id: stageId, ticket_id: ticketId, verdict: "PASS", findings: [{ ticket_id: ticketId, text: "ok" }] });
    expect(r.status).toBe(201);
    expect(await handoffCount()).toBe(before + 1);
  });

  // stage-sessions 5.2: the valid result above passed the stage; the session closes at its next end of turn.
  test("after the pass, the turn end of the session queues its close once; another session cannot report", async () => {
    expect(((await getJson(hub, `/stages/${stageId}`)).json as { status: string }).status).toBe("passed");
    expect((await postJson(hub, `/stages/${stageId}/turn-end`, { agent: "alice" })).status).toBe(403);
    const sse = openSSE(hub, "/launches/stream");
    const got: Array<{ kind: string; session: string }> = [];
    void (async () => { try { for await (const e of sse.events) got.push(e); } catch { /* closed */ } })();
    await new Promise((r) => setTimeout(r, 150));
    const first = await postJson(hub, `/stages/${stageId}/turn-end`, { agent: "validator-1" });
    expect(first).toMatchObject({ status: 200, json: { action: "close" } });
    expect((await postJson(hub, `/stages/${stageId}/turn-end`, { agent: "validator-1" })).json).toEqual({ action: "none" });
    await new Promise((r) => setTimeout(r, 300));
    sse.close();
    expect(got.map((r) => [r.kind, r.session])).toEqual([["close", "validator-1"]]);
  });

  test("a handoff from an agent that is no stage session is not checked", async () => {
    open.push(await registerAgent(hub, "bob", { room: "r1" }));
    const r = await postJson(hub, "/handoffs", { from: "bob", to: "alice", task: "plain" });
    expect(r.status).toBe(201);
  });
});
