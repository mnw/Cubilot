import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source role file of the Reviewer (request r-2026-10-29-writing-chain-2, ste gate).
const text = readFileSync(join(import.meta.dir, "../../factory/reviewer/reviewer.md"), "utf8");
const flow = text.slice(text.indexOf("## Flow"), text.indexOf("## Decision tree"));
const step1 = flow.slice(flow.indexOf("1. Lint"), flow.indexOf("2. Check the draft"));

describe("reviewer.md: ste gate", () => {
  test("lint step before the review, lint FAIL to_role editor", () => {
    expect(flow.indexOf("1. Lint the draft BEFORE the review")).toBeGreaterThanOrEqual(0);
    expect(flow.indexOf("1. Lint")).toBeLessThan(flow.indexOf("2. Check the draft"));
    expect(flow).toContain('`to_role: "editor"`');
    expect(flow).toContain('gate: "ste-lint"');
    expect(step1).not.toMatch(/decline_handoff/);
  });

  test("two lint runs: --disable must exit 0, --json hits only at listed lines", () => {
    expect(step1).toMatch(/Run 1: `<lint> --disable <the listed rules, comma separated> <context\.path>`/);
    expect(step1).toMatch(/Run 1:[^\n]*\n?[^\n]*It must exit 0/);
    expect(step1).toMatch(/Run 2: `<lint> --json <context\.path>` without `--disable`/);
    expect(step1).toMatch(/hit of a listed rule must be at a listed line/);
  });

  test("the reviewer judges each ste_disable reason", () => {
    expect(step1).toMatch(/Judge each `ste_disable` reason/);
    expect(step1).toMatch(/reason that does not hold is a finding/);
  });
});
