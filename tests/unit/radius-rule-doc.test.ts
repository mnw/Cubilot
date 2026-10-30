// The [doc] exception of the radius rule: terms do not count in a [doc] title, paths do. Real files, no mocks.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticketRadius } from "../../hub/core/radius-rule";

let dir: string;
let before: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radius-rule-doc-"));
  before = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = dir;
});
afterEach(() => {
  if (before === undefined) delete process.env.CUBILOT_DATA_DIR;
  else process.env.CUBILOT_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});
const config = (text: string) => writeFileSync(join(dir, "config.yml"), text);

describe("ticketRadius", () => {
  test("doc ticket with a term is low", () => {
    expect(ticketRadius("[doc] Describe the launch queue", "State the permission rule.", "A token note")).toEqual({ radius: "low", reasons: [] });
  });
  test("code ticket with a term is high", () => {
    expect(ticketRadius("[code] Describe the launch queue", "State the permission rule.", null).radius).toBe("high");
  });
  test("doc ticket with a path is high", () => {
    expect(ticketRadius("[doc] Describe the launch queue", "Edit hub/core/auth.ts.", null)).toEqual({ radius: "high", reasons: ["hub/core/auth.ts"] });
    expect(ticketRadius("[doc] Notes", "Plain.", "see src-tauri/src/pty.rs").radius).toBe("high");
  });
  test("no prefix keeps today's rule", () => {
    expect(ticketRadius("Describe the launch queue", "Plain.", null).radius).toBe("high");
    expect(ticketRadius("Docs for the [doc] launch", "Plain.", null).radius).toBe("high");
  });
  test("configured terms and paths replace the defaults", () => {
    config("radius_rule:\n  terms: [banana]\n  paths: [src/x.ts]\n");
    expect(ticketRadius("[doc] A banana", "launch", null)).toEqual({ radius: "low", reasons: [] });
    expect(ticketRadius("[code] A banana", "launch", null).reasons).toEqual(["banana"]);
    expect(ticketRadius("[doc] A banana", "edit src/x.ts", null)).toEqual({ radius: "high", reasons: ["src/x.ts"] });
    expect(ticketRadius("[doc] Plain", "hub/core/auth.ts", null).radius).toBe("low");
  });
});
