import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the production click handlers of both toggles against one fake DOM: the board
// (ui/kinds/ticket.js, whole file) and the terminal (ui/terminal.js, function sources
// sliced out of its IIFE). The right pane shows the board or the terminal, never both.
const TICKET_SRC = readFileSync("ui/kinds/ticket.js", "utf8");
const TERM_SRC = readFileSync("ui/terminal.js", "utf8");
const slice = (name: string) => {
  const m = TERM_SRC.match(new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
  if (!m) throw new Error(`${name} not found in terminal.js`);
  return m[0];
};

class Btn {
  attrs: Record<string, string> = {};
  click: (() => void) | null = null;
  addEventListener(t: string, fn: () => void) { if (t === "click") this.click = fn; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
}

let bus: Record<string, Array<(e: any) => void>>;
let classes: Set<string>;
let board: Btn, term: Btn;
let calls: string[];
let ctx: vm.Context;

const shows = () => ({
  board: classes.has("board-open"),
  terminal: !classes.has("no-terminal"),
});

beforeEach(() => {
  bus = {};
  classes = new Set(["no-terminal"]);
  board = new Btn();
  term = new Btn();
  calls = [];
  const document = {
    body: { classList: {
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !classes.has(c) : on;
        want ? classes.add(c) : classes.delete(c);
        return want;
      },
      contains: (c: string) => classes.has(c),
    } },
    getElementById: (id: string) => (id === "board-toggle-btn" ? board : null),
    addEventListener: (t: string, fn: (e: any) => void) => (bus[t] ??= []).push(fn),
    dispatchEvent: (e: any) => { for (const fn of bus[e.type] ?? []) fn(e); return true; },
  };
  class CustomEvent { constructor(public type: string, init: { detail?: unknown } = {}) { this.detail = init.detail; } detail: unknown; }
  const base = { document, CustomEvent, console };

  // Terminal: its own IIFE locals, supplied by hand.
  ctx = vm.createContext({
    ...base,
    body: document.body,
    toggleBtn: term,
    tabs: new Map(),
    splitter: { classList: { add: () => {} }, setPointerCapture: () => {} },
    appBody: { getBoundingClientRect: () => ({ width: 1000 }) },
    reconcile: () => calls.push("reconcile"),
    ensureShellAttached: () => calls.push("attach"),
  });
  vm.runInContext(
    "let _paneEnabled = false; function paneEnabled() { return _paneEnabled; }" +
      slice("applyPaneClass") + slice("setPaneEnabled") + slice("onSplitterDown") + slice("onTerminalToggle") + slice("onRightPane") +
      "var dragStart = null; applyPaneClass(); document.addEventListener('cubilot:right-pane', onRightPane);" +
      "globalThis.__term = onTerminalToggle;",
    ctx,
  );
  term.click = () => ctx.__term();

  // Board: the real file; it wires its own click handler.
  const bctx = vm.createContext({
    ...base,
    SELECTED_ROOM: "r", ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
    escHtml: String, escAttr: String, addMessage: () => {}, parseErrorBody: async () => "",
    KindCardRenderer: { observe: () => {} },
    authedFetch: async () => ({ ok: true, json: async () => [] }),
  });
  vm.runInContext(TICKET_SRC, bctx);
});

const pressed = () => ({ board: board.attrs["aria-pressed"], terminal: term.attrs["aria-pressed"] });

describe("board and terminal share the right pane", () => {
  test("1. board click while closed opens the board and closes the terminal", () => {
    term.click!();                                  // terminal open first
    expect(shows()).toEqual({ board: false, terminal: true });
    board.click!();
    expect(shows()).toEqual({ board: true, terminal: false });
    expect(pressed()).toEqual({ board: "true", terminal: "false" });
  });

  test("2. board click while open closes the board; the terminal stays closed", () => {
    board.click!();
    board.click!();
    expect(shows()).toEqual({ board: false, terminal: false });
    expect(pressed()).toEqual({ board: "false", terminal: "false" });
  });

  test("3. terminal click while the board is open closes the board and shows the terminal", () => {
    board.click!();
    calls.length = 0;
    term.click!();
    expect(shows()).toEqual({ board: false, terminal: true });
    expect(pressed()).toEqual({ board: "false", terminal: "true" });
    expect(calls).toEqual(["reconcile", "attach"]);   // the existing open path runs
  });

  test("4. terminal click while the board is closed toggles the terminal", () => {
    term.click!();
    expect(shows()).toEqual({ board: false, terminal: true });
    expect(pressed().terminal).toBe("true");
    expect(calls).toEqual(["reconcile", "attach"]);
    calls.length = 0;
    term.click!();
    expect(shows()).toEqual({ board: false, terminal: false });
    expect(pressed().terminal).toBe("false");
    expect(calls).toEqual([]);
  });

  test("non-click enable paths (handleLaunch, startup restore) replace the board", () => {
    // handleLaunch and startup restore call setPaneEnabled(true), with no click.
    board.click!();
    vm.runInContext("setPaneEnabled(true);", ctx);
    expect(shows()).toEqual({ board: false, terminal: true });
    expect(pressed()).toEqual({ board: "false", terminal: "true" });
    // Re-applying while the terminal is already shown leaves the board closed.
    vm.runInContext("setPaneEnabled(true);", ctx);
    expect(shows()).toEqual({ board: false, terminal: true });
  });

  test("handleLaunch and startup restore enable the terminal through setPaneEnabled", () => {
    const fn = (name: string) => TERM_SRC.slice(TERM_SRC.indexOf(`function ${name}(`), TERM_SRC.indexOf(`function ${name}(`) + 400);
    expect(fn("handleLaunch")).toContain("setPaneEnabled(true)");
    expect(TERM_SRC).toMatch(/!_paneEnabled\) \{\n\s+setPaneEnabled\(true\);\n\s+reconcile\(\);/);   // startup restore
    // No other direct write: only the declaration, the helper and onRightPane.
    const writes = TERM_SRC.match(/\b_paneEnabled = /g) ?? [];
    expect(writes.length).toBe(3);
  });

  test("the splitter starts a drag with the board open, the terminal open, and not with neither", () => {
    const down = () => { vm.runInContext("dragStart = null", ctx); ctx.onSplitterDown({ clientX: 400, pointerId: 1 }); return vm.runInContext("dragStart", ctx); };
    expect(down()).toBeNull();                                   // neither pane
    board.click!();
    expect(down()).toEqual({ x: 400, width: 1000 });             // board only
    term.click!();
    expect(down()).toEqual({ x: 400, width: 1000 });             // terminal only
    term.click!();
    expect(down()).toBeNull();                                   // closed again
  });

  test("5. never both panes, in any click order", () => {
    for (const seq of ["bt", "tb", "bbt", "ttb", "btbtb", "tbbtt"]) {
      for (const c of seq) (c === "b" ? board : term).click!();
      const s = shows();
      expect(s.board && s.terminal).toBe(false);
      expect(pressed().board === "true").toBe(s.board);
      expect(pressed().terminal === "true").toBe(s.terminal);
    }
  });
});
