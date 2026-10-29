// The radius rule over a ticket text. Real files in a temp CUBILOT_DATA_DIR, no mocks.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleRadius } from "../../hub/core/radius-rule";

let dir: string;
let before: string | undefined;
let logs: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radius-rule-"));
  before = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = dir;
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  spy.mockRestore();
  if (before === undefined) delete process.env.CUBILOT_DATA_DIR;
  else process.env.CUBILOT_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});
const config = (text: string) => writeFileSync(join(dir, "config.yml"), text);

describe("ruleRadius", () => {
  test("Launch term", () => {
    expect(ruleRadius("the launch queue refuses a stage")).toEqual({ radius: "high", reasons: ["launch"] });
  });
  test("No term", () => {
    expect(ruleRadius("ui/features/emoji.js")).toEqual({ radius: "low", reasons: [] });
  });
  test("relaunch does not match launch", () => {
    expect(ruleRadius("the app can relaunch quickly")).toEqual({ radius: "low", reasons: [] });
  });
  test("a term matches without case and a multi-word term matches", () => {
    expect(ruleRadius("LAUNCH and Data Loss").reasons).toEqual(["launch", "data loss"]);
  });
  test("a path matches as a substring", () => {
    expect(ruleRadius("edit hub/core/worktrees.ts now")).toEqual({ radius: "high", reasons: ["hub/core/worktrees.ts"] });
  });
  test("Malformed block", () => {
    config("radius_rule: nonsense\n");
    expect(ruleRadius("the launch queue").radius).toBe("high");
    expect(logs.some((l) => l.includes("radius_rule is not a map"))).toBe(true);
  });
  test("terms that are not a list fall back to the defaults", () => {
    config("radius_rule:\n  terms: launch\n");
    expect(ruleRadius("the launch queue").radius).toBe("high");
    expect(logs.some((l) => l.includes("lists of strings"))).toBe(true);
  });
  test("a configured block replaces the default terms", () => {
    config("radius_rule:\n  terms: [banana]\n  paths: [src/x.ts]\n");
    expect(ruleRadius("launch")).toEqual({ radius: "low", reasons: [] });
    expect(ruleRadius("a Banana in src/x.ts")).toEqual({ radius: "high", reasons: ["banana", "src/x.ts"] });
  });
});
