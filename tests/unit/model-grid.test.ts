// The model x effort grid of the spawn modal (task 5.5): the pure grid model (ui/terminal/model-grid.js) and the
// DOM glue of ui/terminal.js, run in a vm with a tiny fake DOM.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const win: any = {};
new Function("window", readFileSync("ui/terminal/model-grid.js", "utf8"))(win);
const g = win.__CUBILOT_TERM__.modelGrid;

const claude = ["haiku", "sonnet", "opus", "fable"].map((m) => ({ provider: "", model: m, thinking: true, ready: true }));
const pi = [
  { provider: "anthropic", model: "claude-fable-5", thinking: true, ready: false },
  { provider: "openai", model: "gpt-4", thinking: false, ready: false },
  { provider: "openai-codex", model: "gpt-5.6-sol", thinking: true, ready: true },
  { provider: "openai-codex", model: "gpt-5.6-terra", thinking: true, ready: true },
];

describe("grid model", () => {
  test("launchReady: a role on its own harness is always ready; on the other harness only with a cell", () => {
    const role = { harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" };
    const c = g.gridModel({ harness: "claude", models: claude, role });
    expect(g.launchReady(c, null, role)).toBe(false);
    expect(g.launchReady(c, { rowKey: "/opus", effort: "high" }, role)).toBe(true);
    expect(g.launchReady(c, null, null)).toBe(true);
    expect(g.launchReady(g.gridModel({ harness: "pi", models: pi, role }), null, role)).toBe(true);
  });

  test("Claude, no role: four rows, five columns, nothing selected, nothing sent", () => {
    const c = g.gridModel({ harness: "claude", models: claude });
    expect(c.columns).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(c.rows.map((r: any) => r.label)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(c.defaultCell).toBeNull();
    expect(g.initialSelection(c)).toBeNull();
    expect(g.choiceFromSelection(c, null)).toBeNull();
    expect(g.choiceFromSelection(c, { rowKey: "/opus", effort: "high" })).toEqual({ model: "opus", provider: null, effort: "high" });
  });

  test("a Claude role marks its row; only the differing parts are sent", () => {
    const c = g.gridModel({ harness: "claude", models: claude, role: { harness: "claude", model: "sonnet", provider: null, thinking: null } });
    expect(c.defaultCell).toEqual({ rowKey: "/sonnet", effort: null });
    expect(g.initialSelection(c)).toBeNull();
    expect(g.choiceFromSelection(c, { rowKey: "/sonnet", effort: "max" })).toEqual({ model: null, provider: null, effort: "max" });
    expect(g.choiceFromSelection(c, { rowKey: "/opus", effort: "low" })).toEqual({ model: "opus", provider: null, effort: "low" });
    expect(g.choiceFromSelection(c, { rowKey: "/opus", effort: "bogus" })).toBeNull();
  });

  test("Pi: all rows flat as <model> [<provider>], not-ready kept and marked, filter and count", () => {
    let p = g.gridModel({ harness: "pi", models: pi });
    expect(p.columns).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(p.count).toEqual({ shown: 4, total: 4 });
    expect(p.rows.map((r: any) => r.label)).toEqual(["claude-fable-5 [anthropic]", "gpt-4 [openai]", "gpt-5.6-sol [openai-codex]", "gpt-5.6-terra [openai-codex]"]);
    expect(p.rows.map((r: any) => r.ready)).toEqual([false, false, true, true]);
    p = g.gridModel({ harness: "pi", models: pi, filter: "  CODEX " });
    expect(p.count).toEqual({ shown: 2, total: 4 });
    expect(g.gridModel({ harness: "pi", models: pi, filter: "zzz" }).count).toEqual({ shown: 0, total: 4 });
    // a selected row stays valid while the filter hides it
    expect(g.choiceFromSelection(p, { rowKey: "anthropic/claude-fable-5", effort: "off" })).toEqual({ model: "claude-fable-5", provider: "anthropic", effort: "off" });
  });

  test("a Pi role: its default cell is selected and sends nothing; other cells send the differences", () => {
    const val = { harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" };
    const p = g.gridModel({ harness: "pi", models: pi, role: val });
    expect(p.defaultCell).toEqual({ rowKey: "openai-codex/gpt-5.6-sol", effort: "high" });
    expect(g.initialSelection(p)).toEqual({ rowKey: "openai-codex/gpt-5.6-sol", effort: "high" });
    expect(g.choiceFromSelection(p, g.initialSelection(p))).toBeNull();
    expect(g.choiceFromSelection(p, { rowKey: "openai-codex/gpt-5.6-sol", effort: "low" })).toEqual({ model: null, provider: null, effort: "low" });
    expect(g.choiceFromSelection(p, { rowKey: "openai-codex/gpt-5.6-terra", effort: "high" })).toEqual({ model: "gpt-5.6-terra", provider: "openai-codex", effort: null });
    expect(g.choiceFromSelection(p, { rowKey: "anthropic/claude-fable-5", effort: "max" })).toEqual({ model: "claude-fable-5", provider: "anthropic", effort: "max" });
    // a role model that is not listed, or a role of the other harness, marks nothing
    expect(g.gridModel({ harness: "pi", models: pi, role: { harness: "pi", model: "gone", provider: "x", thinking: "high" } }).defaultCell).toBeNull();
    expect(g.gridModel({ harness: "claude", models: claude, role: val }).defaultCell).toBeNull();
  });

  test("a remembered choice maps back to a cell only while its model is still listed", () => {
    const p = g.gridModel({ harness: "pi", models: pi, role: { harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" } });
    expect(g.selectionFromChoice(p, { model: "gpt-5.6-terra", provider: "openai-codex", effort: "low" })).toEqual({ rowKey: "openai-codex/gpt-5.6-terra", effort: "low" });
    expect(g.selectionFromChoice(p, { model: "gone", provider: "x", effort: "low" })).toBeNull();
    expect(g.selectionFromChoice(p, { effort: "low" })).toEqual({ rowKey: "openai-codex/gpt-5.6-sol", effort: "low" });
  });
});

// ---- the glue in ui/terminal.js, sliced out of its IIFE ----
class El {
  tag: string; children: El[] = []; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {}; className = ""; value = "";
  hidden = false; _text = ""; disabled = false; checked = false;
  constructor(tag: string) { this.tag = tag; }
  append(...k: El[]) { this.children.push(...k); }
  add(o: El) { this.children.push(o); }
  set innerHTML(_v: string) { this.children = []; }
  set textContent(v: string) { this._text = v; if (v === "") this.children = []; }
  get textContent() { return this._text; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: Function) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  closest(_sel: string) { return this.className.includes("cell") ? this : null; }
  fire(t: string, e: any = {}) { for (const f of this.listeners[t] || []) f({ target: this, ...e }); }
  all(pred: (c: El) => boolean, out: El[] = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

describe("spawn modal grid glue", () => {
  const src = readFileSync("ui/terminal.js", "utf8");
  const block = src.slice(src.indexOf("  // Roles come from the staged version;"), src.indexOf("  function refreshSpawnRoomDatalist() {"));
  const roles = [
    { name: "worker", harness: "claude", model: "sonnet", provider: null, thinking: null },
    { name: "validator", harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" },
  ];
  const lists: any = { claude, pi };

  test("rendering, selection, role defaults, filter, marks and the choice that is sent", async () => {
    const els: Record<string, El> = {};
    for (const id of ["spawnRoleEl", "spawnRoleErrEl", "spawnGridEl", "spawnGridFilterEl", "spawnGridCountEl", "spawnGridNoteEl", "spawnHarnessPi", "spawnHarnessClaude", "spawnAgentEl", "spawnSubmit"]) els[id] = new El("x");
    els.spawnAgentEl.value = "worker-1";
    const calls: string[] = [];
    const Option = function (label: string, value: string) { const o = new El("option"); o._text = label; o.value = value; return o; };
    const ctx = vm.createContext({
      document: { createElement: (t: string) => new El(t) }, Option, console, Map, Promise, localStorage: {},
      ...els, roleList: null, modelGrid: g, roleMemory: { recall: () => null },
      listRoles: async () => roles, listModels: async (h: string) => { calls.push(h); return lists[h]; },
    });
    vm.runInContext("let spawnRoles = new Map();" + block + ";this.api={refreshSpawnRoles,onSpawnRoleChange,spawnGridChoice,get sel(){return gridSelected;}};", ctx);
    const api = (ctx as any).api;
    const cells = () => els.spawnGridEl.all((c) => c.className.includes("cell"));
    const labels = () => els.spawnGridEl.all((c) => c.className.includes("row-label"));
    const click = (c: El) => els.spawnGridEl.fire("click", { target: c });

    await api.refreshSpawnRoles();   // no role, Claude radio
    expect(calls).toEqual(["claude"]);
    expect(cells()).toHaveLength(20);
    expect(els.spawnGridFilterEl.hidden).toBe(true);
    expect(els.spawnGridCountEl.textContent).toBe("");
    expect(api.spawnGridChoice()).toBeNull();
    click(cells()[7]);
    expect(api.sel).toEqual({ rowKey: "/sonnet", effort: "high" });
    expect(api.spawnGridChoice()).toEqual({ model: "sonnet", provider: null, effort: "high" });
    click(cells()[7]);
    expect(api.sel).toBeNull();   // a second click clears it

    els.spawnRoleEl.value = "worker";
    await api.onSpawnRoleChange();
    expect(els.spawnHarnessPi.disabled || els.spawnHarnessClaude.disabled).toBe(false);   // a role does not lock the radios
    expect(els.spawnHarnessClaude.checked).toBe(true);
    expect(els.spawnSubmit.disabled).toBe(false);
    expect(labels().some((l) => l.className.includes("default") && l._text === "sonnet")).toBe(true);
    click(cells()[8]);
    expect(api.spawnGridChoice()).toEqual({ model: null, provider: null, effort: "xhigh" });

    els.spawnRoleEl.value = "validator";
    await api.onSpawnRoleChange();
    expect(calls).toEqual(["claude", "pi"]);
    expect(els.spawnHarnessPi.checked).toBe(true);
    expect(cells()).toHaveLength(28);
    expect(els.spawnGridFilterEl.hidden).toBe(false);
    expect(els.spawnGridCountEl.textContent).toBe("4/4");
    expect(labels().map((l) => l._text)).toEqual(["claude-fable-5 [anthropic]", "gpt-4 [openai]", "gpt-5.6-sol [openai-codex]", "gpt-5.6-terra [openai-codex]"]);
    expect(labels().filter((l) => l.className.includes("not-ready"))).toHaveLength(2);
    expect(cells().filter((c) => c.className.includes("default"))).toHaveLength(1);
    expect(cells().filter((c) => c.className.includes("selected"))).toHaveLength(1);
    expect(api.spawnGridChoice()).toBeNull();   // the default cell sends nothing

    els.spawnGridFilterEl.value = "terra";
    els.spawnGridFilterEl.fire("input");
    expect(els.spawnGridCountEl.textContent).toBe("1/4");
    expect(cells()).toHaveLength(7);
    els.spawnGridFilterEl.value = "";
    els.spawnGridFilterEl.fire("input");

    click(cells()[0]);   // claude-fable-5 [anthropic], off
    expect(api.spawnGridChoice()).toEqual({ model: "claude-fable-5", provider: "anthropic", effort: "off" });
    expect(els.spawnGridNoteEl.textContent).toMatch(/anthropic is not signed in/);

    // task 9.5: the Pi role on the Claude harness: no default mark, Launch off until a cell is picked
    els.spawnHarnessPi.checked = false;
    els.spawnHarnessClaude.checked = true;
    els.spawnHarnessClaude.fire("change");
    await new Promise((r) => setTimeout(r, 0));
    expect(cells()).toHaveLength(20);
    expect(cells().filter((c) => c.className.includes("default"))).toHaveLength(0);
    expect(els.spawnSubmit.disabled).toBe(true);
    click(cells()[7]);
    expect(els.spawnSubmit.disabled).toBe(false);
    expect(api.spawnGridChoice()).toEqual({ model: "sonnet", provider: null, effort: "high" });   // the whole cell is sent

    els.spawnRoleEl.value = "";
    els.spawnHarnessPi.checked = false;
    await api.onSpawnRoleChange();
    expect(els.spawnHarnessPi.disabled).toBe(false);
    expect(calls).toEqual(["claude", "pi"]);   // rows are cached for one opening of the modal
  });

  // C1 of install 5: name, role worker, harness pi, a Pi cell, Launch. The launch came with no role.
  function mkCtx(listRolesImpl: () => Promise<any[]>) {
    const els: Record<string, El> = {};
    for (const id of ["spawnRoleEl", "spawnRoleErrEl", "spawnGridEl", "spawnGridFilterEl", "spawnGridCountEl", "spawnGridNoteEl", "spawnHarnessPi", "spawnHarnessClaude", "spawnAgentEl", "spawnSubmit"]) els[id] = new El("x");
    els.spawnAgentEl.value = "t-worker-pi";
    const Option = function (label: string, value: string) { const o = new El("option"); o._text = label; o.value = value; return o; };
    const ctx = vm.createContext({
      document: { createElement: (t: string) => new El(t) }, Option, console, Map, Promise, localStorage: {},
      ...els, roleList: null, modelGrid: g, roleMemory: { recall: () => null },
      listRoles: listRolesImpl, listModels: async (h: string) => lists[h],
    });
    const src = readFileSync("ui/terminal.js", "utf8");
    const block = src.slice(src.indexOf("  // Roles come from the staged version;"), src.indexOf("  function refreshSpawnRoomDatalist() {"));
    vm.runInContext("let spawnRoles = new Map();" + block + ";this.api={refreshSpawnRoles,onSpawnRoleChange};", ctx);
    return { els, api: (ctx as any).api };
  }

  test("C1 in order: the role stays 'worker' through the harness change and the cell pick", async () => {
    const { els, api } = mkCtx(async () => roles);
    await api.refreshSpawnRoles();
    els.spawnRoleEl.value = "worker";
    await api.onSpawnRoleChange();
    els.spawnHarnessPi.checked = true; els.spawnHarnessClaude.checked = false;
    els.spawnHarnessPi.fire("change");
    await new Promise((r) => setTimeout(r, 0));
    els.spawnGridEl.fire("click", { target: Object.assign(new El("b"), { className: "cell", dataset: { row: "openai-codex/gpt-5.6-sol", effort: "high" } }) });
    expect(els.spawnRoleEl.value).toBe("worker");
  });

  test("a slow list_roles must not reset a role picked from the options of the previous opening", async () => {
    let release: (v: any[]) => void = () => {};
    const { els, api } = mkCtx(() => new Promise((r) => { release = r; }));
    // the modal was opened before: its options are still there
    els.spawnRoleEl.add(Object.assign(new El("option"), { value: "worker", _text: "worker" }));
    const pending = api.refreshSpawnRoles();
    els.spawnRoleEl.value = "worker";   // the human picks the role while list_roles is still running
    release(roles);
    await pending;
    expect(els.spawnRoleEl.value).toBe("worker");
  });

  // t_41e14dde706805e3: list_roles used to turn an error into "no roles", which cleared a picked role in silence.
  test("a list_roles error keeps the picked role and its options, and shows the error in the window", async () => {
    let fail: (e: Error) => void = () => {};
    const { els, api } = mkCtx(() => new Promise((_r, rej) => { fail = rej; }));
    els.spawnRoleEl.add(Object.assign(new El("option"), { value: "worker", _text: "worker" }));
    els.spawnRoleErrEl.hidden = true;
    const pending = api.refreshSpawnRoles();
    els.spawnRoleEl.value = "worker";
    fail(new Error("backend gone"));
    await pending;
    expect(els.spawnRoleEl.value).toBe("worker");
    expect(els.spawnRoleEl.children.length).toBe(1);   // the options were not rebuilt from an empty list
    expect(els.spawnRoleErrEl.hidden).toBe(false);
    expect(els.spawnRoleErrEl.textContent).toContain("backend gone");
  });
  test("a list_roles answer without the picked role keeps the pick, says so, and the launch guard refuses it", async () => {
    let release: (v: any[]) => void = () => {};
    const { els, api } = mkCtx(() => new Promise((r) => { release = r; }));
    els.spawnRoleEl.add(Object.assign(new El("option"), { value: "editor", _text: "editor" }));
    els.spawnRoleErrEl.hidden = true;
    const pending = api.refreshSpawnRoles();
    els.spawnRoleEl.value = "editor";
    release(roles);   // the answer lists worker and validator only
    await pending;
    expect(els.spawnRoleEl.value).toBe("editor");   // not None
    expect(els.spawnRoleErrEl.hidden).toBe(false);
    expect(els.spawnRoleErrEl.textContent).toContain('"editor" is not in the staged role list');
  });
  test("a later successful list_roles clears the error", async () => {
    let n = 0;
    const { els, api } = mkCtx(async () => { if (++n === 1) throw new Error("x"); return roles; });
    await api.refreshSpawnRoles();
    expect(els.spawnRoleErrEl.hidden).toBe(false);
    await api.refreshSpawnRoles();
    expect(els.spawnRoleErrEl.hidden).toBe(true);
    expect(els.spawnRoleErrEl.textContent).toBe("");
  });
  test("pty.listRoles rejects when the command fails (it no longer answers [])", async () => {
    const win: any = { __TAURI__: { core: { invoke: async () => { throw new Error("nope"); } } } };
    new Function("window", "TextEncoder", readFileSync("ui/terminal/pty.js", "utf8"))(win, TextEncoder);
    await expect(win.__CUBILOT_TERM__.pty.listRoles()).rejects.toThrow("nope");
  });
  test("a new opening starts at None, not at the role of the last launch", async () => {
    const els: Record<string, El> = {};
    for (const id of ["spawnRoleEl", "spawnRoleErrEl", "spawnGridEl", "spawnGridFilterEl", "spawnGridCountEl", "spawnGridNoteEl", "spawnHarnessPi", "spawnHarnessClaude", "spawnAgentEl", "spawnSubmit", "spawnCwdEl", "spawnRoomEl"]) els[id] = new El("x");
    const modalClasses = new Set<string>();
    const Option = function (label: string, value: string) { const o = new El("option"); o._text = label; o.value = value; return o; };
    const ctx = vm.createContext({
      document: { createElement: (t: string) => new El(t) }, Option, console, Map, Promise, localStorage: {}, setTimeout: () => 0,
      ...els, spawnModal: { classList: { add: (c: string) => modalClasses.add(c) } }, spawnSessionContinue: null, spawnSessionResume: null,
      refreshSpawnRoomDatalist: () => {}, roleList: null, modelGrid: g, roleMemory: { recall: () => null },
      listRoles: async () => roles, listModels: async (h: string) => lists[h],
    });
    const src = readFileSync("ui/terminal.js", "utf8");
    const block = src.slice(src.indexOf("  function openSpawnModal("), src.indexOf("  function refreshSpawnRoomDatalist() {"));
    vm.runInContext("let spawnRoles = new Map();" + block + ";this.api={openSpawnModal};", ctx);
    const { openSpawnModal } = (ctx as any).api;
    openSpawnModal();
    await new Promise((r) => setTimeout(r, 0));
    els.spawnRoleEl.value = "worker";           // the human picks worker and launches
    openSpawnModal();                            // a new opening for a new name
    expect(els.spawnRoleEl.value).toBe("");
    await new Promise((r) => setTimeout(r, 0));
    expect(els.spawnRoleEl.value).toBe("");
    expect(modalClasses.has("open")).toBe(true);
  });
});
