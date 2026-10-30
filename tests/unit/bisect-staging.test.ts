// scripts/bisect-staging.sh (t_730e7d28c39ddb3e): a temp repo with three merges on staging; the second one adds a failing
// test file. A stub test command replaces scripts/test.sh, so no test run and no heavy lock is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../..", "scripts/bisect-staging.sh");
const IDS = ["t_1111111111111111", "t_2222222222222222", "t_3333333333333333"];

let dir: string;
let repo: string;
let stub: string;
let base: string;
const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "",
  HOME: dir,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  ...extra,
});
function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: env() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function bisect(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: repo,
    env: env({ CUBILOT_BISECT_TEST_CMD: stub, ...extra }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bisect-staging-"));
  repo = join(dir, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "staging", repo], { env: env() });
  // Stub test command: fails (exit 1) when a named file exists and holds FAIL; BISECT_STUB_EXIT forces an exit code.
  stub = join(dir, "stub-test.sh");
  writeFileSync(
    stub,
    '#!/bin/bash\n[ -n "${BISECT_STUB_EXIT:-}" ] && exit "$BISECT_STUB_EXIT"\nfor f in "$@"; do grep -qs FAIL "$f" && exit 1; done\nexit 0\n',
  );
  chmodSync(stub, 0o755);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
  const files = ["one.txt", "tests/fail.test.ts", "three.txt"];
  files.forEach((f, i) => {
    git("checkout", "-q", "-b", `ticket/${IDS[i]}`, "staging");
    Bun.spawnSync(["mkdir", "-p", join(repo, "tests")]);
    writeFileSync(join(repo, f), i === 1 ? "FAIL\n" : "ok\n");
    git("add", ".");
    git("commit", "-q", "-m", `work ${i}`);
    git("checkout", "-q", "staging");
    git("merge", "-q", "--no-ff", `ticket/${IDS[i]}`, "-m", `Merge ticket/${IDS[i]}: change ${i}`);
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("scripts/bisect-staging.sh", () => {
  test("names the merge that added the failing test", () => {
    const r = bisect([base, "tests/fail.test.ts"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const bad = git("rev-parse", "staging~1");
    expect(r.out).toContain(`first bad merge: ${bad} ticket ${IDS[1]}`);
  });

  test("checkout restored after the bisect", () => {
    const head = git("rev-parse", "HEAD");
    bisect([base, "tests/fail.test.ts"]);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("staging");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(Bun.spawnSync(["git", "bisect", "log"], { cwd: repo, env: env() }).exitCode).not.toBe(0);
  });

  test("checkout restored after a failed step", () => {
    const head = git("rev-parse", "HEAD");
    const r = bisect([base, "tests/fail.test.ts"], { BISECT_STUB_EXIT: "99" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("exited 99");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("staging");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(Bun.spawnSync(["git", "bisect", "log"], { cwd: repo, env: env() }).exitCode).not.toBe(0);
  });

  test("a detached start returns to the same commit", () => {
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach");
    try {
      expect(bisect([base, "tests/fail.test.ts"]).code).toBe(0);
      expect(git("rev-parse", "HEAD")).toBe(head);
    } finally {
      git("checkout", "-q", "staging");
    }
  });

  test("usage error and unknown commit exit 2 without a bisect", () => {
    expect(bisect([]).code).toBe(2);
    expect(bisect(["nope-not-a-commit"]).code).toBe(2);
  });
});
