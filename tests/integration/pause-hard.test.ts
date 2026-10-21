import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, openSSE } from "../helpers/fetch";
import { modeFor } from "../../hub/channel/core";

// PAUSE-HARD: a paused agent cannot write to others (423), hears nothing from agents, and gets
// structured events stamped `paused` (the bridge delivers those as context, never a wake).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(hub: HubHandle, agent: string, room: string) {
  const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=${encodeURIComponent(room)}`);
  const events: any[] = [];
  (async () => {
    try { for await (const e of sse.events) events.push(e); } catch {}
  })();
  return { events, close: sse.close };
}

describe("a paused agent", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  const pause = (agent: string, paused: boolean) => postJson(hub, `/agents/${agent}/pause`, { paused, by: hub.humanName });

  test("its writes that reach others get 423 'agent is paused'; the others are unaffected", async () => {
    const a = collect(hub, "ph-a", "phz");
    const b = collect(hub, "ph-b", "phz");
    await sleep(200);
    await pause("ph-b", true);

    const writes: [string, string, Record<string, unknown>][] = [
      ["/post", "post", { from: "ph-b", to: "ph-a", text: "hi" }],
      ["/handoffs", "handoff", { from: "ph-b", to: "ph-a", task: "t" }],
      ["/interrupts", "interrupt", { from: "ph-b", to: "ph-a", text: "stop" }],
      ["/tickets", "ticket create", { by: "ph-b", title: "t", acceptance_criteria: "c", blast_radius: "low" }],
    ];
    for (const [path, label, body] of writes) {
      const r = await postJson(hub, path, body);
      expect([label, r.status, r.json?.error]).toEqual([label, 423, "agent is paused"]);
    }
    expect((await postJson(hub, "/post", { from: "ph-a", to: "ph-b", text: "unaffected sender" })).status).toBe(200);
    expect((await postJson(hub, "/tickets", { by: "ph-a", title: "t", acceptance_criteria: "c", blast_radius: "low" })).status).toBe(201);

    await pause("ph-b", false);
    expect((await postJson(hub, "/post", { from: "ph-b", to: "ph-a", text: "back" })).status).toBe(200);
    a.close(); b.close();
  });

  test("nothing from agents is delivered as chat; the human's direct message is", async () => {
    const a = collect(hub, "ph-c", "phz");
    const b = collect(hub, "ph-d", "phz");
    await sleep(200);
    await pause("ph-d", true);

    await postJson(hub, "/post", { from: "ph-c", to: "ph-d", text: "agent-direct" });
    await postJson(hub, "/post", { from: "ph-c", to: "all", text: "agent-broadcast" });
    await sleep(300);
    expect(b.events.some((e) => typeof e.text === "string" && e.text.startsWith("agent-"))).toBe(false);

    await postJson(hub, "/send", { target: "ph-d", room: "phz", text: "human-direct" });
    await sleep(300);
    expect(b.events.some((e) => e.text?.includes("human-direct"))).toBe(true);
    a.close(); b.close();
  });

  test("handoff, interrupt and ticket events reach it stamped paused; after a resume they do not", async () => {
    const a = collect(hub, "ph-e", "phz");
    const b = collect(hub, "ph-f", "phz");
    await sleep(200);
    await pause("ph-f", true);

    await postJson(hub, "/handoffs", { from: "ph-e", to: "ph-f", task: "do it" });
    await postJson(hub, "/interrupts", { from: "ph-e", to: "ph-f", text: "look" });
    await postJson(hub, "/tickets", { by: "ph-e", title: "t", acceptance_criteria: "c", blast_radius: "low", assignee: "ph-f" });
    await sleep(400);
    for (const kind of ["handoff.new", "interrupt.new", "ticket.new"]) {
      const ev = b.events.find((e) => e.kind === kind);
      expect([kind, ev?.paused]).toEqual([kind, true]);
    }

    await pause("ph-f", false);
    await postJson(hub, "/interrupts", { from: "ph-e", to: "ph-f", text: "again" });
    await sleep(300);
    const again = b.events.filter((e) => e.kind === "interrupt.new").at(-1);
    expect(again.text ?? JSON.stringify(again)).toContain("again");
    expect(again.paused).toBeUndefined();
    a.close(); b.close();
  });

  test("it cannot accept a handoff (423) but can still decline one", async () => {
    const a = collect(hub, "ph-g", "phz");
    const b = collect(hub, "ph-h", "phz");
    await sleep(200);
    const h1 = (await postJson(hub, "/handoffs", { from: "ph-g", to: "ph-h", task: "one" })).json.id;
    const h2 = (await postJson(hub, "/handoffs", { from: "ph-g", to: "ph-h", task: "two" })).json.id;
    await pause("ph-h", true);
    const acc = await postJson(hub, `/handoffs/${h1}/accept`, { by: "ph-h" });
    expect([acc.status, acc.json?.error]).toEqual([423, "agent is paused"]);
    expect((await postJson(hub, `/handoffs/${h2}/decline`, { by: "ph-h", reason: "paused" })).status).toBe(200);
    await pause("ph-h", false);
    expect((await postJson(hub, `/handoffs/${h1}/accept`, { by: "ph-h" })).status).toBe(200);
    a.close(); b.close();
  });

  test("a peer's permission request does not reach it; its own request does, and is not stamped", async () => {
    const a = collect(hub, "ph-i", "phz");
    const b = collect(hub, "ph-j", "phz");
    await sleep(200);
    await pause("ph-j", true);
    const body = { tool_name: "Bash", description: "d", input_preview: "p" };
    expect((await postJson(hub, "/permissions", { ...body, agent: "ph-i", request_id: "phprq" })).status).toBe(201);
    expect((await postJson(hub, "/permissions", { ...body, agent: "ph-j", request_id: "phpra" })).status).toBe(201);
    await sleep(300);
    const seen = b.events.filter((e) => e.kind === "permission.new").map((e) => e.snapshot?.id ?? e.id);
    expect(seen).toEqual(["phpra"]);
    expect(b.events.find((e) => e.kind === "permission.new")?.paused).toBeUndefined();
    a.close(); b.close();
  });

  test("a paused reconnect replays pending handoffs and interrupts as context, never wake or steer", async () => {
    const a = collect(hub, "ph-k", "phz");
    let b = collect(hub, "ph-l", "phz");
    await sleep(200);
    expect((await postJson(hub, "/handoffs", { from: "ph-k", to: "ph-l", task: "pending work" })).status).toBe(201);
    expect((await postJson(hub, "/interrupts", { from: "ph-k", to: "ph-l", text: "pending signal" })).status).toBe(201);
    await pause("ph-l", true);
    b.close();
    b = collect(hub, "ph-l", "phz");
    await sleep(300);
    const replay = b.events.filter((e) => e.replay && ["handoff.new", "interrupt.new"].includes(e.kind));
    expect(replay.map((e) => [e.kind, modeFor(e, "ph-l")])).toEqual([["handoff.new", "context"], ["interrupt.new", "context"]]);
    a.close(); b.close();
  });

  test("peer chat queued before the pause is not delivered after a paused reconnect", async () => {
    const a = collect(hub, "ph-m", "phz");
    let b = collect(hub, "ph-n", "phz");
    await sleep(200);
    b.close();
    await sleep(100);
    expect((await postJson(hub, "/post", { from: "ph-m", to: "ph-n", text: "queued-before-pause" })).status).toBe(200);
    await pause("ph-n", true);
    b = collect(hub, "ph-n", "phz");
    await sleep(300);
    expect(b.events.some((e) => e.text === "queued-before-pause")).toBe(false);
    await pause("ph-n", false);
    await postJson(hub, "/send", { target: "ph-n", room: "phz", text: "after-resume" });
    await sleep(300);
    expect(b.events.some((e) => e.text?.includes("after-resume"))).toBe(true);
    a.close(); b.close();
  });
});

describe("permission verdict and dismiss authority", () => {
  let hub: HubHandle;
  const open: Array<() => void> = [];
  beforeAll(async () => {
    hub = await spawnHub();
    for (const [n, room] of [["pv-a", "pvz"], ["pv-b", "pvz"], ["pv-x", "other"]]) open.push(collect(hub, n, room).close);
    await sleep(300);
  });
  afterAll(async () => { open.forEach((c) => c()); await hub.kill(); });

  const ask = async (id: string, agent = "pv-a") =>
    (await postJson(hub, "/permissions", { agent, request_id: id, tool_name: "Bash", description: "d", input_preview: "p" })).status;
  const verdict = (id: string, by: string) => postJson(hub, `/permissions/${id}/verdict`, { by, behavior: "allow" });
  const dismiss = (id: string, by: string) => postJson(hub, `/permissions/${id}/dismiss`, { by });

  test("a paused agent cannot vote on a peer's request (423); its own request and the human still pass", async () => {
    expect(await ask("pvaaa")).toBe(201);
    expect(await ask("pvbbb", "pv-b")).toBe(201);
    await postJson(hub, "/agents/pv-b/pause", { paused: true, by: hub.humanName });
    const r = await verdict("pvaaa", "pv-b");
    expect([r.status, r.json?.error]).toEqual([423, "agent is paused"]);
    expect((await verdict("pvbbb", "pv-b")).status).toBe(200);   // its own request
    expect((await verdict("pvaaa", hub.humanName)).status).toBe(200);
    await postJson(hub, "/agents/pv-b/pause", { paused: false, by: hub.humanName });
  });

  test("a verdict or dismiss by an unregistered name is 403, and the request stays pending", async () => {
    expect(await ask("pvccc")).toBe(201);
    expect((await verdict("pvccc", "ghost")).status).toBe(403);
    expect((await dismiss("pvccc", "ghost")).status).toBe(403);
    expect((await dismiss("pvccc", "pv-a")).status).toBe(200);   // the requester dismisses (relay hook)
  });

  test("dismiss: a peer is 403, a cross-room agent is 403, the human is 200", async () => {
    expect(await ask("pvddd")).toBe(201);
    expect((await dismiss("pvddd", "pv-b")).status).toBe(403);
    const x = await dismiss("pvddd", "pv-x");
    expect([x.status, x.json?.error]).toEqual([403, "cross-room dismiss not permitted"]);
    expect((await dismiss("pvddd", hub.humanName)).status).toBe(200);
  });
});
