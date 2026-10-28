// Context pack (context-pack 3.1, 3.2, 3.4, 3.5): what the hub puts in the first message besides the ticket, built with
// code only. No model call, no shell string: every command is an argv array that runs in the stage worktree. A command
// has its own limit (COMMAND_LIMIT_MS) and the commands run one after another, so the worst-case delay of a launch is
// `packCommandCount(role) x COMMAND_LIMIT_MS`. A command that fails or passes its limit marks only its part missing.

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { packDepth } from "./pack-depth";
import type { PackText } from "./first-message";

export const COMMAND_LIMIT_MS = 20_000;
/** graphify `--budget`, in tokens. The output is also cut at 4 bytes per token (the estimate used elsewhere). */
export const GRAPH_BUDGET_TOKENS = 1500;
const GRAPH_QUESTION_MAX = 2000;

export type GraphStatus = "fresh" | "stale" | "missing";
export type CommandResult = { ok: true; stdout: string } | { ok: false; timedOut: boolean };
/** Runs one argv in `cwd` and stops it at `limitMs`. Never throws. A test passes a stub. */
export type Runner = (argv: string[], cwd: string, limitMs: number) => Promise<CommandResult>;

export type PackInput = {
  role: string;
  /** "spec" for a spec-review stage: its depth is not the code Validator's. */
  review?: string | null;
  /** The text the graph query asks: ticket title and criteria, or the request text of a spec stage. */
  question: string;
  worktree: string;
  /** The room's project folder. The room base is the branch that it has out. Without it, the first `git worktree list` entry. */
  projectFolder?: string | null;
  /** Paths that the ticket names (3.3). Only a file inside the worktree reaches ctags; every other path is dropped. */
  files?: string[];
  /** The ctags lookup. Undefined: search PATH and the Homebrew folders. A function lets a test fix the answer (a path, or null for no tool). */
  findCtags?: () => string | null;
  /** Limit of each command in ms. Default COMMAND_LIMIT_MS; a test passes a small one. */
  limitMs?: number;
};

export type Pack = { text: PackText; graphStatus: GraphStatus };

/** Runs one command. The child is killed at the limit and its pipes are not awaited after that (a grandchild may hold them). */
export const runCommand: Runner = async (argv, cwd, limitMs) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return { ok: false, timedOut: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
  });
  const done = (async () => {
    const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    return { out, code };
  })();
  try {
    const r = await Promise.race([done, timeout]);
    if (r === "timeout") {
      try { proc.kill(9); } catch { /* already gone */ }
      done.catch(() => {});
      return { ok: false, timedOut: true };
    }
    return r.code === 0 ? { ok: true, stdout: r.out } : { ok: false, timedOut: false };
  } catch {
    return { ok: false, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** graphify: PATH first, then the per-user install folder. Null when neither has it. */
function findGraphify(): string | null {
  const onPath = Bun.which("graphify", { PATH: process.env.PATH ?? "" });
  if (onPath) return onPath;
  const local = join(homedir(), ".local", "bin", "graphify");
  return existsSync(local) ? local : null;
}

const cutBytes = (s: string, max: number): string =>
  Buffer.byteLength(s, "utf8") <= max ? s : Buffer.from(s, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "");

/** The most commands buildPack runs for a role: the base of the worst-case launch delay is this number x COMMAND_LIMIT_MS. */
export function packCommandCount(role: string, review?: string | null): number {
  const d = packDepth(role, review);
  let n = 0;
  if (d.has("graph")) n += 2; // git log (HEAD time), graphify query
  if (d.has("diffStat") || d.has("changedFiles")) n += 1; // git symbolic-ref (the room base)
  if (d.has("diffStat")) n += 1;
  if (d.has("changedFiles")) n += 1;
  if (d.has("signatures")) n += 1; // one ctags run for all named files (the Serena path is not implemented)
  return n;
}

/** Graph status and query text (3.1, 3.2). `missing` gives no text at all. */
async function graphPart(question: string, worktree: string, run: Runner, limit: number): Promise<{ status: GraphStatus; text?: string }> {
  const graph = join(worktree, "graphify-out", "graph.json");
  const bin = findGraphify();
  if (!bin || !existsSync(graph)) return { status: "missing" };
  // Fresh when the graph is not older than the commit at HEAD. If git cannot say, the graph is not shown as fresh.
  const head = await run(["git", "log", "-1", "--format=%ct", "HEAD"], worktree, limit);
  const headSec = head.ok ? Number(head.stdout.trim()) : NaN;
  const status: GraphStatus = Number.isFinite(headSec) && statSync(graph).mtimeMs / 1000 >= headSec ? "fresh" : "stale";
  const q = question.trim().replace(/^-+/, "").slice(0, GRAPH_QUESTION_MAX);
  const r = await run([bin, "query", q, "--budget", String(GRAPH_BUDGET_TOKENS)], worktree, limit);
  if (!r.ok || !r.stdout.trim()) return { status: "missing" };
  return { status, text: `Graph status: ${status}\n${cutBytes(r.stdout.trim(), GRAPH_BUDGET_TOKENS * 4)}` };
}

const FILES_MAX = 20;
const SIGNATURES_MAX_BYTES = 8 * 1024;
const PATH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|h|cc|cpp|hpp|rb|php|swift|kt|sh|json|md|toml|yaml|yml|html|css)$/;

/** Path-like tokens of a text: contain "/" or end in a known extension. At most FILES_MAX, no duplicates. */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s`'"()\[\]<>,;]+/)) {
    const tok = raw.replace(/[.:]+$/, "");
    if (!/^[\w.\-@/]+$/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
    if (tok.includes("/") ? !/\w/.test(tok) : !PATH_EXT.test(tok)) continue;
    out.add(tok);
    if (out.size >= FILES_MAX) break;
  }
  return [...out];
}

/**
 * Path containment (5b). Each named path is resolved with realpath; only a file inside the real worktree is kept.
 * A file that is missing but lies inside the worktree by its text is `missing` (shown as "none"). Every other path
 * (absolute outside, ".." out, symlink to a file or folder outside, a folder) is dropped and never read.
 */
export function containNamed(names: string[], worktree: string): { keep: string[]; missing: string[] } {
  const keep: string[] = [];
  const missing: string[] = [];
  let root: string;
  try { root = realpathSync(worktree); } catch { return { keep, missing }; }
  const inside = (p: string) => p.startsWith(root + sep);
  for (const name of names) {
    const abs = isAbsolute(name) ? resolve(name) : resolve(root, name);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      // Not on disk. Only a path that is inside the worktree by its text counts as a named missing file.
      if (inside(abs)) missing.push(relative(root, abs));
      continue;
    }
    try {
      if (inside(real) && statSync(real).isFile()) keep.push(relative(root, real));
    } catch { /* dropped */ }
  }
  return { keep: [...new Set(keep)], missing: [...new Set(missing)] };
}

/** Universal-ctags: PATH, then the Homebrew folders. The BSD ctags of macOS is found too, but it fails on the options below, so the part is missing. */
function findCtags(): string | null {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].join(":");
  return Bun.which("ctags", { PATH: `${process.env.PATH ?? ""}:${extra}` });
}

const SIGNATURES_MISSING = "Symbol signatures: missing (no Serena interface for the hub, no universal-ctags run)";

/** Signatures (ctags) of the named files (3.3). Undefined: nothing was named. A failing or slow ctags gives the missing line. */
async function signaturesPart(names: string[], worktree: string, run: Runner, limit: number, find: () => string | null): Promise<string | undefined> {
  const contained = containNamed(names, worktree);
  const keep = contained.keep.slice(0, FILES_MAX);
  const missing = contained.missing.slice(0, FILES_MAX);
  if (!keep.length && !missing.length) return undefined;
  const none = missing.map((m) => `${m}: none`);
  if (!keep.length) return ["signatures (ctags)", ...none].join("\n");
  const bin = find();
  if (!bin) return SIGNATURES_MISSING;
  const argv = [bin, "--output-format=json", "--fields=+nS", "-f", "-", ...keep.map((k) => `./${k}`)];
  const r = await run(argv, realpathSync(worktree), limit);
  if (!r.ok) return SIGNATURES_MISSING;
  const byFile = new Map<string, string[]>();
  for (const line of r.stdout.split("\n")) {
    try {
      const t = JSON.parse(line) as { _type?: string; name?: string; path?: string; kind?: string; signature?: string; line?: number };
      if (t._type !== "tag" || typeof t.name !== "string" || typeof t.path !== "string") continue;
      const f = t.path.replace(/^\.\//, "");
      const l = byFile.get(f) ?? [];
      l.push(`  ${t.kind ?? "tag"} ${t.name}${t.signature ?? ""}${t.line ? ` :${t.line}` : ""}`);
      byFile.set(f, l);
    } catch { /* not a tag line */ }
  }
  const body = keep.map((k) => (byFile.get(k)?.length ? `${k}:\n${byFile.get(k)!.join("\n")}` : `${k}: none`));
  return cutBytes(["signatures (ctags)", ...body, ...none].join("\n"), SIGNATURES_MAX_BYTES);
}

/**
 * The room base: the branch that the room's project folder has out. createWorktree branches the ticket from that HEAD
 * (worktrees.ts), and the folder may be a linked worktree, so the first `git worktree list` entry is not always right.
 */
async function roomBase(worktree: string, projectFolder: string | null | undefined, run: Runner, limit: number): Promise<string | null> {
  if (projectFolder) {
    const r = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], projectFolder, limit);
    const b = r.ok ? r.stdout.trim() : "";
    return b && !b.startsWith("-") ? b : null;
  }
  const r = await run(["git", "worktree", "list", "--porcelain"], worktree, limit);
  if (!r.ok) return null;
  const first = r.stdout.split("\n\n")[0] ?? "";
  const m = /^branch refs\/heads\/(.+)$/m.exec(first);
  return m && !m[1].startsWith("-") ? m[1] : null;
}

/**
 * Builds the pack parts that the depth table gives `role`. Never throws; a part that could not be built is absent.
 */
export async function buildPack(i: PackInput, run: Runner = runCommand): Promise<Pack> {
  const depth = packDepth(i.role, i.review);
  const limit = i.limitMs ?? COMMAND_LIMIT_MS;
  const text: PackText = {};
  let graphStatus: GraphStatus = "missing";
  try {
    if (depth.has("graph")) {
      const g = await graphPart(i.question, i.worktree, run, limit);
      graphStatus = g.status;
      if (g.text) text.graph = g.text;
    }
    if (depth.has("signatures") && i.files?.length) {
      const sig = await signaturesPart(i.files, i.worktree, run, limit, i.findCtags ?? findCtags);
      if (sig) text.signatures = sig;
    }
    if (depth.has("diffStat") || depth.has("changedFiles")) {
      const base = await roomBase(i.worktree, i.projectFolder, run, limit);
      if (base) {
        if (depth.has("diffStat")) {
          const r = await run(["git", "diff", "--stat", `${base}...HEAD`], i.worktree, limit);
          if (r.ok && r.stdout.trim()) text.diffStat = r.stdout.trim();
        }
        if (depth.has("changedFiles")) {
          const r = await run(["git", "diff", "--name-only", `${base}...HEAD`], i.worktree, limit);
          if (r.ok && r.stdout.trim()) text.changedFiles = r.stdout.trim();
        }
      }
    }
  } catch (e) {
    console.error("[context-pack] build failed:", e);
  }
  return { text, graphStatus };
}
