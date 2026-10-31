// Terminal WebSocket, Take control, hold and composer input through the real hub (hub-first-browser, group 9).
// The tmux socket is a temp folder, never <app data>/tmux.sock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux } from "../../hub/core/tmux";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { registerAgent } from "../helpers/fetch";
import { resolveTmuxBin } from "../helpers/tmux";

const bin = resolveTmuxBin();
let hub: HubHandle;
let work: string;
let socket: string;
let tmux: ReturnType<typeof createTmux>;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "cubilot-termws-"));
  hub = await spawnHub({ env: { CUBILOT_TMUX: bin, CUBILOT_CAPTURES_DIR: join(work, "captures"), SHELL: "/bin/sh" } });
  mkdirSync(hub.dataDir, { recursive: true });
  socket = join(hub.dataDir, "tmux.sock");
  tmux = createTmux({ bin, socket, env: { ...process.env, SHELL: "/bin/sh" } });
});

afterEach(async () => {
  for (const s of sockets) try { s.close(); } catch {}
  sockets = [];
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  await hub.kill();
  rmSync(work, { recursive: true, force: true });
});

/** A session that writes every byte it receives to <work>/<name>.out (raw mode, no echo). */
async function sink(name: string): Promise<string> {
  const out = join(work, `${name}.out`);
  const script = join(work, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nstty raw -echo\nprintf 'sink-ready\\n'\nexec cat >> '${out}'\n`);
  chmodSync(script, 0o755);
  await tmux.newSession({ name, cwd: work, command: script });
  for (let i = 0; i < 100 && !(await tmux.run(["capture-pane", "-p", "-t", `=${name}:`])).includes("sink-ready"); i++) await Bun.sleep(50);
  await Bun.sleep(200);
  return out;
}
const received = (out: string) => (existsSync(out) ? readFileSync(out, "utf8") : "");
const size = async (name: string) => (await tmux.run(["display-message", "-p", "-t", `=${name}:`, "#{window_width}x#{window_height}"])).trim();

type Viewer = { ws: WebSocket; text: any[]; bytes: () => number; next: (pred: (m: any) => boolean, ms?: number) => Promise<any> };
async function open(agent: string, opts: { token?: string; cols?: number; rows?: number } = {}): Promise<Viewer> {
  const q = new URLSearchParams({ token: opts.token ?? hub.humanToken });
  if (opts.cols) q.set("cols", String(opts.cols));
  if (opts.rows) q.set("rows", String(opts.rows));
  const ws = new WebSocket(`${hub.url.replace("http", "ws")}/terminal/${agent}?${q}`);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const text: any[] = [];
  let n = 0;
  ws.onmessage = (e) => {
    if (typeof e.data === "string") text.push(JSON.parse(e.data));
    else n += (e.data as ArrayBuffer).byteLength;
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const next = async (pred: (m: any) => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = text.find(pred);
      if (hit) return hit;
      await Bun.sleep(25);
    }
    throw new Error(`no matching frame in ${ms} ms: ${JSON.stringify(text)}`);
  };
  return { ws, text, bytes: () => n, next };
}
const send = (v: Viewer, m: unknown) => v.ws.send(JSON.stringify(m));
const keys = (s: string) => ({ t: "in", d: Buffer.from(s).toString("base64") });
const take = async (v: Viewer) => { send(v, { t: "take" }); await v.next((m) => m.t === "control" && m.by === "you"); };

describe("Read-only viewer", () => {
  test("streams the screen as binary frames and drops input with a read-only error", async () => {
    const out = await sink("w1");
    const v = await open("w1");
    for (let i = 0; i < 100 && v.bytes() === 0; i++) await Bun.sleep(25);
    expect(v.bytes()).toBeGreaterThan(0);
    send(v, keys("ls\r"));
    const err = await v.next((m) => m.t === "error");
    expect(err.e).toBe("read-only");
    send(v, { t: "resize", cols: 100, rows: 30 });
    await Bun.sleep(300);
    expect(received(out)).toBe("");
  });

  test("the agent token gets 403 and an unknown session gets 404", async () => {
    await sink("w1");
    const agent = await fetch(`${hub.url}/terminal/w1`, { headers: { Authorization: `Bearer ${hub.token}` } });
    expect(agent.status).toBe(403);
    const agentQ = await fetch(`${hub.url}/terminal/w1?token=${hub.token}`, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
    expect(agentQ.status).toBe(403);
    const none = await fetch(`${hub.url}/terminal/w1`);
    expect(none.status).toBe(401);
    const nosess = await fetch(`${hub.url}/terminal/ghost`, { headers: { Authorization: `Bearer ${hub.humanToken}` } });
    expect(nosess.status).toBe(404);
    const plain = await fetch(`${hub.url}/terminal/w1`, { headers: { Authorization: `Bearer ${hub.humanToken}` } });
    expect(plain.status).toBe(426);
  });
});

describe("Phone does not resize", () => {
  test("a read-only viewer at 40x20 leaves a 120x40 controller session alone", async () => {
    await sink("w1");
    const desktop = await open("w1", { cols: 120, rows: 40 });
    send(desktop, { t: "take", cols: 120, rows: 40 });
    await desktop.next((m) => m.t === "control" && m.by === "you");
    for (let i = 0; i < 40 && (await size("w1")) !== "120x40"; i++) await Bun.sleep(50);
    expect(await size("w1")).toBe("120x40");
    const phone = await open("w1", { cols: 40, rows: 20 });
    for (let i = 0; i < 100 && phone.bytes() === 0; i++) await Bun.sleep(25);
    await Bun.sleep(300);
    expect(await size("w1")).toBe("120x40");
    send(phone, { t: "resize", cols: 40, rows: 20 });
    expect((await phone.next((m) => m.t === "error")).e).toBe("read-only");
    expect(await size("w1")).toBe("120x40");
  });
});

describe("control", () => {
  test("Take control gives input, Hand back takes it away", async () => {
    const out = await sink("w1");
    const v = await open("w1");
    await take(v);
    send(v, keys("abc"));
    for (let i = 0; i < 60 && received(out) !== "abc"; i++) await Bun.sleep(50);
    expect(received(out)).toBe("abc");
    send(v, { t: "hand_back" });
    await v.next((m) => m.t === "control" && m.by === "none");
    send(v, keys("zzz"));
    expect((await v.next((m) => m.t === "error")).e).toBe("read-only");
    await Bun.sleep(200);
    expect(received(out)).toBe("abc");
  });

  test("Control moves: a second Take control moves it and tells the first viewer", async () => {
    const out = await sink("w1");
    const a = await open("w1");
    const b = await open("w1");
    await take(a);
    await take(b);
    await a.next((m) => m.t === "control" && m.by === "other");
    send(b, keys("B"));
    for (let i = 0; i < 60 && !received(out).includes("B"); i++) await Bun.sleep(50);
    expect(received(out)).toBe("B");
    send(a, keys("A"));
    expect((await a.next((m) => m.t === "error")).e).toBe("read-only");
    await Bun.sleep(200);
    expect(received(out)).toBe("B");
  });

  test("a hand back by a viewer without control changes nothing", async () => {
    await sink("w1");
    const a = await open("w1");
    const b = await open("w1");
    await take(a);
    send(b, { t: "hand_back" });
    await Bun.sleep(150);
    send(a, keys("x"));
    await Bun.sleep(150);
    expect(a.text.filter((m) => m.t === "error")).toEqual([]);
  });

  test("control holds the entries of the agent, closing the controller's socket releases them in order", async () => {
    await sink("w1");
    const agent = await registerAgent(hub, "w1");
    const get = async (path: string) => (await fetch(`${hub.url}${path}`, { headers: { Authorization: `Bearer ${hub.humanToken}` } })).json() as Promise<any>;
    const say = (text: string) => fetch(`${hub.url}/post`, { method: "POST", headers: { Authorization: `Bearer ${hub.humanToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "human", to: "w1", text }) });
    const v = await open("w1");
    await take(v);
    expect((await say("first")).status).toBe(200);
    expect((await say("second")).status).toBe(200);
    expect((await get("/presence")).held).toEqual({ w1: 2 });
    expect((await get("/agents")).find((a: any) => a.name === "w1").held).toBe(2);
    v.ws.close();
    for (let i = 0; i < 60 && Object.keys((await get("/presence")).held).length > 0; i++) await Bun.sleep(50);
    expect((await get("/presence")).held).toEqual({});
    expect((await get("/agents")).find((a: any) => a.name === "w1").held).toBe(0);
    agent.close();
  });

  test("Hand back releases the hold", async () => {
    await sink("w1");
    const agent = await registerAgent(hub, "w1");
    const get = async (path: string) => (await fetch(`${hub.url}${path}`, { headers: { Authorization: `Bearer ${hub.humanToken}` } })).json() as Promise<any>;
    const v = await open("w1");
    await take(v);
    await fetch(`${hub.url}/post`, { method: "POST", headers: { Authorization: `Bearer ${hub.humanToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "human", to: "w1", text: "x" }) });
    expect((await get("/presence")).held).toEqual({ w1: 1 });
    send(v, { t: "hand_back" });
    await v.next((m) => m.t === "control" && m.by === "none");
    expect((await get("/presence")).held).toEqual({});
    agent.close();
  });
});

describe("composer", () => {
  test("Slash command from the composer: POST /terminal/<agent>/input writes once", async () => {
    const out = await sink("w1");
    const r = await fetch(`${hub.url}/terminal/w1/input`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.humanToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/cost\r" }),
    });
    expect(r.status).toBe(200);
    for (let i = 0; i < 60 && !received(out).includes("/cost"); i++) await Bun.sleep(50);
    expect(received(out)).toBe("/cost\r");
  });

  test("the agent token gets 403, a bad body 400, a missing session 404", async () => {
    const out = await sink("w1");
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${hub.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/terminal/w1/input", hub.token, { text: "x" })).status).toBe(403);
    expect((await post("/terminal/w1/input", hub.humanToken, { text: 5 })).status).toBe(400);
    expect((await post("/terminal/ghost/input", hub.humanToken, { text: "x" })).status).toBe(404);
    await Bun.sleep(200);
    expect(received(out)).toBe("");
  });
});

describe("session list", () => {
  test("lists the live sessions by name, without the shell, for the human only", async () => {
    await sink("zed");
    await sink("alpha");
    await sink("shell");
    const get = (token: string) => fetch(`${hub.url}/terminal-sessions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(((await (await get(hub.humanToken)).json()) as any).sessions).toEqual(["alpha", "zed"]);
    expect((await get(hub.token)).status).toBe(403);
  });
});
