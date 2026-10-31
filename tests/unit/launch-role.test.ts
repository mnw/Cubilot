// hub/core/launch-role.ts: the Rust tests of resolve_role_launch, launch_in and write_agent_settings ported (group 7a),
// plus the version check, the Pi sign-in check, the MCP config file and the first-message file. Temp folders only,
// a fake claude and a fake pi. No real session, no real ~/.claude.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../../hub/features/factory-skills";
import { agentKey } from "../../hub/core/skills";
import {
  authCheckResult, buildAgentSettings, checkClaudeVersion, checkRoleHarness, clearAgentRecords, ensureClaudeVersion, launchChoice, launchIn,
  linkAgent, loadRoleSpec, parseClaudeVersion, parseGlobalMcpServers, parseRoleSpec, piAuthCheck, piProviderToCheck, prepareLaunch,
  resolveRoleLaunchIn, roleLaunchOn, withChoice, writeAgentSettings, writeFirstMessage, writeGlobalMcpConfig, type LaunchDeps,
} from "../../hub/core/launch-role";

const V = "v-0000000000000001";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (tag: string): string => {
  const r = mkdtempSync(join(tmpdir(), `cubilot-launch-role-${tag}-`));
  roots.push(r);
  return r;
};
const mode = (p: string) => statSync(p).mode & 0o777;
const put = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

const WORKER_MD = "---\nname: worker\nmodel: sonnet\ndisallowedTools: Task, Agent\nexcludeTools: edit\n---\nBody\n";
const VALIDATOR_MD = "---\nname: validator\nharness: pi\nprovider: openai-codex\nmodel: gpt-x\nthinking: high\nexcludeTools: write\n---\nBody\n";

/** A bundled factory/ (frontmatter) and a staged version (role.md, skills, shared) in a temp app data dir. */
function fixture() {
  const root = tmp("fx");
  const src = join(root, "bundle");
  const data = join(root, "data");
  const factory = join(data, "factory");
  const v = join(factory, V);
  put(join(src, "worker/worker.md"), WORKER_MD);
  put(join(src, "validator/validator.md"), VALIDATOR_MD);
  for (const [g, skills] of [["worker", ["a", "b"]], ["validator", ["c"]], ["shared", ["s"]]] as const) {
    mkdirSync(join(v, g, ".claude-plugin"), { recursive: true });
    put(join(v, g, ".claude-plugin/plugin.json"), `{"name":"factory-${g}"}`);
    for (const s of skills) put(join(v, g, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
    if (g !== "shared") put(join(v, g, "role.md"), "role");
  }
  put(join(v, "shared/scripts/statusline.sh"), "#!/bin/bash\n");
  put(join(factory, "current"), `${V}\n`);
  mkdirSync(join(factory, "active"), { recursive: true });
  mkdirSync(join(factory, "agents"), { recursive: true });
  require("node:fs").symlinkSync(V, join(factory, "active.tmp"));
  rmSync(join(factory, "active"), { recursive: true, force: true });
  require("node:fs").renameSync(join(factory, "active.tmp"), join(factory, "active"));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  return { root, src, data, factory, v, home, dirs: { factory, src, settingsDir: join(data, "factory-settings"), userClaude: join(home, ".claude") } };
}
const rec = (factory: string, agent: string, suffix: string) => join(factory, "agents", `${agentKey(agent)}${suffix}`);

describe("role spec and choice", () => {
  test("parseRoleSpec reads the frontmatter and refuses a bad one", () => {
    expect(parseRoleSpec("worker", WORKER_MD)).toEqual({ name: "worker", harness: "claude", provider: undefined, model: "sonnet", thinking: undefined, effort: undefined, disallowedTools: ["Task", "Agent"], excludeTools: ["edit"] });
    expect(parseRoleSpec("validator", VALIDATOR_MD).harness).toBe("pi");
    expect(() => parseRoleSpec("x", "---\nname: x\ncouncil: yes\n---\n")).toThrow("role 'x' is a council, not a single agent; it cannot be spawned");
    expect(() => parseRoleSpec("x", "---\nname: y\n---\n")).toThrow("role 'x': frontmatter name is 'y'");
    expect(() => parseRoleSpec("x", "no frontmatter")).toThrow("role 'x': no frontmatter name");
    expect(() => parseRoleSpec("x", "---\nname: x\nharness: gpt\n---\n")).toThrow("role 'x': unknown harness 'gpt'");
    expect(() => parseRoleSpec("x", "---\nname: x\nharness: pi\neffort: high\n---\n")).toThrow("'effort' is for Claude roles");
    expect(() => parseRoleSpec("x", "---\nname: x\neffort: max9\n---\n")).toThrow("invalid effort 'max9' (allowed: low, medium, high, xhigh, max)");
  });

  test("loadRoleSpec: an unknown role, a bad name and an unstaged role are errors", () => {
    const { src, v } = fixture();
    expect(loadRoleSpec("worker", src, v).name).toBe("worker");
    expect(() => loadRoleSpec("nope", src, v)).toThrow("unknown role: nope");
    expect(() => loadRoleSpec("../x", src, v)).toThrow("invalid role");
    rmSync(join(v, "worker/role.md"));
    expect(() => loadRoleSpec("worker", src, v)).toThrow(`role 'worker' is not staged in ${v}`);
  });

  test("launchChoice: blank is not set; a bad value is refused with the texts the hub expects", () => {
    expect(launchChoice(false, " ", "", null)).toEqual({});
    expect(launchChoice(false, "opus", null, "high")).toEqual({ model: "opus", effort: "high" });
    expect(launchChoice(true, "m", "openai-codex", "off")).toEqual({ model: "m", provider: "openai-codex", effort: "off" });
    const starts = (f: () => unknown, p: string) => expect(() => f()).toThrow(new RegExp(`^${p.replace(/[()]/g, "\\$&")}`));
    starts(() => launchChoice(false, "bad model!"), "invalid model");
    starts(() => launchChoice(false, null, "p"), "a provider (");
    starts(() => launchChoice(true, null, "Bad Provider"), "invalid provider");
    starts(() => launchChoice(false, null, null, "max9"), "invalid effort");
    starts(() => launchChoice(true, null, null, "max9"), "invalid thinking level");
    expect(() => launchChoice(false, null, null, "off")).toThrow("invalid effort"); // off is a Pi level only
  });

  test("a role on the other harness needs a chosen model; the role's own values do not carry over", () => {
    const { src, v } = fixture();
    const worker = loadRoleSpec("worker", src, v);
    expect(() => checkRoleHarness(worker, "pi", {})).toThrow("role 'worker' runs on claude by default; to launch it on pi choose a model. Nothing was started.");
    checkRoleHarness(worker, "pi", { model: "m" });
    const onPi = roleLaunchOn(worker, "pi", v, null);
    expect([onPi.model, onPi.provider, onPi.thinking, onPi.effort]).toEqual([undefined, undefined, undefined, undefined]);
    expect(onPi.excludeTools).toEqual(["edit"]);
    const own = roleLaunchOn(worker, "claude", v, "/s.json");
    expect(own).toMatchObject({ name: "worker", pluginDir: join(v, "worker"), sharedDir: join(v, "shared"), promptFile: join(v, "worker/role.md"), settings: "/s.json", model: "sonnet" });
  });

  test("withChoice beats the role default for one launch: Claude effort, Pi thinking and provider", () => {
    const { src, v } = fixture();
    const c = withChoice(roleLaunchOn(loadRoleSpec("worker", src, v), "claude", v, "/s"), { model: "opus", effort: "max" });
    expect([c.model, c.effort]).toEqual(["opus", "max"]);
    const p = withChoice(roleLaunchOn(loadRoleSpec("validator", src, v), "pi", v, null), { provider: "other", effort: "low" });
    expect([p.provider, p.model, p.thinking, p.effort]).toEqual(["other", "gpt-x", "low", undefined]);
  });

  test("the Pi sign-in provider: the choice wins, a Pi role names one, a Claude role on Pi and a plain agent have none", () => {
    const { src, v } = fixture();
    const val = loadRoleSpec("validator", src, v);
    const worker = loadRoleSpec("worker", src, v);
    expect(piProviderToCheck("claude", val, {})).toBeNull();
    expect(piProviderToCheck("pi", val, {})).toBe("openai-codex");
    expect(piProviderToCheck("pi", val, { provider: "x" })).toBe("x");
    expect(piProviderToCheck("pi", worker, {})).toBeNull();
    expect(piProviderToCheck("pi", null, {})).toBeNull();
  });
});

describe("agent settings (write_agent_settings)", () => {
  function fakeHome(root: string): string {
    const home = join(root, "home");
    put(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "ponytail@ponytail": [], "figma@official": [], "factory-worker@inline": [], "factory-shared@inline": [], "chatbridge@inline": [] } }));
    put(join(home, ".claude/skills/humanizer/SKILL.md"), "---\nname: humanizer\n---\n");
    mkdirSync(join(home, ".claude/skills/synced"), { recursive: true }); // no SKILL.md: not a skill
    put(join(home, ".claude/commands/opsx/apply.md"), "x");
    put(join(home, ".claude/commands/plan-product.md"), "x");
    return home;
  }

  test("turns plugins, skills and commands off but not the role, shared or chatbridge plugin", () => {
    const root = tmp("settings");
    const home = fakeHome(root);
    const proj = join(root, "proj");
    put(join(proj, ".claude/skills/projskill/SKILL.md"), "---\nname: projskill\n---\n");
    put(join(proj, ".claude/commands/x/y.md"), "x");
    const path = writeAgentSettings("worker-1", "worker", proj, join(home, ".claude"), join(root, "shared"), join(root, "out"));
    expect(path).toBe(join(root, "out/worker-1.json"));
    const v = JSON.parse(readFileSync(path, "utf8"));
    expect(v.enabledPlugins).toEqual({ "figma@official": false, "ponytail@ponytail": false });
    for (const k of ["humanizer", "projskill", "opsx:apply", "plan-product", "x:y"]) expect(v.skillOverrides[k]).toBe("off");
    expect(v.skillOverrides.synced).toBeUndefined();
    expect(mode(path)).toBe(0o600);
  });

  test("the file is the serde_json pretty text: sorted keys at every level, two-space indent, no final newline", () => {
    const root = tmp("settings-text");
    const home = fakeHome(root);
    const text = JSON.stringify(buildAgentSettings("worker", join(home, ".claude"), join(root, "proj"), "/it's shared"), null, 2);
    expect(text).toBe(
      [
        "{",
        '  "enabledPlugins": {',
        '    "figma@official": false,',
        '    "ponytail@ponytail": false',
        "  },",
        '  "skillOverrides": {',
        '    "humanizer": "off",',
        '    "opsx:apply": "off",',
        '    "plan-product": "off"',
        "  },",
        '  "statusLine": {',
        `    "command": "bash '/it'\\\\''s shared/scripts/statusline.sh'",`,
        '    "type": "command"',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  test("two agents in different projects get separate files; a relaunch rewrites the file and leaves no temp file", () => {
    const root = tmp("settings2");
    const home = fakeHome(root);
    const [p1, p2] = [join(root, "p1"), join(root, "p2")];
    put(join(p1, ".claude/skills/only-one/SKILL.md"), "x");
    put(join(p2, ".claude/skills/only-two/SKILL.md"), "x");
    const dir = join(root, "out");
    const a = writeAgentSettings("worker-1", "worker", p1, join(home, ".claude"), join(root, "shared"), dir);
    const b = writeAgentSettings("worker-2", "worker", p2, join(home, ".claude"), join(root, "shared"), dir);
    expect(a).not.toBe(b);
    const [ta, tb] = [readFileSync(a, "utf8"), readFileSync(b, "utf8")];
    expect(ta.includes("only-one") && !ta.includes("only-two")).toBe(true);
    expect(tb.includes("only-two") && !tb.includes("only-one")).toBe(true);
    writeAgentSettings("worker-1", "worker", p1, join(home, ".claude"), join(root, "shared"), dir);
    expect(readdirSync(dir).length).toBe(2);
  });

  test("a path in the agent name is refused", () => {
    const root = tmp("settings3");
    for (const bad of ["", "../x", "a/b", ".hidden", "a\\b"]) expect(() => writeAgentSettings(bad, "worker", root, join(root, "h"), join(root, "shared"), join(root, "out"))).toThrow("invalid agent name for a settings file");
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  test("the user's ~/.claude is only read", () => {
    const root = tmp("settings4");
    const home = fakeHome(root);
    const before = JSON.stringify(readdirSync(join(home, ".claude"), { recursive: true }).sort());
    writeAgentSettings("w", "worker", root, join(home, ".claude"), join(root, "shared"), join(root, "out"));
    expect(JSON.stringify(readdirSync(join(home, ".claude"), { recursive: true }).sort())).toBe(before);
  });
});

describe("agent link and records", () => {
  test("linkAgent makes the link and the .applied record; clearAgentRecords removes link, .applied, .pending and .last", () => {
    const { factory } = fixture();
    const link = linkAgent(factory, "ag", V);
    expect(link).toBe(rec(factory, "ag", ""));
    expect(readlinkSync(link)).toBe(join(factory, V));
    expect(readFileSync(rec(factory, "ag", ".applied"), "utf8")).toBe(V);
    for (const s of [".pending", ".last", ".skills-off"]) writeFileSync(rec(factory, "ag", s), "x");
    clearAgentRecords(factory, "ag");
    expect(existsSync(rec(factory, "ag", ""))).toBe(false);
    for (const s of [".applied", ".pending", ".last"]) expect(existsSync(rec(factory, "ag", s))).toBe(false);
    expect(existsSync(rec(factory, "ag", ".skills-off"))).toBe(true); // the human's choice survives
    clearAgentRecords(factory, "ag"); // nothing there: no error
  });
});

describe("launchIn (skills.rs launch_in)", () => {
  test("an empty skill choice returns null and writes the published and applied records, same text, sorted keys", async () => {
    const { factory, v } = fixture();
    linkAgent(factory, "ag", V);
    writeFileSync(rec(factory, "ag", ".skills-prepared"), "{}");
    writeFileSync(rec(factory, "ag", ".skills-pending"), "{}");
    expect(await launchIn(factory, v, "ag", "worker", V)).toBeNull();
    const body = `{"gen":0,"off":[],"skills":["shared/s","worker/a","worker/b"],"version":"${V}"}`;
    expect(readFileSync(rec(factory, "ag", ".skills-published"), "utf8")).toBe(body);
    expect(readFileSync(rec(factory, "ag", ".skills-applied"), "utf8")).toBe(body);
    expect(mode(rec(factory, "ag", ".skills-applied"))).toBe(0o600);
    expect(existsSync(rec(factory, "ag", ".skills-prepared"))).toBe(false);
    expect(existsSync(rec(factory, "ag", ".skills-pending"))).toBe(false);
    expect(existsSync(rec(factory, "ag", ".view"))).toBe(false);
  });

  test("a stored skill off builds and publishes the view and returns the view root", async () => {
    const { factory, v } = fixture();
    linkAgent(factory, "ag", V);
    writeFileSync(rec(factory, "ag", ".skills-off"), JSON.stringify(["worker/b", "gone/x"])); // an id outside the inventory is dropped
    const root = await launchIn(factory, v, "ag", "worker", V);
    expect(root).toBe(rec(factory, "ag", ".view"));
    expect(readlinkSync(root!)).toBe(`${agentKey("ag")}.view-1`);
    expect(readdirSync(join(root!, "worker/skills"))).toEqual(["a"]);
    expect(readdirSync(join(root!, "shared/skills"))).toEqual(["s"]);
    expect(lstatSync(join(root!, "worker/role.md")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root!, "worker/.claude-plugin")).isSymbolicLink()).toBe(false); // a real copy
    const body = JSON.parse(readFileSync(rec(factory, "ag", ".skills-published"), "utf8"));
    expect(body).toEqual({ gen: 1, off: ["worker/b"], skills: ["shared/s", "worker/a", "worker/b"], version: V });
    // the second launch makes generation 2 and keeps the one below the published
    await launchIn(factory, v, "ag", "worker", V);
    expect(readlinkSync(rec(factory, "ag", ".view"))).toBe(`${agentKey("ag")}.view-2`);
    expect(existsSync(rec(factory, "ag", ".view-1"))).toBe(true);
  });

  test("it takes the factory-skills lock and releases it; a busy lock is an error and the launch changes nothing", async () => {
    const { factory, v } = fixture();
    linkAgent(factory, "ag", V);
    expect(await launchIn(factory, v, "ag", "worker", V)).toBeNull();
    expect(existsSync(rec(factory, "ag", ".skills-lock"))).toBe(false); // released
    expect(readdirSync(join(factory, "agents")).filter((n) => n.includes("lock") && !n.endsWith(".skills-lock.guard"))).toEqual([]); // no second lock
    const held = await takeLock(factory, agentKey("ag"), 500, "hub");
    try {
      rmSync(rec(factory, "ag", ".skills-published"));
      await expect(launchIn(factory, v, "ag", "worker", V)).rejects.toThrow("the skills lock is busy; try again");
      expect(existsSync(rec(factory, "ag", ".skills-published"))).toBe(false);
    } finally {
      held();
    }
  });
});

describe("resolveRoleLaunchIn (factory.rs resolve_role_launch)", () => {
  test("a Claude role: agent link, applied record, skills records, settings file, role paths through the link", async () => {
    const f = fixture();
    const l = await resolveRoleLaunchIn(f.dirs, "worker-1", "worker", f.root, "claude", {});
    const link = rec(f.factory, "worker-1", "");
    expect(readlinkSync(link)).toBe(join(f.factory, V));
    expect(readFileSync(rec(f.factory, "worker-1", ".applied"), "utf8")).toBe(V);
    expect(l).toMatchObject({ name: "worker", harness: "claude", pluginDir: join(link, "worker"), sharedDir: join(link, "shared"), promptFile: join(link, "worker/role.md"), model: "sonnet", disallowedTools: ["Task", "Agent"] });
    expect(l.settings).toBe(join(f.data, "factory-settings/worker-1.json"));
    expect(mode(l.settings!)).toBe(0o600);
    expect(existsSync(rec(f.factory, "worker-1", ".skills-applied"))).toBe(true);
  });

  test("a Pi role gets no settings file; a role on the other harness without a model is refused before anything is written", async () => {
    const f = fixture();
    const l = await resolveRoleLaunchIn(f.dirs, "val-1", "validator", f.root, "pi", {});
    expect(l.settings).toBeNull();
    expect(l).toMatchObject({ harness: "pi", provider: "openai-codex", model: "gpt-x", thinking: "high", excludeTools: ["write"] });
    expect(existsSync(f.dirs.settingsDir)).toBe(false);
    await expect(resolveRoleLaunchIn(f.dirs, "w-2", "worker", f.root, "pi", {})).rejects.toThrow("role 'worker' runs on claude by default; to launch it on pi choose a model. Nothing was started.");
    expect(existsSync(f.dirs.settingsDir)).toBe(false);
  });

  test("a view launch names the view root", async () => {
    const f = fixture();
    linkAgent(f.factory, "worker-1", V);
    writeFileSync(rec(f.factory, "worker-1", ".skills-off"), JSON.stringify(["worker/a"]));
    const l = await resolveRoleLaunchIn(f.dirs, "worker-1", "worker", f.root, "claude", { effort: "high" });
    expect(l.pluginDir).toBe(join(rec(f.factory, "worker-1", ".view"), "worker"));
    expect(l.effort).toBe("high");
    expect(JSON.parse(readFileSync(l.settings!, "utf8")).statusLine.command).toBe(`bash '${rec(f.factory, "worker-1", ".view")}/shared/scripts/statusline.sh'`);
  });

  test("a staging swap that loses the role stops the launch", async () => {
    const f = fixture();
    rmSync(join(f.v, "worker/role.md"));
    await expect(resolveRoleLaunchIn(f.dirs, "w", "worker", f.root, "claude", {})).rejects.toThrow(/not staged|being staged/);
    put(join(f.v, "worker/role.md"), "role");
    rmSync(join(f.factory, "current"));
    await expect(resolveRoleLaunchIn(f.dirs, "w", "worker", f.root, "claude", {})).rejects.toThrow("factory/current");
  });
});

describe("global MCP config, first message", () => {
  test("the MCP file is filtered, private, atomic and sorted; no servers means no file and no flag", () => {
    const servers = parseGlobalMcpServers(`{"_comment":"x","mcpServers":{"chatbridge":{"command":"evil"},"serena":{"command":"s"},"context7":{"prompts":["p"],"command":"c7"}}}`, "test");
    const root = tmp("mcp");
    const dir = join(root, "mcp-configs");
    const path = writeGlobalMcpConfig(dir, servers)!;
    expect(path).toBe(join(dir, "global.json"));
    const text = readFileSync(path, "utf8");
    expect(text).toBe('{\n  "mcpServers": {\n    "context7": {\n      "command": "c7"\n    },\n    "serena": {\n      "command": "s"\n    }\n  }\n}');
    expect(mode(path)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(writeGlobalMcpConfig(dir, {})).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(writeGlobalMcpConfig(dir, parseGlobalMcpServers('{"mcpServers":{"chatbridge":{}}}', "test"))).toBeNull();
    expect(parseGlobalMcpServers("not json", "test")).toEqual({});
    expect(parseGlobalMcpServers('{"other":1}', "test")).toEqual({});
  });

  test("the MCP write fails only when the folder cannot be made; a project .mcp.json is never written", () => {
    const root = tmp("mcp2");
    const notDir = join(root, "file-not-dir");
    writeFileSync(notDir, "x");
    expect(() => writeGlobalMcpConfig(notDir, { a: { command: "c" } })).toThrow(/create .*file-not-dir/);
    expect(writeGlobalMcpConfig(notDir, {})).toBeNull();
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  test("the first-message file: <dir>/<session>/first-message.md, mode 0600 in a 0700 folder, rewritten in place", () => {
    const root = tmp("fm");
    const p = writeFirstMessage(root, "worker-1", "TICKET");
    expect(p).toBe(join(root, "worker-1/first-message.md"));
    expect(readFileSync(p, "utf8")).toBe("TICKET");
    expect(mode(p)).toBe(0o600);
    expect(mode(join(root, "worker-1"))).toBe(0o700);
    writeFirstMessage(root, "worker-1", "TWO");
    expect(readFileSync(p, "utf8")).toBe("TWO");
    expect(readdirSync(join(root, "worker-1"))).toEqual(["first-message.md"]);
    for (const bad of ["a.b", "shell", "", " a", "a/b", "x".repeat(65)]) expect(() => writeFirstMessage(root, bad, "t")).toThrow("invalid session name");
  });
});

describe("Claude version check", () => {
  test("parses the first major.minor.patch and compares with 2.1.296", () => {
    expect(parseClaudeVersion("2.1.296 (Claude Code)")).toEqual([2, 1, 296]);
    expect(parseClaudeVersion("noise\nClaude Code v12.3.4-beta.1+b5")).toEqual([12, 3, 4]);
    expect(parseClaudeVersion("1.2.x 4.5.6")).toEqual([4, 5, 6]);
    expect(parseClaudeVersion("no version")).toBeNull();
    for (const ok of [[2, 1, 296], [2, 1, 297], [2, 2, 0], [3, 0, 0]] as const) checkClaudeVersion("/c", [...ok]);
    for (const old of [[2, 1, 295], [2, 0, 999], [1, 9, 9]] as const) expect(() => checkClaudeVersion("/c", [...old])).toThrow(`Claude Code at /c is ${old.join(".")}, older than 2.1.296, which chatbridge needs (mods load unreliably before it). Update it with \`claude update\``);
  });

  function fake(root: string, name: string, script: string): string {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("a fake claude: current passes; old, no version, non-zero exit, timeout and a missing binary fail with their texts", async () => {
    const root = tmp("ver");
    await ensureClaudeVersion(fake(root, "new", 'echo "2.1.300 (Claude Code)"'));
    await expect(ensureClaudeVersion(fake(root, "old", 'echo "2.1.200 (Claude Code)"'))).rejects.toThrow("is 2.1.200, older than 2.1.296");
    await expect(ensureClaudeVersion(fake(root, "none", 'echo "hello"'))).rejects.toThrow("returned no parseable version. Output: hello");
    await expect(ensureClaudeVersion(fake(root, "bad", 'echo "boom" >&2; exit 3'))).rejects.toThrow(/exited with code 3\. Output: boom/);
    await expect(ensureClaudeVersion(fake(root, "slow", "sleep 5"), 300)).rejects.toThrow(/--version timed out at .*slow/);
    await expect(ensureClaudeVersion(join(root, "missing"))).rejects.toThrow("Could not start Claude Code at");
  });
});

describe("Pi sign-in check", () => {
  test("the answer is read and a failure names the fix", () => {
    authCheckResult("openai-codex", true, '{"status":"ready"}');
    const fails = (ok: boolean, out: string) => { try { authCheckResult("p", ok, out); } catch (e) { return (e as Error).message; } return "no error"; };
    expect(fails(true, '{"status":"not_ready","reason":"credentials_not_configured"}')).toBe("Pi is not signed in to p. Run `pi` and /login p. Nothing was started.");
    expect(fails(false, '{"reason":"provider_not_found"}')).toBe("Pi does not know the provider p. Nothing was started.");
    expect(fails(false, '{"reason":"expired"}')).toBe("Pi is not ready for p (expired). Run `pi` and /login p. Nothing was started.");
    expect(fails(false, "garbage")).toBe("The Pi sign-in check for p gave no usable answer. Run `pi` and /login p. Nothing was started.");
    expect(fails(false, '{"status":"ready"}')).toContain("gave no usable answer"); // exit code not 0
  });

  test("runs the real command with a fake pi, with the given PATH, and kills a slow one", async () => {
    const root = tmp("pi");
    const pi = join(root, "pi");
    writeFileSync(pi, `#!/bin/sh\necho "$@" > "${root}/args"\necho "$PATH" > "${root}/path"\ncase "$4" in ok) echo '{"status":"ready"}';; *) echo '{"status":"not_ready","reason":"credentials_not_configured"}'; exit 1;; esac\n`);
    chmodSync(pi, 0o755);
    await piAuthCheck(pi, "ok", "/custom/path:/usr/bin:/bin");
    expect(readFileSync(join(root, "args"), "utf8").trim()).toBe("auth check --provider ok --json");
    expect(readFileSync(join(root, "path"), "utf8").trim()).toBe("/custom/path:/usr/bin:/bin");
    await expect(piAuthCheck(pi, "no", "/usr/bin:/bin")).rejects.toThrow("Pi is not signed in to no. Run `pi` and /login no. Nothing was started.");
    const slow = join(root, "slow");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
    chmodSync(slow, 0o755);
    await expect(piAuthCheck(slow, "x", "/usr/bin:/bin", 300)).rejects.toThrow("The Pi sign-in check for x took more than 0 seconds. Run `pi` and /login x. Nothing was started.");
    await expect(piAuthCheck(join(root, "missing"), "x")).rejects.toThrow("Could not run `pi auth check` for x");
  });
});

describe("prepareLaunch", () => {
  function setup() {
    const f = fixture();
    const calls: string[] = [];
    const deps: LaunchDeps = {
      loginPath: async () => "/login/bin:/usr/bin",
      ensureClaudeVersion: async (p) => { calls.push(`version ${p}`); },
      piAuthCheck: async (p, prov, path) => { calls.push(`auth ${p} ${prov} ${path}`); },
    };
    const env = { CUBILOT_DATA_DIR: f.data, CUBILOT_FACTORY_DIR: f.factory, CUBILOT_FACTORY_SRC: f.src, HOME: f.home, CUBILOT_MOD_DIR: "/staged/mod", CUBILOT_PI_EXTENSION: "/staged/pi-extension.js", CUBILOT_CLAUDE_BIN: "/bin/claude", CUBILOT_PI_BIN: "/bin/pi" };
    return { f, calls, deps, env };
  }
  const STAGE = "s_0123456789abcdef";

  test("a Claude worker stage: command, tmux env, role files, MCP config and first message, in one call", async () => {
    const { f, calls, deps, env } = setup();
    put(join(f.data, "mcp.json"), '{"mcpServers":{"serena":{"command":"s"}}}');
    const plan = await prepareLaunch({ agent: "worker-1", room: "cubilot", role: "worker", cwd: f.root, harness: "claude", stageId: STAGE, firstMessage: "TICKET", apiKey: "k" }, env, deps);
    const link = rec(f.factory, "worker-1", "");
    expect(calls).toEqual(["version /bin/claude"]);
    expect(plan).toMatchObject({ name: "worker-1", cwd: f.root, harness: "claude", role: "worker", choice: {} });
    expect(plan.env).toEqual([`CUBILOT_DATA_DIR=${f.data}`, "ANTHROPIC_API_KEY=k", `CUBILOT_STAGE_ID=${STAGE}`]);
    const c = plan.command;
    expect(c.startsWith("PATH='/login/bin:/usr/bin' CHATBRIDGE_AGENT='worker-1' CHATBRIDGE_ROOM='cubilot' CHATBRIDGE_ROLE='worker' '/bin/claude' --plugin-dir '/staged/mod' ")).toBe(true);
    expect(c).toContain(`--mcp-config '${f.data}/mcp-configs/global.json' --plugin-dir '${link}/worker' --plugin-dir '${link}/shared' --append-system-prompt-file '${link}/worker/role.md' --settings '${f.data}/factory-settings/worker-1.json' --model 'sonnet' --disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission' --allowed-tools 'mcp__chatbridge__post,`);
    expect(c.endsWith(` -- "$(cat '${f.data}/sessions/worker-1/first-message.md')"`)).toBe(true);
    expect(readFileSync(join(f.data, "sessions/worker-1/first-message.md"), "utf8")).toBe("TICKET");
    expect(existsSync(join(f.data, "factory-settings/worker-1.json"))).toBe(true);
    expect(existsSync(join(f.root, ".mcp.json"))).toBe(false);
    expect(readdirSync(join(f.home, ".claude"))).toEqual([]); // nothing written under ~/.claude
  });

  test("a manual Claude launch has no role, no login PATH and no stage id; the choice is appended", async () => {
    const { f, deps, env } = setup();
    const plan = await prepareLaunch({ agent: "bob", room: "r", role: " ", cwd: f.root, harness: "claude", model: "opus", sessionMode: "resume" }, env, deps);
    expect(plan.command).toBe("CHATBRIDGE_AGENT='bob' CHATBRIDGE_ROOM='r' '/bin/claude' --resume --plugin-dir '/staged/mod' --allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file' --model 'opus'");
    expect(plan.env).toEqual([`CUBILOT_DATA_DIR=${f.data}`]);
    expect(existsSync(join(f.data, "mcp-configs"))).toBe(false); // no global servers: no file, no flag
    expect(existsSync(join(f.data, "factory-settings"))).toBe(false);
  });

  test("a Pi validator stage: the sign-in check runs with the login PATH, the command has the Pi role flags", async () => {
    const { f, calls, deps, env } = setup();
    const plan = await prepareLaunch({ agent: "validator-1", room: "cubilot", role: "validator", cwd: f.root, harness: "pi", stageId: STAGE, firstMessage: "T" }, env, deps);
    expect(calls).toEqual(["auth /bin/pi openai-codex /login/bin:/usr/bin"]);
    const link = rec(f.factory, "validator-1", "");
    expect(plan.command).toBe(
      `PATH='/login/bin:/usr/bin' CHATBRIDGE_AGENT='validator-1' CHATBRIDGE_ROOM='cubilot' CHATBRIDGE_ROLE='validator' '/bin/pi' --no-approve ` +
      `--no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt '${link}/validator/role.md' --skill '${link}/validator/skills' --skill '${link}/shared/skills' ` +
      `--provider 'openai-codex' --model 'gpt-x' --thinking 'high' --exclude-tools 'write,ack_permission' -e '/staged/pi-extension.js'` +
      ` -- "$(cat '${f.data}/sessions/validator-1/first-message.md')"`,
    );
    expect(existsSync(join(f.data, "factory-settings"))).toBe(false); // Pi: no Claude settings file
  });

  test("a failed check stops the launch before any role file is written", async () => {
    const { f, deps, env } = setup();
    const bad: LaunchDeps = { ...deps, piAuthCheck: async () => { throw new Error("Pi is not signed in to openai-codex. Run `pi` and /login openai-codex. Nothing was started."); } };
    await expect(prepareLaunch({ agent: "validator-1", room: "r", role: "validator", cwd: f.root, harness: "pi", firstMessage: "T" }, env, bad)).rejects.toThrow("Pi is not signed in");
    const old: LaunchDeps = { ...deps, ensureClaudeVersion: async () => { throw new Error("Claude Code at /bin/claude is 2.1.1, older than 2.1.296"); } };
    await expect(prepareLaunch({ agent: "worker-1", room: "r", role: "worker", cwd: f.root, harness: "claude", firstMessage: "T" }, env, old)).rejects.toThrow("older than 2.1.296");
    expect(existsSync(rec(f.factory, "worker-1", ""))).toBe(false);
    expect(existsSync(join(f.data, "sessions"))).toBe(false);
    expect(existsSync(join(f.data, "factory-settings"))).toBe(false);
  });

  test("it refuses a bad stage id, a dot or space-edged name, an unknown role, a bad harness and a missing env value", async () => {
    const { f, deps, env } = setup();
    const base = { room: "r", role: "worker", cwd: f.root, harness: "claude" as const };
    await expect(prepareLaunch({ ...base, agent: "a", stageId: "bad" }, env, deps)).rejects.toThrow("invalid stage id: bad");
    await expect(prepareLaunch({ ...base, agent: "a.b" }, env, deps)).rejects.toThrow("a dot is not allowed in a terminal agent name: tmux changes it");
    await expect(prepareLaunch({ ...base, agent: "a b ", role: null }, env, deps)).rejects.toThrow("invalid agent name");
    await expect(prepareLaunch({ ...base, agent: "a", role: "nope" }, env, deps)).rejects.toThrow("unknown role: nope");
    await expect(prepareLaunch({ ...base, agent: "a", harness: "gpt" as any }, env, deps)).rejects.toThrow("invalid harness: gpt");
    await expect(prepareLaunch({ ...base, agent: "a", role: null }, { ...env, CUBILOT_MOD_DIR: "" }, deps)).rejects.toThrow("CUBILOT_MOD_DIR is not set");
    await expect(prepareLaunch({ ...base, agent: "a", provider: "p" }, env, deps)).rejects.toThrow("a provider ");
    expect(existsSync(join(f.data, "sessions"))).toBe(false);
  });

  test("a new launch drops the records of an earlier agent of the same name", async () => {
    const { f, deps, env } = setup();
    linkAgent(f.factory, "worker-1", V);
    writeFileSync(rec(f.factory, "worker-1", ".pending"), "stale");
    await prepareLaunch({ agent: "worker-1", room: "r", role: null, cwd: f.root, harness: "claude" }, env, deps);
    expect(existsSync(rec(f.factory, "worker-1", ""))).toBe(false); // a role-less launch never hot-reloads
    expect(existsSync(rec(f.factory, "worker-1", ".pending"))).toBe(false);
  });
});
