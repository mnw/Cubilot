// C5a: the human's Reload reaches one agent only, through the real hub. No briefing, no chat entry, no UI event.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { agentKey } from "../../hub/features/factory";
import { openSSE, postJson } from "../helpers/fetch";

const V1 = "v-1111111111111111";
const V2 = "v-2222222222222222";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(hub: HubHandle, path: string) {
  const sse = openSSE(hub, path);
  const events: any[] = [];
  (async () => { try { for await (const e of sse.events) events.push(e); } catch {} })();
  return { events, close: sse.close };
}

describe("POST /agents/:name/reload", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const saved = { dir: process.env.CUBILOT_FACTORY_DIR, version: process.env.CUBILOT_FACTORY_VERSION };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "reload-factory-"));
    mkdirSync(join(dir, V1)); mkdirSync(join(dir, V2)); mkdirSync(join(dir, "agents"));
    symlinkSync(join(dir, V1), join(dir, "agents", agentKey("rl-bob")));
    symlinkSync(join(dir, V1), join(dir, "agents", agentKey("rl-alice")));
    symlinkSync(join(dir, V1), join(dir, "agents", agentKey("rl-carol")));
    process.env.CUBILOT_FACTORY_DIR = dir;
    process.env.CUBILOT_FACTORY_VERSION = V2;
    hub = await spawnHub();
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
    for (const [k, v] of [["CUBILOT_FACTORY_DIR", saved.dir], ["CUBILOT_FACTORY_VERSION", saved.version]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("the request reaches rl-bob only; rl-alice gets no reload and no briefing; the UI stream gets nothing", async () => {
    const bob = collect(hub, "/agent-stream?agent=rl-bob&room=rl");
    const alice = collect(hub, "/agent-stream?agent=rl-alice&room=rl");
    const ui = collect(hub, "/stream");
    open.push(bob, alice, ui);
    await sleep(800); // the first briefings land
    const bobBefore = bob.events.length, aliceBefore = alice.events.length, uiBefore = ui.events.length;

    const r = await postJson(hub, "/agents/rl-bob/reload", { by: hub.humanName, force: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ agent: "rl-bob", online: true, paused: false, room: "rl", requested: true });
    expect((r.json as any).factory).toMatchObject({ desired: V2, linked: V1 });
    await sleep(600);

    const got = bob.events.slice(bobBefore);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "agent.reload", force: true, room: "rl" });
    expect(alice.events.slice(aliceBefore)).toHaveLength(0); // nothing at all: no reload, no briefing
    expect(ui.events.slice(uiBefore).filter((e) => e.type === "agent.reload")).toHaveLength(0);
  });

  test("an agent cannot call the route: 403, and nobody gets a request", async () => {
    const bob = collect(hub, "/agent-stream?agent=rl-bob&room=rl");
    open.push(bob);
    await sleep(500);
    const before = bob.events.length;
    expect((await postJson(hub, "/agents/rl-bob/reload", { by: "rl-alice" })).status).toBe(403);
    expect((await postJson(hub, "/agents/rl-bob/reload", {})).status).toBe(403);
    await sleep(300);
    expect(bob.events.slice(before)).toHaveLength(0);
  });

  test("an agent with no factory link only reads its status", async () => {
    const eve = collect(hub, "/agent-stream?agent=rl-eve&room=rl");
    open.push(eve);
    await sleep(500);
    const before = eve.events.length;
    const r = await postJson(hub, "/agents/rl-eve/reload", { by: hub.humanName });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ agent: "rl-eve", requested: false });
    await sleep(300);
    expect(eve.events.slice(before)).toHaveLength(0);
  });

  test("an offline agent gets no request: the route answers offline, and a reconnect delivers nothing (Validator)", async () => {
    for (const c of open.splice(0)) c.close();
    await sleep(600); // the streams are gone
    const r = await postJson(hub, "/agents/rl-bob/reload", { by: hub.humanName, force: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ agent: "rl-bob", online: false, requested: false });
    const again = collect(hub, "/agent-stream?agent=rl-bob&room=rl");
    open.push(again);
    await sleep(600);
    expect(again.events.filter((e) => e.type === "agent.reload")).toHaveLength(0);
  });

  test("GET reload-status sends no agent.reload entry; a failed force reload shows result failed (C5a2)", async () => {
    const bob = collect(hub, "/agent-stream?agent=rl-bob&room=rl");
    open.push(bob);
    await sleep(600);
    const before = bob.events.length;
    const get = await fetch(`${hub.url}/agents/rl-bob/reload-status?token=${hub.token}`);
    expect(get.status).toBe(200);
    const j = (await get.json()) as any;
    expect(j).toMatchObject({ agent: "rl-bob", online: true, room: "rl" });
    expect("requested" in j).toBe(false);
    expect(j.factory.last).toBeNull();
    expect((await fetch(`${hub.url}/agents/nobody/reload-status?token=${hub.token}`)).status).toBe(400);
    expect((await fetch(`${hub.url}/agents/${hub.humanName}/reload-status?token=${hub.token}`)).status).toBe(400);
    expect((await fetch(`${hub.url}/agents/rl-bob/reload-status`)).status).toBe(401); // read auth
    await sleep(300);
    expect(bob.events.slice(before)).toHaveLength(0);

    // the agent's own record calls: a good reload, then a forced one that fails
    const first = await postJson(hub, "/factory/relink", { agent: "rl-bob" });
    expect(first.status).toBe(200);
    expect((await postJson(hub, "/factory/applied", { agent: "rl-bob", version: V2, attempt: (first.json as any).attempt })).status).toBe(200);
    const ok = (await (await fetch(`${hub.url}/agents/rl-bob/reload-status?token=${hub.token}`)).json()) as any;
    expect(ok.factory.last).toMatchObject({ result: "applied", version: V2 });
    const forced = await postJson(hub, "/factory/relink", { agent: "rl-bob", force: true });
    expect(forced.json).toMatchObject({ reload: true });
    expect((await postJson(hub, "/factory/applied", { agent: "rl-bob", failed: true, attempt: "0000000000000000" })).status).toBe(409); // a stale report
    expect((await postJson(hub, "/factory/applied", { agent: "rl-bob", failed: true, attempt: (forced.json as any).attempt })).status).toBe(200);
    const bad = (await (await fetch(`${hub.url}/agents/rl-bob/reload-status?token=${hub.token}`)).json()) as any;
    expect(bad.factory).toMatchObject({ linked: V2, applied: V2 });
    expect(bad.factory.last).toMatchObject({ result: "failed", version: V2 });
  });

  test("a last-result write error is not hidden: the report answers 500, .pending stays, and the same report works after the fault is gone (C5a2)", async () => {
    const carol = collect(hub, "/agent-stream?agent=rl-carol&room=rl"); // the status route knows connected agents only
    open.push(carol);
    await sleep(600);
    const dir = process.env.CUBILOT_FACTORY_DIR!;
    const lastPath = join(dir, "agents", `${agentKey("rl-carol")}.last`);
    // a folder where the file belongs: the rename of the temp file onto it fails
    mkdirSync(lastPath);
    try {
      const a = await postJson(hub, "/factory/relink", { agent: "rl-carol" });
      expect(a.json).toMatchObject({ reload: true });
      const attempt = (a.json as any).attempt;
      const bad = await postJson(hub, "/factory/applied", { agent: "rl-carol", version: V2, attempt });
      expect(bad.status).toBe(500);
      expect(String((bad.json as any).error)).toContain("last write failed");
      // the order is still held: no second reload is ordered, and the status shows no last result
      const again = await postJson(hub, "/factory/relink", { agent: "rl-carol", force: true });
      expect(again.json).toMatchObject({ reload: false, pending: true });
      rmSync(lastPath, { recursive: true });
      const ok = await postJson(hub, "/factory/applied", { agent: "rl-carol", version: V2, attempt });
      expect(ok.status).toBe(200);
      const st = (await (await fetch(`${hub.url}/agents/rl-carol/reload-status?token=${hub.token}`)).json()) as any;
      expect(st.factory.last).toMatchObject({ result: "applied", version: V2 });
    } finally {
      rmSync(lastPath, { recursive: true, force: true });
    }
    // a failed report, the same fault: 500 and .pending stays
    const b = await postJson(hub, "/factory/relink", { agent: "rl-carol", force: true });
    mkdirSync(lastPath);
    try {
      const bad = await postJson(hub, "/factory/applied", { agent: "rl-carol", failed: true, attempt: (b.json as any).attempt });
      expect(bad.status).toBe(500);
      expect((await postJson(hub, "/factory/relink", { agent: "rl-carol", force: true })).json).toMatchObject({ reload: false, pending: true });
      rmSync(lastPath, { recursive: true });
      // the same attempt reports again and now succeeds
      expect((await postJson(hub, "/factory/applied", { agent: "rl-carol", failed: true, attempt: (b.json as any).attempt })).status).toBe(200);
      const st = (await (await fetch(`${hub.url}/agents/rl-carol/reload-status?token=${hub.token}`)).json()) as any;
      expect(st.factory.last).toMatchObject({ result: "failed", version: V2 });
    } finally {
      rmSync(lastPath, { recursive: true, force: true });
    }
  });
});
