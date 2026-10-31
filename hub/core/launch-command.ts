// The Claude and Pi launch command lines, ported from src-tauri/src/pty.rs (group 7a, hub-first-browser design decision 3).
// Pure string builders: the same string for the same input as the Rust shell. Nothing here reads a file except the
// installed_plugins.json of Pi's shared Claude plugins (as pty.rs does). No caller yet (group 7b).
//
// The command is NOT wrapped in `$SHELL -ic` here: hub/core/tmux.ts newSessionArgv wraps it once.
// Rules that stay: --plugin-dir <staged mod> (never the .app), --allowed-tools on the claude command, Claude hooks
// through --settings <path> (never ~/.claude/settings.json), no project .mcp.json, CUBILOT_STAGE_ID only for a stage.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Harness = "claude" | "pi";
export type SessionMode = "continue" | "resume";

/** What the human picked in the model x effort grid for one launch. Effort is the Claude effort or the Pi thinking level. */
export type LaunchChoice = { model?: string; provider?: string; effort?: string };

/** Everything a command builder needs for a role (factory.rs RoleLaunch). Paths are absolute. */
export type RoleLaunch = {
  name: string;
  harness: Harness;
  pluginDir: string; // <version>/<role>
  sharedDir: string; // <version>/shared
  promptFile: string; // <version>/<role>/role.md
  settings: string | null; // <app data>/factory-settings/<agent>.json, Claude roles only
  provider?: string;
  model?: string;
  thinking?: string; // Pi
  effort?: string; // Claude
  disallowedTools: string[]; // Claude
  excludeTools: string[]; // Pi
};

/** The staged paths the shell passes in env. */
export type LaunchBins = { modDir: string; piExtension: string; claudeBin: string; piBin: string };

export const sq = (s: string): string => s.replace(/'/g, `'\\''`);

export const validRoleName = (role: string): boolean => /^[a-z0-9_-]{1,40}$/.test(role);

// What a role agent may call without a prompt. ack_permission is NOT here: the human answers permission requests.
export const ROLE_ALLOWED_TOOLS = [
  "post", "post_file",
  "send_handoff", "accept_handoff", "decline_handoff", "cancel_handoff",
  "send_interrupt", "ack_interrupt",
  "create_ticket", "claim_ticket", "transition_ticket", "assign_ticket", "attach_ticket_file", "list_tickets",
] as const;
export const ACK_PERMISSION = "ack_permission";
const NO_ROLE_ALLOWED_TOOLS = "mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file";

/** The role's own list plus `name`, without a duplicate. */
export function withAckPermissionBlocked(list: readonly string[], name: string): string[] {
  return list.includes(name) ? [...list] : [...list, name];
}

/** The four env values of the shell. A missing one is an error that names it: nothing starts without the staged paths. */
export function launchBins(env: Record<string, string | undefined> = process.env): LaunchBins {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return { modDir: need("CUBILOT_MOD_DIR"), piExtension: need("CUBILOT_PI_EXTENSION"), claudeBin: need("CUBILOT_CLAUDE_BIN"), piBin: need("CUBILOT_PI_BIN") };
}

function modePart(mode: SessionMode | undefined | null): string {
  if (mode === "continue") return "--continue ";
  if (mode === "resume") return "--resume ";
  if (mode == null) return "";
  throw new Error(`invalid session_mode: ${mode}`);
}

// ---- Claude (pty.rs format_claude_command) ----
export type ClaudeCommandInput = {
  agent: string;
  room: string;
  sessionMode?: SessionMode | null;
  claudeBin: string;
  modDir: string;
  mcpConfig?: string | null;
  role?: RoleLaunch | null;
};

export function formatClaudeCommand(i: ClaudeCommandInput): string {
  let rolePart = "";
  let roleFlags = "";
  const r = i.role;
  if (r) {
    if (r.harness !== "claude") throw new Error(`role '${r.name}' runs on ${r.harness}, not claude`);
    if (!validRoleName(r.name)) throw new Error(`invalid role: ${JSON.stringify(r.name)}`);
    if (!r.settings) throw new Error(`role '${r.name}': no settings file`);
    roleFlags = `--plugin-dir '${sq(r.pluginDir)}' --plugin-dir '${sq(r.sharedDir)}' --append-system-prompt-file '${sq(r.promptFile)}' --settings '${sq(r.settings)}' `;
    if (r.model) roleFlags += `--model '${sq(r.model)}' `;
    if (r.effort) roleFlags += `--effort '${sq(r.effort)}' `;
    const blocked = withAckPermissionBlocked(r.disallowedTools, `mcp__chatbridge__${ACK_PERMISSION}`);
    roleFlags += `--disallowed-tools '${sq(blocked.join(","))}' `;
    rolePart = `CHATBRIDGE_ROLE='${r.name}' `;
  }
  const mode = modePart(i.sessionMode);
  const mcp = i.mcpConfig ? `--mcp-config '${sq(i.mcpConfig)}' ` : "";
  const allowed = r ? ROLE_ALLOWED_TOOLS.map((t) => `mcp__chatbridge__${t}`).join(",") : NO_ROLE_ALLOWED_TOOLS;
  return `CHATBRIDGE_AGENT='${sq(i.agent)}' CHATBRIDGE_ROOM='${sq(i.room)}' ${rolePart}'${sq(i.claudeBin)}' ${mode}--plugin-dir '${sq(i.modDir)}' ${mcp}${roleFlags}--allowed-tools '${allowed}'`;
}

// ---- Pi (pty.rs pi_command, pi_role_flags, claude_resource_flags) ----
/** Claude plugins whose skills Pi shares. Listed last so a same-named skill of the user still wins. */
export const SHARED_CLAUDE_PLUGINS = ["figma@claude-plugins-official"];

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** installed_plugins.json is the only record of the live plugin version. */
function claudePluginSkillsDir(home: string, key: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8"));
    const entries = v?.plugins?.[key];
    if (!Array.isArray(entries)) return null;
    const install = entries.map((e: any) => e?.installPath).find((p: unknown) => typeof p === "string");
    if (!install) return null;
    const skills = join(install, "skills");
    return isDir(skills) ? skills : null;
  } catch {
    return null;
  }
}

/** Existing skill and command folders only; project-local BEFORE user-level (Pi: first one wins). A launch without a role only. */
export function claudeResourceFlags(cwd: string, home: string = homedir() || "/tmp"): string {
  const candidates: [string, string][] = [
    ["--skill", join(cwd, ".claude/skills")],
    ["--skill", join(home, ".claude/skills")],
    ["--prompt-template", join(cwd, ".claude/commands")],
    ["--prompt-template", join(home, ".claude/commands")],
  ];
  let out = "";
  for (const [flag, p] of candidates) if (isDir(p)) out += `${flag} '${sq(p)}' `;
  for (const key of SHARED_CLAUDE_PLUGINS) {
    const p = claudePluginSkillsDir(home, key);
    if (p) out += `--skill '${sq(p)}' `;
  }
  return out;
}

/** `--exclude-tools`, never `--tools` (an allowlist would remove the chatbridge tools). Returns [role env part, flags]. */
export function piRoleFlags(r: RoleLaunch): [string, string] {
  if (!validRoleName(r.name)) throw new Error(`invalid role: ${JSON.stringify(r.name)}`);
  let f = `--no-skills --no-extensions -e builtin:mcp -e builtin:tool-search --append-system-prompt '${sq(r.promptFile)}' `;
  if (isDir(join(r.pluginDir, "skills"))) f += `--skill '${sq(join(r.pluginDir, "skills"))}' `;
  f += `--skill '${sq(join(r.sharedDir, "skills"))}' `;
  for (const [flag, v] of [["--provider", r.provider], ["--model", r.model], ["--thinking", r.thinking]] as const) {
    if (v) f += `${flag} '${sq(v)}' `;
  }
  f += `--exclude-tools '${sq(withAckPermissionBlocked(r.excludeTools, ACK_PERMISSION).join(","))}' `;
  return [`CHATBRIDGE_ROLE='${r.name}' `, f];
}

export type PiCommandInput = {
  agent: string;
  room: string;
  cwd: string;
  sessionMode?: SessionMode | null;
  piBin: string;
  extension: string;
  role?: RoleLaunch | null;
  home?: string;
};

export function formatPiCommand(i: PiCommandInput): string {
  const mode = modePart(i.sessionMode);
  // A role gets exactly its own and the shared skill folders: no folder from claudeResourceFlags.
  const shared = i.role ? "" : claudeResourceFlags(i.cwd, i.home);
  let rolePart = "";
  let roleFlags = "";
  if (i.role) {
    if (i.role.harness !== "pi") throw new Error(`role '${i.role.name}' runs on ${i.role.harness}, not pi`);
    [rolePart, roleFlags] = piRoleFlags(i.role);
  }
  return `CHATBRIDGE_AGENT='${sq(i.agent)}' CHATBRIDGE_ROOM='${sq(i.room)}' ${rolePart}'${sq(i.piBin)}' ${mode}--no-approve ${roleFlags}${shared}-e '${sq(i.extension)}'`;
}

// ---- Choice, login PATH, first message, tmux env ----
/** Flags of a choice for a launch WITHOUT a role. An empty choice adds nothing. */
export function choiceFlags(isPi: boolean, c: LaunchChoice): string {
  let f = "";
  if (isPi && c.provider) f += ` --provider '${sq(c.provider)}'`;
  if (c.model) f += ` --model '${sq(c.model)}'`;
  if (c.effort) f += ` ${isPi ? "--thinking" : "--effort"} '${sq(c.effort)}'`;
  return f;
}

/** Pi always gets the login PATH; Claude only as a stage session. */
export const wantsLoginPath = (harness: Harness, stageId?: string | null): boolean => harness === "pi" || !!stageId;

/** `PATH='<path>' ` in front of the command (never `new-session -e PATH=`: tmux starts the pane with the server PATH). */
export function withLoginPath(cmd: string, harness: Harness, stageId: string | null | undefined, path: string | null | undefined): string {
  return wantsLoginPath(harness, stageId) && path ? `PATH='${sq(path)}' ${cmd}` : cmd;
}

/** The first message as ONE quoted argument read from a file. `--` ends the options first (a variadic option would take it). */
export const withFirstMessage = (cmd: string, file: string): string => `${cmd} -- "$(cat '${sq(file)}')"`;

export const validStageId = (id: string): boolean => /^s_[0-9a-f]{16}$/.test(id);

/** The `-e` entries of new-session that pty.rs adds after TERM, COLORTERM, LANG and LC_ALL (tmux.ts adds those four). */
export function spawnEnv(o: { dataDir: string; apiKey?: string | null; stageId?: string | null }): string[] {
  const env = [`CUBILOT_DATA_DIR=${o.dataDir}`];
  if (o.apiKey) env.push(`ANTHROPIC_API_KEY=${o.apiKey}`);
  if (o.stageId) env.push(`CUBILOT_STAGE_ID=${o.stageId}`);
  return env;
}

// ---- The whole command (pty.rs agent_command + final_spawn) ----
export type LaunchCommandInput = {
  agent: string;
  room: string;
  cwd: string;
  harness: Harness;
  sessionMode?: SessionMode | null;
  role?: RoleLaunch | null;
  choice?: LaunchChoice;
  bins: LaunchBins;
  mcpConfig?: string | null;
  stageId?: string | null;
  loginPath?: string | null;
  firstMessageFile?: string | null;
  home?: string;
};

export function buildLaunchCommand(i: LaunchCommandInput): string {
  if (i.stageId != null && !validStageId(i.stageId)) throw new Error(`invalid stage id: ${i.stageId}`);
  const choice = i.choice ?? {};
  let cmd: string;
  if (i.harness === "claude") {
    cmd = formatClaudeCommand({ agent: i.agent, room: i.room, sessionMode: i.sessionMode, claudeBin: i.bins.claudeBin, modDir: i.bins.modDir, mcpConfig: i.mcpConfig, role: i.role });
  } else {
    cmd = formatPiCommand({ agent: i.agent, room: i.room, cwd: i.cwd, sessionMode: i.sessionMode, piBin: i.bins.piBin, extension: i.bins.piExtension, role: i.role, home: i.home });
  }
  // Without a role the choice is appended (a role already carries it in its own flags).
  if (!i.role) cmd += choiceFlags(i.harness === "pi", choice);
  cmd = withLoginPath(cmd, i.harness, i.stageId, i.loginPath);
  return i.firstMessageFile ? withFirstMessage(cmd, i.firstMessageFile) : cmd;
}
