import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source role files. src-tauri/src/factory.rs stage_role copies the six stage roles into the staged tree at app start.
const ROLES = ["worker", "tester", "validator", "writer", "editor", "reviewer", "orchestrator"];
const read = (role: string) => readFileSync(join(import.meta.dir, "../../factory", role, `${role}.md`), "utf8");

describe("role prompts: find before you read (context-pack 4.1)", () => {
  for (const role of ROLES) {
    test(`${role}.md names graphify query, rg and find_symbol`, () => {
      const text = read(role);
      expect(text).toContain("`graphify query`");
      expect(text).toContain("`rg`");
      expect(text).toContain("`find_symbol`");
    });
  }

  test("orchestrator.md gives the rg fallback and the planning note rule (4.2)", () => {
    const text = read("orchestrator");
    expect(text).toMatch(/When a tool is missing, use `rg`/);
    expect(text).toContain("`planning_note`");
  });
});
