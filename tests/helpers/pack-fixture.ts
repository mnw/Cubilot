// Fixtures for the context-pack tests: a temp git repo with a worktree, and a stub `graphify` on PATH.
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sh = (cwd: string, ...a: string[]): string => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A repo on branch `staging` with one commit, plus a worktree on `ticket/t_1` with one more commit (b.txt). */
export function repoWithBranch(): { project: string; worktree: string } {
  const project = mkdtempSync(join(tmpdir(), "pack-proj-"));
  sh(project, "git", "init", "-q", "-b", "staging");
  sh(project, "git", "config", "user.email", "t@t");
  sh(project, "git", "config", "user.name", "t");
  writeFileSync(join(project, "a.txt"), "1\n");
  sh(project, "git", "add", ".");
  sh(project, "git", "commit", "-qm", "one");
  const worktree = join(mkdtempSync(join(tmpdir(), "pack-wt-")), "wt");
  sh(project, "git", "worktree", "add", "-q", "-b", "ticket/t_1", worktree);
  writeFileSync(join(worktree, "b.txt"), "2\n3\n");
  sh(worktree, "git", "add", ".");
  sh(worktree, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two");
  return { project, worktree };
}

/** A folder with a `graphify` script; returns the folder to put at the front of PATH. */
export function stubGraphify(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-bin-"));
  const f = join(dir, "graphify");
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return dir;
}

/** Writes graphify-out/graph.json in the worktree with the given age in seconds (negative: in the future). */
export function writeGraph(worktree: string, ageSec = 0): string {
  mkdirSync(join(worktree, "graphify-out"), { recursive: true });
  const f = join(worktree, "graphify-out", "graph.json");
  writeFileSync(f, "{}");
  const t = Date.now() / 1000 - ageSec;
  utimesSync(f, t, t);
  return f;
}

/** Runs `fn` with PATH and HOME replaced; HOME points to an empty folder so the per-user graphify is not found. */
export async function withEnv<T>(env: { PATH?: string; HOME?: string }, fn: () => Promise<T>): Promise<T> {
  const old = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (env.PATH !== undefined) process.env.PATH = env.PATH;
  process.env.HOME = env.HOME ?? mkdtempSync(join(tmpdir(), "pack-home-"));
  try {
    return await fn();
  } finally {
    process.env.PATH = old.PATH;
    process.env.HOME = old.HOME;
  }
}
