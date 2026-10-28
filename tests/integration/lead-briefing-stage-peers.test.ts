// P6-10: the room lead's briefing ignores stage sessions. The hub knows a stage session from its own launch record,
// never from what a session sends. Real hub, a fake shell client on GET /launches/stream.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "lb";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAST_DEBOUNCE_MS = 1200; // the dispatcher debounce is 500 ms

async function until<T>(f: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v !== undefined) return v;
    await sleep(25);
  }
  throw new Error("timeout");
}

// Opens an agent stream and drains it (openSSE connects only when read).
function join(hub: HubHandle, path: string, into: any[] = []) {
  const sse = openSSE(hub, path);
  void (async () => { try { for await (const e of sse.events) into.push(e); } catch { /* closed */ } })();
  return sse;
}

describe("lead briefing and stage sessions", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  const leadEvents: any[] = [];
  const leadBriefings = () => leadEvents.filter((e) => e.type === "briefing");
  let session = "";
  let stageId = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    open.push(join(hub, `/agent-stream?agent=Orchestrator&room=${ROOM}`, leadEvents));
    open.push(join(hub, "/launches/stream", launches));
    await sleep(300);

    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Lead ticket", acceptance_criteria: "c", blast_radius: "low", priority: "high" });
    expect(t.status).toBe(201);
    const ticket = (t.json as any).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "worker", task: `work ${ticket}`, context: { ticket_id: ticket } })).status).toBe(201);
    const req = await until(() => launches.find((l) => l.kind === "launch"));
    session = req.session;
    stageId = req.stage_id;
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    await until(() => (leadBriefings().length > 0 ? true : undefined));
    await sleep(PAST_DEBOUNCE_MS);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("Stage session joins: the launched session does not re-brief the lead", async () => {
    const before = leadBriefings().length;
    open.push(join(hub, `/agent-stream?agent=${encodeURIComponent(session)}&room=${ROOM}&stage=${stageId}`));
    await sleep(PAST_DEBOUNCE_MS);
    expect(leadBriefings()).toHaveLength(before);
  });

  test("a session that sends a stage id but is not in the hub's launch record is ignored as a stage peer", async () => {
    const before = leadBriefings().length;
    open.push(join(hub, `/agent-stream?agent=lb-impostor&room=${ROOM}&stage=${stageId}`));
    await until(() => (leadBriefings().length > before ? true : undefined));
  });

  test("a non-stage agent joining still re-briefs the lead", async () => {
    const before = leadBriefings().length;
    open.push(await registerAgent(hub, "lb-bob", { room: ROOM }));
    await until(() => (leadBriefings().length > before ? true : undefined));
  });
});
