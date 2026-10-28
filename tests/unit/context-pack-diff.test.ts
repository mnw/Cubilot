// context-pack 3.4: diff stat and changed files against the room base (the branch the main checkout has out).
import { describe, expect, test } from "bun:test";
import { buildPack } from "../../hub/core/context-pack";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoWithBranch, sh } from "../helpers/pack-fixture";

describe("diff part of the pack (3.4)", () => {
  test("validator: diff stat and changed files of the one commit on the branch", async () => {
    const { worktree } = repoWithBranch();
    const p = await buildPack({ role: "validator", question: "q", worktree });
    expect(p.text.diffStat).toContain("b.txt | 2 ++");
    expect(p.text.diffStat).toContain("1 file changed, 2 insertions(+)");
    expect(p.text.changedFiles).toBe("b.txt");
    expect(p.text.graph).toBeUndefined();
  });

  test("tester: changed files only", async () => {
    const { worktree } = repoWithBranch();
    const p = await buildPack({ role: "tester", question: "q", worktree });
    expect(p.text).toEqual({ changedFiles: "b.txt" });
  });

  test("worker and editor get no diff", async () => {
    const { worktree } = repoWithBranch();
    for (const role of ["worker", "editor"]) expect((await buildPack({ role, question: "q", worktree })).text.diffStat).toBeUndefined();
  });

  test("no commit on the branch: no diff text, no placeholder", async () => {
    const { project } = repoWithBranch();
    const { worktree } = { worktree: project };
    const p = await buildPack({ role: "validator", question: "q", worktree });
    expect(p.text).toEqual({});
  });

  test("a detached worktree at the branch tip (Tester, Validator) sees the same diff", async () => {
    const { project, worktree } = repoWithBranch();
    const sha = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"]).stdout.toString().trim();
    const det = worktree + "-det";
    Bun.spawnSync(["git", "-C", project, "worktree", "add", "-q", "--detach", det, sha]);
    const p = await buildPack({ role: "validator", question: "q", worktree: det });
    expect(p.text.changedFiles).toBe("b.txt");
  });

  test("project folder is a linked worktree on staging, main worktree on main: base is staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "pack-room-"));
    const main = join(root, "main");
    sh(root, "git", "init", "-q", "-b", "main", main);
    sh(main, "git", "config", "user.email", "t@t");
    sh(main, "git", "config", "user.name", "t");
    writeFileSync(join(main, "a.txt"), "1\n");
    sh(main, "git", "add", ".");
    sh(main, "git", "commit", "-qm", "one");
    const staging = join(root, "staging");
    sh(main, "git", "worktree", "add", "-q", "-b", "staging", staging);
    writeFileSync(join(staging, "staging-base.txt"), "s\n");
    sh(staging, "git", "add", ".");
    sh(staging, "git", "commit", "-qm", "staging only");
    const wt = join(root, "wt");
    sh(staging, "git", "worktree", "add", "-q", "-b", "ticket/t_2", wt);
    writeFileSync(join(wt, "ticket.txt"), "t\n");
    sh(wt, "git", "add", ".");
    sh(wt, "git", "commit", "-qm", "ticket");
    const p = await buildPack({ role: "tester", question: "q", worktree: wt, projectFolder: staging });
    expect(p.text.changedFiles).toBe("ticket.txt");
  });
});
