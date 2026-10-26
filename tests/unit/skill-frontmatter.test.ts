// Every factory SKILL.md must parse with the parser Pi uses (yaml, default parse()) and have a string name and description.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const skills = (readdirSync("factory", { recursive: true }) as string[])
  .filter((p) => p.split("/").pop() === "SKILL.md")
  .map((p) => join("factory", p))
  .sort();

describe("factory SKILL.md frontmatter", () => {
  test("finds the skill files", () => {
    expect(skills.length).toBeGreaterThan(0);
  });
  for (const file of skills) {
    test(file, () => {
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
      expect(m).not.toBeNull();
      const fm = parse(m![1]);
      expect(typeof fm?.name).toBe("string");
      expect(typeof fm?.description).toBe("string");
    });
  }
});
