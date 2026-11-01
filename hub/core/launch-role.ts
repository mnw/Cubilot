// The role setup of a launch, ported from the Rust shell (group 7a, hub-first-browser design decision 3):
// factory.rs resolve_role_launch / write_agent_settings, skills.rs launch_in, login_path.rs (hub/core/models.ts
// loginPath), the Claude version check and the Pi sign-in check of pty.rs, the global MCP config file and the
// first-message file. Same paths, file names and file contents as the Rust shell.
//
// One lock: the publication lock of hub/features/factory-skills.ts (holder "hub"). No second lock.
// It never writes a project .mcp.json and never writes under ~/.claude (that folder is only read).
// No caller yet (group 7b/8). Group 8 calls `prepareLaunch`.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCK_WAIT_MS, SkillsLockBusy, swapView, takeLock } from "../features/factory-skills";
import { buildLaunchCommand, launchBins, validRoleName, validStageId, type Harness, type LaunchChoice, type RoleLaunch, type SessionMode, spawnEnv } from "./launch-command";
import { loginPath, validModel, validProvider } from "./models";
import { agentKey, cleanupViews, inventory, nextGen, readOff, buildView, writeAtomic } from "./skills";

type Env = Record<string, string | undefined>;

export const MIN_CLAUDE_CODE: [number, number, number] = [2, 1, 296];
export const CLAUDE_VERSION_TIMEOUT_MS = 10_000;
export const PI_AUTH_CHECK_MS = 20_000;
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const RESERVED_MCP_SERVER = "chatbridge";
const AGENT_RECORD_SUFFIXES = [".applied", ".pending", ".last"];
const DOT_IN_TERMINAL_NAME = "a dot is not allowed in a terminal agent name: tmux changes it";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// ---- Paths ----
/** The home folder (HOME first, as dirs::home_dir): only read, never written. */
export const homeDir = (env: Env = process.env): string => env.HOME?.trim() || homedir() || "/tmp";
export const dataDir = (env: Env = process.env): string => env.CUBILOT_DATA_DIR?.trim() || join(homeDir(env), "Library", "Application Support", "Cubilot");
export const factoryDir = (env: Env = process.env): string => env.CUBILOT_FACTORY_DIR?.trim() || join(dataDir(env), "factory");
export const factorySettingsDir = (env: Env = process.env): string => join(dataDir(env), "factory-settings");
export const sessionsDir = (env: Env = process.env): string => join(dataDir(env), "sessions");
const mcpConfigsDir = (env: Env): string => join(dataDir(env), "mcp-configs");
const globalMcpConfigPath = (env: Env): string => join(dataDir(env), "mcp.json");

// serde_json (no preserve_order) writes object keys in byte order at every depth; JSON.stringify keeps insertion order.
const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort(byteCmp).map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

// Mode 0600 file through a temp file and a rename. `tmpName` keeps the temp name of the Rust writer it replaces.
function writeFile0600(dir: string, name: string, tmpName: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = join(dir, tmpName);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`write ${path}: ${errMsg(e)}`);
  }
  return path;
}

let runs = 0;

// ---- Role frontmatter (factory.rs) ----
export type RoleSpec = { name: string; harness: Harness; provider?: string; model?: string; thinking?: string; effort?: string; disallowedTools: string[]; excludeTools: string[] };

export function frontmatterValue(text: string, key: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const rest = text.slice(4);
  const end = rest.indexOf("\n---");
  if (end < 0) return undefined;
  for (const l of rest.slice(0, end).split("\n")) {
    if (l.startsWith(key) && l.slice(key.length).startsWith(":")) return l.slice(key.length + 1).trim().replace(/^["']+|["']+$/g, "");
  }
  return undefined;
}
const csvList = (v: string | undefined): string[] => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

export function parseRoleSpec(role: string, text: string): RoleSpec {
  if (frontmatterValue(text, "council") !== undefined) throw new Error(`role '${role}' is a council, not a single agent; it cannot be spawned`);
  const name = frontmatterValue(text, "name");
  if (name === undefined) throw new Error(`role '${role}': no frontmatter name`);
  if (name !== role) throw new Error(`role '${role}': frontmatter name is '${name}'`);
  const harness = frontmatterValue(text, "harness") || "claude";
  if (harness !== "claude" && harness !== "pi") throw new Error(`role '${role}': unknown harness '${harness}'`);
  const opt = (k: string): string | undefined => frontmatterValue(text, k) || undefined;
  const effort = opt("effort");
  if (effort !== undefined) {
    if (harness === "pi") throw new Error(`role '${role}': 'effort' is for Claude roles; a Pi role uses 'thinking'`);
    if (!CLAUDE_EFFORTS.includes(effort)) throw new Error(`role '${role}': invalid effort '${effort}' (allowed: ${CLAUDE_EFFORTS.join(", ")})`);
  }
  return { name, harness, provider: opt("provider"), model: opt("model"), thinking: opt("thinking"), effort, disallowedTools: csvList(frontmatterValue(text, "disallowedTools")), excludeTools: csvList(frontmatterValue(text, "excludeTools")) };
}

/** Unknown role (bad name, no file, or not staged in the version) is an error: nothing launches. */
export function loadRoleSpec(role: string, src: string, versionDir: string): RoleSpec {
  if (!validRoleName(role)) throw new Error(`invalid role: ${JSON.stringify(role)}`);
  const text = read(join(src, role, `${role}.md`));
  if (text === null) throw new Error(`unknown role: ${role}`);
  const spec = parseRoleSpec(role, text);
  if (!isFile(join(versionDir, role, "role.md"))) throw new Error(`role '${role}' is not staged in ${versionDir}`);
  return spec;
}

export function currentVersionDir(factory: string): string {
  const name = read(join(factory, "current"));
  if (name === null) throw new Error("factory/current: No such file or directory (os error 2)");
  const dir = join(factory, name.trim());
  if (!isDir(dir)) throw new Error(`factory version ${name.trim()} is missing`);
  return dir;
}

function factorySrc(env: Env): string {
  const src = env.CUBILOT_FACTORY_SRC?.trim();
  if (!src) throw new Error("CUBILOT_FACTORY_SRC is not set");
  return src;
}

// ---- Choice (factory.rs launch_choice, check_role_harness, role_launch_on, with_choice) ----
export function launchChoice(isPi: boolean, model?: string | null, provider?: string | null, effort?: string | null): LaunchChoice {
  const clean = (v?: string | null): string | undefined => (v?.trim() ? v.trim() : undefined);
  const [m, p, e] = [clean(model), clean(provider), clean(effort)];
  if (m !== undefined && !validModel(m)) throw new Error(`invalid model: ${JSON.stringify(m)}`);
  if (p !== undefined) {
    if (!isPi) throw new Error(`a provider (${JSON.stringify(p)}) only applies to a Pi launch`);
    if (!validProvider(p)) throw new Error(`invalid provider: ${JSON.stringify(p)}`);
  }
  if (e !== undefined) {
    const allowed = isPi ? PI_EFFORTS : CLAUDE_EFFORTS;
    if (!allowed.includes(e)) throw new Error(`invalid ${isPi ? "thinking level" : "effort"} ${JSON.stringify(e)} (allowed: ${allowed.join(", ")})`);
  }
  const out: LaunchChoice = {};
  if (m !== undefined) out.model = m;
  if (p !== undefined) out.provider = p;
  if (e !== undefined) out.effort = e;
  return out;
}

/** A launch on another harness than the role's has no default model: it needs one from the human. */
export function checkRoleHarness(spec: RoleSpec, harness: Harness, choice: LaunchChoice): void {
  if (spec.harness !== harness && !choice.model) {
    throw new Error(`role '${spec.name}' runs on ${spec.harness} by default; to launch it on ${harness} choose a model. Nothing was started.`);
  }
}

/** The role on the launch harness. The role's provider, model and thinking apply only on the role's own harness. */
export function roleLaunchOn(spec: RoleSpec, harness: Harness, versionDir: string, settings: string | null): RoleLaunch {
  const own = spec.harness === harness;
  const pluginDir = join(versionDir, spec.name);
  return {
    name: spec.name,
    harness,
    pluginDir,
    sharedDir: join(versionDir, "shared"),
    promptFile: join(pluginDir, "role.md"),
    settings,
    provider: own ? spec.provider : undefined,
    model: own ? spec.model : undefined,
    thinking: own ? spec.thinking : undefined,
    effort: own ? spec.effort : undefined,
    disallowedTools: spec.disallowedTools,
    excludeTools: spec.excludeTools,
  };
}

/** Applies the choice to ONE launch. The role file and the staged version are not touched. */
export function withChoice(l: RoleLaunch, c: LaunchChoice): RoleLaunch {
  const out = { ...l };
  if (c.model) out.model = c.model;
  if (out.harness === "pi") {
    if (c.provider) out.provider = c.provider;
    if (c.effort) out.thinking = c.effort;
  } else if (c.effort) out.effort = c.effort;
  return out;
}

// ---- Agent link and records (factory.rs) ----
/** A new session starts with no record of an earlier agent of the same name. */
export function clearAgentRecords(dest: string, agent: string): void {
  const key = agentKey(agent);
  for (const name of [key, ...AGENT_RECORD_SUFFIXES.map((x) => `${key}${x}`)]) {
    const p = join(dest, "agents", name);
    let exists = true;
    try {
      readlinkSync(p);
    } catch {
      try {
        statSync(p);
      } catch {
        exists = false;
      }
    }
    if (exists) {
      try {
        unlinkSync(p);
      } catch (e) {
        throw new Error(`remove ${p}: ${errMsg(e)}`);
      }
    }
  }
}

/** `<dest>/agents/<key>` -> `<dest>/<version>`, by temp link plus rename; `<key>.applied` records the version. */
export function linkAgent(dest: string, agent: string, version: string): string {
  const dir = join(dest, "agents");
  mkdirSync(dir, { recursive: true });
  const key = agentKey(agent);
  const run = runs++;
  const tmp = join(dir, `${key}.tmp-${process.pid}-${run}`);
  rmSync(tmp, { force: true });
  try {
    symlinkSync(join(dest, version), tmp);
  } catch (e) {
    throw new Error(`write agent link: ${errMsg(e)}`);
  }
  const link = join(dir, key);
  try {
    renameSync(tmp, link);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`publish agent link: ${errMsg(e)}`);
  }
  const appliedTmp = join(dir, `${key}.applied.tmp-${process.pid}-${run}`);
  try {
    writeAtomicRaw(appliedTmp, version);
    renameSync(appliedTmp, join(dir, `${key}.applied`));
  } catch (e) {
    rmSync(appliedTmp, { force: true });
    throw new Error(`publish applied: ${errMsg(e)}`);
  }
  return link;
}
function writeAtomicRaw(path: string, text: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** A launch names `<link>/<role>`. If a staging swap makes the link miss for a moment, refuse. */
export function checkActiveRole(active: string, role: string): void {
  if (!isFile(join(active, role, "role.md"))) throw new Error("the factory is being staged: try the launch again");
}

// ---- skills.rs launch_in ----
/** An empty skill choice returns null (the flags name the agent link). A choice with a skill off builds and publishes the view. */
export async function launchIn(dest: string, versionDir: string, agent: string, role: string, version: string): Promise<string | null> {
  const key = agentKey(agent);
  let release: () => void;
  try {
    release = await takeLock(dest, key, LOCK_WAIT_MS, "hub");
  } catch (e) {
    if (e instanceof SkillsLockBusy) throw new Error("the skills lock is busy; try again");
    throw e;
  }
  try {
    const inv = inventory(versionDir, role);
    const off = readOff(dest, agent).filter((id) => inv.includes(id));
    let gen = 0;
    let root: string | null = null;
    if (off.length) {
      gen = nextGen(dest, agent);
      buildView(dest, versionDir, agent, role, gen, off);
      swapView(dest, key, `${key}.view-${gen}`);
      root = join(dest, "agents", `${key}.view`);
    }
    const body = JSON.stringify(canon({ version, gen, off, skills: inv })); // serde_json::to_string: sorted keys, compact
    const rec = (suffix: string) => join(dest, "agents", `${key}${suffix}`);
    writeAtomic(rec(".skills-published"), body);
    writeAtomic(rec(".skills-applied"), body);
    rmSync(rec(".skills-prepared"), { force: true });
    rmSync(rec(".skills-pending"), { force: true });
    cleanupViews(dest, agent);
    return root;
  } finally {
    release();
  }
}

// ---- Per-agent Claude settings (factory.rs build_agent_settings, write_agent_settings) ----
const skillName = (text: string): string | undefined => {
  if (!text.startsWith("---\n")) return undefined;
  const rest = text.slice(4);
  const end = rest.indexOf("\n---");
  if (end < 0) return undefined;
  const line = rest.slice(0, end).split("\n").find((l) => l.startsWith("name:"));
  return line === undefined ? undefined : line.slice(5).trim().replace(/^["']+|["']+$/g, "");
};

/** Skill (and slash command) names that a role launch turns off. */
function skillOverrideNames(root: string): string[] {
  const names: string[] = [];
  try {
    for (const e of readdirSync(root + "/skills", { withFileTypes: true })) {
      const text = read(join(root, "skills", e.name, "SKILL.md")); // follows symlinked skill folders
      if (text === null) continue;
      names.push(skillName(text) || e.name);
    }
  } catch {}
  const commands = (base: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(join(base, rel));
    } catch {
      return;
    }
    for (const n of entries) {
      const path = rel ? `${rel}/${n}` : n;
      if (isDir(join(base, path))) commands(base, path);
      else if (n.endsWith(".md") && n.length > 3) names.push(path.slice(0, -3).replace(/\//g, ":"));
    }
  };
  commands(join(root, "commands"), "");
  return names;
}

export function buildAgentSettings(role: string, userClaude: string, project: string, shared: string): unknown {
  let plugins: string[] = [];
  try {
    const v = JSON.parse(read(join(userClaude, "plugins/installed_plugins.json")) ?? "");
    if (v?.plugins && typeof v.plugins === "object" && !Array.isArray(v.plugins)) plugins = Object.keys(v.plugins);
  } catch {}
  const keep = [`factory-${role}@inline`, "factory-shared@inline", "chatbridge@inline"];
  plugins = plugins.filter((k) => !keep.includes(k)).sort(byteCmp);
  const skills = [...new Set([...skillOverrideNames(userClaude), ...skillOverrideNames(join(project, ".claude"))].sort(byteCmp))];
  const statusLine = `bash '${join(shared, "scripts/statusline.sh").replace(/'/g, `'\\''`)}'`;
  return canon({
    enabledPlugins: Object.fromEntries(plugins.map((k) => [k, false])),
    skillOverrides: Object.fromEntries(skills.map((k) => [k, "off"])),
    statusLine: { type: "command", command: statusLine },
  });
}

/** `<dir>/<agent>.json`, mode 0600, temp file and rename. One file per agent, outside the version folders. */
export function writeAgentSettings(agent: string, role: string, project: string, userClaude: string, shared: string, dir: string): string {
  if (!agent || agent.startsWith(".") || agent.includes("/") || agent.includes("\\")) throw new Error(`invalid agent name for a settings file: ${JSON.stringify(agent)}`);
  mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(buildAgentSettings(role, userClaude, project, shared), null, 2);
  return writeFile0600(dir, `${agent}.json`, `.${agent}.json.tmp-${process.pid}-${runs++}`, text);
}

// ---- Global MCP config (pty.rs write_global_mcp_config) ----
export function parseGlobalMcpServers(raw: string, label: string): Record<string, any> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[mcp] ${label} parse failed: ${errMsg(e)}`);
    return {};
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out = { ...servers };
  if (RESERVED_MCP_SERVER in out) {
    delete out[RESERVED_MCP_SERVER];
    console.error(`[mcp] dropped reserved server name '${RESERVED_MCP_SERVER}' from global config`);
  }
  return out;
}

/** Global MCP servers for Claude agents as a standalone --mcp-config file. Empty map: no file, no flag. Never a project .mcp.json. */
export function writeGlobalMcpConfig(dir: string, servers: Record<string, any>): string | null {
  const path = join(dir, "global.json");
  if (Object.keys(servers).length === 0) {
    try {
      rmSync(path, { force: true });
    } catch {} // a stale file that cannot be removed is not an error (the Rust code ignores it)
    return null;
  }
  for (const cfg of Object.values(servers)) if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) delete cfg.prompts; // Cubilot's own picker key
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`create ${dir}: ${errMsg(e)}`);
  }
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const text = JSON.stringify(canon({ mcpServers: servers }), null, 2);
  return writeFile0600(dir, "global.json", `.global.json.tmp-${process.pid}-${runs++}`, text);
}

// ---- First message (pty.rs write_first_message) ----
export function validAgentName(name: string): boolean {
  if (name === "shell" || name.length < 1 || [...name].length > 64) return false;
  if (name.startsWith(" ") || name.endsWith(" ")) return false;
  return /^[A-Za-z0-9_. -]+$/.test(name);
}

/** `<dir>/<session>/first-message.md`, mode 0600, folder 0700. The command reads it back with `$(cat ...)`. */
export function writeFirstMessage(dir: string, session: string, text: string): string {
  if (!validAgentName(session) || session.includes(".")) throw new Error(`invalid session name: ${session}`);
  const folder = join(dir, session);
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new Error(`create ${folder}: ${errMsg(e)}`);
  }
  try {
    chmodSync(folder, 0o700);
  } catch (e) {
    throw new Error(`chmod ${folder}: ${errMsg(e)}`);
  }
  const tmp = join(folder, `.first-message.${process.pid}.tmp`);
  const target = join(folder, "first-message.md");
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`write ${target}: ${errMsg(e)}`);
  }
  return target;
}

// ---- Claude version check (pty.rs) ----
export function parseClaudeVersion(out: string): [number, number, number] | null {
  for (const line of out.split("\n")) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(line);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

export function checkClaudeVersion(path: string, found: [number, number, number]): void {
  const ok = found[0] !== MIN_CLAUDE_CODE[0] ? found[0] > MIN_CLAUDE_CODE[0] : found[1] !== MIN_CLAUDE_CODE[1] ? found[1] > MIN_CLAUDE_CODE[1] : found[2] >= MIN_CLAUDE_CODE[2];
  if (ok) return;
  const UPDATE = "Update it with `claude update` (native install) or `npm update -g @anthropic-ai/claude-code` (npm install)";
  throw new Error(`Claude Code at ${path} is ${found.join(".")}, older than 2.1.296, which chatbridge needs (mods load unreliably before it). ${UPDATE}`);
}

// Runs `bin args` with a time limit: its output (stdout, then stderr) and exit code, or null on a timeout (killed).
async function runLimited(bin: string, args: string[], limitMs: number, env?: Env, stdoutOnly = false): Promise<{ out: string; code: number } | null> {
  const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> | undefined });
  const done = (async () => {
    const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { out: stdoutOnly ? so : so && se ? `${so}\n${se}` : so || se, code };
  })();
  done.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(null);
    }, limitMs);
  });
  try {
    return await Promise.race([done, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Probed on every new launch, never cached: the binary can be swapped in place. */
export async function ensureClaudeVersion(path: string, limitMs = CLAUDE_VERSION_TIMEOUT_MS): Promise<void> {
  let r: Awaited<ReturnType<typeof runLimited>>;
  try {
    r = await runLimited(path, ["--version"], limitMs);
  } catch (e) {
    throw new Error(`Could not start Claude Code at ${path} for --version: ${errMsg(e)}`);
  }
  if (r === null) throw new Error(`Claude Code --version timed out at ${path}. Output: `);
  if (r.code !== 0) throw new Error(`Claude Code --version at ${path} exited with code ${r.code}. Output: ${r.out}`);
  const v = parseClaudeVersion(r.out);
  if (!v) throw new Error(`Claude Code at ${path} returned no parseable version. Output: ${r.out}`);
  checkClaudeVersion(path, v);
}

// ---- Pi sign-in check (pty.rs) ----
export function authCheckResult(provider: string, exitOk: boolean, stdout: string): void {
  let v: any = null;
  try {
    v = JSON.parse(stdout.trim());
  } catch {}
  if (exitOk && v?.status === "ready") return;
  const reason = typeof v?.reason === "string" ? v.reason : undefined;
  if (reason === "credentials_not_configured") throw new Error(`Pi is not signed in to ${provider}. Run \`pi\` and /login ${provider}. Nothing was started.`);
  if (reason === "provider_not_found") throw new Error(`Pi does not know the provider ${provider}. Nothing was started.`);
  if (reason !== undefined) throw new Error(`Pi is not ready for ${provider} (${reason}). Run \`pi\` and /login ${provider}. Nothing was started.`);
  throw new Error(`The Pi sign-in check for ${provider} gave no usable answer. Run \`pi\` and /login ${provider}. Nothing was started.`);
}

/** `path` is the PATH of the pi child (undefined keeps the inherited one). */
export async function piAuthCheck(pi: string, provider: string, path?: string, limitMs = PI_AUTH_CHECK_MS): Promise<void> {
  const env = path ? { ...process.env, PATH: path } : process.env;
  let r: Awaited<ReturnType<typeof runLimited>>;
  try {
    r = await runLimited(pi, ["auth", "check", "--provider", provider, "--json"], limitMs, env, true); // stdout only, as pty.rs
  } catch (e) {
    throw new Error(`Could not run \`pi auth check\` for ${provider} (${errMsg(e)}). Nothing was started.`);
  }
  if (r === null) throw new Error(`The Pi sign-in check for ${provider} took more than ${Math.floor(limitMs / 1000)} seconds. Run \`pi\` and /login ${provider}. Nothing was started.`);
  authCheckResult(provider, r.code === 0, r.out);
}

/** The provider to check: the human's choice wins; a Pi ROLE names one; a plain Pi agent with no choice is left alone. */
export function piProviderToCheck(harness: Harness, spec: RoleSpec | null, choice: LaunchChoice): string | null {
  if (harness !== "pi") return null;
  if (choice.provider) return choice.provider;
  return spec && spec.harness === "pi" ? (spec.provider ?? null) : null;
}

// ---- resolve_role_launch ----
export function resolveRoleLaunch(env: Env, agent: string, role: string, cwd: string, harness: Harness, choice: LaunchChoice): Promise<RoleLaunch> {
  return resolveRoleLaunchIn({ factory: factoryDir(env), src: factorySrc(env), settingsDir: factorySettingsDir(env), userClaude: join(homeDir(env), ".claude") }, agent, role, cwd, harness, choice);
}

export type RoleDirs = { factory: string; src: string; settingsDir: string; userClaude: string };

export async function resolveRoleLaunchIn(d: RoleDirs, agent: string, role: string, cwd: string, harness: Harness, choice: LaunchChoice): Promise<RoleLaunch> {
  const versionDir = currentVersionDir(d.factory);
  const spec = loadRoleSpec(role, d.src, versionDir);
  // Launch flags name this agent's own link, not the version folder or the shared `active` link.
  checkActiveRole(join(d.factory, "active"), role);
  const version = read(join(d.factory, "current"));
  if (version === null) throw new Error("factory/current: No such file or directory (os error 2)");
  const active = linkAgent(d.factory, agent, version.trim());
  checkActiveRole(active, role);
  const launchRoot = (await launchIn(d.factory, versionDir, agent, role, version.trim())) ?? active;
  checkActiveRole(launchRoot, role);
  checkRoleHarness(spec, harness, choice);
  const settings = harness === "claude" ? writeAgentSettings(agent, role, cwd, d.userClaude, join(launchRoot, "shared"), d.settingsDir) : null;
  return withChoice(roleLaunchOn(spec, harness, launchRoot, settings), choice);
}

// ---- The one function group 8 calls ----
export type LaunchInput = {
  agent: string;
  /** The room label the agent runs in (CHATBRIDGE_ROOM). */
  room: string;
  /** Blank or null: no role. */
  role: string | null;
  cwd: string;
  harness: Harness;
  /** Only what the human changed in the model x effort grid. */
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  sessionMode?: SessionMode | null;
  /** A hub-launched stage session: CUBILOT_STAGE_ID, the login PATH for Claude, the first message. */
  stageId?: string | null;
  firstMessage?: string | null;
  apiKey?: string | null;
};

/** What hub/core/tmux.ts newSession takes (name, cwd, command, env) plus the facts a pill record needs. */
export type LaunchPlan = { name: string; cwd: string; command: string; env: string[]; harness: Harness; role: string | null; choice: LaunchChoice; spec: RoleSpec | null };

export type LaunchDeps = {
  loginPath: () => Promise<string | undefined>;
  ensureClaudeVersion: (path: string) => Promise<void>;
  piAuthCheck: (pi: string, provider: string, path?: string) => Promise<void>;
};
const defaultDeps: LaunchDeps = { loginPath, ensureClaudeVersion, piAuthCheck };

/**
 * Same order as pty_spawn for a new session: names and choice checks, Pi sign-in check, Claude version check, agent
 * records cleared, role resolved (link, skills launch, settings), MCP config, login PATH, first-message file.
 * Writes only under the Cubilot data dir (factory/, factory-settings/, mcp-configs/, sessions/). Starts no session.
 */
export async function prepareLaunch(i: LaunchInput, env: Env = process.env, deps: LaunchDeps = defaultDeps): Promise<LaunchPlan> {
  if (i.stageId != null && !validStageId(i.stageId)) throw new Error(`invalid stage id: ${i.stageId}`);
  const role = i.role?.trim() ? i.role.trim() : null;
  if (!validAgentName(i.agent)) throw new Error(`invalid agent name: ${i.agent}`);
  if (i.agent.includes(".")) throw new Error(DOT_IN_TERMINAL_NAME);
  if (i.harness !== "claude" && i.harness !== "pi") throw new Error(`invalid harness: ${i.harness}`);
  const isPi = i.harness === "pi";
  const choice = launchChoice(isPi, i.model, i.provider, i.effort);
  const dirs: RoleDirs = { factory: factoryDir(env), src: role ? factorySrc(env) : "", settingsDir: factorySettingsDir(env), userClaude: join(homeDir(env), ".claude") };
  const spec = role ? loadRoleSpec(role, dirs.src, currentVersionDir(dirs.factory)) : null;
  if (spec) checkRoleHarness(spec, i.harness, choice);
  const bins = launchBins(env);

  // As pty.rs wants_login_path: Pi always, Claude only for a hub-launched stage.
  const path = i.harness === "pi" || i.stageId != null ? await deps.loginPath() : undefined;
  const provider = piProviderToCheck(i.harness, spec, choice);
  if (provider) await deps.piAuthCheck(bins.piBin, provider, path);
  if (!isPi) await deps.ensureClaudeVersion(bins.claudeBin);

  clearAgentRecords(dirs.factory, i.agent); // a new session: drop any link and .applied of an earlier agent of this name
  const launch = role ? await resolveRoleLaunchIn(dirs, i.agent, role, i.cwd, i.harness, choice) : null;
  let mcpConfig: string | null = null;
  if (!isPi) {
    const raw = read(globalMcpConfigPath(env));
    mcpConfig = writeGlobalMcpConfig(mcpConfigsDir(env), raw === null ? {} : parseGlobalMcpServers(raw, globalMcpConfigPath(env)));
  }
  const firstFile = i.firstMessage ? writeFirstMessage(sessionsDir(env), i.agent, i.firstMessage) : null;
  const command = buildLaunchCommand({
    agent: i.agent, room: i.room, cwd: i.cwd, harness: i.harness, sessionMode: i.sessionMode, role: launch, choice, bins, mcpConfig,
    stageId: i.stageId, loginPath: path, firstMessageFile: firstFile, home: homeDir(env),
  });
  return { name: i.agent, cwd: i.cwd, command, env: spawnEnv({ dataDir: dataDir(env), apiKey: i.apiKey, stageId: i.stageId }), harness: i.harness, role, choice, spec };
}
