// Settings feature — read routes for what the UI got from Tauri commands (get_ui_settings, get_human_name, get_app_version,
// get_mcp_template, list_roles, pty_roles, pty_harness, resolve_default_room) plus the native paths. config.yml is read at
// each call through core/config-file.ts, so an edit shows at the next request with no reload.
// Env the shell sets: CUBILOT_APP_VERSION, CUBILOT_TMUX, CUBILOT_FACTORY_SRC, CUBILOT_MOD_DIR (plus the existing
// CUBILOT_DATA_DIR, CUBILOT_FACTORY_DIR, CUBILOT_HUMAN_NAME).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HubFeature } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { readConfig } from "../core/config-file";
import { AGENT_NAME_RE } from "../core/ids";
import { claudeModels, loginPath, piModels, PiListError } from "../core/models";
import { applyIn, listIn, setOffIn, SkillsError } from "../core/skills";
import { discoverSlashCommands, readGlobalMcpServers } from "../core/slash-discover";

export type SettingsDeps = {
  agents: AgentRegistry;
  defaultRoom: string;
};

const VALID_THEMES = ["default", "rose-pine-dawn", "rose-pine-moon"];
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.25;
const FONT_NAME_MAX = 64;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const dataDir = () => process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot");
const cfg = () => readConfig("settings");

// Whitelist keeps a font name from breaking out of the UI's CSS string composer.
function sanitizeFontName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t) return "";
  if (t.length > FONT_NAME_MAX) {
    console.log(`[settings] font name '${t}' exceeds ${FONT_NAME_MAX} chars; ignored`);
    return "";
  }
  if (!/^[A-Za-z0-9 ._-]+$/.test(t)) {
    console.log(`[settings] font name '${t}' contains characters outside [A-Za-z0-9 ._-]; ignored`);
    return "";
  }
  return t;
}

export function uiSettings() {
  const c = cfg();
  const rawTheme = typeof c.theme === "string" ? c.theme.trim().toLowerCase() : "";
  let theme = rawTheme || "default";
  if (!VALID_THEMES.includes(theme)) {
    console.log(`[settings] theme '${theme}' not in ${VALID_THEMES.join(", ")}; falling back to default`);
    theme = "default";
  }
  const rawScale = typeof c.font_scale === "number" && Number.isFinite(c.font_scale) ? c.font_scale : 1;
  const fonts = (typeof c.fonts === "object" && c.fonts !== null ? c.fonts : {}) as Record<string, unknown>;
  return {
    theme,
    font_scale: Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, rawScale)),
    fonts: { ui: sanitizeFontName(fonts.ui), mono: sanitizeFontName(fonts.mono) },
  };
}

// Spawn-modal Room default: git-root basename, falling back to cwd basename.
export function defaultRoomForCwd(cwd: string): string {
  let p = cwd;
  for (;;) {
    if (existsSync(join(p, ".git"))) {
      const n = basename(p);
      if (n) return n;
    }
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return basename(cwd) || "default";
}

// ---- tmux (read only): the roster pill and the harness of a running agent ----

function tmuxRun(args: string[]): string | null {
  const bin = process.env.CUBILOT_TMUX;
  if (!bin) return null;
  const lang = /utf/i.test(process.env.LANG ?? "") ? process.env.LANG! : "en_US.UTF-8";
  try {
    const r = Bun.spawnSync([bin, "-S", join(dataDir(), "tmux.sock"), ...args], {
      env: { ...process.env, LANG: lang, LC_ALL: lang },
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

const validAgentName = (n: string) => n !== "shell" && AGENT_NAME_RE.test(n);
const tmuxPane = (n: string) => `=${n}:`;

// First word of a pane start command after leading VAR=value words, as a basename (quotes honoured).
export function commandExecutable(cmd: string): string | null {
  let s = cmd.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // tmux wraps pane_start_command in double quotes and escapes shell-significant bytes.
    s = s.slice(1, -1).replace(/\\(["\\$])/g, "$1");
  }
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    let word = "";
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i++];
      if (c === "'") {
        quoted = true;
        while (i < s.length && s[i] !== "'") word += s[i++];
        i++;
      } else if (c === '"') {
        quoted = true;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\") i++;
          if (i < s.length) word += s[i];
          i++;
        }
        i++;
      } else if (c === "\\") {
        quoted = true;
        if (i < s.length) word += s[i++];
      } else word += c;
    }
    if (!word && !quoted) return null;
    const eq = word.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq))) continue;
    return basename(word) || null;
  }
}

function paneHarness(agent: string): "claude" | "pi" {
  const opt = tmuxRun(["show-options", "-v", "-t", tmuxPane(agent), "@cubilot_harness"])?.trim();
  if (opt === "claude" || opt === "pi") return opt;
  const cmd = tmuxRun(["list-panes", "-t", tmuxPane(agent), "-F", "#{pane_start_command}"]);
  return cmd !== null && commandExecutable(cmd) === "pi" ? "pi" : "claude";
}

const PILL_FORMAT = "#{session_name}\t#{@cubilot_role}\t#{@cubilot_model}\t#{@cubilot_provider}\t#{@cubilot_effort}\t#{@cubilot_harness}";

type Pill = { role: string; model: string; provider: string; effort: string; harness: string };

// A session is listed when it has a role or a harness record; sessions with neither were not launched by this app.
export function parseRolePills(out: string): Record<string, Pill> {
  const map: Record<string, Pill> = Object.create(null); // a session may be named __proto__
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f.length < 4) continue;
    const [name, role, model, provider, effort = "", harness = ""] = f;
    if ((!role && !harness) || !validAgentName(name)) continue;
    map[name] = { role, model, provider, effort, harness };
  }
  return map;
}

// ---- roles: frontmatter of the bundled role file, filtered by what the current staged version holds ----

type RoleInfo = {
  name: string;
  harness: string;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  effort: string | null;
};

function frontmatterValue(text: string, key: string): string | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  for (const line of text.slice(4, end).split("\n")) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// null: a council, a bad file or an unknown harness or effort (not a role).
export function parseRoleSpec(role: string, text: string): RoleInfo | null {
  if (frontmatterValue(text, "council") !== null) return null;
  if (frontmatterValue(text, "name") !== role) return null;
  const harness = frontmatterValue(text, "harness") || "claude";
  if (harness !== "claude" && harness !== "pi") return null;
  const opt = (k: string) => frontmatterValue(text, k) || null;
  const effort = opt("effort");
  if (effort !== null && (harness === "pi" || !CLAUDE_EFFORTS.includes(effort))) return null;
  return { name: role, harness, provider: opt("provider"), model: opt("model"), thinking: opt("thinking"), effort };
}

export function listRoles(src: string, versionDir: string): RoleInfo[] {
  let names: string[];
  try {
    names = readdirSync(versionDir);
  } catch {
    return [];
  }
  const out: RoleInfo[] = [];
  for (const n of names) {
    if (!/^[a-z0-9_-]{1,40}$/.test(n)) continue;
    try {
      if (!statSync(join(versionDir, n, "role.md")).isFile()) continue;
      const spec = parseRoleSpec(n, readFileSync(join(src, n, `${n}.md`), "utf8"));
      if (spec) out.push(spec);
    } catch {
      /* not a staged role */
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function currentVersionDir(): string | null {
  const dir = (process.env.CUBILOT_FACTORY_DIR ?? "").trim();
  if (!dir) return null;
  try {
    const v = join(dir, readFileSync(join(dir, "current"), "utf8").trim());
    return statSync(v).isDirectory() ? v : null;
  } catch {
    return null;
  }
}

// config.yml `pi_path` (a leading ~ is the home folder), else the pnpm default.
function resolvePiPath(): string {
  const raw = cfg().pi_path;
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return join(homedir(), "Library/pnpm/bin/pi");
  return v === "~" ? homedir() : v.startsWith("~/") ? join(homedir(), v.slice(2)) : v;
}

const modDirComplete = (d: string) => [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js"].every((f) => existsSync(join(d, f)));

export function createSettingsFeature(deps: SettingsDeps): HubFeature {
  const { agents, defaultRoom } = deps;
  const err = (error: string, status: number) => Response.json({ error }, { status });

  // The agent's role (tmux pill) and launch command (pane start command), with the factory and the staged version.
  const skillTarget = (name: string) => {
    const known = agents.get(name) !== null || (validAgentName(name) && tmuxRun(["has-session", "-t", `=${name}`]) !== null);
    if (!known) return err(`unknown agent: ${name}`, 404);
    const dest = (process.env.CUBILOT_FACTORY_DIR ?? "").trim();
    const vdir = currentVersionDir();
    if (!dest || !vdir) return err("no factory is staged", 503);
    const pills = parseRolePills(tmuxRun(["list-sessions", "-F", PILL_FORMAT]) ?? "");
    const command = tmuxRun(["list-panes", "-t", tmuxPane(name), "-F", "#{pane_start_command}"]);
    return { name, dest, vdir, role: pills[name]?.role || null, command };
  };
  const skillsFail = (e: unknown) => {
    if (e instanceof SkillsError) return err(e.message, e.status);
    throw e;
  };

  return {
    routes: [
      { method: "GET", path: "/settings/ui", auth: "read", handler: () => Response.json(uiSettings()) },
      {
        method: "GET",
        path: "/settings/human",
        auth: "read",
        // The hub's own identity (set at start): the name the removed get_human_name returned.
        handler: () => Response.json({ name: process.env.CUBILOT_HUMAN_NAME || "human" }),
      },
      {
        method: "GET",
        path: "/settings/version",
        auth: "read",
        handler: () => Response.json({ version: process.env.CUBILOT_APP_VERSION ?? "" }),
      },
      {
        method: "GET",
        path: "/settings/mcp-template",
        auth: "read",
        handler: () => {
          const dir = process.env.CUBILOT_MOD_DIR;
          // Same guard as a spawn: never hand out a launch line for a stale or missing mod.
          if (!dir || !modDirComplete(dir)) return err("chatbridge mod is not staged; the next Claude spawn stages the mod again", 503);
          const q = dir.replace(/'/g, `'\\''`);
          return Response.json({ template: `CHATBRIDGE_AGENT='agent' CHATBRIDGE_ROOM='default' claude --plugin-dir '${q}'` });
        },
      },
      {
        method: "GET",
        path: "/settings/paths",
        auth: "read",
        handler: (req) => {
          const agent = new URL(req.url).searchParams.get("agent");
          const body: Record<string, string | null> = {
            config: join(dataDir(), "config.yml"),
            skills: join(dataDir(), "factory-user"),
            mcp: join(dataDir(), "mcp.json"),
          };
          if (agent !== null) {
            if (!validAgentName(agent)) return err(`invalid agent: ${agent}`, 400);
            body.agent_cwd = tmuxRun(["display-message", "-p", "-t", tmuxPane(agent), "#{pane_current_path}"])?.trim() || null;
          }
          return Response.json(body);
        },
      },
      {
        method: "GET",
        path: "/roles",
        auth: "read",
        handler: () => {
          const src = (process.env.CUBILOT_FACTORY_SRC ?? "").trim();
          const vdir = currentVersionDir();
          const out = tmuxRun(["list-sessions", "-F", PILL_FORMAT]);
          return Response.json({
            roles: src && vdir ? listRoles(src, vdir) : [],
            pills: out === null ? {} : parseRolePills(out),
          });
        },
      },
      {
        method: "GET",
        path: /^\/agents\/([^/]+)\/harness$/,
        auth: "read",
        handler: (_req, _cap, params) => {
          const name = decodeURIComponent(params.id ?? "");
          const known = agents.get(name) !== null || (validAgentName(name) && tmuxRun(["has-session", "-t", `=${name}`]) !== null);
          if (!known) return err(`unknown agent: ${name}`, 404);
          return Response.json({ harness: paneHarness(name) });
        },
      },
      {
        method: "GET",
        path: "/models",
        auth: "read",
        handler: async (req) => {
          const harness = (new URL(req.url).searchParams.get("harness") ?? "").trim();
          if (harness === "claude" || harness === "") return Response.json({ models: claudeModels() });
          if (harness !== "pi") return err(`invalid harness: ${harness}`, 400);
          try {
            return Response.json({ models: await piModels(resolvePiPath(), { path: await loginPath(), limitMs: Number(process.env.CUBILOT_PI_LIST_LIMIT_MS) || undefined }) });
          } catch (e) {
            if (!(e instanceof PiListError)) throw e;
            return Response.json({ models: [], warning: e.message });
          }
        },
      },
      {
        method: "GET",
        path: /^\/agents\/([^/]+)\/slash-commands$/,
        auth: "read",
        handler: (_req, _cap, params) => {
          const name = decodeURIComponent(params.id ?? "");
          const known = agents.get(name) !== null || (validAgentName(name) && tmuxRun(["has-session", "-t", `=${name}`]) !== null);
          if (!known) return err(`unknown agent: ${name}`, 404);
          const cwd = tmuxRun(["display-message", "-p", "-t", tmuxPane(name), "#{pane_current_path}"])?.trim() || null;
          return Response.json({
            commands: discoverSlashCommands({
              cwd,
              home: homedir(),
              harness: paneHarness(name),
              mcpServers: readGlobalMcpServers(join(dataDir(), "mcp.json")),
            }),
          });
        },
      },
      {
        method: "GET",
        path: /^\/agents\/([^/]+)\/skills$/,
        auth: "read",
        handler: (_req, _cap, params) => {
          const t = skillTarget(decodeURIComponent(params.id ?? ""));
          if (t instanceof Response) return t;
          return Response.json(listIn(t.dest, t.vdir, t.name, t.role, t.command));
        },
      },
      {
        method: "PUT",
        path: /^\/agents\/([^/]+)\/skills$/,
        auth: "mutating",
        handler: async (req, _cap, params) => {
          const t = skillTarget(decodeURIComponent(params.id ?? ""));
          if (t instanceof Response) return t;
          const body = (await req.json().catch(() => null)) as { off?: unknown } | null;
          if (!body || !Array.isArray(body.off) || body.off.some((x) => typeof x !== "string")) return err("off must be an array of skill ids", 400);
          if (!t.role) return err("the agent has no role", 409);
          try {
            setOffIn(t.dest, t.vdir, t.name, t.role, body.off as string[]);
          } catch (e) {
            return skillsFail(e);
          }
          return Response.json({ ok: true });
        },
      },
      {
        method: "POST",
        path: /^\/agents\/([^/]+)\/skills\/apply$/,
        auth: "mutating",
        handler: async (_req, _cap, params) => {
          const t = skillTarget(decodeURIComponent(params.id ?? ""));
          if (t instanceof Response) return t;
          try {
            await applyIn(t.dest, t.vdir, t.name, t.role, t.command);
          } catch (e) {
            return skillsFail(e);
          }
          return Response.json({ ok: true });
        },
      },
      {
        method: "GET",
        path: "/room-default",
        auth: "read",
        handler: (req) => {
          const cwd = new URL(req.url).searchParams.get("cwd");
          return Response.json({ room: cwd ? defaultRoomForCwd(cwd) : defaultRoom });
        },
      },
    ],
  };
}
