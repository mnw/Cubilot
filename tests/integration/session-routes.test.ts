// POST /sessions, POST /sessions/shell, GET /sessions, GET /sessions/shell and POST /sessions/<name>/kill through a real
// hub (hub-first-browser 8.1). Fake claude binary, hermetic tmux socket in a temp data folder. Never a real agent session.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { resolveTmuxBin } from "../helpers/tmux";

const V = "v-0000000000000001";
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
let hub: HubHandle;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cubilot-session-routes-"));
  const data = join(root, "data");
  socket = join(data, "tmux.sock");
  const factory = join(data, "factory");
  const src = join(root, "bundle");
  const v = join(factory, V);
  for (const role of ["worker", "tester"]) put(join(src, role, `${role}.md`), `---\nname: ${role}\nmodel: sonnet\n---\nBody\n`);
  for (const g of ["worker", "tester", "shared"]) {
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
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\nprintf '%s\\n' "$@" > "${root}/argv-$CHATBRIDGE_AGENT.txt"\nsleep 600\n`);
  chmodSync(claude, 0o755);
  hub = await spawnHub({
    env: {
      SHELL: "/bin/sh", HOME: join(root, "home"), LANG: "en_US.UTF-8",
      CUBILOT_DATA_DIR: data, CUBILOT_FACTORY_DIR: factory, CUBILOT_FACTORY_SRC: src,
      CUBILOT_MOD_DIR: "/staged/mod", CUBILOT_PI_EXTENSION: "/staged/pi-extension.js", CUBILOT_CLAUDE_BIN: claude, CUBILOT_PI_BIN: "/bin/pi",
      CUBILOT_TMUX: bin,
    },
  });
});

afterEach(async () => {
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  await hub.kill();
  rmSync(root, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, token = hub.humanToken) =>
  fetch(`${hub.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
const tmuxOut = (args: string[]) => {
  const r = Bun.spawnSync([bin, "-S", socket, ...args]);
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
const hasSession = (n: string) => tmuxOut(["has-session", "-t", `=${n}`]).code === 0;
const form = (over: Record<string, unknown> = {}) => ({ name: "w1", room: "cubilot", harness: "claude", role: "worker", cwd: join(root, "work"), ...over });

describe("create and list", () => {
  test("a create starts the session with the launch flags and the pill records, and the list shows it", async () => {
    const r = await call("POST", "/sessions", form({ model: "opus" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: "w1", created: true });
    expect(hasSession("w1")).toBe(true);
    expect(await until(() => existsSync(join(root, "argv-w1.txt")))).toBe(true);
    const argv = readFileSync(join(root, "argv-w1.txt"), "utf8").split("\n");
    expect(argv).toContain("--plugin-dir");
    expect(argv).toContain("--allowed-tools");
    expect(argv).toContain("--settings");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    const pill = tmuxOut(["list-sessions", "-F", "#{session_name}|#{@cubilot_harness}|#{@cubilot_role}|#{@cubilot_model}|#{@cubilot_effort}"]).out;
    expect(pill).toBe("w1|claude|worker|opus|default");
    const list = await (await call("GET", "/sessions")).json();
    expect(list).toEqual({ sessions: ["w1"] });
  });

  test("resume adds --resume to the command", async () => {
    expect((await call("POST", "/sessions", form({ resume: "resume" }))).status).toBe(200);
    expect(await until(() => existsSync(join(root, "argv-w1.txt")))).toBe(true);
    expect(readFileSync(join(root, "argv-w1.txt"), "utf8").split("\n")).toContain("--resume");
  });

  test("a create for a running session starts nothing new: the same role gives 200, another role gives 409", async () => {
    expect((await call("POST", "/sessions", form())).status).toBe(200);
    const again = await call("POST", "/sessions", form());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, name: "w1", created: false });
    const other = await call("POST", "/sessions", form({ role: "tester" }));
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: string }).error).toContain("already runs with role worker");
  });

  test.each([
    ["an invalid name", { name: "a/b" }],
    ["a reserved name", { name: "system" }],
    ["the shell name", { name: "shell" }],
    ["a dot in the name", { name: "a.b" }],
    ["an unknown harness", { harness: "gpt" }],
    ["an invalid resume", { resume: "fork" }],
    ["an invalid room", { room: "a/b" }],
    ["no working folder", { cwd: "" }],
    ["no role", { role: "" }],
    ["an unknown role", { role: "nope" }],
  ])("%s gets 400 and starts no session", async (_n, over) => {
    const r = await call("POST", "/sessions", form(over));
    expect(r.status).toBe(400);
    expect(typeof ((await r.json()) as { error: string }).error).toBe("string");
    expect(tmuxOut(["list-sessions"]).code).not.toBe(0);
  });
});

describe("shell", () => {
  test("the shell check is false, then true after a shell create, and the list leaves the shell out", async () => {
    expect(await (await call("GET", "/sessions/shell")).json()).toEqual({ exists: false });
    const r = await call("POST", "/sessions/shell");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, created: true });
    expect(await (await call("GET", "/sessions/shell")).json()).toEqual({ exists: true });
    expect(tmuxOut(["show-options", "-v", "-t", "=shell:", "allow-passthrough"]).out).toBe("on");
    expect(await (await call("POST", "/sessions/shell")).json()).toEqual({ ok: true, created: false });
    await call("POST", "/sessions", form());
    expect(await (await call("GET", "/sessions")).json()).toEqual({ sessions: ["w1"] });
  });
});

describe("kill", () => {
  test("a kill ends the session, a second kill gives 404 and an invalid name gives 400", async () => {
    await call("POST", "/sessions", form());
    expect(hasSession("w1")).toBe(true);
    expect(await (await call("POST", "/sessions/w1/kill")).json()).toEqual({ ok: true });
    expect(hasSession("w1")).toBe(false);
    expect((await call("POST", "/sessions/w1/kill")).status).toBe(404);
    expect((await call("POST", "/sessions/system/kill")).status).toBe(400);
    expect((await call("POST", "/sessions/%E0%A4%A/kill")).status).toBe(400);
  });
});

describe("human only", () => {
  test("the agent token gets 403 on each route and changes nothing", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/sessions", form()],
      ["POST", "/sessions/shell"],
      ["GET", "/sessions"],
      ["GET", "/sessions/shell"],
      ["POST", "/sessions/w1/kill"],
    ];
    for (const [m, p, b] of routes) expect((await call(m, p, b, hub.token)).status, `${m} ${p}`).toBe(403);
    expect(tmuxOut(["list-sessions"]).code).not.toBe(0);
  });
});
