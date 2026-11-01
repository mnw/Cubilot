// The slash commands of an agent (ported from slash_discover_for_agent in src-tauri/src/lib.rs).
// Scans the agent's folder and the home folder for commands and skills, plus the `prompts` of the global MCP servers.
// Built-ins are not included. Pure over its inputs: the caller reads tmux for the folder and the harness.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type SlashEntry = { name: string; description: string };

// Claude plugins whose skills are shared with pi agents. Keep equal to SHARED_CLAUDE_PLUGINS in src-tauri/src/pty.rs.
const SHARED_CLAUDE_PLUGINS = ["figma@claude-plugins-official"];

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Tolerant: handles Claude Code's single-line, optionally-quoted value shape only. ~120 chars keeps the picker compact.
export function readFrontmatterDescription(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (t === "---") break;
    if (t.startsWith("description:")) {
      const v = t.slice("description:".length).trim().replace(/^["']+|["']+$/g, "");
      if (v) return [...v].slice(0, 120).join("");
    }
  }
  return null;
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// The first definition of a name wins.
export function scanCommandsDir(dir: string, out: Map<string, string>): void {
  for (const f of dirNames(dir)) {
    if (!f.endsWith(".md") || f === ".md") continue;
    const stem = f.slice(0, -3);
    if (!out.has(stem)) out.set(stem, readFrontmatterDescription(join(dir, f)) ?? "");
  }
}

export function scanSkillsDir(dir: string, out: Map<string, string>): void {
  for (const n of dirNames(dir)) {
    const p = join(dir, n);
    if (!isDir(p) || !isFile(join(p, "SKILL.md"))) continue;
    if (!out.has(n)) out.set(n, readFrontmatterDescription(join(p, "SKILL.md")) ?? "");
  }
}

// The active skills dir of a Claude plugin, from installed_plugins.json (the cache keeps stale versions next to it).
function claudePluginSkillsDir(home: string, key: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8"));
    const entry = (v?.plugins?.[key] as { installPath?: unknown }[] | undefined)?.find((e) => typeof e?.installPath === "string");
    if (!entry) return null;
    const skills = join(entry.installPath as string, "skills");
    return isDir(skills) ? skills : null;
  } catch {
    return null;
  }
}

// Package layouts differ (npm is flat-ish, git clones nest by host/org/repo): walk a bounded depth for `skills` dirs.
function collectPackageSkillDirs(dir: string, out: string[], depth: number): void {
  if (depth > 3) return;
  for (const n of dirNames(dir)) {
    const p = join(dir, n);
    if (!isDir(p)) continue;
    if (isDir(join(p, "skills"))) out.push(join(p, "skills"));
    collectPackageSkillDirs(p, out, depth + 1);
  }
}

// The skill roots a pi agent sees: the --skill paths of the spawn plus pi's own package and project roots.
export function piSkillRoots(cwd: string, home: string): string[] {
  const roots = [join(cwd, ".claude/skills"), join(home, ".claude/skills"), join(cwd, ".pi/skills"), join(home, ".pi/agent/skills")];
  for (const key of SHARED_CLAUDE_PLUGINS) {
    const p = claudePluginSkillsDir(home, key);
    if (p) roots.push(p);
  }
  for (const base of [join(home, ".pi/agent/npm/node_modules"), join(home, ".pi/agent/git")]) collectPackageSkillDirs(base, roots, 0);
  return roots.filter(isDir);
}

const RESERVED_MCP_SERVER = "chatbridge";

// Only the `mcpServers` map survives (`_comment` etc. are dropped), minus the reserved name. Bad JSON gives {}.
export function readGlobalMcpServers(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`[mcp] ${file} parse failed: ${(e as Error).message}`);
    return {};
  }
  const servers = (doc as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
  const out = { ...(servers as Record<string, unknown>) };
  delete out[RESERVED_MCP_SERVER];
  return out;
}

export type SlashInputs = {
  cwd: string | null; // the agent's pane folder, null when tmux has none
  home: string;
  harness: "claude" | "pi";
  mcpServers: Record<string, unknown>;
};

const byName = (m: Map<string, string>): SlashEntry[] =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, description]) => ({ name, description }));

export function discoverSlashCommands(i: SlashInputs): SlashEntry[] {
  const out = new Map<string, string>();
  const roots = [i.cwd, i.home].filter((r): r is string => !!r);

  // pi addresses skills as `/skill:<name>` and has no MCP prompts; its prompt templates are the same
  // `~/.claude/commands` files the spawn passes through.
  if (i.harness === "pi") {
    const skills = new Map<string, string>();
    for (const r of piSkillRoots(i.cwd ?? "", i.home)) scanSkillsDir(r, skills);
    for (const [n, d] of skills) out.set(`skill:${n}`, d);
    for (const r of roots) scanCommandsDir(join(r, ".claude/commands"), out);
    return byName(out);
  }

  for (const r of roots) {
    scanCommandsDir(join(r, ".claude/commands"), out);
    scanSkillsDir(join(r, ".claude/skills"), out);
  }
  for (const [server, cfg] of Object.entries(i.mcpServers)) {
    const c = cfg as { prompts?: unknown; description?: unknown } | null;
    const description = typeof c?.description === "string" ? c.description : "";
    if (!Array.isArray(c?.prompts)) continue;
    for (const p of c.prompts) {
      if (typeof p !== "string") continue;
      const full = `mcp__${server}__${p}`;
      if (!out.has(full)) out.set(full, description);
    }
  }
  return byName(out);
}
