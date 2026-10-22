// Ticket t_918fd3a5211856f8: a launch must send the role the window shows, and autoAttach must not create a session.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync("ui/terminal.js", "utf8");
const between = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));

describe("spawnRoleMismatch", () => {
  const block = between("  function spawnRoleMismatch() {", "  // ---- The model x effort grid");
  const run = (value: string, shown: string | null, staged: string[]) => {
    const ctx: any = vm.createContext({
      spawnRoleEl: { value }, spawnRoles: new Map(staged.map((n) => [n, {}])),
      roleList: shown === null ? null : { shown: () => shown },
    });
    vm.runInContext(block + ";this.r = spawnRoleMismatch();", ctx);
    return ctx.r;
  };

  test("window and value agree: no mismatch", () => {
    expect(run("reviewer", "reviewer", ["reviewer"])).toBe("");
    expect(run("", "None", ["reviewer"])).toBe("");
  });
  test("the window shows a role but the value is None: refused", () => {
    expect(run("", "reviewer", ["reviewer"])).toContain('shows "reviewer" but the role is "None"');
  });
  test("the window shows None but the value is a role: refused", () => {
    expect(run("worker", "None", ["worker"])).toContain('role is "worker"');
  });
  test("a value that is not a staged role is refused", () => {
    expect(run("ghost", "ghost", ["worker"])).toContain("not in the role list");
  });
});

describe("autoAttach and reconcile", () => {
  const block = between("  async function reconcile() {", "  setInterval(() => { if (paneEnabled()) reconcile()");
  // lists: the answers of successive ptyList() calls (the last one repeats). onList runs at the start of each call.
  const run = async (lists: string[][], state = "external", onList?: (n: number, tab: any) => void, spawnError?: string) => {
    const spawned: any[] = [];
    const states: string[] = [];
    const tab: any = { state, tabEl: { dataset: {} } };
    const tabs = new Map([["a", tab]]);
    let n = 0;
    const ctx: any = vm.createContext({
      tabs, ROSTER: [], HUMAN_NAME: "human", cwdCache: {}, console, String, Array, Set, window: {}, activeAgent: "a", focusTab: () => {},
      tabsEl: { querySelector: () => ({}) },
      isShell: () => false, removeTab: () => {}, ensureTab: () => tab,
      setTabState: (_a: string, s: string) => { tab.state = s; states.push(s); },
      ptyList: async () => { onList?.(n, tab); return lists[Math.min(n++, lists.length - 1)]; },
      ptySpawn: async (...a: any[]) => { spawned.push(a); if (spawnError) throw new Error(spawnError); },
      _connectLiveTab: async () => {},
    });
    vm.runInContext(block + ";this.reconcile = reconcile;", ctx);
    await ctx.reconcile();
    await new Promise((r) => setTimeout(r, 5));
    return { spawned, states, tab };
  };

  test("the session is gone between the reconcile listing and the spawn: nothing is spawned, the state is untouched", async () => {
    const r = await run([["a"], []]);
    expect(r.spawned).toEqual([]);
    expect(r.states).toEqual([]);
  });
  test("the session exists at both listings: it is re-attached", async () => {
    const r = await run([["a"]]);
    expect(r.spawned).toHaveLength(1);
    expect(r.states[0]).toBe("launching");
  });
  test("autoAttach passes attachOnly: true (the 10th ptySpawn argument) and no role", async () => {
    const r = await run([["a"]]);
    expect(r.spawned[0][9]).toBe(true);
    expect(r.spawned[0].slice(2, 9).every((v: any) => v == null)).toBe(true);
  });
  test('Rust answers "session not found": the tab goes back to external, no warning loop', async () => {
    const r = await run([["a"]], "external", undefined, "session not found");
    expect(r.states).toEqual(["launching", "external"]);
  });
  test("launch starts, reconcile runs, launch ends: reconcile never spawns for a launching tab", async () => {
    const r = await run([["a"]], "launching");
    expect(r.spawned).toEqual([]);
    expect(r.states).toEqual([]);
  });
  test("a launch that starts while autoAttach lists: no spawn and the launching state is not reset", async () => {
    const r = await run([["a"], ["a"]], "external", (n, tab) => { if (n === 1) tab.state = "launching"; });
    expect(r.spawned).toEqual([]);
    expect(r.states).toEqual([]);
    expect(r.tab.state).toBe("launching");
  });
});

describe("the name field", () => {
  const block = between("  // A remembered role fills an empty choice only", "  // The role the window shows");
  const run = async (picked: string) => {
    const el: any = { value: picked };
    const calls: string[] = [];
    let handler: any;
    const ctx: any = vm.createContext({
      spawnRoleEl: el, spawnAgentEl: { addEventListener: (_t: string, f: any) => { handler = f; } },
      recallSpawnRole: async () => { calls.push("recall"); el.value = "remembered"; },
    });
    vm.runInContext(block + ";", ctx);
    await handler();
    return { value: el.value, calls };
  };
  test("a role picked by the human is not replaced when the name is committed", async () => {
    expect(await run("reviewer")).toEqual({ value: "reviewer", calls: [] });
  });
  test("with the role None the remembered role is recalled", async () => {
    expect(await run("")).toEqual({ value: "remembered", calls: ["recall"] });
  });
});

describe("other paths to an empty role", () => {
  const html = readFileSync("ui/index.html", "utf8");
  test("the role select is hidden (no focus, no type-ahead) and the modal is not a form (Enter submits nothing)", () => {
    expect(html).toMatch(/<select id="spawn-role-select" hidden>/);
    const modal = html.slice(html.indexOf('id="spawn-modal"'), html.indexOf('id="spawn-submit"'));
    expect(modal).not.toContain("<form");
    expect(src).not.toMatch(/spawnSubmit\.click\(|requestSubmit/);
  });
});

describe("ptySpawn and the launch alert", () => {
  const load = (invoke: any) => {
    const win: any = { __TAURI__: { core: { invoke } } };
    new Function("window", "TextEncoder", readFileSync("ui/terminal/pty.js", "utf8"))(win, TextEncoder);
    return win.__CUBILOT_TERM__.pty;
  };
  test("attachOnly is sent only when true", async () => {
    const seen: any[] = [];
    const pty = load(async (_c: string, a: any) => { seen.push(a); });
    await pty.ptySpawn("a", "/tmp", null, null, null, null, null, null, null, true);
    await pty.ptySpawn("b", "/tmp");
    expect(seen[0].attachOnly).toBe(true);
    expect("attachOnly" in seen[1]).toBe(false);
  });
  test("a Rust error (a string) reaches the Launch failed alert unchanged", async () => {
    const block = between("  async function handleLaunch(", "  async function handleOpenEditor(");
    const alerts: string[] = [];
    const t: any = {};
    const ctx: any = vm.createContext({
      _paneEnabled: true, performance, console, String, Math,
      ensureTab: () => t, clearJoinWarning: () => {}, clearPauseForLaunch: async () => {}, setTabState: () => {},
      focusTab: () => {}, ptySpawn: async () => { throw "role 'reviewer' is not on the running session t-reviewer"; },
      alert: (m: string) => alerts.push(m), removeTab: () => {}, reconcile: () => {},
    });
    vm.runInContext(block + ";this.f = handleLaunch;", ctx);
    await ctx.f("t-reviewer", "/tmp", null, null, "pi", "reviewer");
    expect(alerts).toEqual(["Launch failed: role 'reviewer' is not on the running session t-reviewer"]);
  });
});
