// hub/core/launch-command.ts: the pty.rs command-line tests ported (group 7a). The same string for the same input.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchCommand, choiceFlags, claudeResourceFlags, formatClaudeCommand, formatPiCommand, launchBins, piRoleFlags, spawnEnv,
  withFirstMessage, withLoginPath, type RoleLaunch,
} from "../../hub/core/launch-command";
import { createTmux } from "../../hub/core/tmux";

const NONE_ALLOWED = "mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file";
const claude = (o: Partial<Parameters<typeof formatClaudeCommand>[0]> = {}) =>
  formatClaudeCommand({ agent: "a", room: "r", claudeBin: "/c", modDir: "/m", ...o });

const role = (o: Partial<RoleLaunch> = {}): RoleLaunch => ({
  name: "worker", harness: "claude", pluginDir: "/v/worker", sharedDir: "/v/shared", promptFile: "/v/worker/role.md",
  settings: "/d/factory-settings/worker-1.json", model: "sonnet", disallowedTools: ["Task", "Agent"], excludeTools: [], ...o,
});

describe("Claude command", () => {
  test("without a role it is byte for byte the old command", () => {
    expect(claude()).toBe(`CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/c' --plugin-dir '/m' --allowed-tools '${NONE_ALLOWED}'`);
  });

  test("uses --plugin-dir and env identity only", () => {
    const cmd = claude({ agent: "Dev 1", room: "EU Space", sessionMode: "resume", claudeBin: "/Users/me/bin/claude", modDir: "/Users/me/Library/Application Support/Cubilot/chatbridge-mod" });
    expect(cmd.startsWith("CHATBRIDGE_AGENT='Dev 1' CHATBRIDGE_ROOM='EU Space' '/Users/me/bin/claude' --resume --plugin-dir '")).toBe(true);
    expect(cmd).toContain("--plugin-dir '/Users/me/Library/Application Support/Cubilot/chatbridge-mod'");
    expect(cmd).toContain(`--allowed-tools '${NONE_ALLOWED}'`);
    expect(cmd).not.toContain("--mcp-config");
    expect(cmd).not.toContain("dangerously-load-development-channels");
    expect(cmd).not.toContain("CHATBRIDGE_HUB");
  });

  test("one --mcp-config after --plugin-dir", () => {
    const cmd = claude({ agent: "alice", mcpConfig: "/Users/me/Application Support/Cubilot/mcp-configs/global.json" });
    expect(cmd.split("--mcp-config").length - 1).toBe(1);
    expect(cmd).toContain("--plugin-dir '/m' --mcp-config '/Users/me/Application Support/Cubilot/mcp-configs/global.json' --allowed-tools");
  });

  test("escapes single quotes and rejects a bad session mode", () => {
    const cmd = claude({ agent: "o'neil", room: "r'm" });
    expect(cmd).toContain(`CHATBRIDGE_AGENT='o'\\''neil'`);
    expect(cmd).toContain(`CHATBRIDGE_ROOM='r'\\''m'`);
    expect(() => claude({ sessionMode: "bogus" as any })).toThrow("invalid session_mode: bogus");
    expect(claude({ sessionMode: "continue" })).toContain("'/c' --continue --plugin-dir");
  });

  test("a role loads the role and shared plugin, prompt file, settings and model, in the pty.rs order", () => {
    const cmd = claude({ agent: "worker-1", role: role() });
    expect(cmd).toBe(
      "CHATBRIDGE_AGENT='worker-1' CHATBRIDGE_ROOM='r' CHATBRIDGE_ROLE='worker' '/c' --plugin-dir '/m' " +
      "--plugin-dir '/v/worker' --plugin-dir '/v/shared' --append-system-prompt-file '/v/worker/role.md' " +
      "--settings '/d/factory-settings/worker-1.json' --model 'sonnet' " +
      "--disallowed-tools 'Task,Agent,mcp__chatbridge__ack_permission' " +
      "--allowed-tools 'mcp__chatbridge__post,mcp__chatbridge__post_file,mcp__chatbridge__send_handoff,mcp__chatbridge__accept_handoff," +
      "mcp__chatbridge__decline_handoff,mcp__chatbridge__cancel_handoff,mcp__chatbridge__send_interrupt,mcp__chatbridge__ack_interrupt," +
      "mcp__chatbridge__create_ticket,mcp__chatbridge__claim_ticket,mcp__chatbridge__transition_ticket,mcp__chatbridge__assign_ticket," +
      "mcp__chatbridge__attach_ticket_file,mcp__chatbridge__list_tickets'",
    );
    expect(cmd).not.toContain("mcp__chatbridge__ack_permission,"); // not in the allow list
    expect(claude({ role: role({ effort: "high" }) })).toContain("--model 'sonnet' --effort 'high' --disallowed-tools");
    expect(claude({ role: role({ disallowedTools: ["mcp__chatbridge__ack_permission", "Task"] }) })).toContain("--disallowed-tools 'mcp__chatbridge__ack_permission,Task'");
  });

  test("a role launch needs settings, a valid name and its own harness", () => {
    expect(() => claude({ role: role({ settings: null }) })).toThrow("role 'worker': no settings file");
    expect(() => claude({ role: role({ name: "Bad Role" }) })).toThrow("invalid role");
    expect(() => claude({ role: role({ harness: "pi" }) })).toThrow("role 'worker' runs on pi, not claude");
  });
});

describe("Pi command", () => {
  const pi = (o: Partial<Parameters<typeof formatPiCommand>[0]> = {}) =>
    formatPiCommand({ agent: "a", room: "r", cwd: "/nonexistent-cwd", piBin: "/p/pi", extension: "/e/pi-extension.js", home: "/nonexistent-home", ...o });

  test("a plain Pi command", () => {
    expect(pi()).toBe("CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/p/pi' --no-approve -e '/e/pi-extension.js'");
    expect(pi({ sessionMode: "continue" })).toContain("'/p/pi' --continue --no-approve -e");
    expect(() => pi({ sessionMode: "x" as any })).toThrow("invalid session_mode: x");
  });

  test("a role gets its own and the shared skill folders and excludes ack_permission", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-command-pi-"));
    try {
      mkdirSync(join(root, "worker/skills"), { recursive: true });
      const r = role({ harness: "pi", pluginDir: join(root, "worker"), sharedDir: join(root, "shared"), promptFile: join(root, "worker/role.md"), settings: null, provider: "openai-codex", model: "gpt-x", thinking: "high", excludeTools: ["edit"] });
      const [part, flags] = piRoleFlags(r);
      expect(part).toBe("CHATBRIDGE_ROLE='worker' ");
      expect(flags).toBe(
        `--no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt '${root}/worker/role.md' ` +
        `--skill '${root}/worker/skills' --skill '${root}/shared/skills' --provider 'openai-codex' --model 'gpt-x' --thinking 'high' --exclude-tools 'edit,ack_permission' `,
      );
      const cmd = pi({ role: r });
      expect(cmd.startsWith("CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' CHATBRIDGE_ROLE='worker' '/p/pi' --no-approve --no-skills")).toBe(true);
      expect(cmd.endsWith("-e '/e/pi-extension.js'")).toBe(true);
      expect((cmd.match(/--skill /g) ?? []).length).toBe(2); // exactly two skill folders, none inherited
      expect(() => pi({ role: role() })).toThrow("role 'worker' runs on claude, not pi");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a launch without a role shares only existing Claude skill folders, project before user", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-command-res-"));
    try {
      const cwd = join(root, "proj");
      const home = join(root, "home");
      for (const d of [`${cwd}/.claude/skills`, `${cwd}/.claude/commands`, `${home}/.claude/skills`]) mkdirSync(d, { recursive: true });
      const plug = join(root, "figma-v2/skills");
      mkdirSync(plug, { recursive: true });
      mkdirSync(join(home, ".claude/plugins"), { recursive: true });
      writeFileSync(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "figma@claude-plugins-official": [{ installPath: join(root, "figma-v2") }] } }));
      expect(claudeResourceFlags(cwd, home)).toBe(
        `--skill '${cwd}/.claude/skills' --skill '${home}/.claude/skills' --prompt-template '${cwd}/.claude/commands' --skill '${plug}' `,
      );
      expect(claudeResourceFlags(join(root, "none"), join(root, "nohome"))).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("choice, login PATH, first message", () => {
  test("a choice without a role is appended; an empty choice changes nothing", () => {
    expect(choiceFlags(false, {})).toBe("");
    expect(choiceFlags(false, { model: "opus", effort: "high" })).toBe(" --model 'opus' --effort 'high'");
    expect(choiceFlags(true, { provider: "openai-codex", model: "m", effort: "low" })).toBe(" --provider 'openai-codex' --model 'm' --thinking 'low'");
  });

  test("the login PATH is an env prefix for Pi and for a Claude stage session, never for a manual Claude spawn", () => {
    const cmd = "CHATBRIDGE_AGENT='a' 'pi' --no-approve";
    expect(withLoginPath(cmd, "pi", null, "/opt/a:/usr/bin")).toBe("PATH='/opt/a:/usr/bin' CHATBRIDGE_AGENT='a' 'pi' --no-approve");
    expect(withLoginPath(cmd, "pi", null, "/o'x")).toBe("PATH='/o'\\''x' CHATBRIDGE_AGENT='a' 'pi' --no-approve");
    expect(withLoginPath(cmd, "pi", null, undefined)).toBe(cmd);
    expect(withLoginPath(cmd, "claude", null, "/p")).toBe(cmd);
    expect(withLoginPath(cmd, "claude", "s_0123456789abcdef", "/p")).toBe(`PATH='/p' ${cmd}`);
  });

  test("the first message is one quoted argument after --", () => {
    expect(withFirstMessage("CHATBRIDGE_AGENT='a' '/bin/claude' --model x", "/tmp/m.txt")).toBe("CHATBRIDGE_AGENT='a' '/bin/claude' --model x -- \"$(cat '/tmp/m.txt')\"");
    expect(withFirstMessage("c", "/t/it's.md")).toBe("c -- \"$(cat '/t/it'\\''s.md')\"");
  });

  test("the whole command for a Claude stage session: login PATH, then first message, after the blocks", () => {
    const stageId = "s_0123456789abcdef";
    const cmd = buildLaunchCommand({ agent: "worker-1", room: "r", cwd: "/w", harness: "claude", role: role(), bins: { modDir: "/m", claudeBin: "/c", piBin: "/p", piExtension: "/e" }, stageId, loginPath: "/opt/bin", firstMessageFile: "/s/worker-1/first-message.md" });
    expect(cmd.startsWith("PATH='/opt/bin' CHATBRIDGE_AGENT='worker-1'")).toBe(true);
    expect(cmd.endsWith(" -- \"$(cat '/s/worker-1/first-message.md')\"")).toBe(true);
    expect(cmd.indexOf("--disallowed-tools")).toBeLessThan(cmd.indexOf(" -- \"$(cat"));
    expect(() => buildLaunchCommand({ agent: "a", room: "r", cwd: "/w", harness: "claude", bins: { modDir: "/m", claudeBin: "/c", piBin: "/p", piExtension: "/e" }, stageId: "bad" })).toThrow("invalid stage id: bad");
  });

  test("a launch without a role appends the choice; with a role the choice is in the role flags only", () => {
    const bins = { modDir: "/m", claudeBin: "/c", piBin: "/p", piExtension: "/e" };
    const plain = buildLaunchCommand({ agent: "a", room: "r", cwd: "/nonexistent-cwd", harness: "claude", choice: { model: "opus" }, bins });
    expect(plain.endsWith(`--allowed-tools '${NONE_ALLOWED}' --model 'opus'`)).toBe(true);
    const piPlain = buildLaunchCommand({ agent: "a", room: "r", cwd: "/nonexistent-cwd", harness: "pi", choice: { provider: "p", model: "m" }, bins, loginPath: "/x", home: "/nonexistent-home" });
    expect(piPlain).toBe("PATH='/x' CHATBRIDGE_AGENT='a' CHATBRIDGE_ROOM='r' '/p' --no-approve -e '/e' --provider 'p' --model 'm'");
  });
});

describe("env of the shell and the tmux argv", () => {
  test("launchBins reads the four env values and names a missing one", () => {
    const env = { CUBILOT_MOD_DIR: "/m", CUBILOT_PI_EXTENSION: "/e", CUBILOT_CLAUDE_BIN: "/c", CUBILOT_PI_BIN: "/p" };
    expect(launchBins(env)).toEqual({ modDir: "/m", piExtension: "/e", claudeBin: "/c", piBin: "/p" });
    for (const k of Object.keys(env)) expect(() => launchBins({ ...env, [k]: " " })).toThrow(`${k} is not set`);
  });

  test("the -e entries: CUBILOT_DATA_DIR always, the API key and CUBILOT_STAGE_ID only when given", () => {
    expect(spawnEnv({ dataDir: "/d" })).toEqual(["CUBILOT_DATA_DIR=/d"]);
    expect(spawnEnv({ dataDir: "/d", apiKey: "k", stageId: "s_0123456789abcdef" })).toEqual(["CUBILOT_DATA_DIR=/d", "ANTHROPIC_API_KEY=k", "CUBILOT_STAGE_ID=s_0123456789abcdef"]);
  });

  test("New terminal session for a Claude agent: one $SHELL -ic wrap, the command is ONE last argv element", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-command-argv-"));
    try {
      const cmd = buildLaunchCommand({ agent: "Dev 1", room: "EU Space", cwd: root, harness: "claude", bins: { modDir: "/Users/me/Library/Application Support/Cubilot/chatbridge-mod", claudeBin: "/Users/me/bin/claude", piBin: "/p", piExtension: "/e" } });
      const tmux = createTmux({ bin: "tmux", socket: join(root, "s.sock"), env: { SHELL: "/bin/zsh", CUBILOT_DATA_DIR: root, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
      const argv = tmux.newSessionArgv({ name: "Dev 1", cwd: root, command: cmd, env: spawnEnv({ dataDir: root }) });
      expect(argv.slice(0, 4)).toEqual(["new-session", "-d", "-s", "Dev 1"]);
      const joined = argv.join(" ");
      for (const e of ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", `CUBILOT_DATA_DIR=${root}`]) expect(joined).toContain(e);
      expect(argv.slice(-7, -1)).toEqual(["-x", "80", "-y", "24", "-c", root]);
      const last = argv[argv.length - 1];
      expect(last).toBe(`'/bin/zsh' -ic '${cmd.replace(/'/g, `'\\''`)}'`);
      expect(last.split("-ic ").length - 1).toBe(1); // wrapped once; the command itself holds no -ic
      expect(cmd).not.toContain("-ic");
      expect(argv.filter((a) => a.includes("--plugin-dir")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
