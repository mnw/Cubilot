// Stage-sessions 6.5: a hub-launched stage session receives its briefing on connect. Real hub, a fake shell client on
// the fake executor stream, the ack, then /agent-stream as the launched session name with the stage's room.
// Current behaviour kept: every connect sends a briefing and seeds the signature (hub/features/streams.ts);
// the dispatcher dedups only the scheduled fanout (hub/core/briefing-dispatcher.ts). Reconnect dedup is not asserted.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { openSSE, postJson, registerAgent } from "../helpers/fetch";
import { modeFor, renderBriefing } from "../../hub/channel/core";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "sb";
const NUTSHELL = "Stage briefing test project: nutshell marker.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The dispatcher debounce is 500 ms; wait past it so a scheduled fanout has run.
const PAST_DEBOUNCE_MS = 1200;

async function until<T>(f: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v !== undefined) return v;
    await sleep(25);
  }
  throw new Error("timeout");
}

describe("stage session briefing on connect", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  const events: any[] = [];
  const briefings = () => events.filter((e) => e.type === "briefing");
  let session = "";
  let ticket = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    open.push(await registerAgent(hub, "sb-alice", { room: ROOM }));

    // Room nutshell: the "[nutshell]" handoff to the human, accepted by the human.
    const h = await postJson(hub, "/handoffs", {
      from: "sb-alice", to: hub.humanName, task: "[nutshell] set", context: { patch: NUTSHELL },
    });
    expect(h.status).toBe(201);
    const acc = await postJson(hub, `/handoffs/${(h.json as any).id}/accept`, { by: hub.humanName });
    expect(acc.status).toBe(200);

    // Fake shell client.
    const ls = openLaunchStream(hub);
    open.push(ls);
    void (async () => { try { for await (const e of ls.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);

    const t = await postJson(hub, "/tickets", {
      by: "sb-alice", title: "Briefing ticket", acceptance_criteria: "marker-criteria", blast_radius: "low", priority: "high",
    });
    expect(t.status).toBe(201);
    ticket = (t.json as any).snapshot.id;
    // A second open ticket of the room: a stage session must not see it (ss 6.5 gap B).
    const other = await postJson(hub, "/tickets", {
      by: "sb-alice", title: "Unrelated ticket", acceptance_criteria: "c", blast_radius: "low",
    });
    expect(other.status).toBe(201);

    const r = await postJson(hub, "/handoffs", {
      from: "sb-alice", to_role: "worker", task: `work ${ticket}`, context: { ticket_id: ticket },
    });
    expect(r.status).toBe(201);
    const req = await until(() => launches.find((l) => l.kind === "launch"));
    session = req.session;
    expect(req).toMatchObject({ role: "worker", room: ROOM });
    expect((await ackLaunch(hub, req.id, { result: "spawned" })).status).toBe(200);

    // The launched session connects with the stage's room.
    const sse = openSSE(hub, `/agent-stream?agent=${encodeURIComponent(session)}&room=${ROOM}`);
    open.push(sse);
    void (async () => { try { for await (const e of sse.events) events.push(e); } catch { /* closed */ } })();
    await until(() => (briefings().length > 0 ? true : undefined));
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("the launched session gets exactly one briefing on connect", async () => {
    await sleep(PAST_DEBOUNCE_MS);
    expect(session).toMatch(/^worker-\d+$/);
    expect(briefings()).toHaveLength(1);
  });

  test("the briefing names the room, the human, the online peers, the room nutshell and the session's own open ticket", () => {
    const b = briefings()[0];
    expect(b.room).toBe(ROOM);
    expect(b.human_name).toBe(hub.humanName);
    expect(b.peers.filter((p: any) => p.online).map((p: any) => p.name)).toContain("sb-alice");
    expect(b.nutshell).toBe(NUTSHELL);
    // kind_lines come from the ticket kind's briefingLines: the stage's own ticket only
    const lines = b.kind_lines.join("\n");
    expect(lines).toContain(ticket);
    expect(lines).toContain("Briefing ticket");
    expect(lines).toContain("marker-criteria");
    expect(lines).not.toContain("Unrelated ticket");
    // and the text the agent reads carries the same facts
    const text = renderBriefing(b, session, ROOM);
    expect(text).toContain(`You are "${session}" in room "${ROOM}"`);
    expect(text).toContain(`The human's name is "${hub.humanName}"`);
    expect(text).toContain("sb-alice");
    expect(text).toContain(NUTSHELL);
    expect(text).toContain(ticket);
  });

  test("the briefing is delivered in context mode (modeFor of hub/channel/core.ts, as a stage session)", () => {
    const b = briefings()[0];
    expect(modeFor(b, session, true)).toBe("context");
    expect(modeFor(b, session, false)).toBe("context");
  });

  test("a scheduled fanout with an unchanged signature sends no second briefing; a roster change sends one", async () => {
    // Another agent connecting is a roster change, so it schedules a fanout; the first one after the connect
    // briefing had the same signature and sent nothing (count stayed 1 in the first test).
    expect(briefings()).toHaveLength(1);
    await postJson(hub, "/post", { from: "sb-alice", to: "all", text: "no briefing change" });
    await sleep(PAST_DEBOUNCE_MS);
    expect(briefings()).toHaveLength(1);

    open.push(await registerAgent(hub, "sb-bob", { room: ROOM }));
    await until(() => (briefings().length >= 2 ? true : undefined));
    await sleep(PAST_DEBOUNCE_MS);
    expect(briefings()).toHaveLength(2);
    expect(briefings()[1].peers.map((p: any) => p.name)).toContain("sb-bob");
  });
});
