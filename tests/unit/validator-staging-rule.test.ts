import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source role file. src-tauri/src/factory.rs stage_role copies it into the staged tree at app start.
const text = readFileSync(join(import.meta.dir, "../../factory/validator/validator.md"), "utf8");

// The section runs from its heading to the next heading of the same or higher level.
function section(heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, "") === heading);
  if (start < 0) return "";
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const tree = section("Decision tree: blocking or suggestion");

describe("validator.md: staging baseline rule", () => {
  test("(a) the tree has the staging rule sentence, before question 2", () => {
    const rule =
      "Before a test failure blocks, check the same test on staging without the ticket. If it fails there too, it is a staging issue: name it as a suggestion, not a blocking finding.";
    const at = tree.indexOf(rule);
    expect(at).toBeGreaterThan(-1);
    const q2 = tree.indexOf("\n2. Does an acceptance criterion fail?");
    expect(q2).toBeGreaterThan(-1);
    expect(at).toBeLessThan(q2);
  });

  test("(b) the tree names git merge-base and the staging-suite log path", () => {
    expect(tree).toContain("git merge-base");
    expect(tree).toContain("~/Library/Logs/Cubilot/staging-suite/");
  });

  test("(c) with no log for B the failure stays blocking", () => {
    expect(tree).toContain("no staging log for");
    expect(tree).toMatch(/No log for B[^\n]*stays blocking/);
  });

  test("(d) a test that passes in the log for B and fails with the ticket stays blocking", () => {
    expect(tree).toMatch(/passes in the log for B and fails with the ticket[^\n]*stays blocking/);
  });
});
