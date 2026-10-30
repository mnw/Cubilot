// scripts/test-affected.sh and scripts/affected-tests.ts (Part 20 step 2). Each test builds a temp git repo that holds
// copies of both scripts and a stub scripts/test.sh, so no real suite runs and the heavy lock is never taken.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (cwd: string, cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (cwd: string, ...a: string[]) => {
  const r = run(cwd, ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
  expect(r.code).toBe(0);
  return r.out.trim();
};

function repo(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "test-affected-"));
  dirs.push(d);
  const put = (name: string, text: string) => {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), text);
  };
  for (const s of ["test-affected.sh", "affected-tests.ts"]) {
    mkdirSync(join(d, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts", s), join(d, "scripts", s));
  }
  put("scripts/test.sh", '#!/bin/bash\necho "STUB test.sh $*"\n');
  chmodSync(join(d, "scripts/test.sh"), 0o755);
  chmodSync(join(d, "scripts/test-affected.sh"), 0o755);
  for (const [n, t] of Object.entries(files)) put(n, t);
  git(d, "init", "-q");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "base");
  const base = git(d, "rev-parse", "HEAD");
  const change = (name: string, text: string) => {
    put(name, text);
    git(d, "add", "-A");
    git(d, "commit", "-qm", `change ${name}`);
  };
  return { d, base, change };
}

const FILES = {
  "hub/a.ts": "export const a = 1;\n",
  "hub/b.ts": "export const b = 2;\n",
  "hub/index.ts": 'export * from "./a";\n',
  "tests/unit/uses-a.test.ts": 'import { a } from "../../hub/a";\n',
  "tests/unit/uses-b.test.ts": 'import { b } from "../../hub/b";\n',
  "tests/unit/uses-index.test.ts": 'import { a } from "../../hub/index";\n',
  "tests/unit/plain.test.ts": "export {};\n",
  "tests/contract/c.test.ts": "export {};\n",
};
const select = (r: { d: string; base: string }) => {
  const x = run(r.d, ["bun", "scripts/affected-tests.ts", r.base]);
  expect(x.code).toBe(0);
  return x.out.split("\n").filter(Boolean);
};

describe("test-affected", () => {
  test("one hub file changed runs its importers and the contract tests", () => {
    const r = repo(FILES);
    r.change("hub/b.ts", "export const b = 3;\n");
    expect(select(r)).toEqual(["tests/contract/c.test.ts", "tests/unit/uses-b.test.ts"]);
  });

  test("re-export one level", () => {
    const r = repo(FILES);
    r.change("hub/a.ts", "export const a = 9;\n");
    expect(select(r)).toEqual(["tests/contract/c.test.ts", "tests/unit/uses-a.test.ts", "tests/unit/uses-index.test.ts"]);
  });

  test("re-export is followed one level only", () => {
    const r = repo({ ...FILES, "hub/top.ts": 'export * from "./index";\n', "tests/unit/uses-top.test.ts": 'import "../../hub/top";\n' });
    r.change("hub/a.ts", "export const a = 9;\n");
    expect(select(r)).not.toContain("tests/unit/uses-top.test.ts");
  });

  test("changed test file runs", () => {
    const r = repo(FILES);
    r.change("tests/unit/plain.test.ts", "export const x = 1;\n");
    expect(select(r)).toEqual(["tests/contract/c.test.ts", "tests/unit/plain.test.ts"]);
  });

  test("a deleted test file is not selected", () => {
    const r = repo(FILES);
    run(r.d, ["rm", "tests/unit/plain.test.ts"]);
    git(r.d, "add", "-A");
    git(r.d, "commit", "-qm", "rm");
    expect(select(r)).toEqual(["tests/contract/c.test.ts"]);
  });

  test("the script runs the selected files through test.sh", () => {
    const r = repo(FILES);
    r.change("hub/b.ts", "export const b = 3;\n");
    const x = run(r.d, ["bash", "scripts/test-affected.sh", r.base]);
    expect(x.code).toBe(0);
    expect(x.out).toContain("2 test files");
    expect(x.out).toContain("STUB test.sh ./tests/contract/c.test.ts ./tests/unit/uses-b.test.ts");
    expect(x.out).not.toContain("fell back");
  });

  test("empty selection runs the full suite", () => {
    const { tests: _t, ...rest } = { tests: 0, ...FILES };
    const files = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("tests/contract/")));
    const r = repo(files);
    r.change("hub/a.ts", "export const a = 9;\n");
    run(r.d, ["rm", "-r", "tests/unit/uses-a.test.ts", "tests/unit/uses-index.test.ts"]);
    git(r.d, "add", "-A");
    git(r.d, "commit", "-qm", "rm");
    const x = run(r.d, ["bash", "scripts/test-affected.sh", r.base]);
    expect(x.out).toContain("fell back to the full suite");
    expect(x.out).toMatch(/STUB test\.sh\s*$/);
  });

  test("selection error runs the full suite", () => {
    const r = repo(FILES);
    const x = run(r.d, ["bash", "scripts/test-affected.sh", "no-such-commit"]);
    expect(x.out).toContain("fell back to the full suite");
    expect(x.out).toMatch(/STUB test\.sh\s*$/);
  });

  test("no base commit is a usage error", () => {
    const r = repo(FILES);
    expect(run(r.d, ["bash", "scripts/test-affected.sh"]).code).toBe(2);
  });
});
