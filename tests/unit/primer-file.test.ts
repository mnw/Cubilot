// context-pack 2.4: docs/PRIMER.md exists and stays within the 2,000-token cap (ceil(bytes / 4)).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMER_CAP_BYTES } from "../../hub/core/primer";

const file = join(import.meta.dir, "../../docs/PRIMER.md");

describe("docs/PRIMER.md", () => {
  test("exists", () => {
    expect(existsSync(file)).toBe(true);
  });

  test("ceil(bytes / 4) is at most 2,000", () => {
    const bytes = readFileSync(file).byteLength;
    expect(Math.ceil(bytes / 4)).toBeLessThanOrEqual(2000);
    expect(bytes).toBeLessThanOrEqual(PRIMER_CAP_BYTES);
  });
});
