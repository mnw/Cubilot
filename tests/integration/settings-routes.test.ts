// Settings read routes (Part 12 group 2): the values the removed Tauri commands returned, from the hub.
// Real hub per test (helpers/hub.ts); config.yml, the factory tree, the mod folder and tmux are fixtures in a temp folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";

const fx = mkdtempSync(join(tmpdir(), "cubilot-settings-"));
const src = join(fx, "src");
const factory = join(fx, "factory");
const modDir = join(fx, "mod");
const gitRoot = join(fx, "proj");

function role(name: string, front: string) {
  mkdirSync(join(src, name), { recursive: true });
  writeFileSync(join(src, name, `${name}.md`), `---\nname: ${name}\n${front}---\nbody\n`);
}
function stage(name: string) {
  mkdirSync(join(factory, "v1", name), { recursive: true });
  writeFileSync(join(factory, "v1", name, "role.md"), "body");
}

// A tmux stand-in: one pi session "p1" with a pill, a claude session "c1" with a harness option, nothing else.
const fakeTmux = join(fx, "tmux");

let hub: HubHandle;
const get = (path: string, token = hub.token) => fetch(`${hub.url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
const config = (yml: string) => writeFileSync(join(hub.dataDir, "config.yml"), yml);

beforeAll(async () => {
  role("worker", "model: claude-x\n");
  role("validator", "harness: pi\nprovider: openai-codex\nmodel: gpt-5.6-sol\nthinking: high\n");
  role("orchestrator", "effort: medium\n");
  role("a11y", "council: yes\n");
  role("unstaged", "");
  for (const r of ["worker", "validator", "orchestrator", "a11y"]) stage(r);
  stage("shared"); // a staged folder that is not a role
  writeFileSync(join(factory, "current"), "v1\n");
  for (const f of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js"]) {
    mkdirSync(join(modDir, f, ".."), { recursive: true });
    writeFileSync(join(modDir, f), "{}");
  }
  mkdirSync(join(gitRoot, ".git"), { recursive: true });
  mkdirSync(join(gitRoot, "a", "b"), { recursive: true });
  writeFileSync(
    fakeTmux,
    `#!/bin/sh
case "$*" in
  *list-sessions*) printf 'p1\\tvalidator\\tgpt\\topenai-codex\\thigh\\tpi\\nc1\\t\\tm\\t\\tdefault\\tclaude\\nx\\t\\t\\t\\t\\t\\n' ;;
  *has-session*"=p1"*|*has-session*"=c1"*) exit 0 ;;
  *has-session*) exit 1 ;;
  *show-options*"=p1:"*) echo pi ;;
  *show-options*"=c1:"*) echo claude ;;
  *display-message*"=p1:"*) echo /work/p1 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(fakeTmux, 0o755);
  hub = await spawnHub({
    humanName: "boss",
    env: {
      CUBILOT_APP_VERSION: "9.8.7",
      CUBILOT_FACTORY_SRC: src,
      CUBILOT_FACTORY_DIR: factory,
      CUBILOT_MOD_DIR: modDir,
      CUBILOT_TMUX: fakeTmux,
    },
  });
  mkdirSync(hub.dataDir, { recursive: true });
});

afterAll(async () => {
  await hub.kill();
});

describe("settings routes", () => {
  test("Theme change without reload", async () => {
    config("theme: rose-pine-dawn\n");
    expect((await (await get("/settings/ui")).json()).theme).toBe("rose-pine-dawn");
    config("theme: rose-pine-moon\n");
    expect((await (await get("/settings/ui")).json()).theme).toBe("rose-pine-moon");
  });

  test("Same values as the shell: ui settings", async () => {
    config("theme: nonsense\nfont_scale: 9\nfonts:\n  ui: Inter\n  mono: 'Bad;Font'\n");
    expect(await (await get("/settings/ui")).json()).toEqual({ theme: "default", font_scale: 1.25, fonts: { ui: "Inter", mono: "" } });
    config("font_scale: 0.1\n");
    expect(await (await get("/settings/ui")).json()).toEqual({ theme: "default", font_scale: 0.85, fonts: { ui: "", mono: "" } });
    config("");
    expect(await (await get("/settings/ui")).json()).toEqual({ theme: "default", font_scale: 1, fonts: { ui: "", mono: "" } });
  });

  test("Same values as the shell: human name, version, mcp template", async () => {
    expect(await (await get("/settings/human")).json()).toEqual({ name: "boss" });
    expect(await (await get("/settings/version")).json()).toEqual({ version: "9.8.7" });
    expect((await (await get("/settings/mcp-template")).json()).template).toBe(
      `CHATBRIDGE_AGENT='agent' CHATBRIDGE_ROOM='default' claude --plugin-dir '${modDir}'`,
    );
  });

  test("mcp template: a mod folder that lost a file gives 503", async () => {
    const f = join(modDir, "hooks/register.js");
    const keep = readFileSync(f);
    rmSync(f);
    const res = await get("/settings/mcp-template");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("next Claude spawn stages the mod again");
    writeFileSync(f, keep);
    expect((await get("/settings/mcp-template")).status).toBe(200);
  });

  test("mcp template: a stale mod folder is not exported by the shell, so the hub gives 503", async () => {
    const bare = await spawnHub({ humanName: "boss" });
    try {
      const res = await fetch(`${bare.url}/settings/mcp-template`, { headers: { Authorization: `Bearer ${bare.token}` } });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("next Claude spawn stages the mod again");
    } finally {
      await bare.kill();
    }
  });

  test("Same values as the shell: roles are the staged single-agent roles, sorted", async () => {
    const { roles, pills } = await (await get("/roles")).json();
    expect(roles.map((r: any) => r.name)).toEqual(["orchestrator", "validator", "worker"]);
    const v = roles.find((r: any) => r.name === "validator");
    expect([v.harness, v.provider, v.model, v.thinking, v.effort]).toEqual(["pi", "openai-codex", "gpt-5.6-sol", "high", null]);
    expect(roles.find((r: any) => r.name === "orchestrator").effort).toBe("medium");
    expect(roles.find((r: any) => r.name === "worker").harness).toBe("claude");
    expect(pills).toEqual({
      p1: { role: "validator", model: "gpt", provider: "openai-codex", effort: "high", harness: "pi" },
      c1: { role: "", model: "m", provider: "", effort: "default", harness: "claude" },
    });
  });

  test("harness: running sessions answer, an unknown agent gets 404", async () => {
    expect(await (await get("/agents/p1/harness")).json()).toEqual({ harness: "pi" });
    expect(await (await get("/agents/c1/harness")).json()).toEqual({ harness: "claude" });
    expect((await get("/agents/nobody/harness")).status).toBe(404);
  });

  test("harness: a roster agent with no session is claude", async () => {
    const ac = new AbortController();
    const s = await fetch(`${hub.url}/agent-stream?agent=w1&token=${hub.token}`, { signal: ac.signal });
    expect(s.status).toBe(200);
    expect(await (await get("/agents/w1/harness")).json()).toEqual({ harness: "claude" });
    ac.abort();
  });

  test("room-default: cwd gives the git-root basename, no cwd the hub default", async () => {
    expect(await (await get(`/room-default?cwd=${encodeURIComponent(join(gitRoot, "a", "b"))}`)).json()).toEqual({ room: "proj" });
    expect(await (await get(`/room-default?cwd=${encodeURIComponent(join(fx, "src"))}`)).json()).toEqual({ room: "src" });
    expect(await (await get("/room-default")).json()).toEqual({ room: "default" });
  });

  test("paths: config, skills folder, mcp config, agent cwd", async () => {
    const p = await (await get("/settings/paths?agent=p1")).json();
    expect(p).toEqual({
      config: join(hub.dataDir, "config.yml"),
      skills: join(hub.dataDir, "factory-user"),
      mcp: join(hub.dataDir, "mcp.json"),
      agent_cwd: "/work/p1",
    });
    expect((await get("/settings/paths")).status).toBe(200);
  });

  test("a request without a token gets 401", async () => {
    expect((await fetch(`${hub.url}/settings/ui`)).status).toBe(401);
  });
});

describe("the real factory tree", () => {
  test("the roles are the single-agent roles of the repo, no council and no shared (port of the shell test)", async () => {
    const realSrc = join(import.meta.dir, "../../factory");
    const realFactory = join(fx, "real-factory");
    const { readdirSync } = await import("node:fs");
    for (const d of readdirSync(realSrc)) {
      mkdirSync(join(realFactory, "v1", d), { recursive: true });
      writeFileSync(join(realFactory, "v1", d, "role.md"), "body");
    }
    writeFileSync(join(realFactory, "current"), "v1\n");
    const h = await spawnHub({ env: { CUBILOT_FACTORY_SRC: realSrc, CUBILOT_FACTORY_DIR: realFactory } });
    try {
      const { roles } = await (await fetch(`${h.url}/roles`, { headers: { Authorization: `Bearer ${h.token}` } })).json();
      expect(roles.map((r: any) => r.name)).toEqual(["editor", "orchestrator", "retrospective", "reviewer", "tester", "validator", "worker", "writer"]);
      const val = roles.find((r: any) => r.name === "validator");
      expect([val.harness, val.model]).toEqual(["pi", "gpt-5.6-sol"]);
      expect(roles.find((r: any) => r.name === "orchestrator").effort).toBe("medium");
      expect(roles.find((r: any) => r.name === "worker").effort).toBeNull();
    } finally {
      await h.kill();
    }
  });
});
