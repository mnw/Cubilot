// New factory room (task 9.6): the form check and the launch it builds, harness and grid choice included.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/terminal/model-grid.js", "utf8"))(win);
new Function("window", readFileSync("ui/terminal/factory-room.js", "utf8"))(win);
const { buildFactoryRoom, terminalNameError } = win.__CUBILOT_TERM__.factoryRoom;
const g = win.__CUBILOT_TERM__.modelGrid;

const base = { room: "r1", cwd: "/p", workers: "2", testers: "1" };

describe("buildFactoryRoom harness and model", () => {
  test("default: Claude, the role's own harness, no model sent", () => {
    const r = buildFactoryRoom({ ...base, roleHarness: "claude" }, []);
    expect(r.launch).toEqual({ agent: "orchestrator", cwd: "/p", room: "r1", role: "orchestrator", harness: "claude", model: null, provider: null, effort: null });
    expect(r.limits).toEqual({ workers: 2, testers: 1 });
  });
  test("an effort on the role's own harness is passed", () => {
    const r = buildFactoryRoom({ ...base, roleHarness: "claude", choice: { model: null, provider: null, effort: "max" } }, []);
    expect(r.launch.effort).toBe("max");
    expect(r.launch.model).toBeNull();
  });
  test("Pi without a chosen model is an error; with one the model, provider and effort are passed", () => {
    expect(buildFactoryRoom({ ...base, roleHarness: "claude", harness: "pi" }, []).error).toMatch(/Pick a model for pi/);
    const r = buildFactoryRoom({ ...base, roleHarness: "claude", harness: "pi", choice: { model: "gpt-5.6-sol", provider: "openai-codex", effort: "high" } }, []);
    expect(r.launch).toMatchObject({ harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", effort: "high" });
  });
  test("an unknown harness is an error", () => {
    expect(buildFactoryRoom({ ...base, harness: "bogus" }, []).error).toMatch(/Unknown harness/);
  });
  test("the grid: the orchestrator default is Claude opus; on Pi no default and a cell is needed", () => {
    const role = { harness: "claude", model: "opus", provider: null, thinking: null };
    const claude = ["haiku", "sonnet", "opus", "fable"].map((m) => ({ provider: "", model: m, thinking: true, ready: true }));
    const pi = [{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: true, ready: true }];
    const c = g.gridModel({ harness: "claude", models: claude, role });
    expect(c.defaultCell.rowKey).toBe("/opus");
    expect(g.launchReady(c, null, role)).toBe(true);
    const p = g.gridModel({ harness: "pi", models: pi, role });
    expect(p.defaultCell).toBeNull();
    expect(g.launchReady(p, null, role)).toBe(false);
    const sel = { rowKey: "openai-codex/gpt-5.6-sol", effort: "high" };
    expect(g.launchReady(p, sel, role)).toBe(true);
    expect(buildFactoryRoom({ ...base, roleHarness: "claude", harness: "pi", choice: g.choiceFromSelection(p, sel) }, []).launch.model).toBe("gpt-5.6-sol");
  });
});

// tmux changes a '.' in a session name, so a terminal agent cannot have one (same text as pty.rs).
describe("terminal agent names: no dot", () => {
  test("terminalNameError", () => {
    expect(terminalNameError("t a.b")).toBe("a dot is not allowed in a terminal agent name: tmux changes it");
    for (const ok of ["t a-b", "orchestrator-Test room", "alice", "a_b"]) expect(terminalNameError(ok)).toBeNull();
  });
  test("a dotted room is fine while the generated agent name has no dot; refused when it would", () => {
    const ok = buildFactoryRoom({ ...base, room: "release.1", roleHarness: "claude" }, []);
    expect(ok.error).toBeUndefined();
    expect(ok.launch).toMatchObject({ agent: "orchestrator", room: "release.1" });
    const bad = buildFactoryRoom({ ...base, room: "release.1", roleHarness: "claude" }, ["orchestrator"]);
    expect(bad.launch).toBeUndefined();
    expect(bad.error).toMatch(/orchestrator-release\.1.*a dot is not allowed in a terminal agent name/);
    expect(buildFactoryRoom({ ...base, room: "my room", roleHarness: "claude" }, ["orchestrator"]).launch.agent).toBe("orchestrator-my room");
  });
});
