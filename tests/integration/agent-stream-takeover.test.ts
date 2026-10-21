// One live /agent-stream per agent: a newer connection takes over from the older one, so no
// event goes to a bridge connection that is already gone. Presence stays right throughout.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, openSSE, postJson } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("agent stream takeover", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  function connect(agent: string) {
    const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=tk`);
    const texts: string[] = [];
    const state = { ended: false };
    (async () => {
      try { for await (const e of sse.events) if (typeof e.text === "string") texts.push(e.text); } catch {}
      state.ended = true;
    })();
    return { texts, state, close: sse.close };
  }
  const online = async (agent: string) => ((await getJson(hub, "/presence")).json as { agents: Record<string, boolean> }).agents[agent];
  const tell = (text: string) => postJson(hub, "/send", { target: "tk-a", room: "tk", text });

  test("the first event after a second connect reaches the second stream; the first ends; presence stays online", async () => {
    const first = connect("tk-a");
    await sleep(250);
    expect(await online("tk-a")).toBe(true);

    const second = connect("tk-a");     // the bridge restarted: the old connection is still open
    await sleep(250);
    expect(first.state.ended).toBe(true);            // the hub ended the older stream
    expect(second.state.ended).toBe(false);
    expect(await online("tk-a")).toBe(true);        // the older stream's disconnect did not take it offline

    await tell("for-the-new-bridge");
    await sleep(300);
    expect(second.texts).toContain("for-the-new-bridge");
    expect(first.texts).not.toContain("for-the-new-bridge");

    second.close();
    await sleep(250);
    expect(await online("tk-a")).toBe(false);       // the count came back to zero: nothing leaked
    first.close();
  });

  test("several reconnects in a row leave one live stream and a correct presence count", async () => {
    const streams = [] as ReturnType<typeof connect>[];
    for (let i = 0; i < 4; i++) { streams.push(connect("tk-a")); await sleep(120); }
    await sleep(200);
    expect(streams.slice(0, 3).every((s) => s.state.ended)).toBe(true);
    expect(streams[3]!.state.ended).toBe(false);
    expect(await online("tk-a")).toBe(true);
    await tell("only-the-last");
    await sleep(300);
    expect(streams[3]!.texts).toContain("only-the-last");
    for (const s of streams.slice(0, 3)) expect(s.texts).not.toContain("only-the-last");
    streams[3]!.close();
    await sleep(250);
    expect(await online("tk-a")).toBe(false);
    for (const s of streams) s.close();
  });

  test("another agent's stream is untouched by a takeover", async () => {
    const other = connect("tk-b");
    const first = connect("tk-a");
    await sleep(200);
    const second = connect("tk-a");
    await sleep(250);
    expect(other.state.ended).toBe(false);
    expect(await online("tk-b")).toBe(true);
    other.close(); first.close(); second.close();
  });
});

// The zombie: /remove used to leave the removed agent's stream open on its old queue. A newer stream of
// the same name then took over, and the old stream's cleanup decremented the NEW agent's connection
// count. The count hit zero while the new stream was live, and the stale timer removed the agent.
describe("agent stream and /remove", () => {
  let hub: HubHandle;
  const STALE_MS = 500;
  beforeAll(async () => {
    const orig = process.env.CUBILOT_STALE_AGENT_MS;
    process.env.CUBILOT_STALE_AGENT_MS = String(STALE_MS);       // the app's 15 s, shortened for the test
    try { hub = await spawnHub(); } finally {
      if (orig === undefined) delete process.env.CUBILOT_STALE_AGENT_MS; else process.env.CUBILOT_STALE_AGENT_MS = orig;
    }
  });
  afterAll(async () => { await hub.kill(); });

  function connect(agent: string, room = "rm") {
    const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=${room}`);
    const texts: string[] = [];
    const state = { ended: false };
    (async () => {
      try { for await (const e of sse.events) if (typeof e.text === "string") texts.push(e.text); } catch {}
      state.ended = true;
    })();
    return { texts, state, close: sse.close };
  }
  const presence = async (a: string) => ((await getJson(hub, "/presence")).json as { agents: Record<string, boolean> }).agents[a];
  const roster = async () => (await getJson(hub, "/agents")).json as Array<{ name: string; room: string | null }>;

  test("/remove ends the agent's live stream at once, so the bridge reconnects", async () => {
    const old = connect("zm-a");
    await sleep(250);
    expect((await postJson(hub, "/remove", { agent: "zm-a" })).status).toBe(200);
    await sleep(250);
    expect(old.state.ended).toBe(true);
    old.close();
  });

  test("stream → /remove → a new stream of the same name: online, receiving, and still there after the stale timer", async () => {
    const old = connect("zm-b");
    await sleep(250);
    await postJson(hub, "/remove", { agent: "zm-b" });
    const fresh = connect("zm-b");                    // the bridge reconnects
    await sleep(250);
    expect(await presence("zm-b")).toBe(true);
    await sleep(STALE_MS * 3);                        // well past the stale timer the zombie would have armed
    expect(await presence("zm-b")).toBe(true);
    expect((await roster()).some((a) => a.name === "zm-b")).toBe(true);
    await postJson(hub, "/send", { target: "zm-b", room: "rm", text: "reaches-the-new-stream" });
    await sleep(300);
    expect(fresh.texts).toContain("reaches-the-new-stream");
    expect(old.texts).not.toContain("reaches-the-new-stream");
    fresh.close(); old.close();
  });

  test("a new stream that connects at the very moment of the /remove is not undone by the old stream's cleanup", async () => {
    for (let i = 0; i < 6; i++) {
      const name = `zm-r${i}`;
      const old = connect(name);
      await sleep(150);
      const [, fresh] = await Promise.all([postJson(hub, "/remove", { agent: name }), Promise.resolve(connect(name))]);
      await sleep(STALE_MS * 2 + 200);
      expect(await presence(name)).toBe(true);
      expect((await roster()).some((a) => a.name === name)).toBe(true);
      fresh.close(); old.close();
    }
  }, 30_000);

  test("the takeover still works after a /remove: a third stream ends the second", async () => {
    const one = connect("zm-c");
    await sleep(200);
    await postJson(hub, "/remove", { agent: "zm-c" });
    const two = connect("zm-c");
    await sleep(200);
    const three = connect("zm-c");
    await sleep(250);
    expect(two.state.ended).toBe(true);
    expect(three.state.ended).toBe(false);
    expect(await presence("zm-c")).toBe(true);
    await sleep(STALE_MS * 3);
    expect(await presence("zm-c")).toBe(true);
    one.close(); two.close(); three.close();
  });

  test("a stream that closes on its own still takes the agent offline after the stale timer", async () => {
    const only = connect("zm-d");
    await sleep(250);
    only.close();
    await sleep(STALE_MS * 3);
    expect((await roster()).some((a) => a.name === "zm-d")).toBe(false);   // the timer still removes a really gone agent
  });
});

// /post used to register an unknown sender with the DEFAULT room. After a hub restart a post could beat
// the bridge's reconnect and pin the agent there for good (the room is fixed by the first stream).
describe("/post and unknown senders", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("an unknown sender gets 409, creates no agent, and the first stream then sets the room", async () => {
    const early = await postJson(hub, "/post", { from: "late-bridge", to: "all", text: "too early" });
    expect(early.status).toBe(409);
    expect((early.json as { error: string }).error).toContain("connect /agent-stream first");
    expect(((await getJson(hub, "/agents")).json as Array<{ name: string }>).some((a) => a.name === "late-bridge")).toBe(false);

    const sse = openSSE(hub, "/agent-stream?agent=late-bridge&room=my-room");
    (async () => { try { for await (const _ of sse.events) { /* drain */ } } catch {} })();
    await sleep(250);
    const agent = ((await getJson(hub, "/agents")).json as Array<{ name: string; room: string }>).find((a) => a.name === "late-bridge")!;
    expect(agent.room).toBe("my-room");                                  // not "default"
    expect((await postJson(hub, "/post", { from: "late-bridge", to: "all", text: "now it works" })).status).toBe(200);
    sse.close();
  });

  test("a bad name is still 400 and the human can still post", async () => {
    expect((await postJson(hub, "/post", { from: "bad/name", text: "x" })).status).toBe(400);
    expect((await postJson(hub, "/post", { from: hub.humanName, to: "all", text: "hello" })).status).toBe(200);
  });
});
