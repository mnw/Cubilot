import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postJson, getJson, openSSE, authedFetch, registerAgent } from "../helpers/fetch";

// Agent pause: broadcasts skip a paused agent; a direct human send delivers and lifts the pause.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(hub: HubHandle, agent: string, room: string) {
  const sse = openSSE(hub, `/agent-stream?agent=${agent}&room=${encodeURIComponent(room)}`);
  const texts: string[] = [];
  (async () => {
    try { for await (const e of sse.events) if (typeof e.text === "string") texts.push(e.text); } catch {}
  })();
  return { texts, close: sse.close };
}

describe("agent pause", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  test("broadcasts skip a paused agent; a direct human send delivers and resumes it", async () => {
    const a = collect(hub, "pause-a", "pz");
    const b = collect(hub, "pause-b", "pz");
    await sleep(200);

    expect((await postJson(hub, "/agents/pause-b/pause", { paused: true, by: hub.humanName })).status).toBe(200);
    expect((await getJson(hub, "/agents/pause-b/pause")).json).toEqual({ agent: "pause-b", paused: true });

    await postJson(hub, "/send", { target: "all", room: "pz", text: "human-broadcast" });
    await postJson(hub, "/post", { from: "pause-a", to: "all", text: "agent-broadcast" });
    await sleep(300);
    expect(a.texts.some((t) => t.includes("human-broadcast"))).toBe(true);
    expect(b.texts.some((t) => t.includes("broadcast"))).toBe(false);

    await postJson(hub, "/send", { target: "pause-b", room: "pz", text: "direct" });
    await sleep(300);
    expect(b.texts.some((t) => t.includes("direct"))).toBe(true);
    expect((await getJson(hub, "/agents/pause-b/pause")).json).toEqual({ agent: "pause-b", paused: false });

    expect((await postJson(hub, "/agents/nobody/pause", { paused: true, by: hub.humanName })).status).toBe(400);
    expect((await postJson(hub, "/agents/pause-a/pause", { paused: "yes" })).status).toBe(400);
    a.close(); b.close();
  });

  test("a null body is rejected with 400", async () => {
    const c = collect(hub, "pause-c", "pz");
    await sleep(200);
    const r = await fetch(`${hub.url}/agents/pause-c/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      body: "null",
    });
    expect(r.status).toBe(400);
    c.close();
  });

  test("a pause does not survive removal and respawn under the same name", async () => {
    let d = collect(hub, "pause-d", "pz");
    await sleep(200);
    await postJson(hub, "/agents/pause-d/pause", { paused: true, by: hub.humanName });
    d.close();
    await sleep(100);
    expect((await postJson(hub, "/remove", { agent: "pause-d" })).status).toBe(200);
    d = collect(hub, "pause-d", "pz");
    await sleep(200);
    expect((await getJson(hub, "/agents/pause-d/pause")).json).toEqual({ agent: "pause-d", paused: false });
    await postJson(hub, "/send", { target: "all", room: "pz", text: "after-respawn" });
    await sleep(300);
    expect(d.texts.some((t) => t.includes("after-respawn"))).toBe(true);
    d.close();
  });

  test("only the human pauses or resumes: any other `by`, or none, is 403 and changes nothing", async () => {
    const e = collect(hub, "pause-e", "pz");
    const f = collect(hub, "pause-f", "pz");
    await sleep(200);
    const state = async () => ((await getJson(hub, "/agents/pause-e/pause")).json as { paused: boolean }).paused;

    for (const by of [undefined, "pause-f", "pause-e", "Human", "", 7]) {
      const r = await postJson(hub, "/agents/pause-e/pause", { paused: true, ...(by === undefined ? {} : { by }) });
      expect(r.status).toBe(403);
    }
    expect(await state()).toBe(false);

    expect((await postJson(hub, "/agents/pause-e/pause", { paused: true, by: hub.humanName })).status).toBe(200);
    expect(await state()).toBe(true);
    // An agent cannot lift a pause, its own or a peer's.
    expect((await postJson(hub, "/agents/pause-e/pause", { paused: false, by: "pause-e" })).status).toBe(403);
    expect((await postJson(hub, "/agents/pause-e/pause", { paused: false, by: "pause-f" })).status).toBe(403);
    expect(await state()).toBe(true);
    expect((await postJson(hub, "/agents/pause-e/pause", { paused: false, by: hub.humanName })).status).toBe(200);
    expect(await state()).toBe(false);
    e.close(); f.close();
  });
});

describe("pause across a stream drop and a launch", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });
  const paused = async (a: string) => ((await getJson(hub, `/agents/${a}/pause`)).json as { paused: boolean }).paused;

  test("a stream drop and reconnect inside the stale window keeps the pause", async () => {
    let c = collect(hub, "keep-a", "pz");
    await sleep(200);
    await postJson(hub, "/agents/keep-a/pause", { paused: true, by: hub.humanName });
    c.close();
    await sleep(100);
    c = collect(hub, "keep-a", "pz");   // same Agent object: the 15 s timer was cancelled
    await sleep(200);
    expect(await paused("keep-a")).toBe(true);
    c.close();
  });

  test("a launch from the UI (POST paused:false as the human) before the new stream starts unpaused", async () => {
    let c = collect(hub, "fresh-a", "pz");
    await sleep(200);
    await postJson(hub, "/agents/fresh-a/pause", { paused: true, by: hub.humanName });
    c.close();                                 // the old session dies
    await sleep(100);
    expect(await paused("fresh-a")).toBe(true);  // still inside the stale window
    expect((await postJson(hub, "/agents/fresh-a/pause", { paused: false, by: hub.humanName })).status).toBe(200); // handleLaunch
    c = collect(hub, "fresh-a", "pz");         // the new bridge connects
    await sleep(200);
    expect(await paused("fresh-a")).toBe(false);
    await postJson(hub, "/send", { target: "all", room: "pz", text: "after-launch" });
    await sleep(300);
    expect(c.texts.some((t) => t.includes("after-launch"))).toBe(true);
    c.close();
  });
});

describe("pause audit entries are ambient", () => {
  let hub: HubHandle;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "a2a-pause-transcript-"));
    mkdirSync(dir, { recursive: true });
    const orig = process.env.A2A_TRANSCRIPTS_DIR;
    process.env.A2A_TRANSCRIPTS_DIR = dir;
    try { hub = await spawnHub(); } finally {
      if (orig === undefined) delete process.env.A2A_TRANSCRIPTS_DIR; else process.env.A2A_TRANSCRIPTS_DIR = orig;
    }
  });
  afterAll(async () => { await hub.kill(); });

  const streamTexts = (path: string) => {
    const sse = openSSE(hub, path);
    const texts: string[] = [];
    (async () => { try { for await (const e of sse.events) if (typeof e.text === "string") texts.push(e.text); } catch {} })();
    return { texts, close: sse.close };
  };

  test("pause and resume reach the live UI stream but not the transcript, the chat log or hydration", async () => {
    const room = "pq";
    expect((await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify({ persist_transcript: true }) })).status).toBe(200);
    const agent = await registerAgent(hub, "pq-a", { room });
    const live = streamTexts("/stream");
    await sleep(200);

    await postJson(hub, "/send", { target: "all", room, text: "visible-marker" });
    expect((await postJson(hub, "/agents/pq-a/pause", { paused: true, by: hub.humanName })).status).toBe(200);
    expect((await postJson(hub, "/agents/pq-a/pause", { paused: false, by: hub.humanName })).status).toBe(200);
    await sleep(300);

    // The webview still gets both entries live (the pause button depends on them).
    expect(live.texts).toContain("[agent paused]");
    expect(live.texts).toContain("[agent resumed]");

    // On disk: the chat line is there, the audit lines are not.
    const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const disk = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(disk).toContain("visible-marker");
    expect(disk).not.toContain("[agent paused]");
    expect(disk).not.toContain("[agent resumed]");

    // A fresh stream replays the chat log: the chat line is in it, the audit lines are not.
    const replay = streamTexts("/stream");
    await sleep(300);
    expect(replay.texts).toContain("visible-marker");
    expect(replay.texts).not.toContain("[agent paused]");
    expect(replay.texts).not.toContain("[agent resumed]");
    live.close(); replay.close(); agent.close();
  });
});
