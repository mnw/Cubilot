// Per-agent skill switches (C6b), ported from src-tauri/src/skills.rs: list, store and prepare. The hub writes
// `.skills-off`; the shell still builds a view at a role launch (`launch_in`) and only reads it. Design:
// factory/brief/04a-c6-design.md, sections 1 to 5. Files beside the agent link in `<factory dir>/agents/`, key =
// lowercase hex of the agent name (see features/factory-skills.ts for the records the hub publishes).

import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SkillsLockBusy, takeLock } from "../features/factory-skills";

export type SkillItem = { id: string; on: boolean; state: "loaded" | "not_loaded" | "new" };
export type SkillGroup = { name: string; skills: SkillItem[] };
export type AgentSkills = { role: string | null; mode: "none" | "legacy" | "plain" | "view"; relaunch_needed: boolean; groups: SkillGroup[] };

// status: 400 bad request, 409 the agent state does not allow it.
export class SkillsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const agentKey = (agent: string): string => Buffer.from(agent, "utf8").toString("hex");
const agentsDir = (dest: string) => join(dest, "agents");
const rec = (dest: string, agent: string, suffix: string) => join(agentsDir(dest), `${agentKey(agent)}${suffix}`);

let runs = 0;
// Mode 0600, temp file and rename: a reader sees the old file or the whole new one.
export function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${runs++}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

// ---- Inventory ----
function skillFolders(versionDir: string, group: string): string[] {
  const base = join(versionDir, group, "skills");
  try {
    return readdirSync(base)
      .filter((n) => {
        try {
          return statSync(join(base, n)).isDirectory(); // follows links
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// Every skill id of the version: `<role>/<folder>` and `shared/<folder>`, sorted.
export function inventory(versionDir: string, role: string): string[] {
  return [...skillFolders(versionDir, role).map((f) => `${role}/${f}`), ...skillFolders(versionDir, "shared").map((f) => `shared/${f}`)].sort();
}

const readOff = (dest: string, agent: string): string[] => strings(readJson(rec(dest, agent, ".skills-off")));

// ---- Mode: proven from the real launch flags, never from a substring ----
// Splits like a shell: single quotes, double quotes (backslash before " \ $ `), backslash. No expansion.
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      has = true;
      for (i++; i < s.length && s[i] !== "'"; i++) cur += s[i];
    } else if (c === '"') {
      has = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) i++;
        cur += s[i];
      }
    } else if (c === "\\") {
      has = true;
      if (i + 1 < s.length) cur += s[++i];
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// Flags that take a value in the role launch commands. The word after one is a value, never a flag.
const VALUE_FLAGS = new Set([
  "--append-system-prompt", "--append-system-prompt-file", "--settings", "--model", "--effort", "--thinking", "--provider",
  "--exclude-tools", "--mcp-config", "--allowed-tools", "--disallowed-tools", "-e", "--prompt-template",
]);

// `view`: a --skill or --plugin-dir value is under this agent's `<key>.view/`. `plain`: under its link `<key>/`.
// Anything else, or no command: `legacy`. A path of another agent, or a view path in another argument, is no proof.
export function modeFromCommand(cmd: string, dest: string, agent: string): "view" | "plain" | "legacy" {
  const key = agentKey(agent);
  const viewPrefix = `${join(agentsDir(dest), `${key}.view`)}/`;
  const linkPrefix = `${join(agentsDir(dest), key)}/`;
  let words = shellWords(cmd);
  // tmux prints a one-argument pane command as one double-quoted word: split that word once more.
  if (words.length === 1 && /\s/.test(words[0])) words = shellWords(words[0]);
  let view = false;
  let plain = false;
  for (let i = 0; i < words.length; ) {
    const w = words[i];
    if ((w === "--skill" || w === "--plugin-dir") && i + 1 < words.length) {
      const v = words[i + 1];
      if (v.startsWith(viewPrefix)) view = true;
      else if (v.startsWith(linkPrefix)) plain = true;
      i += 2;
    } else i += VALUE_FLAGS.has(w) ? 2 : 1;
  }
  return view ? "view" : plain ? "plain" : "legacy";
}

// ---- List ----
// The skills of the staged version `versionDir`, in two groups, with the box (`on`) and the state derived only from
// `.skills-applied`: loaded, not_loaded (in the applied inventory and off there) or new (not in the inventory).
export function listIn(dest: string, versionDir: string, agent: string, role: string | null, command: string | null): AgentSkills {
  if (!role) return { role: null, mode: "none", relaunch_needed: false, groups: [] };
  const mode = command === null ? "legacy" : modeFromCommand(command, dest, agent);
  // An id of an older role (a name used again with another role) is ignored here, as launch_in ignores it.
  const inv = inventory(versionDir, role);
  const off = readOff(dest, agent);
  const relaunch_needed = (mode === "legacy" || mode === "plain") && off.some((id) => inv.includes(id));
  const applied = readJson(rec(dest, agent, ".skills-applied"));
  const aSkills = strings(applied?.skills);
  const aOff = strings(applied?.off);
  const group = (name: string, g: string): SkillGroup => ({
    name,
    skills: skillFolders(versionDir, g).map((f) => {
      const id = `${g}/${f}`;
      const state = !aSkills.includes(id) ? "new" : aOff.includes(id) ? "not_loaded" : "loaded";
      return { id, on: !off.includes(id), state };
    }),
  });
  return { role, mode, relaunch_needed, groups: [group(`Role · ${role}`, role), group("Shared", "shared")] };
}

// ---- Store ----
// Unknown id: error, nothing written. Empty list: the file goes. A failed write changes nothing.
export function setOffIn(dest: string, versionDir: string, agent: string, role: string, off: string[]): void {
  const inv = inventory(versionDir, role);
  const bad = off.find((id) => !inv.includes(id));
  if (bad !== undefined) throw new SkillsError(`unknown skill: ${bad}`, 400);
  const ids = [...new Set(off)].sort();
  const path = rec(dest, agent, ".skills-off");
  if (ids.length === 0) rmSync(path, { force: true });
  else writeAtomic(path, JSON.stringify(ids));
}

// ---- Builds ----
function viewGens(dest: string, agent: string): number[] {
  const prefix = `${agentKey(agent)}.view-`;
  try {
    return readdirSync(agentsDir(dest))
      .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
      .map((n) => Number(n.slice(prefix.length)));
  } catch {
    return [];
  }
}

const recordGen = (dest: string, agent: string, suffix: string): number | null => {
  const g = readJson(rec(dest, agent, suffix))?.gen;
  return Number.isInteger(g) && g >= 0 ? g : null;
};

// One more than the highest generation seen in a record or a view folder.
function nextGen(dest: string, agent: string): number {
  const seen = [".skills-prepared", ".skills-published", ".skills-pending", ".skills-applied"].map((s) => recordGen(dest, agent, s)).filter((g): g is number => g !== null);
  const all = [...seen, ...viewGens(dest, agent)];
  return all.length ? Math.max(...all) + 1 : 1;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// `<key>.view-<gen>/<group>/`: a plugin folder per group. `skills/` is a real folder of symlinks to the skills that
// are on (the target goes through the agent link, so a version change reaches the right files). `.claude-plugin`,
// `.gitignore` and `tsconfig.json` are real copies: Claude Code writes into them, and a write through a link would
// change a staged file that every agent of the version shares. Everything else (role.md, hooks, ...) is a link.
export function buildView(dest: string, versionDir: string, agent: string, role: string, gen: number, off: string[]): string {
  const key = agentKey(agent);
  const link = join(agentsDir(dest), key);
  const view = join(agentsDir(dest), `${key}.view-${gen}`);
  try {
    rmSync(view, { recursive: true, force: true });
    for (const group of [role, "shared"]) {
      const src = join(versionDir, group);
      if (!isDir(src)) throw new SkillsError(`${src} is missing in the staged version`, 409);
      const dst = join(view, group);
      mkdirSync(dst, { recursive: true });
      for (const n of readdirSync(src)) {
        if (n === ".DS_Store") continue;
        if (n === "skills") {
          mkdirSync(join(dst, "skills"), { recursive: true });
          for (const f of skillFolders(versionDir, group)) {
            if (off.includes(`${group}/${f}`)) continue;
            symlinkSync(join(link, group, "skills", f), join(dst, "skills", f));
          }
        } else if (n === ".claude-plugin" || n === ".gitignore" || n === "tsconfig.json") {
          cpSync(join(src, n), join(dst, n), { recursive: true, filter: (s) => basename(s) !== ".DS_Store" });
        } else {
          symlinkSync(join(link, group, n), join(dst, n));
        }
      }
    }
  } catch (e) {
    rmSync(view, { recursive: true, force: true });
    throw e;
  }
  return view;
}

// Deletes the builds that no record names, except the one generation below the published one (a lazy read through
// the old path still works for one more generation). Never touches a named build. Runs under the lock.
function cleanupViews(dest: string, agent: string): void {
  const named = [".skills-prepared", ".skills-published", ".skills-pending"].map((s) => recordGen(dest, agent, s)).filter((g): g is number => g !== null);
  const published = recordGen(dest, agent, ".skills-published");
  const gens = viewGens(dest, agent);
  const lower = published === null ? [] : gens.filter((g) => g < published);
  const previous = lower.length ? Math.max(...lower) : null;
  for (const g of gens) {
    if (!named.includes(g) && g !== previous) rmSync(join(agentsDir(dest), `${agentKey(agent)}.view-${g}`), { recursive: true, force: true });
  }
}

// The Reload click: builds the next view from the stored choice and writes `.skills-prepared`. Publishes nothing.
export async function applyIn(dest: string, versionDir: string, agent: string, role: string | null, command: string | null, waitMs?: number): Promise<void> {
  if (!role) throw new SkillsError("the agent has no role", 409);
  const state = listIn(dest, versionDir, agent, role, command);
  if (state.relaunch_needed) throw new SkillsError(`Relaunch ${agent} to apply: it was started without a skill view`, 409);
  let release: () => void;
  try {
    release = await takeLock(dest, agentKey(agent), waitMs, "hub");
  } catch (e) {
    if (e instanceof SkillsLockBusy) throw new SkillsError("the skills lock is busy; try again", 409);
    throw e;
  }
  try {
    const inv = inventory(versionDir, role);
    const off = readOff(dest, agent).filter((id) => inv.includes(id));
    const gen = nextGen(dest, agent);
    const version = basename(versionDir);
    if (state.mode !== "view") {
      // Plain or legacy, and every skill on: the launch flags name the agent link and already load everything, so there
      // is no build. The inventory is still refreshed: a version may have added a skill, and without a new record
      // every Reload would keep the old inventory and show that skill as "new" for good. The hub publishes this
      // record at the next relink (kind "inventory": no view swap).
      writeAtomic(rec(dest, agent, ".skills-prepared"), JSON.stringify({ gen, off: [], skills: inv, kind: "inventory", version }));
      return;
    }
    const view = buildView(dest, versionDir, agent, role, gen, off);
    try {
      writeAtomic(rec(dest, agent, ".skills-prepared"), JSON.stringify({ gen, off, skills: inv, kind: "view", version }));
    } catch (e) {
      rmSync(view, { recursive: true, force: true });
      throw e;
    }
    cleanupViews(dest, agent);
  } finally {
    release();
  }
}
