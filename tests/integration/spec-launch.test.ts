// A spec stage launches like any validator stage (spec-review-stage 2.4) through the real hub:
// no ticket, a read-only worktree, the room's validator limit, the free-slot start, and the real-hub checks moved from 3.1 and 2.3.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Launch = { id: string; kind: string; harness: string; stage_id: string; session: string; role: string; room: string; cwd: string | null; env: Record<string, string> };

describe("spec stage launch", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: Launch[] = [];
  let stream: ReturnType<typeof openSSE>;
  let first = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "sl");
    expect((await authedFetch(hub, "/rooms/sl/settings", { method: "PUT", body: JSON.stringify({ role_limits: { validator: 1 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, "sl-alice", { room: "sl" }));
    // The result of a spec review goes to the room lead (spec-review 4.1b): the default lead is "Orchestrator".
    open.push(await registerAgent(hub, "Orchestrator", { room: "sl" }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e as Launch); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await sleep(50);
    expect(fn()).toBe(true);
  };
  const draft = (request_id: string) =>
    postJson(hub, "/tickets", { by: "sl-alice", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft" });
  const spec = (request_id: string) =>
    postJson(hub, "/handoffs", { from: "sl-alice", to_role: "validator", review: "spec", request_id, task: "review", context: { request_text: "Build X" } });
  const launchesOnly = () => launches.filter((l) => l.kind === "launch");
  // The session ends its turn: the hub queues the close; the shell acks it, and the slot is free.
  const endSession = async (stageId: string, session: string) => {
    const n = launches.filter((l) => l.kind === "close").length;
    expect((await postJson(hub, `/stages/${stageId}/turn-end`, { agent: session })).json).toEqual({ action: "close" });
    for (let i = 0; i < 60 && launches.filter((l) => l.kind === "close").length === n; i++) await sleep(50);
    const close = launches.filter((l) => l.kind === "close").at(-1)!;
    expect((await postJson(hub, `/launches/${close.id}/ack`, { result: "spawned" })).status).toBe(200);
  };
  const stages = async () => (await getJson(hub, "/stages?status=all")).json as Array<{ id: string; status: string; role: string; review: string | null; ticket_id: string | null; request_id: string | null; session: string | null }>;

  test("the validator launch names no ticket and its worktree is read-only; an ack makes it running", async () => {
    expect((await draft("req-1")).status).toBe(201);
    expect((await spec("req-1")).status).toBe(201);
    await until(() => launches.length === 1);
    const l = launches[0];
    expect(l).toMatchObject({ kind: "launch", role: "validator", room: "sl", session: "validator-1", harness: "pi" }); // the role's own harness (4.6)
    expect(l.env.CUBILOT_STAGE_ID).toBe(l.stage_id);
    expect(Object.keys(l.env).join(" ")).not.toMatch(/TICKET/i);
    expect(l.cwd).toContain("request-req-1");
    expect(() => writeFileSync(join(l.cwd!, "x.txt"), "1")).toThrow();
    // no ticket was assigned: nobody owns a ticket for this stage
    expect((await stages())[0]).toMatchObject({ review: "spec", ticket_id: null, status: "launching" });
    first = l.stage_id;
    expect((await postJson(hub, `/launches/${l.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, "validator-1", { room: "sl" }));
    expect((await stages())[0].status).toBe("running");
  });

  test("two spec handoffs for one request give one running and one queued; a spec result with a schema error keeps the stage running", async () => {
    expect((await draft("req-1")).status).toBe(201);
    expect((await spec("req-1")).status).toBe(201);
    await sleep(300);
    const all = await stages();
    expect(all.filter((s) => s.status === "running")).toHaveLength(1);
    expect(all.filter((s) => s.status === "queued")).toHaveLength(1);
    expect(launchesOnly()).toHaveLength(1);

    const bad = await postJson(hub, "/handoffs", {
      from: "validator-1", to: "Orchestrator", task: "result",
      context: { stage_id: first, review: "spec", request_id: "req-1", verdict: "pass", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(bad.status).toBe(400);
    expect(((await getJson(hub, `/stages/${first}`)).json as { status: string }).status).toBe("running");
  });

  test("a spec stage counts against the validator limit: a ticket validator stage stays queued", async () => {
    const t = await postJson(hub, "/tickets", { by: "sl-alice", title: "V", acceptance_criteria: "c", blast_radius: "low", role: "validator" });
    expect(t.status).toBe(201);
    await sleep(300);
    expect(launchesOnly()).toHaveLength(1);
    expect((await stages()).filter((s) => s.role === "validator" && s.status === "queued")).toHaveLength(2);
  });

  test("when the first validator stage ends, the oldest queued stage (the second spec stage) starts", async () => {
    const pass = await postJson(hub, "/handoffs", {
      from: "validator-1", to: "Orchestrator", task: "result",
      context: { stage_id: first, review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
    await sleep(300);
    expect(launchesOnly()).toHaveLength(1); // the passed session is still open: it holds the slot
    await endSession(first, "validator-1");
    await until(() => launchesOnly().length === 2);
    expect(launchesOnly()[1]).toMatchObject({ role: "validator", session: "validator-1" }); // closed: the name and the slot are free
    const all = await stages();
    const second = all.find((s) => s.id === launchesOnly()[1].stage_id)!;
    expect(second).toMatchObject({ review: "spec", status: "launching" });
    expect(all.filter((s) => s.status === "queued")).toHaveLength(1); // the ticket stage keeps waiting: limit 1
  });
});
