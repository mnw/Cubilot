// default_model in config.yml: the model a new agent starts with, per harness. Real files in a temp CUBILOT_DATA_DIR.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultModels } from "../../hub/core/default-model";

let dir: string;
let before: string | undefined;
let logs: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "default-model-"));
  before = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = dir;
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => {
  spy.mockRestore();
  if (before === undefined) delete process.env.CUBILOT_DATA_DIR;
  else process.env.CUBILOT_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});
const config = (text: string) => writeFileSync(join(dir, "config.yml"), text);
const own = () => logs.filter((l) => l.startsWith("[default-model]"));

describe("defaultModels", () => {
  test("valid: a model for each known harness", () => {
    config("default_model:\n  claude: opus\n  pi: some-model\n");
    expect(defaultModels()).toEqual({ claude: "opus", pi: "some-model" });
    expect(own()).toEqual([]);
  });

  test("one harness only", () => {
    config("default_model:\n  pi: m\n");
    expect(defaultModels()).toEqual({ pi: "m" });
  });

  test("a value is trimmed and an empty string counts as not set", () => {
    config("default_model:\n  claude: '  opus  '\n  pi: ''\n");
    expect(defaultModels()).toEqual({ claude: "opus" });
    expect(own()).toEqual([]);
  });

  test("missing key gives {} and no default_model log line", () => {
    config("theme: default\n");
    expect(defaultModels()).toEqual({});
    expect(own()).toEqual([]);
  });

  test("missing file gives {}", () => {
    expect(defaultModels()).toEqual({});
  });

  test("default_model that is not a map gives {} and one log line", () => {
    config("default_model: opus\n");
    expect(defaultModels()).toEqual({});
    expect(own()).toHaveLength(1);
  });

  test("a value that is not a string is ignored with one log line; the other harness stays", () => {
    config("default_model:\n  claude: 5\n  pi: m\n");
    expect(defaultModels()).toEqual({ pi: "m" });
    expect(own()).toHaveLength(1);
    expect(own()[0]).toContain("claude");
  });

  test("an unknown harness key is ignored with one log line", () => {
    config("default_model:\n  claude: opus\n  gemini: x\n");
    expect(defaultModels()).toEqual({ claude: "opus" });
    expect(own()).toHaveLength(1);
    expect(own()[0]).toContain("gemini");
  });

  test("an edit applies at the next read", () => {
    config("default_model:\n  claude: opus\n");
    expect(defaultModels()).toEqual({ claude: "opus" });
    config("default_model:\n  claude: sonnet\n");
    expect(defaultModels()).toEqual({ claude: "sonnet" });
  });

  test("stage launches do not read it: role_models stays the stage source", () => {
    expect(readFileSync(join(import.meta.dir, "../../hub/kinds/stage.ts"), "utf8")).not.toContain("default-model");
  });
});
