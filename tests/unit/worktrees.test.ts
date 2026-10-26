import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, findWritable, removeWorktree } from "../../hub/core/worktrees";

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let dir: string, repo: string, root: string, first: string, second: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wt-"));
  repo = join(dir, "repo");
  root = join(dir, "worktrees");
  sh(dir, "git", "init", "-q", "-b", "main", repo);
  sh(repo, "git", "config", "user.email", "t@t");
  sh(repo, "git", "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-qm", "one");
  first = sh(repo, "git", "rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "2");
  sh(repo, "git", "commit", "-qam", "two");
  second = sh(repo, "git", "rev-parse", "HEAD");
});
// A read-only worktree cannot be deleted until it is writable again.
afterEach(() => {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
});

const req = (o: Partial<Parameters<typeof createWorktree>[0]> = {}) => ({ project: repo, room: "cubilot", ticketId: "t_1", session: "worker-1", role: "worker", ...o });

describe("worktrees (4.5)", () => {
  test("a worker gets the branch ticket/<id>, created from HEAD, and a later session reuses it", () => {
    const w = createWorktree(req(), root);
    expect(w).toMatchObject({ branch: "ticket/t_1", temporary: false });
    expect(sh(w.path, "git", "branch", "--show-current")).toBe("ticket/t_1");
    expect(sh(w.path, "git", "rev-parse", "HEAD")).toBe(second);
    const again = createWorktree(req({ session: "worker-2" }), root);
    expect(realpathSync(again.path)).toBe(realpathSync(w.path));
  });

  test("an existing branch is checked out again after its worktree was removed", () => {
    const w = createWorktree(req(), root);
    writeFileSync(join(w.path, "b.txt"), "x");
    sh(w.path, "git", "add", ".");
    sh(w.path, "git", "commit", "-qm", "work");
    const head = sh(w.path, "git", "rev-parse", "HEAD");
    removeWorktree(repo, w.path);
    const back = createWorktree(req({ session: "worker-3" }), root);
    expect(sh(back.path, "git", "rev-parse", "HEAD")).toBe(head);
  });

  test("a tester gets a detached worktree at the named commit, and it is gone after removal", () => {
    const w = createWorktree(req({ role: "tester", session: "tester-1", commit: first }), root);
    expect(w).toMatchObject({ branch: null, temporary: true });
    expect(sh(w.path, "git", "rev-parse", "HEAD")).toBe(first);
    expect(sh(w.path, "git", "branch", "--show-current")).toBe("");
    removeWorktree(repo, w.path);
    expect(existsSync(w.path)).toBe(false);
    expect(sh(repo, "git", "worktree", "list")).not.toContain("tester-1");
    removeWorktree(repo, w.path); // twice is fine
  });

  test("without a commit the detached worktree is at HEAD; a retry of the same session name works", () => {
    const w = createWorktree(req({ role: "validator", session: "validator-1" }), root);
    expect(sh(w.path, "git", "rev-parse", "HEAD")).toBe(second);
    expect(createWorktree(req({ role: "validator", session: "validator-1", commit: first }), root).path).toBe(w.path);
    expect(sh(w.path, "git", "rev-parse", "HEAD")).toBe(first);
  });

  test("without a commit a temporary role starts at the head of ticket/<id> when that branch exists, else at HEAD; a named commit wins", () => {
    const w = createWorktree(req(), root); // makes ticket/t_1 at HEAD (second)
    writeFileSync(join(w.path, "b.txt"), "x");
    sh(w.path, "git", "add", ".");
    sh(w.path, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "on the ticket branch");
    const head = sh(w.path, "git", "rev-parse", "HEAD");
    expect(head).not.toBe(second);
    for (const role of ["tester", "validator", "editor", "reviewer"]) {
      expect(sh(createWorktree(req({ role, session: `${role}-1` }), root).path, "git", "rev-parse", "HEAD")).toBe(head);
    }
    expect(sh(createWorktree(req({ role: "tester", session: "tester-2", commit: first }), root).path, "git", "rev-parse", "HEAD")).toBe(first);
    expect(sh(createWorktree(req({ role: "tester", session: "tester-3", ticketId: "t_none" }), root).path, "git", "rev-parse", "HEAD")).toBe(second);
  });

  test("a bad commit, an option-like commit, a missing folder and a non-repository are errors", () => {
    expect(() => createWorktree(req({ role: "tester", commit: "nope" }), root)).toThrow();
    expect(() => createWorktree(req({ role: "tester", commit: "--output=x" }), root)).toThrow(/invalid commit/);
    expect(() => createWorktree(req({ project: join(dir, "missing") }), root)).toThrow(/does not exist/);
    expect(() => createWorktree(req({ project: dir }), root)).toThrow();
  });

  // 4.4: Validator and Reviewer read the tree; nothing in it can be written, and git still reads it.
  test.each(["validator", "reviewer"])("a %s worktree is read-only; git status and git diff still run; removal works", (role) => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "b.txt"), "x");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "sub");
    const w = createWorktree(req({ role, session: `${role}-1` }), root);
    // writes fail: a file, a new file at the root, a new file in a subfolder, a delete
    expect(() => writeFileSync(join(w.path, "a.txt"), "changed")).toThrow();
    expect(() => writeFileSync(join(w.path, "new.txt"), "x")).toThrow();
    expect(() => writeFileSync(join(w.path, "sub", "new.txt"), "x")).toThrow();
    expect(() => rmSync(join(w.path, "sub", "b.txt"))).toThrow();
    // reads and git work
    expect(sh(w.path, "git", "status", "--porcelain")).toBe("");
    expect(sh(w.path, "git", "diff")).toBe("");
    expect(sh(w.path, "git", "log", "--oneline", "-1")).toContain("sub");
    expect(sh(w.path, "cat", "a.txt")).toBe("2");
    // the tree is deleted although it is read-only, and a retry of the same name works
    expect(() => createWorktree(req({ role, session: `${role}-1` }), root)).not.toThrow();
    removeWorktree(repo, w.path);
    expect(existsSync(w.path)).toBe(false);
  });

  test("a symlink in the tree is not followed by the chmod; the other roles stay writable", () => {
    symlinkSync(join(dir, "outside"), join(repo, "link"));
    writeFileSync(join(dir, "outside"), "o");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "link");
    const v = createWorktree(req({ role: "validator", session: "validator-1" }), root);
    expect(() => writeFileSync(join(dir, "outside"), "still writable")).not.toThrow();
    expect(v.temporary).toBe(true);
    const t = createWorktree(req({ role: "tester", session: "tester-1" }), root);
    expect(() => writeFileSync(join(t.path, "a.txt"), "ok")).not.toThrow();
  });

  // 4.4 review: a write ACL survives chmod a-w (a checkout hook can add one). It must be removed, and the check
  // must ask the system for the effective access, not read the mode bits.
  test("a write ACL added by a checkout hook is removed from a read-only worktree", () => {
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nchmod +a "${process.env.USER} allow write,delete,append" a.txt\n`, { mode: 0o755 });
    const w = createWorktree(req({ role: "validator", session: "validator-1" }), root);
    expect(sh(w.path, "ls", "-le", "a.txt")).not.toContain("allow"); // the ACL is gone
    expect(() => writeFileSync(join(w.path, "a.txt"), "acl write")).toThrow();
    expect(findWritable(w.path)).toEqual([]);
  });

  test("findWritable lists every writable entry, including one made writable by an ACL, and none in a read-only tree", () => {
    const t = createWorktree(req({ role: "tester", session: "tester-1" }), root);
    const all = findWritable(t.path);
    expect(all).toContain(t.path);
    expect(all.some((p) => p.endsWith("a.txt"))).toBe(true);
    // a mode-read-only file with a write ACL is still found
    const f = join(t.path, "a.txt");
    Bun.spawnSync(["chmod", "a-w", f]);
    expect(findWritable(t.path)).not.toContain(f);
    Bun.spawnSync(["chmod", "+a", `${process.env.USER} allow write`, f]);
    expect(findWritable(t.path)).toContain(f);
    Bun.spawnSync(["chmod", "-N", f]);
    expect(findWritable(t.path)).not.toContain(f);
  });

  // 4.4 review: the refusal path. A check that reports one entry as writable makes the launch fail and removes the tree.
  test("a read-only role is refused when an entry stays writable, and no worktree is left behind", () => {
    const stub = (p: string) => [join(p, "a.txt")];
    expect(() => createWorktree(req({ role: "validator", session: "validator-1" }), root, stub)).toThrow(/still writable.*a\.txt/);
    expect(existsSync(join(root, "cubilot", "t_1", "validator-1"))).toBe(false);
    expect(sh(repo, "git", "worktree", "list")).not.toContain("validator-1");
    // the roles that are not read-only never ask the check
    expect(() => createWorktree(req({ role: "tester", session: "tester-1" }), root, stub)).not.toThrow();
  });
});
