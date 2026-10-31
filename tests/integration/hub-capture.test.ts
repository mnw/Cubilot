// Turn capture, tap read, capture read and geometry heal through the real hub (hub-first-browser, group 6).
// The tmux socket and the capture folder are temp folders, never <app data>/tmux.sock or /tmp/cubilot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE, detectIdlePrompt, readCapture, CapturePathError } from "../../hub/core/tmux";
import { createTmux } from "../../hub/core/tmux";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { resolveTmuxBin } from "../helpers/tmux";

const bin = resolveTmuxBin();
let hub: HubHandle;
let work: string;
let capturesRoot: string;
let socket: string;
let tmux: ReturnType<typeof createTmux>;

const DIVIDER = "─".repeat(40);

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "cubilot-capture-"));
  capturesRoot = join(work, "captures");
  hub = await spawnHub({ env: { CUBILOT_TMUX: bin, CUBILOT_CAPTURES_DIR: capturesRoot, SHELL: "/bin/sh" } });
  mkdirSync(hub.dataDir, { recursive: true });
  socket = join(hub.dataDir, "tmux.sock");
  tmux = createTmux({ bin, socket, env: { ...process.env, SHELL: "/bin/sh" } });
});

afterEach(async () => {
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  await hub.kill();
  rmSync(work, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${hub.humanToken}` });
const get = (path: string, token = true) => fetch(`${hub.url}${path}`, { headers: token ? auth() : {} });
const post = (path: string, body: unknown = {}) =>
  fetch(`${hub.url}${path}`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** A TUI that reads one line, prints a reply, then shows the divider, the prompt and the cursor (the idle signature). */
async function fakeTui(name: string) {
  const script = join(work, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nprintf 'tui-ready\\n'\nIFS= read -r line\nprintf 'reply to %s\\n' "$line"\nprintf '%s\\n' '${DIVIDER}'\nprintf '❯ \\033[?25h'\nsleep 60\n`);
  chmodSync(script, 0o755);
  await tmux.newSession({ name, cwd: work, command: script });
  // Input sent before the script runs `read` can be lost: wait for the marker.
  for (let i = 0; i < 100 && !(await tmux.run(["capture-pane", "-p", "-t", `=${name}:`])).includes("tui-ready"); i++) await Bun.sleep(50);
}

describe("Turn capture", () => {
  test("a slash input returns the reply and the idle-prompt status, and the geometry comes back", async () => {
    await fakeTui("w1");
    const r = await post("/terminal/w1/capture-turn", { input: "/cost\r", timeout_ms: 8000 });
    expect(r.status).toBe(200);
    const res = (await r.json()) as { name: string; log_path: string; status: string; start_ms: number; end_ms: number };
    expect(res.status).toBe("idle-prompt");
    expect(res.end_ms).toBeGreaterThanOrEqual(res.start_ms);
    const log = await (await get(`/terminal/w1/capture?name=${encodeURIComponent(res.name)}`)).text();
    expect(log).toContain("reply to /cost");
    expect(log).toContain(DIVIDER);
    // pipe-pane is off and window-size is not left on manual
    expect((await tmux.run(["display-message", "-p", "-t", "=w1:", "#{pane_pipe}"])).trim()).toBe("0");
    expect((await tmux.run(["show-options", "-wv", "-t", "=w1:", "window-size"])).trim()).toBe("latest");
  });

  test("the input waits for the attach client: three captures in a row each hold the reply", async () => {
    for (const n of ["r1", "r2", "r3"]) {
      await fakeTui(n);
      const r = await post(`/terminal/${n}/capture-turn`, { input: "/cost\r", timeout_ms: 8000 });
      const res = (await r.json()) as { name: string; status: string };
      expect(res.status).toBe("idle-prompt");
      expect(await (await get(`/terminal/${n}/capture?name=${encodeURIComponent(res.name)}`)).text()).toContain("reply to /cost");
    }
  }, 40000);

  test("a pane with no output ends with timeout and keeps its log", async () => {
    await tmux.newSession({ name: "w2", cwd: work, command: "sleep 60" });
    const r = await post("/terminal/w2/capture-turn", { input: "", timeout_ms: 400 });
    const res = (await r.json()) as { name: string; status: string };
    expect(res.status).toBe("timeout");
    expect((await get(`/terminal/w2/capture?name=${res.name}`)).status).toBe(200);
  });

  test("a body without input is 400; an unknown session is 404; an invalid agent is 400", async () => {
    await fakeTui("w1");
    expect((await post("/terminal/w1/capture-turn", {})).status).toBe(400);
    expect((await post("/terminal/nope/capture-turn", { input: "x" })).status).toBe(404);
    expect((await post("/terminal/a%3Bb/capture-turn", { input: "x" })).status).toBe(400);
  });

  test("a mutating route needs the token", async () => {
    await fakeTui("w1");
    const r = await fetch(`${hub.url}/terminal/w1/capture-turn`, { method: "POST", body: JSON.stringify({ input: "x" }) });
    expect(r.status).toBe(401);
  });
});

describe("Tap read", () => {
  test("a 200 ms tap returns the current screen bytes", async () => {
    await tmux.newSession({ name: "w1", cwd: work, command: "printf 'screen text'; sleep 60" });
    const r = await get("/terminal/w1/tap?ms=200");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("screen text");
  });

  test("a missing ms uses the default; an unknown session is 404", async () => {
    await tmux.newSession({ name: "w1", cwd: work, command: "sleep 60" });
    expect((await get("/terminal/w1/tap")).status).toBe(200);
    expect((await get("/terminal/nope/tap?ms=0")).status).toBe(404);
  });
});

describe("Capture read", () => {
  test("a path outside the capture folder gets 400", async () => {
    mkdirSync(join(capturesRoot, "w1", "captures"), { recursive: true });
    writeFileSync(join(work, "secret.txt"), "secret");
    symlinkSync(join(work, "secret.txt"), join(capturesRoot, "w1", "captures", "link.log"));
    for (const name of ["/etc/hosts", "../../../../etc/hosts", join(work, "secret.txt"), "link.log"]) {
      const r = await get(`/terminal/w1/capture?name=${encodeURIComponent(name)}`);
      expect(r.status, name).toBe(400);
    }
  });

  test("a missing log is 404; a missing name is 400; the read needs the token", async () => {
    expect((await get("/terminal/w1/capture?name=turn-1.log")).status).toBe(404);
    expect((await get("/terminal/w1/capture")).status).toBe(400);
    expect((await get("/terminal/w1/capture?name=x", false)).status).toBe(401);
  });

  test("readCapture caps the bytes it returns", () => {
    const dir = join(work, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.log"), "0123456789");
    expect(readCapture(dir, "a.log", 4)).toBe("0123");
    expect(() => readCapture(dir, "../x")).toThrow(CapturePathError);
  });
});

describe("Human-only and error mapping", () => {
  test("the agent token gets 403 on the four routes", async () => {
    const a = { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" };
    for (const [m, p] of [["POST", "/terminal/w1/capture-turn"], ["GET", "/terminal/w1/tap"], ["GET", "/terminal/w1/capture?name=x"], ["POST", "/terminal/w1/heal"]]) {
      const r = await fetch(`${hub.url}${p}`, { method: m, headers: a, body: m === "POST" ? "{}" : undefined });
      expect(r.status, p).toBe(403);
    }
  });

  test("a missing session is 404; a tmux error from has-session is 500", async () => {
    expect((await get("/terminal/nope/tap?ms=0")).status).toBe(404);
    // A tmux that fails with an error other than "no session" or "no server": has-session throws.
    await hub.kill();
    const fake = join(work, "fake-tmux.sh");
    writeFileSync(fake, "#!/bin/sh\necho 'protocol version mismatch' >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    hub = await spawnHub({ env: { CUBILOT_TMUX: fake, CUBILOT_CAPTURES_DIR: capturesRoot, SHELL: "/bin/sh" } });
    const r = await get("/terminal/w1/tap?ms=0");
    expect(r.status).toBe(500);
  });

  test("max_bytes above CAPTURE.readMaxBytes is clamped", async () => {
    const dir = join(capturesRoot, "w1", "captures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "big.log"), "a".repeat(CAPTURE.readMaxBytes + 1000));
    const r = await get(`/terminal/w1/capture?name=big.log&max_bytes=${CAPTURE.readMaxBytes * 4}`);
    expect((await r.text()).length).toBe(CAPTURE.readMaxBytes);
  });
});

describe("Heal", () => {
  test("a pane stuck on window-size manual goes back to latest", async () => {
    await tmux.newSession({ name: "w1", cwd: work, command: "sleep 60" });
    await tmux.run(["set-option", "-w", "-t", "=w1:", "window-size", "manual"]);
    const r = await post("/terminal/w1/heal");
    expect(r.status).toBe(200);
    expect((await tmux.run(["show-options", "-wv", "-t", "=w1:", "window-size"])).trim()).toBe("latest");
    expect((await post("/terminal/nope/heal")).status).toBe(404);
  });
});

describe("detectIdlePrompt", () => {
  test("needs a divider of 30, then the prompt, then the cursor", () => {
    const ok = Buffer.from(`text\n${DIVIDER}\n❯ \x1b[?25h`);
    expect(detectIdlePrompt(ok)).toBe(true);
    expect(detectIdlePrompt(Buffer.from(`text\n${"─".repeat(10)}\n❯ \x1b[?25h`))).toBe(false);
    expect(detectIdlePrompt(Buffer.from(`text\n${DIVIDER}\n❯ `))).toBe(false);
  });
});
