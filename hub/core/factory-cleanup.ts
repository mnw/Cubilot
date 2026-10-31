// Factory version cleanup (hub-first-browser group 10: moved from src-tauri/src/factory.rs, the shell has no tmux layer).
// Deletes what no launch can still use. Any failed read deletes nothing.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { agentKey } from "./skills";
import { resolveLocale, tmuxFromEnv, type TmuxEnv } from "./tmux";

export const CLEANUP_MIN_AGE_MS = 10 * 60 * 1000;
const AGENT_RECORD_SUFFIXES = [".applied", ".pending", ".last"];
const VERSION_IN_TEXT = /v-[0-9a-f]{16}/g;

/** Live tmux sessions and the start command of every live pane. */
export type LiveState = { sessions: string[]; panes: string };

export function cleanupVersions(dest: string, live: LiveState | Error, now: number = Date.now()): string[] {
  const fail = (what: string) => [`[factory] cleanup skipped, nothing deleted: ${what}`];
  if (live instanceof Error) return fail(`tmux: ${live.message}`);
  const keys = new Set(live.sessions.map(agentKey));
  const agents = join(dest, "agents");
  const links: { path: string; key: string; target: string }[] = [];
  if (existsSync(agents)) {
    let names: string[];
    try { names = readdirSync(agents); } catch (e) { return fail(`read ${agents}: ${(e as Error).message}`); }
    for (const name of names) {
      // The skill records, the view symlink, its builds and the lock are not agent links.
      if (name.includes(".tmp-") || name.includes(".skills-") || name.includes(".view") || AGENT_RECORD_SUFFIXES.some((x) => name.endsWith(x))) continue;
      const path = join(agents, name);
      try { links.push({ path, key: name, target: basename(readlinkSync(path)) }); }
      catch (e) { return fail(`read link ${path}: ${(e as Error).message}`); }
    }
  }
  const inUse = new Set<string>(live.panes.match(VERSION_IN_TEXT) ?? []);
  try { inUse.add(readFileSync(join(dest, "current"), "utf8").trim()); } catch (e) { return fail(`read current: ${(e as Error).message}`); }
  try { lstatSync(join(dest, "active")); inUse.add(basename(readlinkSync(join(dest, "active")))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return fail(`read link active: ${(e as Error).message}`); }
  const log: string[] = [];
  for (const l of links) {
    // A link younger than the age rule may belong to a spawn whose tmux session does not exist yet.
    let young = true;
    try { young = now - lstatSync(l.path).mtimeMs < CLEANUP_MIN_AGE_MS; } catch { /* unreadable age counts as young */ }
    if (keys.has(l.key) || young) { inUse.add(l.target); continue; }
    try {
      unlinkSync(l.path);
      for (const x of AGENT_RECORD_SUFFIXES) rmSync(join(agents, `${l.key}${x}`), { force: true });
      log.push(`[factory] deleted agent link ${l.key}: its session is gone`);
    } catch { inUse.add(l.target); }
  }
  let entries: string[];
  try { entries = readdirSync(dest); } catch { return fail(`read ${dest}`); }
  for (const name of entries) {
    const p = join(dest, name);
    if (!name.startsWith("v-") || inUse.has(name)) continue;
    try {
      const st = statSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < CLEANUP_MIN_AGE_MS) continue;
      rmSync(p, { recursive: true, force: true });
      log.push(`[factory] deleted unused version ${name}`);
    } catch { /* kept */ }
  }
  return log;
}

/**
 * Ask tmux. No tmux server means nothing is live, and that is known only when the socket file does not exist.
 * Any other failure is an Error, so the cleanup deletes nothing.
 */
export function readLiveState(env: TmuxEnv = process.env): LiveState | Error {
  let o;
  try { o = tmuxFromEnv(env); } catch (e) { return e as Error; }
  const lang = resolveLocale(env);
  const ask = (args: string[]): string | Error => {
    try {
      const r = Bun.spawnSync([o.bin, "-S", o.socket, ...args], { env: { ...env, LANG: lang, LC_ALL: lang } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) return r.stdout.toString();
      return existsSync(o.socket) ? new Error(`tmux ${args[0]} failed: ${r.stderr.toString().trim()}`) : "";
    } catch (e) { return e as Error; }
  };
  const s = ask(["list-sessions", "-F", "#S"]);
  if (s instanceof Error) return s;
  const p = ask(["list-panes", "-a", "-F", "#{pane_start_command}"]);
  if (p instanceof Error) return p;
  return { sessions: s.split("\n").map((l) => l.trim()).filter(Boolean), panes: p };
}

/** Run once at hub start. Needs CUBILOT_FACTORY_DIR; without it the app staged no factory. */
export function runFactoryCleanup(env: TmuxEnv = process.env): string[] {
  const dir = (env.CUBILOT_FACTORY_DIR ?? "").trim();
  if (!dir) return [];
  return cleanupVersions(dir, readLiveState(env));
}
