import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source role files. src-tauri/src/factory.rs stage_role copies them into the staged tree at app start.
const read = (role: string) => readFileSync(join(import.meta.dir, `../../factory/${role}/${role}.md`), "utf8");

const sentences = (text: string) => text.split(/(?<=[.:])\s+|\n/).filter((s) => s.trim());

describe("role files: test-run split", () => {
  test("(a) worker.md: targeted tests, no ./scripts/test.sh run, no split across testers", () => {
    const text = read("worker");
    expect(text).toContain("targeted tests");
    expect(text).toContain("Never run `./scripts/test.sh`");
    expect(text).not.toMatch(/(?<!never )run `?\.\/scripts\/test\.sh/i);
    const splits = sentences(text).filter((s) => /split/i.test(s));
    expect(splits.every((s) => /Do not split/.test(s))).toBe(true);
    expect(text).not.toContain("For a large run");
  });

  test("(b) tester.md: full suite runs once, never splits, mutation-only exception", () => {
    const text = read("tester");
    expect(text).toMatch(/`\.\/scripts\/test\.sh` once for each handoff/);
    expect(text).toMatch(/full suite never splits/);
    expect(text).toMatch(/mutation-only handoff/);
    expect(text).toMatch(/Do not run `\.\/scripts\/test\.sh`/);
  });

  test("(e) tester.md: test-affected.sh for low tickets, ./scripts/test.sh for high, the result names the run", () => {
    const text = read("tester");
    expect(text).toMatch(/Ticket radius `low`: run `\.\/scripts\/test-affected\.sh <base>`/);
    expect(text).toMatch(/Ticket radius `high`: run `\.\/scripts\/test\.sh`/);
    expect(text).toContain("`full_suite: false`");
    expect(text).toContain("`tests_run:");
  });

  test("(c) validator.md: never reruns the full suite, a doubted rerun names its reason", () => {
    const text = read("validator");
    expect(text).toMatch(/Never rerun the full suite/);
    expect(text).toMatch(/rerun only a test you doubt/i);
    expect(text).toMatch(/name the reason/i);
  });

  test("(d) orchestrator.md: names the staging-suite log directory", () => {
    const text = read("orchestrator");
    expect(text).toContain("~/Library/Logs/Cubilot/staging-suite/");
    expect(text).toContain("Worker: targeted tests");
  });
});
