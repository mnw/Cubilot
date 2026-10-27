// context-pack 2.2: primer = docs/PRIMER.md + Nutshell; cap 2,000 tokens on the file; the Nutshell is never cut; CONTEXT.md is never read.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIMER_CAP_BYTES, PRIMER_CUT_LINE, PRIMER_MISSING_LINE, renderStable } from "../../hub/core/primer";

const project = (primer?: string, context?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "primer-"));
  mkdirSync(join(dir, "docs"));
  if (primer !== undefined) writeFileSync(join(dir, "docs", "PRIMER.md"), primer);
  if (context !== undefined) writeFileSync(join(dir, "CONTEXT.md"), context);
  return dir;
};

describe("renderStable", () => {
  test("a short file and the Nutshell are in full, with no cut line", () => {
    const out = renderStable({ projectFolder: project("# Primer\nShort text.\n"), nutshell: "Nutshell text." });
    expect(out).toContain("# Primer\nShort text.");
    expect(out).toContain("## Nutshell\nNutshell text.");
    expect(out).not.toContain(PRIMER_CUT_LINE);
    expect(out).not.toContain(PRIMER_MISSING_LINE);
  });

  test("a long file is cut at a heading boundary with one cut line; the Nutshell stays whole", () => {
    const section = (n: number) => `## Part ${n}\n${"line of text\n".repeat(60)}`;
    const file = "# Primer\n" + Array.from({ length: 30 }, (_, n) => section(n)).join("");
    const nut = "N".repeat(20_000);
    const out = renderStable({ projectFolder: project(file), nutshell: nut });
    expect(out.split(PRIMER_CUT_LINE).length).toBe(2);
    const kept = out.slice(0, out.indexOf(PRIMER_CUT_LINE));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(PRIMER_CAP_BYTES);
    expect(kept.trimEnd().endsWith("line of text")).toBe(true); // ends on whole section text, no heading without body
    expect(kept).not.toMatch(/## Part \d+\n$/);
    expect(out).toContain(nut);
  });

  test("a long file with no heading is cut at a line", () => {
    const out = renderStable({ projectFolder: project("word ".repeat(50).trim() + "\n" + "abc def\n".repeat(5000)), nutshell: "" });
    const kept = out.slice(0, out.indexOf(PRIMER_CUT_LINE));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(PRIMER_CAP_BYTES);
    expect(kept.trimEnd().endsWith("abc def")).toBe(true);
  });

  test("a file of exactly the cap is not cut", () => {
    const out = renderStable({ projectFolder: project("x".repeat(PRIMER_CAP_BYTES - 1) + "\n"), nutshell: "" });
    expect(out).not.toContain(PRIMER_CUT_LINE);
  });

  test("a multi-byte character at the cap is not split", () => {
    const out = renderStable({ projectFolder: project("é".repeat(PRIMER_CAP_BYTES)), nutshell: "" });
    expect(out).not.toContain("�");
    expect(out).toContain(PRIMER_CUT_LINE);
  });

  test("a missing file gives 'primer missing' and the Nutshell", () => {
    const out = renderStable({ projectFolder: project(), nutshell: "Nutshell text." });
    expect(out).toBe(`${PRIMER_MISSING_LINE}\n\n## Nutshell\nNutshell text.\n\n`);
  });

  test("no project folder gives 'primer missing'", () => {
    expect(renderStable({ projectFolder: null, nutshell: "" })).toBe(`${PRIMER_MISSING_LINE}\n\n`);
  });

  test("CONTEXT.md is never read: a project with CONTEXT.md and no docs/PRIMER.md has none of its text", () => {
    const out = renderStable({ projectFolder: project(undefined, "SECRET-CONTEXT-MARKER architecture notes"), nutshell: "Nutshell." });
    expect(out).not.toContain("SECRET-CONTEXT-MARKER");
    expect(out).toContain(PRIMER_MISSING_LINE);
  });
});
