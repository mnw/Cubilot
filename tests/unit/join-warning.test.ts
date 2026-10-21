import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the production hasJoined + warnIfNotJoined from ui/terminal.js (they live inside
// an IIFE, so the two function sources are sliced out) against a fake DOM/timer/tab map.
const SRC = readFileSync("ui/terminal.js", "utf8");
const slice = (name: string) => {
  const m = SRC.match(new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
  if (!m) throw new Error(`${name} not found in terminal.js`);
  return m[0];
};

class El {
  children: El[] = [];
  parent: El | null = null;
  style: Record<string, unknown> = {};
  listeners: Record<string, () => void> = {};
  textContent = "";
  append(...els: El[]) { for (const e of els) this.appendChild(e); }
  appendChild(e: El) { e.parent = this; this.children.push(e); return e; }
  addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  setAttribute() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
}

let timers: Array<{ fn: () => void; ms: number; cleared?: boolean }>;
let tabs: Map<string, { paneEl: El }>;
let tab: { paneEl: El };
let ctx: vm.Context;

const run = (agent: string) => {
  vm.runInContext(`warnIfNotJoined(${JSON.stringify(agent)}, __tab)`, ctx);
  expect(timers.length).toBe(1);
  expect(timers[0].ms).toBe(20000);
  timers[0].fn();
};

beforeEach(() => {
  timers = [];
  tab = { paneEl: new El() };
  tabs = new Map([["a", tab]]);
  ctx = vm.createContext({
    tabs,
    __tab: tab,
    // The agent is in the roster in every case: only presence decides the warning.
    ROSTER: [{ name: "a" }],
    document: { createElement: () => new El() },
    window: {},
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: (id: number) => { timers[id - 1]!.cleared = true; },
  });
  vm.runInContext(
    slice("hasJoined") + slice("clearJoinWarning") + slice("warnIfNotJoined") +
      SRC.match(/\n  window\.noteJoinPresence = function[\s\S]*?\n  \};\n/)![0],
    ctx,
  );
});

describe("join warning", () => {
  test("known but offline agent shows the warning", () => {
    ctx.presenceState = { a: false };
    run("a");
    expect(tab.paneEl.children.length).toBe(1);
    expect(tab.paneEl.children[0].children[0].textContent).toContain('"a" has not joined the room after 20 s');
  });

  test("agent absent from presence shows the warning", () => {
    ctx.presenceState = { other: true };
    run("a");
    expect(tab.paneEl.children.length).toBe(1);
  });

  test("presence global not defined yet still warns", () => {
    run("a");
    expect(tab.paneEl.children.length).toBe(1);
  });

  test("connected agent shows nothing", () => {
    ctx.presenceState = { a: true };
    run("a");
    expect(tab.paneEl.children.length).toBe(0);
  });

  test("closed or replaced tab shows nothing", () => {
    ctx.presenceState = {};
    tabs.set("a", { paneEl: new El() });
    run("a");
    expect(tab.paneEl.children.length).toBe(0);
  });

  test("dismiss button removes the warning", () => {
    ctx.presenceState = {};
    run("a");
    const bar = tab.paneEl.children[0];
    bar.children[1].listeners.click();
    expect(tab.paneEl.children.length).toBe(0);
  });
});

describe("join warning lifecycle", () => {
  const warn = () => vm.runInContext('warnIfNotJoined("a", __tab)', ctx);
  const fire = (i: number) => timers[i]!.fn();

  test("a late join removes the warning", () => {
    ctx.presenceState = {};
    warn(); fire(0);
    expect(tab.paneEl.children.length).toBe(1);
    ctx.window.noteJoinPresence({ a: true });
    expect(tab.paneEl.children.length).toBe(0);
  });

  test("presence that does not show the agent as joined keeps the warning", () => {
    ctx.presenceState = {};
    warn(); fire(0);
    ctx.window.noteJoinPresence({ a: false });
    ctx.window.noteJoinPresence({ other: true });
    expect(tab.paneEl.children.length).toBe(1);
  });

  test("a relaunch removes the old warning and starts one fresh countdown", () => {
    ctx.presenceState = {};
    warn(); fire(0);
    expect(tab.paneEl.children.length).toBe(1);
    warn();                                  // relaunch on the same tab
    expect(tab.paneEl.children.length).toBe(0);
    expect(timers.length).toBe(2);
    fire(1);
    expect(tab.paneEl.children.length).toBe(1); // one bar, not two
  });

  test("a relaunch while the countdown runs cancels the old countdown", () => {
    ctx.presenceState = {};
    warn(); warn();
    expect(timers[0]!.cleared).toBe(true);
    expect(timers[1]!.cleared).toBeUndefined();
  });

  test("dismissing the bar and then joining late does nothing", () => {
    ctx.presenceState = {};
    warn(); fire(0);
    tab.paneEl.children[0].children[1].listeners.click();
    expect(() => ctx.window.noteJoinPresence({ a: true })).not.toThrow();
    expect(tab.paneEl.children.length).toBe(0);
  });

  test("handleLaunch clears the old warning before it spawns", () => {
    expect(SRC).toMatch(/const t = ensureTab\(agent\);\n    clearJoinWarning\(t\);/);
  });
});
