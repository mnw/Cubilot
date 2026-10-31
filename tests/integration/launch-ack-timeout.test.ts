// Launch ack and time-out through the real hub with a fake shell client (4.1). The time-out is lowered only through
// the ackMs option (CUBILOT_LAUNCH_ACK_MS, hub/kinds/index.ts); the default is checked in tests/unit/launch-ack-constant.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ACK_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("launch ack and time-out over HTTP", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const frames: any[] = [];
  let stream: ReturnType<typeof openSSE>;
  const prior = process.env.CUBILOT_LAUNCH_ACK_MS;

  const ack = (id: string, body: unknown) => ackLaunch(hub, id, body);
  const stagesOf = async (ticket: string) => ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.ticket_id === ticket);
  const until = async <T>(f: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(25); }
    throw new Error("condition not met in time");
  };
  const eventKinds = (id: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query<{ kind: string; payload_json: string }, [string]>("SELECT kind, payload_json FROM events WHERE entity_id = ? ORDER BY seq").all(id); }
    finally { db.close(); }
  };
  const mkTicket = async () => {
    const r = await postJson(hub, "/tickets", { by: "alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: null });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };

  beforeAll(async () => {
    process.env.CUBILOT_LAUNCH_ACK_MS = String(ACK_MS);
    hub = await spawnHub();
    if (prior === undefined) delete process.env.CUBILOT_LAUNCH_ACK_MS; else process.env.CUBILOT_LAUNCH_ACK_MS = prior;
    await giveProjectHttp(hub, "r1");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    stream = openLaunchStream(hub);
    // The fake shell: it keeps every request and acks every close at once; a launch is acked by the test.
    void (async () => {
      try {
        for await (const f of stream.events) {
          frames.push(f);
          if (f.kind === "close") void ack(f.id, { result: "spawned" });
        }
      } catch { /* closed */ }
    })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("a launch request arrives on the stream and an ack moves the stage to running", async () => {
    const t = await mkTicket();
    expect((await postJson(hub, "/handoffs", { from: "alice", to_role: "worker", task: "x", context: { ticket_id: t } })).status).toBe(201);
    const req = await until(async () => frames.find((f) => f.kind === "launch" && f.role === "worker"));
    expect(req).toMatchObject({ kind: "launch", role: "worker", room: "r1" });
    expect((await stagesOf(t))[0]).toMatchObject({ id: req.stage_id, status: "launching", attempt: 1 });
    expect((await ack(req.id, { result: "spawned" })).status).toBe(200);
    expect((await stagesOf(t))[0]).toMatchObject({ status: "running", attempt: 1 });
    expect(eventKinds(req.stage_id).map((e) => e.kind)).not.toContain("stage.retrying");
  });

  test("no ack within the time-out: stage.retrying for attempt 1, then attempt 2 is launching or running", async () => {
    const t = await mkTicket();
    expect((await postJson(hub, "/handoffs", { from: "alice", to_role: "tester", task: "x", context: { ticket_id: t } })).status).toBe(201);
    const first = await until(async () => frames.find((f) => f.kind === "launch" && f.role === "tester"));
    expect((await stagesOf(t))[0]).toMatchObject({ status: "launching", attempt: 1 });
    // No ack. The hub ends attempt 1 after ACK_MS and relaunches at once, because a tester slot is free.
    const second = await until(async () => frames.find((f) => f.kind === "launch" && f.role === "tester" && f.id !== first.id), ACK_MS * 6);
    const retrying = eventKinds(first.stage_id).filter((e) => e.kind === "stage.retrying");
    expect(retrying).toHaveLength(1);
    expect(second.stage_id).toBe(first.stage_id);
    const now = (await stagesOf(t))[0];
    expect(["launching", "running"]).toContain(now.status);
    expect(now.attempt).toBe(2);
    // A late ack of attempt 1 is refused; an ack of attempt 2 moves the stage to running.
    expect((await ack(first.id, { result: "spawned" })).status).toBe(409);
    expect((await ack(second.id, { result: "spawned" })).status).toBe(200);
    expect((await stagesOf(t))[0]).toMatchObject({ status: "running", attempt: 2 });
  });
});
