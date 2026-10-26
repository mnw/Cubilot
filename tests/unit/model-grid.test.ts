// The model x effort grid of the spawn modal (task 5.5): the pure grid model (ui/terminal/model-grid.js) and the
// DOM glue of ui/terminal.js, run in a vm with a tiny fake DOM.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import vm from "node:vm";

const win: any = {};
new Function("window", readFileSync("ui/terminal/model-grid.js", "utf8"))(win);
new Function("window", readFileSync("ui/terminal/spawn-form.js", "utf8"))(win);
const g = win.__CUBILOT_TERM__.modelGrid;
const sf = win.__CUBILOT_TERM__.spawnForm;

const claude = ["haiku", "sonnet", "opus", "fable"].map((m) => ({ provider: "", model: m, thinking: true, ready: true }));
const pi = [
  { provider: "anthropic", model: "claude-fable-5", thinking: true, ready: false },
  { provider: "openai", model: "gpt-4", thinking: false, ready: false },
  { provider: "openai-codex", model: "gpt-5.6-sol", thinking: true, ready: true },
  { provider: "openai-codex", model: "gpt-5.6-terra", thinking: true, ready: true },
];

describe("grid model", () => {
  test("launchReady: a role and one selected cell, on any harness", () => {
    const role = { harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" };
    const c = g.gridModel({ harness: "claude", models: claude, role });
    expect(g.launchReady(c, null, role)).toBe(false);
    expect(g.launchReady(c, { rowKey: "/opus", effort: "high" }, role)).toBe(true);
    expect(g.launchReady(c, { rowKey: "/gone", effort: "high" }, role)).toBe(false);
    expect(g.launchReady(c, { rowKey: "/opus", effort: "bogus" }, role)).toBe(false);
    expect(g.launchReady(c, { rowKey: "/opus", effort: "high" }, null)).toBe(false);   // a launch needs a role
    const p = g.gridModel({ harness: "pi", models: pi, role });
    expect(g.launchReady(p, null, role)).toBe(false);   // no cell: not ready, even on the role's own harness
    expect(g.launchReady(p, g.initialSelection(p), role)).toBe(true);   // the preselected default cell counts
  });

  test("a Claude role with an effort marks and preselects that cell; an explicit choice wins", () => {
    const role = { harness: "claude", model: "opus", provider: null, thinking: null, effort: "medium" };
    const c = g.gridModel({ harness: "claude", models: claude, role });
    expect(c.defaultCell).toEqual({ rowKey: "/opus", effort: "medium" });
    expect(g.initialSelection(c)).toEqual({ rowKey: "/opus", effort: "medium" });
    expect(g.launchReady(c, g.initialSelection(c), role)).toBe(true);
    expect(g.choiceFromSelection(c, g.initialSelection(c))).toBeNull();   // the role default sends nothing
    expect(g.choiceFromSelection(c, { rowKey: "/opus", effort: "high" })).toEqual({ model: null, provider: null, effort: "high" });
  });

  test("each staged single-agent role on its default harness has its model row marked", () => {
    // The real factory role files (frontmatter). Councils (a11y, seo) have no launch command.
    const fm = (t: string, k: string) => t.match(new RegExp(`^---\\n[\\s\\S]*?^${k}:[ \\t]*(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
    const staged = readdirSync("factory").flatMap((name) => {
      const f = `factory/${name}/${name}.md`;
      if (!existsSync(f)) return [];
      const t = readFileSync(f, "utf8");
      if (fm(t, "council") !== null) return [];
      return [{ name, harness: fm(t, "harness") || "claude", model: fm(t, "model"), provider: fm(t, "provider"), thinking: fm(t, "thinking"), effort: fm(t, "effort") }];
    });
    expect(staged.map((r) => r.name).sort()).toEqual(["editor", "orchestrator", "reviewer", "tester", "validator", "worker", "writer"]);
    expect(staged.filter((r) => r.harness === "pi").map((r) => r.name).sort()).toEqual(["reviewer", "validator"]);
    for (const role of staged) {
      const grid = g.gridModel({ harness: role.harness, models: role.harness === "pi" ? pi : claude, role });
      expect(g.launchReady(grid, null, null)).toBe(false);
      expect(grid.defaultCell).not.toBeNull();   // the role's own model is in the list: its cell is marked
    }
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
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(t: string, f: Function) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  closest(_sel: string) { return this.className.includes("cell") ? this : null; }
  fire(t: string, e: any = {}) { for (const f of this.listeners[t] || []) f({ target: this, ...e }); }
  all(pred: (c: El) => boolean, out: El[] = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

describe("spawn modal grid glue", () => {
  const src = readFileSync("ui/terminal.js", "utf8");
  const block = src.slice(src.indexOf("  // Roles come from the staged version"), src.indexOf("  function refreshSpawnRoomDatalist() {"));
  const roles = [
    { name: "worker", harness: "claude", model: "sonnet", provider: null, thinking: null },
    { name: "validator", harness: "pi", model: "gpt-5.6-sol", provider: "openai-codex", thinking: "high" },
  ];
  const lists: any = { claude, pi };

  test("rendering, selection, role defaults, filter, marks and the choice that is sent", async () => {
    const els: Record<string, El> = {};
    for (const id of ["spawnRoleEl", "spawnLineEl", "spawnGridLabelEl", "spawnRoleBtn", "spawnCwdEl", "spawnRoomEl", "spawnGridEl", "spawnGridFilterEl", "spawnGridCountEl", "spawnGridNoteEl", "spawnHarnessPi", "spawnHarnessClaude", "spawnAgentEl", "spawnSubmit"]) els[id] = new El("x");
    els.spawnAgentEl.value = "worker-1"; els.spawnCwdEl.value = "/p"; els.spawnRoomEl.value = "p";
    const calls: string[] = [];
    const Option = function (label: string, value: string) { const o = new El("option"); o._text = label; o.value = value; return o; };
    const ctx = vm.createContext({
      document: { createElement: (t: string) => new El(t) }, Option, console, Map, Promise, localStorage: {},
      ...els, spawnForm: sf, roleList: null, modelGrid: g, roleMemory: { recall: () => null },
      listRoles: async () => roles, listModels: async (h: string) => { calls.push(h); return lists[h]; },
    });
    vm.runInContext("let spawnRoles = new Map();" + block + ";this.api={refreshSpawnRoles,onSpawnRoleChange,spawnGridChoice,get sel(){return gridSelected;}};", ctx);
    const api = (ctx as any).api;
    const cells = () => els.spawnGridEl.all((c) => c.className.includes("cell"));
    const labels = () => els.spawnGridEl.all((c) => c.className.includes("row-label"));
    const click = (c: El) => els.spawnGridEl.fire("click", { target: c });

    await api.refreshSpawnRoles();   // no role, Claude radio
    expect(els.spawnSubmit.disabled).toBe(true);
    expect(els.spawnLineEl.textContent).toBe("Fill in: Role, Model and effort.");
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
    expect(els.spawnSubmit.disabled).toBe(true);   // a Claude role without an effort: a cell is still required
    expect(els.spawnLineEl.textContent).toBe("Fill in: Model and effort.");
    expect(labels().some((l) => l.className.includes("default") && l._text === "sonnet")).toBe(true);
    click(cells()[8]);
    expect(els.spawnSubmit.disabled).toBe(false);
    expect(els.spawnLineEl.textContent).toBe("");
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
    expect(els.spawnSubmit.disabled).toBe(false);   // a preselected default cell counts
    expect(els.spawnGridLabelEl.textContent).toBe("Model and thinking (required)");

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

  // The form around the grid: a fake DOM, the real slices of ui/terminal.js, and stubs for the backend.
  const roles2 = [...roles, { name: "orchestrator", harness: "claude", model: "opus", provider: null, thinking: null, effort: "medium" }];
  function mkCtx(listRolesImpl: () => Promise<any[]>) {
    const els: Record<string, El> = {};
    for (const id of ["spawnRoleEl", "spawnLineEl", "spawnGridLabelEl", "spawnRoleBtn", "spawnGridEl", "spawnGridFilterEl", "spawnGridCountEl", "spawnGridNoteEl", "spawnHarnessPi", "spawnHarnessClaude", "spawnAgentEl", "spawnSubmit", "spawnCwdEl", "spawnRoomEl"]) els[id] = new El("x");
    els.spawnAgentEl.value = "t-agent"; els.spawnCwdEl.value = "/p"; els.spawnRoomEl.value = "p";
    els.spawnHarnessClaude.checked = true;
    const Option = function (label: string, value: string) { const o = new El("option"); o._text = label; o.value = value; return o; };
    const launched: any[][] = [];
    const modalClasses = new Set<string>();
    const ctx = vm.createContext({
      document: { createElement: (t: string) => new El(t) }, Option, console, Map, Set, Object, Promise, localStorage: {}, setTimeout: () => 0, alert: () => {},
      ...els, spawnForm: sf, roleList: null, modelGrid: g, roleMemory: { recall: () => null },
      spawnModal: { classList: { add: (c: string) => modalClasses.add(c), remove: (c: string) => modalClasses.delete(c) } },
      spawnSessionContinue: null, spawnSessionResume: null, refreshSpawnRoomDatalist: () => {},
      handleLaunch: async (...a: any[]) => { launched.push(a); },
      listRoles: listRolesImpl, listModels: async (h: string) => lists[h],
    });
    const src = readFileSync("ui/terminal.js", "utf8");
    const slice = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));
    const code = "let spawnRoles = new Map();"
      + slice("  function openSpawnModal(", "  function refreshSpawnRoomDatalist() {")
      + slice("  function closeSpawnModal()", "  spawnCancel?.addEventListener")
      + slice("  spawnSubmit?.addEventListener('click'", "  document.addEventListener('keydown'")
      + ";this.api={openSpawnModal,closeSpawnModal,refreshSpawnRoles,onSpawnRoleChange,get sel(){return gridSelected;}};";
    vm.runInContext(code, ctx);
    const api = (ctx as any).api;
    const click = (row: string, effort: string) => els.spawnGridEl.fire("click", { target: Object.assign(new El("b"), { className: "cell", dataset: { row, effort } }) });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { els, api, launched, click, flush, modalClasses };
  }
  const fill = (t: ReturnType<typeof mkCtx>) => { t.els.spawnAgentEl.value = "t-agent"; t.els.spawnCwdEl.value = "/p"; t.els.spawnRoomEl.value = "p"; };   // opening clears them
  const pick = async (t: ReturnType<typeof mkCtx>, name: string) => { t.els.spawnRoleEl.value = name; await t.api.onSpawnRoleChange(); };

  test("the role stays picked through the harness change and the cell pick", async () => {
    const t = mkCtx(async () => roles2);
    await t.api.refreshSpawnRoles();
    await pick(t, "worker");
    t.els.spawnHarnessPi.checked = true; t.els.spawnHarnessClaude.checked = false;
    t.els.spawnHarnessPi.fire("change");
    await t.flush();
    t.click("openai-codex/gpt-5.6-sol", "high");
    expect(t.els.spawnRoleEl.value).toBe("worker");
  });

  test("orchestrator preselects opus + medium and Launch is on; an explicit high wins", async () => {
    const t = mkCtx(async () => roles2);
    await t.api.refreshSpawnRoles();
    await pick(t, "orchestrator");
    expect(t.api.sel).toEqual({ rowKey: "/opus", effort: "medium" });
    expect(t.els.spawnSubmit.disabled).toBe(false);
    t.click("/opus", "high");
    expect(t.api.sel).toEqual({ rowKey: "/opus", effort: "high" });
    expect(t.els.spawnSubmit.disabled).toBe(false);
  });

  test("loading: Launch is off with the loading line and nothing launches", async () => {
    const t = mkCtx(() => new Promise(() => {}));
    t.els.spawnSubmit.disabled = false;
    t.api.openSpawnModal();
    expect(t.els.spawnSubmit.disabled).toBe(true);
    expect(t.els.spawnLineEl.textContent).toBe("Loading roles…");
    expect(t.modalClasses.has("open")).toBe(true);
    t.els.spawnSubmit.fire("click");
    await t.flush();
    expect(t.launched).toHaveLength(0);
  });

  test("a failed list_roles: Launch is off with the error line and nothing launches", async () => {
    const t = mkCtx(async () => { throw new Error("backend gone"); });
    t.els.spawnSubmit.disabled = false;
    t.api.openSpawnModal();
    await t.flush(); await t.flush();
    expect(t.els.spawnSubmit.disabled).toBe(true);
    expect(t.els.spawnLineEl.textContent).toBe("Could not load the roles: backend gone. Close and open the form again.");
    t.els.spawnSubmit.fire("click");
    await t.flush();
    expect(t.launched).toHaveLength(0);
  });

  test("stale state: open OK, close, reopen with list_roles pending then rejected: Launch off, handleLaunch not called", async () => {
    let n = 0;
    let fail: (e: Error) => void = () => {};
    const t = mkCtx(() => (++n === 1 ? Promise.resolve(roles2) : new Promise((_r, rej) => { fail = rej; })));
    t.api.openSpawnModal();
    await t.flush(); await t.flush();
    fill(t);
    await pick(t, "orchestrator");
    expect(t.els.spawnSubmit.disabled).toBe(false);   // the first opening is complete
    t.api.closeSpawnModal();
    t.api.openSpawnModal();                            // list_roles pending
    expect(t.els.spawnRoleEl.value).toBe("");          // the role of the earlier opening is not used
    expect(t.els.spawnSubmit.disabled).toBe(true);
    t.els.spawnSubmit.fire("click");
    fail(new Error("late"));
    await t.flush(); await t.flush();
    expect(t.els.spawnSubmit.disabled).toBe(true);
    expect(t.els.spawnLineEl.textContent).toBe("Could not load the roles: late. Close and open the form again.");
    t.els.spawnSubmit.fire("click");
    await t.flush();
    expect(t.launched).toHaveLength(0);
  });

  test("a valid form launches once with the role, harness and the choice", async () => {
    const t = mkCtx(async () => roles2);
    t.api.openSpawnModal();
    await t.flush(); await t.flush();
    fill(t);
    await pick(t, "orchestrator");
    t.click("/opus", "high");
    t.els.spawnSubmit.fire("click");
    await t.flush();
    expect(t.launched).toEqual([["t-agent", "/p", null, "p", "claude", "orchestrator", null, "high", null]]);
  });

  test("aria-invalid only after the field's first change", async () => {
    const t = mkCtx(async () => roles2);
    t.els.spawnAgentEl.value = "";
    t.api.openSpawnModal();
    await t.flush(); await t.flush();
    expect(t.els.spawnAgentEl.attrs["aria-invalid"]).toBeUndefined();
    expect(t.els.spawnRoleBtn.attrs["aria-invalid"]).toBeUndefined();
    t.els.spawnAgentEl.fire("input");
    expect(t.els.spawnAgentEl.attrs["aria-invalid"]).toBe("true");
    expect(t.els.spawnRoleBtn.attrs["aria-invalid"]).toBeUndefined();
    t.els.spawnAgentEl.value = "bob";
    t.els.spawnAgentEl.fire("input");
    expect(t.els.spawnAgentEl.attrs["aria-invalid"]).toBeUndefined();
  });

  test("a new opening starts at no role and the Claude harness", async () => {
    const t = mkCtx(async () => roles2);
    t.api.openSpawnModal();
    await t.flush(); await t.flush();
    await pick(t, "validator");
    expect(t.els.spawnHarnessPi.checked).toBe(true);
    t.api.openSpawnModal();
    expect(t.els.spawnRoleEl.value).toBe("");
    expect(t.els.spawnHarnessClaude.checked).toBe(true);
    expect(t.els.spawnHarnessPi.checked).toBe(false);
  });

  test("pty.listRoles rejects when the command fails (it no longer answers [])", async () => {
    const win: any = { __TAURI__: { core: { invoke: async () => { throw new Error("nope"); } } } };
    new Function("window", "TextEncoder", readFileSync("ui/terminal/pty.js", "utf8"))(win, TextEncoder);
    await expect(win.__CUBILOT_TERM__.pty.listRoles()).rejects.toThrow("nope");
  });
});

describe("spawn modal markup", () => {
  const html = readFileSync("ui/index.html", "utf8");
  const modal = html.slice(html.indexOf('id="spawn-modal"'), html.indexOf('id="factory-room-modal"'));
  test("one live region: the line under Launch; Launch points at it", () => {
    expect(modal.match(/aria-live=/g)).toHaveLength(1);
    expect(modal).toContain('id="spawn-launch-line" class="spawn-launch-line" aria-live="polite"');
    expect(modal).toContain('id="spawn-submit" aria-describedby="spawn-launch-line"');
    expect(modal).not.toContain('role="alert"');
  });
  test("each required label ends with (required) and is linked to its control", () => {
    for (const [forId, text] of [["spawn-agent-input", "Agent name"], ["spawn-role-btn", "Role"], ["spawn-cwd-input", "Project folder"], ["spawn-room-input", "Room"]]) {
      expect(modal).toContain(`<label for="${forId}">${text} (required)</label>`);
      expect(modal).toContain(`id="${forId}"`);
    }
    expect(modal).toContain('role="radiogroup" aria-labelledby="spawn-harness-label"');
    expect(modal).toContain('id="spawn-harness-label" class="spawn-label">Harness (required)');
    expect(modal).toContain('id="spawn-grid-label" class="spawn-label">Model and effort (required)');
    expect(modal).toContain('role="grid" aria-labelledby="spawn-grid-label"');
    expect(modal.match(/aria-required="true"/g)!.length).toBeGreaterThanOrEqual(4);
  });
  test("the line uses a theme token, not a hard-coded colour", () => {
    const css = readFileSync("ui/styles/modals.css", "utf8");
    expect(css).toMatch(/\.spawn-launch-line \{[^}]*color: var\(--error-text\)/);
    expect(css).not.toContain("#ff6b6b");
  });
});
