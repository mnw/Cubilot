// The harness of a stage launch is the role's own (stage-sessions 4.6, 4.6b).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleHarness } from "../../hub/core/role-harness";

const ROLES = ["worker", "tester", "validator", "reviewer", "editor", "writer"];

describe("roleHarness", () => {
  test("repo roles (no app): validator and reviewer are pi, the others claude", () => {
    expect(ROLES.map((r) => roleHarness(r, undefined, undefined))).toEqual(["claude", "claude", "pi", "pi", "claude", "claude"]);
  });

  test("the REAL staged layout: stage the roles as the app does, then read them", () => {
    // Stage with the Rust code itself (cargo test stages the real factory tree and checks the same files); here the
    // staged tree is made by the cargo test helper through the real `stage_factory` in a temp folder.
    const out = mkdtempSync(join(tmpdir(), "stage-real-"));
    const r = Bun.spawnSync(["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "stage_for_hub_test", "--", "--nocapture"], {
      env: { ...process.env, CUBILOT_TEST_STAGE_OUT: out },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const version = Bun.spawnSync(["ls", out]).stdout.toString().trim().split("\n")[0];
    expect(version).toBeTruthy();
    expect(ROLES.map((role) => roleHarness(role, out, version))).toEqual(["claude", "claude", "pi", "pi", "claude", "claude"]);
  }, 180_000);

  test("a staged file wins; a missing file or a path-like role gives claude", () => {
    const dir = mkdtempSync(join(tmpdir(), "fac-"));
    mkdirSync(join(dir, "v1", "tester"), { recursive: true });
    writeFileSync(join(dir, "v1", "tester", "harness"), "pi\n");
    expect(roleHarness("tester", dir, "v1")).toBe("pi");
    expect(roleHarness("worker", dir, "v1")).toBe("claude");
    expect(roleHarness("../tester", dir, "v1")).toBe("claude");
  });
});
