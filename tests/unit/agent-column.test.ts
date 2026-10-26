// 4a C1 + C2: the agent column at the left of #app-body, and the header without agent chips.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { stepLimit } from "../helpers/bounded";

const html = readFileSync("ui/index.html", "utf8");
const roster = readFileSync("ui/features/roster.js", "utf8");
const term = readFileSync("ui/terminal.js", "utf8");

describe("markup", () => {
  test("the column is a labelled nav, 300 px, the first child of #app-body, before the chat", () => {
    const body = html.slice(html.indexOf('id="app-body"'), html.indexOf("<!-- /app-body -->"));
    expect(body).toContain('<nav class="agent-col" id="agent-col" aria-label="Agents">');
    expect(body.indexOf('id="agent-col"')).toBeLessThan(body.indexOf('id="chat-col"'));
    expect(readFileSync("ui/styles/tokens.css", "utf8")).toContain("--size-300:  300px");
    expect(readFileSync("ui/styles/terminal.css", "utf8")).toContain("flex: 0 0 var(--size-300)");
  });

  test("the tab rail left the terminal pane; the header has no chips and no '+ agent'", () => {
    const col = html.slice(html.indexOf('id="terminal-col"'), html.indexOf('id="board-col"'));
    expect(col).not.toContain("terminal-tabs");
    expect(html.slice(html.indexOf('id="agent-col"'), html.indexOf('id="chat-col"'))).toContain('id="terminal-tabs"');
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).not.toContain('id="legend"');
    expect(header).not.toContain("add-agent");
    expect(header).toContain('id="ticket-lead"');
  });

  test("the '+' of the column header opens the spawn modal", () => {
    expect(html).toContain('id="agent-col-add"');
    expect(readFileSync("ui/main.js", "utf8")).toContain("getElementById('agent-col-add')");
  });
});

describe("row", () => {
  test("a row has a chevron button, the name as a button, pause, editor, reload, kill and remove, each labelled", () => {
    for (const cls of ["row-chevron", "tab-label", "pause-toggle", "open-editor", "reload-btn", "close-x", "remove-agent"]) {
      expect(term).toContain(`class="${cls}`);
    }
    for (const label of ["'Show details of '", "'Open editor for '", "'Reload '", "'Kill session of '", "'Remove '"]) expect(term).toContain(label);
  });

  test("the reload button is no placeholder any more: it calls the reload route", () => {
    expect(term).not.toMatch(/class="reload-btn" disabled/);
    expect(term).toContain("/reload`");
  });
});

describe("name contrast", () => {
  test("each theme sets the lightness of an agent name; the name rule uses it and the Shell label does not", () => {
    const tokens = readFileSync("ui/styles/tokens.css", "utf8");
    expect(tokens.match(/--agent-name-l:\s*\d+%/g)).toHaveLength(3);
    const css = readFileSync("ui/styles/terminal.css", "utf8");
    expect(css).toContain("hsl(from var(--agent-color, var(--text)) h s var(--agent-name-l))");
    expect(css).toContain(".terminal-tab-shell .tab-label { color: inherit; }");
    // marks (dots, paused icon) use tokens that reach 3:1 in every theme
    expect(tokens.match(/--amber-mark:/g)).toHaveLength(3);
    expect(css).toContain("solid var(--amber-mark)");
    expect(css).toContain("solid var(--text-muted)");
    expect(css).toContain("background: var(--green-strong)");
  });
});

describe("count and presence", () => {
  function run(rosterList: any[], presence: Record<string, boolean>, selected: string) {
    const el: any = { textContent: "" };
    const marks: Record<string, boolean> = {};
    const src = roster.match(/function updateAgentCount\(\) \{[\s\S]*?\n\}\n/)![0];
    const ctx = vm.createContext({
      document: { getElementById: () => el }, ROSTER: rosterList, HUMAN_NAME: "human", SELECTED_ROOM: selected, ROOM_ALL: "*", presenceState: presence,
    });
    vm.runInContext(src + "\nupdateAgentCount();", ctx);
    return { text: el.textContent, marks };
  }
  const list = [
    { name: "human", room: null }, { name: "a", room: "r1" }, { name: "b", room: "r1" }, { name: "c", room: "r2" },
  ];
  test("counts the agents of the selected room, not the human", () => {
    expect(run(list, { a: true, c: true }, "r1").text).toBe("1/2 online");
    expect(run(list, { a: true, c: true }, "*").text).toBe("2/3 online");
  });
});

describe("open row (C4)", () => {
  const sliceFn = (name: string) => term.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}\\n`))![0];
  const pill: any = {};
  new Function("window", readFileSync("ui/features/pill-card.js", "utf8"))(pill);

  function make(info: any, store: Record<string, string> = {}) {
    const mk = () => {
      const kids: any[] = [];
      return { className: "", textContent: "", dataset: {}, kids, append(...n: any[]) { kids.push(...n); }, replaceChildren(...n: any[]) { kids.length = 0; kids.push(...n); } };
    };
    const details = mk();
    const tabs = new Map([["a", { tabEl: { querySelector: () => details } }]]);
    const ctx = vm.createContext({
      tabs, window: pill, isShell: () => false, pillRoles: info ? { a: info } : {},
      fillSkills: () => {}, refreshSkills: () => {},   // the C6c area has its own tests below
      document: { createElement: mk },
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    });
    vm.runInContext(
      "const ROWS_OPEN_KEY = 'cubilot_open_rows';" + sliceFn("readOpenRows") + sliceFn("writeOpenRow") +
        "const HARNESS_LABEL = { claude: 'claude \\u00b7 Claude Code', pi: 'pi \\u00b7 pi.dev' };" + sliceFn("renderRowDetails"),
      ctx,
    );
    return { ctx, details, store };
  }
  const texts = (d: any) => d.kids.map((k: any) => (k.kids ? k.kids.map((c: any) => c.textContent).join("|") : k.textContent));

  test("a claude agent: harness label and model × effort as the pill card showed them", () => {
    const { ctx, details } = make({ role: "worker", harness: "claude", model: "opus", effort: "high" });
    vm.runInContext("renderRowDetails('a')", ctx);
    expect(texts(details).slice(0, 2)).toEqual(["Harness|claude · Claude Code", "Model × effort|opus × high"]);
    expect(details.kids[2].className).toBe("row-skills");
  });
  test("a pi agent, unknown values show '-', and no role gives the note and no checkbox area", () => {
    const { ctx, details } = make({ role: "", harness: "pi", model: "", effort: "" });
    vm.runInContext("renderRowDetails('a')", ctx);
    expect(texts(details).slice(0, 2)).toEqual(["Harness|pi · pi.dev", "Model × effort|- × -"]);
    expect(details.kids[2].className).toBe("row-noskills");
    expect(details.kids[2].textContent).toBe("No role: the agent loads your own Claude or Pi skills.");
  });
  test("an agent with no recorded data shows '-' everywhere", () => {
    const { ctx, details } = make(null);
    vm.runInContext("renderRowDetails('a')", ctx);
    expect(texts(details).slice(0, 2)).toEqual(["Harness|-", "Model × effort|- × -"]);
  });
  test("open rows are saved per agent, and a storage error does not throw", () => {
    const { ctx, store } = make(null);
    vm.runInContext("writeOpenRow('a', true); writeOpenRow('b', true); writeOpenRow('a', false)", ctx);
    expect(JSON.parse(store.cubilot_open_rows)).toEqual({ b: true });
    const bad = vm.createContext({ ROWS_OPEN_KEY: "k", localStorage: { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } } });
    vm.runInContext(sliceFn("readOpenRows") + sliceFn("writeOpenRow") + "this.r = readOpenRows(); writeOpenRow('a', true);", bad);
    expect((bad as any).r).toEqual({});
  });
});

// C6c: the skill switches of the open row, run from the real source with a small fake DOM.
describe("skill switches (C6c)", () => {
  const sliceFn = (name: string) => term.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}\\n`))![0];
  const sliceConst = (name: string) => term.match(new RegExp(`\\n  const ${name} = [^\\n]*\\n`))![0];

  class El {
    children: any[] = []; dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; listeners: Record<string, Array<() => void>> = {};
    className = ""; hidden = false; disabled = false; checked = false; type = ""; title = ""; id = ""; parent: El | null = null;
    private text = "";
    constructor(public tag: string, private doc: { activeElement: any }) {}
    get classList() { const self = this; return { add: (c: string) => { if (!self.className.split(" ").includes(c)) self.className = (self.className + " " + c).trim(); }, contains: (c: string) => self.className.split(" ").includes(c) }; }
    get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v: string) { this.children = []; this.text = v; }
    append(...n: El[]) { for (const c of n) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); } }
    replaceChildren(...n: El[]) { this.children = []; this.append(...n); }
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn); }
    fire(t: string) { (this.listeners[t] ?? []).forEach((f) => f()); }
    focus() { this.doc.activeElement = this; }
    contains(n: any): boolean { return n === this || this.children.some((c) => c.contains(n)); }
    private match(sel: string): boolean { return sel.startsWith(".") ? this.className.split(" ").includes(sel.slice(1)) : sel === "[data-focus-key]" ? this.dataset.focusKey !== undefined : false; }
    querySelectorAll(sel: string): El[] { return this.children.flatMap((c) => [...(c.match(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
    querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  }

  // A skill of each state of the design note (section 2a point 8).
  const item = (id: string, on: boolean, state: string) => ({ id, on, state });
  const data = (over: any = {}) => ({
    role: "worker", mode: "view", relaunch_needed: false,
    groups: [
      { name: "Role · worker", skills: [item("worker/api-design", true, "loaded"), item("worker/a-very-long-skill-name-that-must-truncate-with-an-ellipsis", true, "loaded"), item("worker/search-first", true, "loaded")] },
      { name: "Shared", skills: [item("shared/asd-ste100", true, "loaded")] },
    ],
    ...over,
  });

  function make(initial: any, handler?: (cmd: string, args: any) => any) {
    const doc: any = { activeElement: null, createElement: (tag: string) => new El(tag, doc) };
    const details = new El("div", doc);
    const reloads: string[] = [];
    const states: string[] = [];
    let current = initial;
    const calls: Array<[string, any]> = [];
    // The row: the live region (empty at start) and the details are siblings under one root, like the createTab template.
    const root = new El("div", doc);
    const live = new El("div", doc);
    live.className = "skills-live";
    details.className = "row-details";
    root.append(live, details);
    const tab: any = { reloadState: "ready", root, live, tabEl: { querySelector: (q: string) => (q === ".reload-btn" ? new El("button", doc) : root.querySelector(q) ?? new El("div", doc)) } };
    const ctx: any = vm.createContext({
      document: doc, console, Promise, Set, Map, Object, String, Number, Array, JSON, RegExp, Error,
      tabs: new Map([["a", tab]]), isShell: () => false,
      pillRoles: { a: { role: "worker", harness: "claude", model: "opus", effort: "high" } }, window: { pillCardFields: () => [["Harness", "claude"], ["Model", "opus"], ["Effort", "high"]] },
      HARNESS_LABEL: {}, RELOAD_MSG: {}, reloadAgent: (a: string) => reloads.push(a),
      invoke: async (cmd: string, args: any) => {
        calls.push([cmd, args]);
        if (handler) { const r = handler(cmd, args); if (r !== undefined) return r; }
        if (cmd === "agent_skills") return structuredClone(current);
        return null;
      },
    });
    tab.tabEl.querySelector = ((orig) => (q: string) => (q === ".reload-btn" ? (tab.btn ??= new El("button", doc)) : q === ".reload-msg" ? (tab.msg ??= new El("div", doc)) : orig(q)))(tab.tabEl.querySelector);
    tab.tabEl.dataset = {};
    vm.runInContext(
      ["errText", "skillName", "skillChanged", "skillsOf", "changesOf"].map((n) => (term.includes(`const ${n} = `) ? sliceConst(n) : sliceFn(n))).join("") +
      sliceFn("skillNote") + sliceFn("refreshSkills") + sliceFn("syncChangeState") + sliceFn("changeSkills") + sliceFn("saveSkills") + sliceFn("skillBox") +
      sliceFn("skillsStrip") + sliceFn("fillSkills") + sliceFn("renderRowDetails") + sliceFn("setReloadState") +
      "\nthis.refreshSkills = refreshSkills; this.renderRowDetails = renderRowDetails; this.changeSkills = changeSkills;",
      ctx,
    );
    ctx.setState = (v: any) => { current = v; };
    return { ctx, doc, details, tab, reloads, calls, states };
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const boxes = (details: El) => details.querySelectorAll("[data-focus-key]").filter((n) => n.tag === "input");
  const rows = (details: El) => details.querySelectorAll(".skill-item");
  const opened = async (initial: any, handler?: any) => {
    const m = make(initial, handler);
    m.ctx.renderRowDetails("a");
    await flush();
    return m;
  };

  test("the list shows the folder names in two groups, the count, a full title and the states of the note's table", async () => {
    const d = data();
    d.groups[0].skills = [item("worker/a", true, "loaded"), item("worker/b", true, "new"), item("worker/c", true, "not_loaded"), item("worker/d", false, "loaded"), item("worker/e", false, "not_loaded"), item("worker/f", false, "new")];
    const { details } = await opened(d);
    expect(details.querySelectorAll(".skills-group-name").map((n) => n.textContent)).toEqual(["Role · worker", "Shared"]);
    expect(details.querySelector(".skills-count")!.textContent).toBe("4 of 7 on");   // a, b, c and the shared skill are on; d, e, f are off
    const byName = Object.fromEntries(rows(details).map((r) => [r.querySelector(".skill-name")!.textContent, r]));
    const note = (n: string) => byName[n].querySelector(".skill-note")?.textContent ?? null;
    expect([note("a"), note("b"), note("c"), note("d"), note("e"), note("f")]).toEqual([null, "new, loads on Reload", "not loaded", null, "not loaded", "new, stays off on Reload"]);
    expect(byName.e.classList.contains("is-grey")).toBe(true);        // only off AND not_loaded is grey
    expect(byName.c.classList.contains("is-grey")).toBe(false);
    expect(byName.d.classList.contains("is-grey")).toBe(false);
    expect(boxes(details).map((b) => b.checked)).toEqual([true, true, true, false, false, false, true]);
    expect(details.querySelector(".skills-strip")!.hidden).toBe(false);   // a: loaded+on no change; b new+on, c not_loaded+on, d off+loaded = 3 changes
    expect(details.querySelector(".skills-strip-text")!.textContent).toBe("3 changes wait for Reload");
  });

  test("a long name truncates visually but keeps the full name in the title and in the label text", async () => {
    const { details } = await opened(data());
    const long = rows(details).find((r) => r.querySelector(".skill-name")!.textContent.startsWith("a-very-long"))!;
    const label = long.children[0];
    expect(label.title).toBe("a-very-long-skill-name-that-must-truncate-with-an-ellipsis");
    expect(label.textContent).toBe("a-very-long-skill-name-that-must-truncate-with-an-ellipsis");
    const css = readFileSync("ui/styles/terminal.css", "utf8");
    expect(css).toMatch(/\.skill-name \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  });

  test("unchecking saves the choice, prepares the build, reads the list again, and the strip and the row button show the change; focus stays on the box", async () => {
    let off: string[] = [];
    const { ctx, details, doc, calls, tab } = await opened(data(), (cmd, args) => {
      if (cmd === "agent_skills_set") off = args.off;
      if (cmd === "agent_skills") { const d = data(); for (const g of d.groups) for (const s of g.skills) s.on = !off.includes(s.id); return d; }
    });
    expect(details.querySelector(".skills-strip")!.hidden).toBe(true);
    const box = boxes(details)[0];
    box.focus();
    box.checked = false;
    box.fire("change");
    await flush();
    expect(calls.filter(([c]) => c !== "agent_skills").map(([c, a]) => [c, a])).toEqual([["agent_skills_set", { agent: "a", off: ["worker/api-design"] }], ["agent_skills_apply", { agent: "a" }]]);
    expect(details.querySelector(".skills-count")!.textContent).toBe("3 of 4 on");
    expect(details.querySelector(".skills-strip-text")!.textContent).toBe("1 change waits for Reload");
    expect(details.querySelector(".skills-reload")!.textContent).toBe("Reload a");
    expect(tab.reloadState).toBe("change");
    expect(doc.activeElement.dataset.focusKey).toBe("worker/api-design");   // the rebuilt box has the focus
    expect(details.contains(doc.activeElement)).toBe(true);                  // and it is the new node, not the replaced one
    expect(boxes(details)[0].checked).toBe(false);
    // checking it again returns to no change
    boxes(details)[0].checked = true;
    boxes(details)[0].fire("change");
    await flush();
    expect(off).toEqual([]);
    expect(details.querySelector(".skills-strip")!.hidden).toBe(true);
    expect(tab.reloadState).toBe("ready");
    void ctx;
  });

  test("the announcement is one persistent status region of the row, outside the rebuilt details: connected, empty at start, text with the agent name", async () => {
    let m: any;
    const saved = (on: boolean) => m.ctx.setState(data({ groups: [{ name: "Shared", skills: [item("shared/x", on, "loaded"), item("shared/y", true, "loaded")] }] }));
    m = await opened(data({ groups: [{ name: "Shared", skills: [item("shared/x", true, "loaded"), item("shared/y", true, "loaded")] }] }), (cmd: string, args: any) => {
      if (cmd === "agent_skills_set") saved(!args.off.includes("shared/x"));
    });
    const { ctx, details, tab } = m;
    const live = tab.live as El;
    const connected = () => tab.root.contains(live) && !details.contains(live) && tab.tabEl.querySelector(".skills-live") === live;
    expect(live.textContent).toBe("");
    expect(connected()).toBe(true);
    boxes(details)[0].checked = false;
    boxes(details)[0].fire("change");
    await flush();
    expect(connected()).toBe(true);
    expect(live.textContent).toBe("a: 1 change waits for Reload");
    ctx.renderRowDetails("a");
    await flush();
    expect(connected()).toBe(true);
    expect(live.textContent).toBe("a: 1 change waits for Reload");
    boxes(details)[0].checked = true;
    boxes(details)[0].fire("change");
    await flush();
    expect(connected()).toBe(true);
    expect(live.textContent).toBe("");
  });
  test("an unchanged strip text is not written to the region again", async () => {
    const { ctx, tab } = await opened(data({ groups: [{ name: "Shared", skills: [item("shared/x", false, "loaded")] }] }));
    const live = tab.live as El;
    let writes = 0;
    Object.defineProperty(live, "textContent", { get: () => "a: 1 change waits for Reload", set: () => { writes++; }, configurable: true });
    await ctx.refreshSkills("a");
    ctx.renderRowDetails("a");
    await flush();
    expect(writes).toBe(0);
  });

  test("a save error shows a visible message and the box returns to the saved value; nothing is prepared", async () => {
    const { details, calls } = await opened(data(), (cmd) => { if (cmd === "agent_skills_set") throw "disk full"; });
    const box = boxes(details)[0];
    box.checked = false;
    box.fire("change");
    await flush();
    const err = details.querySelector(".skills-error")!;
    expect(err.textContent).toBe("Could not save the skill choice: disk full");
    expect(err.getAttribute("role")).toBe("alert");
    expect(boxes(details)[0].checked).toBe(true);
    expect(calls.some(([c]) => c === "agent_skills_apply")).toBe(false);
    expect(details.querySelector(".skills-strip")!.hidden).toBe(true);
  });

  test("relaunch needed: the strip says Relaunch <agent> to apply, there is no strip Reload button and no error", async () => {
    const { details, tab } = await opened(data(), (cmd) => {
      if (cmd === "agent_skills_apply") throw "Relaunch a to apply: it was started without a skill view";
      if (cmd === "agent_skills") return data({ mode: "plain", relaunch_needed: true });
    });
    boxes(details)[0].checked = false;
    boxes(details)[0].fire("change");
    await flush();
    expect(details.querySelector(".skills-strip-text")!.textContent).toBe("Relaunch a to apply");
    expect(details.querySelector(".skills-reload")!.hidden).toBe(true);
    expect(details.querySelector(".skills-error")).toBeNull();
    void tab;
  });

  test("Turn all on saves an empty off-list; it is aria-disabled (and keeps the focus) while every skill is on", async () => {
    const off = ["worker/api-design", "worker/search-first"];
    const d = () => { const x = data(); for (const g of x.groups) for (const s of g.skills) s.on = !off.includes(s.id); return x; };
    const { details, calls, doc } = await opened(d(), (cmd, args) => { if (cmd === "agent_skills_set") off.splice(0, off.length, ...args.off); if (cmd === "agent_skills") return d(); });
    const all = () => details.querySelector(".skills-all")!;
    all().focus();
    expect(all().getAttribute("aria-disabled")).toBe("false");
    expect(details.querySelector(".skills-count")!.textContent).toBe("2 of 4 on");
    all().fire("click");
    await flush();
    expect(calls.find(([c]) => c === "agent_skills_set")![1]).toEqual({ agent: "a", off: [] });
    expect(details.querySelector(".skills-count")!.textContent).toBe("4 of 4 on");
    expect(all().getAttribute("aria-disabled")).toBe("true");   // not `disabled`: the focus stays on the button
    expect(doc.activeElement.dataset.focusKey).toBe("turn-all-on");
    expect(details.contains(doc.activeElement)).toBe(true);
    const setsBefore = calls.filter(([c]) => c === "agent_skills_set").length;
    all().fire("click");                                         // a press while it is aria-disabled does nothing
    await flush();
    expect(calls.filter(([c]) => c === "agent_skills_set").length).toBe(setsBefore);
    expect(all().disabled).toBe(false);
  });

  test("two quick clicks are saved one after the other, and the second list contains the first change", async () => {
    const sets: string[][] = [];
    let off: string[] = [];
    const { details } = await opened(data(), (cmd, args) => {
      if (cmd === "agent_skills_set") { sets.push(args.off); off = args.off; }
      if (cmd === "agent_skills") { const d = data(); for (const g of d.groups) for (const s of g.skills) s.on = !off.includes(s.id); return d; }
    });
    const [b0, b1] = boxes(details);
    b0.checked = false; b0.fire("change");
    b1.checked = false; b1.fire("change");
    await flush();
    expect(sets).toEqual([["worker/api-design"], ["worker/a-very-long-skill-name-that-must-truncate-with-an-ellipsis", "worker/api-design"]]);
  });

  test("a failed reload keeps the labels: the row button stays Failed and a new list read does not change the state", async () => {
    const d = data({ groups: [{ name: "Role · worker", skills: [item("worker/x", false, "loaded")] }] });
    const { ctx, details, tab } = await opened(d);
    const before = rows(details).map((r) => r.textContent);
    tab.reloadState = "failed";                                   // the poll ended in Failed
    await ctx.refreshSkills("a");
    expect(tab.reloadState).toBe("failed");                       // not turned back to change or ready
    expect(rows(details).map((r) => r.textContent)).toEqual(before);
    expect(details.querySelector(".skills-strip-text")!.textContent).toBe("1 change waits for Reload");
  });

  test("the strip Reload button runs the same reload as the row button", async () => {
    const { details, reloads } = await opened(data({ groups: [{ name: "Shared", skills: [item("shared/x", false, "loaded")] }] }));
    details.querySelector(".skills-reload")!.fire("click");
    expect(reloads).toEqual(["a"]);
  });

  test("an agent_skills error shows a message instead of boxes", async () => {
    const { details } = await opened(data(), (cmd) => { if (cmd === "agent_skills") throw "no factory"; });
    expect(details.querySelector(".skills-error")!.textContent).toBe("Skills not available: no factory");
    expect(boxes(details)).toEqual([]);
  });

  test("a read error is apart from a save error: a good read clears the read error and keeps the save error", async () => {
    let failRead = false;
    let failPrepare = false;
    const { ctx, details } = await opened(data(), (cmd) => {
      if (cmd === "agent_skills" && failRead) throw "no factory";
      if (cmd === "agent_skills_apply" && failPrepare) throw "disk full";
    });
    failRead = true;
    await ctx.refreshSkills("a");
    expect(details.querySelectorAll(".skills-error").map((e) => e.textContent)).toEqual(["Skills not available: no factory"]);
    expect(boxes(details).length).toBeGreaterThan(0);   // the old list stays
    failRead = false;
    await ctx.refreshSkills("a");
    expect(details.querySelector(".skills-error")).toBeNull();   // no obsolete read error
    failPrepare = true;
    boxes(details)[0].checked = false;
    boxes(details)[0].fire("change");
    await flush();
    expect(details.querySelectorAll(".skills-error").map((e) => e.textContent)).toEqual(["The choice is saved, but it could not be prepared: disk full"]);
    failRead = true;
    await ctx.refreshSkills("a");
    expect(details.querySelectorAll(".skills-error").map((e) => e.textContent)).toEqual(["Skills not available: no factory", "The choice is saved, but it could not be prepared: disk full"]);
    failRead = false;
    await ctx.refreshSkills("a");
    expect(details.querySelectorAll(".skills-error").map((e) => e.textContent)).toEqual(["The choice is saved, but it could not be prepared: disk full"]);   // the unresolved save error stays
  });
  test("the first read fails, then succeeds: the error text goes and the boxes come", async () => {
    let failRead = true;
    const { ctx, details } = await opened(data(), (cmd) => { if (cmd === "agent_skills" && failRead) throw "no factory"; });
    expect(boxes(details)).toEqual([]);
    failRead = false;
    await ctx.refreshSkills("a");
    expect(details.querySelector(".skills-error")).toBeNull();
    expect(boxes(details).length).toBeGreaterThan(0);
  });

  test("the styles: only --text and --text-muted colour text, grey is --text-muted, the strip is amber-bordered", () => {
    const css = readFileSync("ui/styles/terminal.css", "utf8");
    const block = css.slice(css.indexOf("/* Skill switches (C6c)."), css.indexOf("/* Shell row"));
    const colours = [...block.matchAll(/(?:^|[ ;{])color: var\(--([a-z-]+)\)/g)].map((m) => m[1]);
    expect(new Set(colours)).toEqual(new Set(["text", "text-muted"]));
    expect(block).toContain(".skill-item.is-grey label { color: var(--text-muted); }");
    expect(block).toMatch(/\.skills-strip \{[^}]*border: var\(--border-1\) solid var\(--amber-mark\)/);
  });
});

describe("split (C1 fix)", () => {
  const src = term.match(/\n  function splitPercent\([\s\S]*?\n  \}\n/)![0];
  const ctx: any = vm.createContext({ Math });
  vm.runInContext(src + "\nthis.f = splitPercent;", ctx);
  const f = (x: number, left: number, w: number, col: number) => ctx.f(x, left, w, col);

  test("the share is taken from the width left after the agent column", () => {
    // window 980, column 300: the chat starts at x = 300; the middle of the rest is x = 300 + 340
    expect(f(640, 0, 980, 300)).toBeCloseTo(50);
    expect(f(300 + 170, 0, 980, 300)).toBeCloseTo(25);
  });
  test("it is clamped to 25-75 %, and a missing column or a zero width does not break it", () => {
    expect(f(0, 0, 980, 300)).toBe(25);
    expect(f(5000, 0, 980, 300)).toBe(75);
    expect(f(500, 0, 980, 0)).toBeCloseTo(51.02, 1);
    expect(f(500, 0, 300, 300)).toBe(50);
  });
  test("the CSS applies the fraction to (100% - column), and the chat may shrink to keep the terminal minimum", () => {
    expect(readFileSync("ui/styles/layout.css", "utf8")).toContain("flex: 0 1 calc((100% - var(--size-300)) * var(--split-frac, 0.5))");
    expect(readFileSync("ui/styles/kinds.css", "utf8")).toContain("flex: 0 1 calc((100% - var(--size-300)) * var(--split-frac, 0.5))");
    expect(term).toContain("'--split-frac'");
    expect(term).not.toContain("'--split',");
  });
});

// t_2a272087075e960f: the splitter handlers run from the real source with stubbed DOM nodes. The same handlers serve the
// terminal pane and the board (the pane test below sets neither board-open nor a card).
describe("splitter drag (t_2a272087075e960f)", () => {
  const applySrc = term.match(/\n  function splitPercent\([\s\S]*?\n  \}\n  function applySplit\(\) \{[\s\S]*?\n  \}\n/)![0];
  const dragSrc = term.slice(term.indexOf("  let dragStart = null;"), term.indexOf("  const tabs = new Map();"));
  function make(opts: { saved?: string | null; boardOpen?: boolean; paneOn?: boolean } = {}) {
    const store: Record<string, string> = {};
    if (opts.saved != null) store.cubilot_terminal_split = opts.saved;
    const listeners: Record<string, (e: any) => void> = {};
    const cls = new Set<string>();
    const props: Record<string, string> = {};
    const calls: string[] = [];
    const ctx: any = vm.createContext({
      Math, Number, String, SPLIT_KEY: "cubilot_terminal_split",
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
      appBody: { style: { setProperty: (k: string, v: string) => { props[k] = v; } }, getBoundingClientRect: () => ({ left: 0, width: 1000 }) },
      agentCol: { getBoundingClientRect: () => ({ width: 300 }) },
      splitter: {
        addEventListener: (t: string, fn: any) => { listeners[t] = fn; },
        classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) },
        setPointerCapture: () => calls.push("capture"), releasePointerCapture: () => calls.push("release"),
      },
      body: { classList: { contains: (c: string) => c === "board-open" && !!opts.boardOpen } },
      paneEnabled: () => !!opts.paneOn,
      tabs: new Map([["a", { term: {}, fitAddon: { fit: () => calls.push("fit") } }]]),
      sendResize: () => calls.push("resize"),
    });
    vm.runInContext(applySrc + dragSrc + "\napplySplit();", ctx);
    return { listeners, cls, props, store, calls };
  }

  test("a saved narrow split (25) and a corrupt or out-of-range value are applied clamped", () => {
    expect(make({ saved: "25" }).props["--split-frac"]).toBe("0.25");
    expect(make({ saved: "3" }).props["--split-frac"]).toBe("0.25");
    expect(make({ saved: "99" }).props["--split-frac"]).toBe("0.75");
    expect(make({ saved: "abc" }).props["--split-frac"]).toBe("0.5");
    expect(make({ saved: null }).props["--split-frac"]).toBe("0.5");
  });

  for (const [label, o] of [["the board", { boardOpen: true }], ["the terminal pane", { paneOn: true }]] as const) {
    test(`with ${label} open, pointerdown starts a drag, a move resizes and saves, pointerup ends it`, () => {
      const m = make(o);
      m.listeners.pointerdown({ clientX: 640, pointerId: 1 });
      expect(m.cls.has("dragging")).toBe(true);
      m.listeners.pointermove({ clientX: 500 });                  // (500 - 300) / 700 = 28.6 %
      expect(Number(m.props["--split-frac"])).toBeCloseTo(200 / 700, 6);
      expect(m.store.cubilot_terminal_split).toBe("29");
      m.listeners.pointerup({ pointerId: 1 });
      expect(m.cls.has("dragging")).toBe(false);
      expect(m.calls).toContain("release");
      expect(m.calls).toContain("resize");
      const before = m.store.cubilot_terminal_split;
      m.listeners.pointermove({ clientX: 900 });                  // no drag: nothing changes
      expect(m.store.cubilot_terminal_split).toBe(before);
    });
  }

  test("pointercancel ends the drag like pointerup: no stuck dragging class, later moves are ignored", () => {
    const m = make({ boardOpen: true });
    m.listeners.pointerdown({ clientX: 640, pointerId: 7 });
    m.listeners.pointercancel({ pointerId: 7 });
    expect(m.cls.has("dragging")).toBe(false);
    expect(m.calls).toContain("release");
    m.listeners.pointermove({ clientX: 400 });
    expect(m.store.cubilot_terminal_split).toBeUndefined();
  });

  test("with neither the board nor the terminal pane open, pointerdown does nothing", () => {
    const m = make();
    m.listeners.pointerdown({ clientX: 640, pointerId: 1 });
    expect(m.cls.has("dragging")).toBe(false);
  });
});

describe("row actions keep their place (C3 fix)", () => {
  const css = readFileSync("ui/styles/terminal.css", "utf8");
  test("Remove is hidden on an online row and shows only on an offline row, in place of the other actions", () => {
    expect(css).toContain(".row-actions .remove-agent { display: none; }");
    expect(css.indexOf(".row-actions .remove-agent { display: none; }")).toBeLessThan(css.indexOf('[data-presence="offline"] .row-actions .remove-agent { display: inline-flex'));
    expect(css).toMatch(/\[data-presence="offline"\] \.row-actions \.remove-agent \{ display: inline-flex; visibility: visible; \}/);
    for (const cls of ["pause-toggle", "open-editor", "reload-btn", "close-x", "row-gap"]) {
      expect(css).toContain(`[data-presence="offline"] .row-actions .${cls}`);
    }
  });
  test("hidden actions use visibility, never display, so the group does not grow on hover", () => {
    expect(css).toContain(".row-actions .open-editor, .row-actions .reload-btn, .row-actions .close-x { visibility: hidden; }");
    const rule = (sel: string) => css.split("\n").filter((l) => l.startsWith(sel));
    for (const l of rule(".row-actions .open-editor") ) expect(l).not.toContain("display: none");
    expect(css).not.toMatch(/\.row-actions \.row-gap \{ display: none/);
    // only an offline row removes the actions from the layout, and it has no Pause or Kill at all
    expect(css).toMatch(/\[data-presence="offline"\] \.row-actions \.close-x \{ display: none; \}/);
  });
});

describe("Reload button (C5b)", () => {
  const sliceFn = (name: string) => term.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}\\n`))![0];
  const RELOAD_SRC = sliceFn("setReloadState") + sliceFn("reloadOutcome") + sliceFn("reloadAgent");
  const MSG = {
    reloading: "Reloading\u2026 (waits for the end of a run)",
    failed: "Reload failed. Click to try again.",
    stale: "Still waiting for the end of a run. Click to send again.",
  };

  // polls: functions (ms since the click) -> status. The clock is fake: wait() moves it.
  function make(opts: { post: any; polls: Array<(ms: number) => any> }) {
    const els: Record<string, any> = {
      ".reload-btn": { disabled: false, attrs: {} as any, setAttribute(k: string, v: string) { this.attrs[k] = v; } },
      ".reload-msg": { textContent: "", hidden: true },
    };
    const tab: any = { tabEl: { dataset: {}, querySelector: (q: string) => els[q] } };
    const tabs = new Map([["a", tab]]);
    let now = 1_000_000;
    const t0 = now;
    const calls: string[] = [];
    const bodies: any[] = [];
    const states: string[] = [];
    let polled = 0;
    const step = stepLimit("reload wait");
    const ctx: any = vm.createContext({
      tabs, HUMAN_NAME: "human", console, Date: { now: () => now, parse: Date.parse }, Number, Promise,
      RELOAD_MSG: MSG, RELOAD_POLL_MS: 1000, RELOAD_LIMIT_MS: 45000, RELOAD_GIVE_UP_MS: 600000,
      wait: async (ms: number) => { step(); now += ms; states.push(tab.tabEl.dataset.reload); },
      applyReloadStatus: (_a: string, s: any) => calls.push("apply:" + JSON.stringify(s.factory ?? null)),
      authedFetch: async (path: string, init?: any) => {
        calls.push(path);
        if (path.endsWith("/reload")) { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => opts.post }; }
        const p = opts.polls[Math.min(polled++, opts.polls.length - 1)];
        return { ok: true, json: async () => p(now - t0) };
      },
    });
    vm.runInContext(RELOAD_SRC + ";this.go = reloadAgent;", ctx);
    return { go: () => ctx.go("a"), tab, els, calls, bodies, states, ms: () => now - t0, polls: () => calls.filter((c) => c.endsWith("reload-status")).length };
  }
  const st = (reload_id: string | null, last: any = null) => ({ online: true, factory: { pending_reload_id: reload_id, last } });

  test("the click sends { by, force: true }: a human click means reload now, also for the same version", async () => {
    const m = make({ post: { requested: true, reload_id: "r-1" }, polls: [() => st("r-1", { result: "applied", reload_id: "r-1" })] });
    await m.go();
    expect(m.bodies).toEqual([{ by: "human", force: true }]);
  });

  test("an offline agent or an agent with no link: the reason shows at once, there is no poll", async () => {
    for (const [post, text] of [[{ online: false, requested: false }, "offline"], [{ online: true, requested: false }, "no factory link"]] as const) {
      const m = make({ post, polls: [] });
      await m.go();
      expect(m.tab.tabEl.dataset.reload).toBe("ready");
      expect(m.els[".reload-msg"].textContent).toContain(text);
      expect(m.polls()).toBe(0);
    }
  });

  test("it stays 'reloading' until the result has the reload_id of THIS click; another id, newer or older, does not count", async () => {
    const m = make({
      post: { requested: true, reload_id: "r-2" },
      polls: [
        () => st("r-2", { result: "applied", reload_id: "r-1", at: 9e15 }),   // an earlier reload, even with a later time
        () => st("r-2", { result: "failed", reload_id: "r-3", at: 9e15 }),    // a later reload of another click
        () => st(null, { result: "applied", reload_id: "r-2", at: 1 }),
      ],
    });
    await m.go();
    expect(m.polls()).toBe(3);
    expect(m.tab.tabEl.dataset.reload).toBe("ready");
  });

  test("a failed result with the click's id shows Failed and the button can click again", async () => {
    const m = make({ post: { requested: true, reload_id: "r-9" }, polls: [() => st(null, { result: "failed", reload_id: "r-9", at: 1 })] });
    await m.go();
    expect(m.tab.tabEl.dataset.reload).toBe("failed");
    expect(m.els[".reload-msg"].textContent).toBe(MSG.failed);
    expect(m.els[".reload-btn"].disabled).toBe(false);
  });

  test("a busy agent: the 45 s limit does not start before the bridge starts the reload; a long wait ends with the result", async () => {
    // not started for 200 s (a busy run), started at 200 s, applied at 210 s
    const m = make({
      post: { requested: true, reload_id: "r-4" },
      polls: [(ms) => (ms < 200_000 ? st(null) : ms < 210_000 ? st("r-4") : st(null, { result: "applied", reload_id: "r-4", at: 1 }))],
    });
    await m.go();
    expect(m.tab.tabEl.dataset.reload).toBe("ready");
    expect(m.ms()).toBeGreaterThanOrEqual(210_000);
  });

  test("no start in 45 s: the button is enabled again with 'Still waiting for the end of a run. Click to send again.'; the poll goes on; a late start shows Reloading again", async () => {
    const m = make({
      post: { requested: true, reload_id: "r-5" },
      polls: [(ms) => (ms < 100_000 ? st(null) : ms < 110_000 ? st("r-5") : st(null, { result: "applied", reload_id: "r-5", at: 1 }))],
    });
    await m.go();
    expect(m.states).toContain("stale");
    const i = m.states.indexOf("stale");
    expect(m.states.slice(i + 1)).toContain("reloading");   // the late start
    expect(m.tab.tabEl.dataset.reload).toBe("ready");
  });

  test("the stale state enables the button and shows the text", async () => {
    const m = make({ post: { requested: true, reload_id: "r-6" }, polls: [() => st(null)] });
    await m.go();   // never starts: the poll gives up after 10 minutes and leaves the stale state
    expect(m.tab.tabEl.dataset.reload).toBe("stale");
    expect(m.els[".reload-msg"].textContent).toBe(MSG.stale);
    expect(m.els[".reload-btn"].disabled).toBe(false);
  });

  test("started but no result in 45 s: Failed with 'no answer'", async () => {
    const m = make({ post: { requested: true, reload_id: "r-7" }, polls: [() => st("r-7")] });
    await m.go();
    expect(m.tab.tabEl.dataset.reload).toBe("failed");
    expect(m.els[".reload-msg"].textContent).toContain("no answer");
  });

  test("the agent goes offline while reloading: Failed with 'agent offline'", async () => {
    const m = make({ post: { requested: true, reload_id: "r-8" }, polls: [() => st(null), () => ({ online: false, factory: { pending_reload_id: null, last: null } })] });
    await m.go();
    expect(m.tab.tabEl.dataset.reload).toBe("failed");
    expect(m.els[".reload-msg"].textContent).toContain("agent offline");
  });

  test("the latest click wins: a click in the stale state replaces the old reload_id and stops the old poll", async () => {
    const m = make({ post: { requested: true, reload_id: "r-old" }, polls: [() => st(null)] });
    const first = m.go();
    // let the first poll run to the stale state, then click again with a new answer
    await first;
    expect(m.tab.tabEl.dataset.reload).toBe("stale");
    const seq1 = m.tab.reloadSeq;
    const second = m.go();
    expect(m.tab.reloadSeq).toBe(seq1 + 1);
    await second;
  });

  test("a second click while reloading does nothing", async () => {
    const m = make({ post: { requested: true, reload_id: "r-1" }, polls: [() => st(null)] });
    m.tab.reloadState = "reloading";
    await m.go();
    expect(m.calls).toHaveLength(0);
  });
});
