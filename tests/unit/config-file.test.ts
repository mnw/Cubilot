// The shared reader of config.yml: real files in a temp CUBILOT_DATA_DIR, no mocks.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../../hub/core/config-file";

let dir: string;
let before: string | undefined;
let logs: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-file-"));
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

describe("readConfig", () => {
  test("missing file gives {} and one log line", () => {
    expect(readConfig("t")).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[t] config.yml not read");
  });
  test("bad YAML gives {} and one log line", () => {
    writeFileSync(join(dir, "config.yml"), "a: [1, 2\nb: : :");
    expect(readConfig("t")).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("not valid YAML");
  });
  test("missing key gives a map without it", () => {
    writeFileSync(join(dir, "config.yml"), "other: 1\n");
    const c = readConfig("t");
    expect(c).toEqual({ other: 1 });
    expect("radius_rule" in c).toBe(false);
    expect(logs).toHaveLength(0);
  });
  test("a top level that is not a map gives {}", () => {
    writeFileSync(join(dir, "config.yml"), "- a\n- b\n");
    expect(readConfig("t")).toEqual({});
  });
});
