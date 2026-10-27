import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source role files. src-tauri/src/factory.rs stage_role copies them into the staged tree at app start.
const ROLES = ["worker", "tester", "validator", "writer", "editor", "reviewer"];
const read = (role: string) => readFileSync(join(import.meta.dir, "../../factory", role, `${role}.md`), "utf8");

describe("role prompts: notes rule (context-pack 4.3)", () => {
  for (const role of ROLES) {
    test(`${role}.md tells the agent to put context.notes in every stage result (target 300, limit 400 words)`, () => {
      const text = read(role);
      expect(text).toContain("`context.notes`");
      expect(text).toMatch(/Target 300 words/);
      expect(text).toMatch(/Limit 400 words/);
    });
  }

  test("validator.md repeats the rule in the spec-review verdict step", () => {
    const text = read("validator");
    const spec = text.slice(text.indexOf("## Spec review"), text.indexOf("## Code review flow"));
    expect(spec).toContain("`context.notes`");
    expect(spec).toMatch(/300 words/);
    expect(spec).toMatch(/400 words/);
  });
});
