// Git worktrees for stage sessions (stage-sessions 4.5, design decision 8). The hub makes them before it queues a
// launch; the shell never runs git. Worker and Writer sessions use the branch `ticket/<id>` and reuse its worktree.
// Every other role gets a temporary worktree, detached at a commit, that is removed when the stage ends for good.

import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorktreeRequest = {
  /** The room's project folder (a git repository). */
  project: string;
  room: string;
  ticketId: string;
  session: string;
  role: string;
  /** From the handoff context; else the head of `ticket/<ticketId>` when that branch exists, else HEAD. Used by the temporary (detached) roles only. */
  commit?: string | null;
};

export type Worktree = { path: string; branch: string | null; temporary: boolean };

const BRANCH_ROLES = new Set(["worker", "writer"]);
/** Validator and Reviewer read the tree and never change it (stage-sessions 4.4). */
export const READ_ONLY_ROLES = new Set(["validator", "reviewer"]);

// chmod over a tree. Symlinks are skipped (chmod would follow them out of the tree). The `.git` entry at the root is
// left alone: git reads it, and the real git data lives in the project's own .git.
function walk(dir: string, apply: (p: string, mode: number) => void, root = true): void {
  for (const name of readdirSync(dir)) {
    if (root && name === ".git") continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, apply, false);
    apply(p, st.mode);
  }
}

// Every ordinary file and folder of the tree (root included), not `.git` at the root and not symlinks.
function entries(path: string): string[] {
  const out = [path];
  walk(path, (p) => out.push(p));
  return out;
}

/** Entries of the tree the current user can still write: access W_OK asks the system, so it counts ACLs too. */
export function findWritable(path: string): string[] {
  return entries(path).filter((p) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * `chmod -R a-w` on the work tree, then the same for macOS ACLs: a hook or a filesystem default can add a write ACL
 * that chmod a-w does not remove, so `chmod -N` strips them first. The launch then asks the system for the effective
 * write access of EVERY entry (access W_OK, which includes ACLs) and refuses the tree if one still allows a write.
 */
function makeReadOnly(path: string, writableCheck: (path: string) => string[] = findWritable): void {
  const all = entries(path);
  // ACLs first (the mode change comes after, so a failed -N cannot hide behind it). A failure here is not final:
  // the check below decides. chmod -N takes many paths, so it runs in batches.
  for (let i = 0; i < all.length; i += 200) {
    Bun.spawnSync(["chmod", "-N", ...all.slice(i, i + 200)], { stdout: "pipe", stderr: "pipe" });
  }
  walk(path, (p, mode) => chmodSync(p, mode & ~0o222));
  chmodSync(path, lstatSync(path).mode & ~0o222);
  const writable = writableCheck(path);
  if (writable.length > 0) throw new Error(`worktree ${path} is still writable after chmod: ${writable.slice(0, 3).join(", ")}`);
}

/** The reverse, so the tree can be deleted. Children are made writable after their directory. */
function makeWritable(path: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
  chmodSync(path, lstatSync(path).mode | 0o200);
  const open = (dir: string, root: boolean) => {
    for (const name of readdirSync(dir)) {
      if (root && name === ".git") continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      chmodSync(p, st.mode | 0o200);
      if (st.isDirectory()) open(p, false);
    }
  };
  open(path, true);
}

export function worktreesRoot(): string {
  return join(process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot"), "worktrees");
}

// A room label or id as one safe path segment.
const segment = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

function git(project: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
  return r.stdout.toString();
}

// The worktree path that has `branch` checked out, if any.
function worktreeOfBranch(project: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of git(project, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** `writableCheck` defaults to the real access W_OK scan; a test passes a stub to reach the refusal path. */
export function createWorktree(req: WorktreeRequest, root: string = worktreesRoot(), writableCheck?: (path: string) => string[]): Worktree {
  if (!existsSync(req.project)) throw new Error(`project folder does not exist: ${req.project}`);
  git(req.project, ["rev-parse", "--git-dir"]); // not a repository: throws

  if (BRANCH_ROLES.has(req.role)) {
    const branch = `ticket/${req.ticketId}`;
    const existing = worktreeOfBranch(req.project, branch);
    if (existing && existsSync(existing)) return { path: existing, branch, temporary: false };
    const path = join(root, segment(req.room), segment(req.ticketId), segment(req.session));
    mkdirSync(join(path, ".."), { recursive: true });
    git(req.project, ["worktree", "prune"]);
    const hasBranch = Bun.spawnSync(["git", "-C", req.project, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
    // ponytail: the room base is the project's current HEAD; a named base branch can replace it when rooms get one.
    git(req.project, hasBranch ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path]);
    return { path, branch, temporary: false };
  }

  const ticketBranch = `refs/heads/ticket/${req.ticketId}`;
  const hasTicketBranch = Bun.spawnSync(["git", "-C", req.project, "show-ref", "--verify", "--quiet", ticketBranch]).exitCode === 0;
  const commit = req.commit?.trim() || (hasTicketBranch ? ticketBranch : "HEAD");
  if (commit.startsWith("-")) throw new Error(`invalid commit: ${commit}`);
  const sha = git(req.project, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  const path = join(root, segment(req.room), segment(req.ticketId), segment(req.session));
  if (existsSync(path)) removeWorktree(req.project, path); // a retry of the same session name
  mkdirSync(join(path, ".."), { recursive: true });
  git(req.project, ["worktree", "add", "--detach", path, sha]);
  if (READ_ONLY_ROLES.has(req.role)) {
    try {
      makeReadOnly(path, writableCheck);
    } catch (e) {
      removeWorktree(req.project, path);
      throw e;
    }
  }
  return { path, branch: null, temporary: true };
}

/** Removes a temporary worktree. Safe to call twice. */
export function removeWorktree(project: string, path: string): void {
  // A read-only tree cannot be deleted: its directories must be writable first.
  try { makeWritable(path); } catch { /* the remove below reports what is left */ }
  Bun.spawnSync(["git", "-C", project, "worktree", "remove", "--force", path], { stdout: "pipe", stderr: "pipe" });
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  Bun.spawnSync(["git", "-C", project, "worktree", "prune"], { stdout: "pipe", stderr: "pipe" });
}
