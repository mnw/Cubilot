// hub/core/launch-executor.ts against a real tmux on a hermetic socket and a fake claude binary (hub-first-browser 7.2).
// Scenarios "Stage launch" and "Input to one session" of the hub-terminal spec, plus close and the ack retry.
// Never <app data>/tmux.sock, never a real claude.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLaunchExecutor, inputLine, type ExecutorHost } from "../../hub/core/launch-executor";
import type { AckOutcome, AckStatus, LaunchRequest } from "../../hub/core/launch-queue";
import { createTmux } from "../../hub/core/tmux";
import { createTerminal } from "../../hub/core/terminal";
import { resolveTmuxBin } from "../helpers/tmux";

const V = "v-0000000000000001";
const STAGE = "s_0123456789abcdef";
const bin = resolveTmuxBin();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(25);
  }
  return false;
}
const put = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

let root: string;
let socket: string;
let env: Record<string, string>;
let tmux: ReturnType<typeof createTmux>;
const stops: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cubilot-launch-exec-"));
  socket = join(root, "tmux.sock");
  const data = join(root, "data");
  const factory = join(data, "factory");
  const src = join(root, "bundle");
  const v = join(factory, V);
  put(join(src, "validator/validator.md"), "---\nname: validator\nmodel: sonnet\n---\nBody\n");
  for (const g of ["validator", "shared"]) {
    put(join(v, g, ".claude-plugin/plugin.json"), `{"name":"factory-${g}"}`);
    put(join(v, g, "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
    if (g !== "shared") put(join(v, g, "role.md"), "role");
  }
  put(join(v, "shared/scripts/statusline.sh"), "#!/bin/bash\n");
  put(join(factory, "current"), `${V}\n`);
  mkdirSync(join(factory, "agents"), { recursive: true });
  symlinkSync(V, join(factory, "active.tmp"));
  renameSync(join(factory, "active.tmp"), join(factory, "active"));
  mkdirSync(join(root, "home/.claude"), { recursive: true });
  mkdirSync(join(root, "work"));
  // The fake claude: answers --version, else writes its argv and the stage id to a file and stays alive.
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\nprintf '%s\\n' "$@" > '${root}/argv.txt'\nprintf '%s' "$CUBILOT_STAGE_ID" > '${root}/stage-id.txt'\nsleep 600\n`);
  chmodSync(claude, 0o755);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: "/bin/sh", HOME: join(root, "home"), LANG: "en_US.UTF-8",
    CUBILOT_DATA_DIR: data, CUBILOT_FACTORY_DIR: factory, CUBILOT_FACTORY_SRC: src, CUBILOT_LOGIN_PATH: process.env.PATH ?? "/usr/bin:/bin",
    CUBILOT_MOD_DIR: "/staged/mod", CUBILOT_PI_EXTENSION: "/staged/pi-extension.js", CUBILOT_CLAUDE_BIN: claude, CUBILOT_PI_BIN: "/bin/pi",
    CUBILOT_TMUX: bin,
  };
  tmux = createTmux({ bin, socket, env });
});

afterEach(() => {
  for (const s of stops.splice(0)) s();
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  rmSync(root, { recursive: true, force: true });
});

/** A host that records the acks. `answers` gives the status of the next acks (default ok). */
function host(answers: AckStatus[] = []) {
  const acks: Array<{ id: string; outcome: AckOutcome }> = [];
  let send: (r: LaunchRequest) => void = () => {};
  let resent = 0;
  const h: ExecutorHost = {
    attach: (s) => { send = s; },
    ack: (id, outcome) => {
      acks.push({ id, outcome });
      return { status: answers.shift() ?? "ok" };
    },
    resendCloses: () => { resent++; },
  };
  return { h, acks, push: (r: LaunchRequest) => send(r), resent: () => resent };
}
const launchReq = (over: Partial<Extract<LaunchRequest, { kind: "launch" }>> = {}): LaunchRequest => ({
  id: "l_00000000000000a1", kind: "launch", stage_id: STAGE, session: "validator-1", role: "validator", room: "cubilot", harness: "claude",
  cwd: join(root, "work"), prompt: "TICKET TEXT", env: {}, ...over,
});

function run(h: ExecutorHost, extra: Record<string, unknown> = {}) {
  const ex = startLaunchExecutor(h, { tmux, env, ackPauseMs: 10, closeRetryMs: 30, inputHoldMs: 100, ...extra });
  stops.push(ex.stop);
  return ex;
}

describe("Stage launch", () => {
  test("a Validator launch starts a tmux session whose command has --plugin-dir, --allowed-tools, --settings and CUBILOT_STAGE_ID, and the launch is acked", async () => {
    const t = host();
    run(t.h);
    t.push(launchReq());
    expect(await until(() => t.acks.length === 1)).toBe(true);
    expect(t.acks[0]).toEqual({ id: "l_00000000000000a1", outcome: { result: "spawned" } });
    expect(await tmux.hasSession("validator-1")).toBe(true);
    expect(await until(() => existsSync(join(root, "argv.txt")))).toBe(true);
    const argv = readFileSync(join(root, "argv.txt"), "utf8").split("\n");
    expect(argv).toContain("--plugin-dir");
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe("/staged/mod");
    expect(argv).toContain("--allowed-tools");
    expect(argv).toContain("--settings");
    expect(argv[argv.indexOf("--settings") + 1]).toBe(join(root, "data/factory-settings/validator-1.json"));
    expect(readFileSync(join(root, "stage-id.txt"), "utf8")).toBe(STAGE);
    expect(readFileSync(join(root, "data/sessions/validator-1/first-message.md"), "utf8")).toBe("TICKET TEXT");
  });

  test("a launch that cannot start is acked as an error and starts no session", async () => {
    const t = host();
    run(t.h);
    t.push(launchReq({ id: "l_00000000000000a2", cwd: null }));
    t.push(launchReq({ id: "l_00000000000000a3", session: "a.b" }));
    t.push(launchReq({ id: "l_00000000000000a4", role: "nope", session: "w9" }));
    expect(await until(() => t.acks.length === 3)).toBe(true);
    const by = Object.fromEntries(t.acks.map((a) => [a.id, a.outcome]));
    expect(by["l_00000000000000a2"]).toEqual({ result: "error", error: "the launch has no working folder" });
    expect((by["l_00000000000000a3"] as { error: string }).error).toContain("a dot is not allowed");
    expect((by["l_00000000000000a4"] as { error: string }).error).toContain("unknown role: nope");
    expect(await tmux.listSessions()).toEqual([]);
  });

  test("an ack the hub could not record is sent again, and the launch runs once", async () => {
    const t = host(["error", "error", "ok"]);
    run(t.h);
    t.push(launchReq());
    expect(await until(() => t.acks.length === 3)).toBe(true);
    expect(t.acks.map((a) => a.outcome)).toEqual([{ result: "spawned" }, { result: "spawned" }, { result: "spawned" }]);
    expect(await tmux.listSessions()).toEqual(["validator-1"]);
  });
});

describe("Close", () => {
  test("a close kills the session and acks spawned; a repeated id acks again without a second kill", async () => {
    const t = host();
    run(t.h);
    t.push(launchReq());
    expect(await until(() => t.acks.length === 1)).toBe(true);
    t.push({ id: "l_00000000000000b1", kind: "close", session: "validator-1" });
    expect(await until(() => t.acks.length === 2)).toBe(true);
    expect(t.acks[1]).toEqual({ id: "l_00000000000000b1", outcome: { result: "spawned" } });
    expect(await tmux.hasSession("validator-1")).toBe(false);
    // A new session of the same name must survive the repeated close.
    await tmux.newSession({ name: "validator-1", cwd: root, command: "sleep 600" });
    t.push({ id: "l_00000000000000b1", kind: "close", session: "validator-1" });
    expect(await until(() => t.acks.length === 3)).toBe(true);
    expect(t.acks[2].outcome).toEqual({ result: "spawned" });
    expect(await tmux.hasSession("validator-1")).toBe(true);
  });

  test("a close for a session that does not exist acks absent", async () => {
    const t = host();
    run(t.h);
    t.push({ id: "l_00000000000000b2", kind: "close", session: "ghost" });
    expect(await until(() => t.acks.length === 1)).toBe(true);
    expect(t.acks[0].outcome).toEqual({ result: "error", error: "no such session", absent: true });
  });

  test("a close that the hub keeps pending is sent again after a pause", async () => {
    const t = host(["pending"]);
    run(t.h);
    t.push({ id: "l_00000000000000b3", kind: "close", session: "ghost" });
    expect(await until(() => t.resent() === 1)).toBe(true);
  });
});

describe("Input to one session", () => {
  test("input {session, text: /clear} reaches that session and no other", async () => {
    const t = host();
    run(t.h);
    for (const s of ["orch", "other"]) await tmux.newSession({ name: s, cwd: root, command: `cat > '${join(root, s + ".txt")}'` });
    t.push({ id: "l_00000000000000c1", kind: "input", session: "orch", text: "/clear" });
    expect(await until(() => t.acks.length === 1)).toBe(true);
    expect(t.acks[0].outcome).toEqual({ result: "spawned" });
    expect(await until(() => existsSync(join(root, "orch.txt")) && readFileSync(join(root, "orch.txt"), "utf8").includes("/clear"))).toBe(true);
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("");
  });

  test("the ack comes after the line reached the session, also when the attach is slow, and the size stays 200x50", async () => {
    const t = host();
    const real = createTerminal(tmux);
    let attachedAt = 0;
    // A slow fake terminal: the attach takes 400 ms.
    const slow = { attach: async (a: string, o: Parameters<typeof real.attach>[1]) => { await sleep(400); attachedAt = Date.now(); return real.attach(a, o); } };
    run(t.h, { terminal: slow });
    const out = join(root, "echo.txt");
    await tmux.newSession({ name: "lead", cwd: root, command: `cat > '${out}'` });
    const size = async () => (await tmux.run(["display-message", "-p", "-t", "=lead:", "#{window_width}x#{window_height}"])).trim();
    const big = await real.attach("lead", { cols: 200, rows: 50, onData() {} });
    try {
      expect(await until(async () => (await size()) === "200x50")).toBe(true);
      let seenAtAck = "";
      const h2 = t.h.ack;
      t.h.ack = (id, o) => { seenAtAck = existsSync(out) ? readFileSync(out, "utf8") : ""; return h2(id, o); };
      t.push({ id: "l_00000000000000c4", kind: "input", session: "lead", text: "/clear" });
      expect(await until(() => t.acks.length === 1)).toBe(true);
      expect(t.acks[0].outcome).toEqual({ result: "spawned" });
      expect(attachedAt).toBeGreaterThan(0);
      expect(seenAtAck).toContain("/clear");
      await sleep(200);
      expect(await size()).toBe("200x50");
    } finally {
      big.close();
    }
  });

  test("an unknown session and a bad text are acked as errors", async () => {
    const t = host();
    run(t.h);
    t.push({ id: "l_00000000000000c2", kind: "input", session: "ghost", text: "/clear" });
    t.push({ id: "l_00000000000000c3", kind: "input", session: "ghost", text: "a\nb" });
    expect(await until(() => t.acks.length === 2)).toBe(true);
    const by = Object.fromEntries(t.acks.map((a) => [a.id, a.outcome]));
    expect(by["l_00000000000000c2"]).toEqual({ result: "error", error: "unknown session: ghost" });
    expect((by["l_00000000000000c3"] as { error: string }).error).toContain("control character");
  });

  test("inputLine: one line, at most 1024 bytes, no control character, Enter appended", () => {
    expect(inputLine("/clear")).toBe("/clear\r");
    expect(inputLine("")).toBeNull();
    expect(inputLine("a\tb")).toBeNull();
    expect(inputLine("x".repeat(1025))).toBeNull();
    expect(inputLine("x".repeat(1024))).toBe("x".repeat(1024) + "\r");
  });
});
