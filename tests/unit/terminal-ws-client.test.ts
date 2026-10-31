// The pane's WebSocket client (hub-first-browser, group 9.5): ui/terminal/pty.js and the functions of ui/terminal.js.
// terminal.js is one IIFE, so its functions are sliced out of the source like tests/unit/right-pane.test.ts does.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const TERM_SRC = readFileSync("ui/terminal.js", "utf8");
const slice = (name: string, async_ = false) => {
  const m = TERM_SRC.match(new RegExp(`\\n  ${async_ ? "async " : ""}function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
  if (!m) throw new Error(`${name} not found in terminal.js`);
  return m[0];
};

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  binaryType = "";
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  frame(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  bytes(b: number[]) { this.onmessage?.({ data: new Uint8Array(b).buffer }); }
}

function loadPty() {
  FakeSocket.all = [];
  const win: any = {
    __CUBILOT_TERM__: {}, WebSocket: FakeSocket, authedFetch: async () => ({ ok: true }),
    btoa, TextEncoder, URLSearchParams,
  };
  new Function("window", "BUS", "AUTH_TOKEN", "TextEncoder", "btoa", "URLSearchParams", readFileSync("ui/terminal/pty.js", "utf8"))(
    win, "http://127.0.0.1:8123", "human-secret", TextEncoder, btoa, URLSearchParams,
  );
  return win.__CUBILOT_TERM__.pty;
}

describe("the pane is opt-in", () => {
  const stored = (value: string | null) => {
    const store = new Map<string, string>(value === null ? [] : [["cubilot_terminal_enabled", value]]);
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const ctx: any = vm.createContext({ localStorage, store });
    const decl = TERM_SRC.match(/  const PANE_KEY = [^\n]*\n[\s\S]*?  let _paneEnabled = [^\n]*\n/)![0];
    vm.runInContext(
      decl + slice("setPaneEnabled") +
      "function applyPaneClass() {} const document = { dispatchEvent() {} }; class CustomEvent {}" +
      ";this.on = () => _paneEnabled; this.set = setPaneEnabled;",
      ctx,
    );
    return ctx;
  };

  test("default off with empty localStorage", () => {
    expect(stored(null).on()).toBe(false);
    expect(stored("false").on()).toBe(false);
  });
  test("the stored choice true restores the pane", () => {
    expect(stored("true").on()).toBe(true);
  });
  test("the toggle stores cubilot_terminal_enabled=true, and false when it is turned off", () => {
    const c = stored(null);
    c.set(true);
    expect(c.store.get("cubilot_terminal_enabled")).toBe("true");
    expect(c.on()).toBe(true);
    c.set(false);
    expect(c.store.get("cubilot_terminal_enabled")).toBe("false");
  });
  test("a launch opens the pane without storing the choice", () => {
    const c = stored(null);
    c.set(true, false);
    expect(c.on()).toBe(true);
    expect(c.store.has("cubilot_terminal_enabled")).toBe(false);
  });
  test("no code removes the stored choice at startup", () => {
    expect(TERM_SRC).not.toMatch(/removeItem\('cubilot_terminal_enabled'\)/);
  });
});

describe("nothing connects while the pane is off", () => {
  test("every timer path to reconcile checks paneEnabled", () => {
    for (const m of TERM_SRC.matchAll(/set(?:Timeout|Interval)\(([^\n]*reconcile[^\n]*)\);?\n/g)) {
      expect(m[1]).toContain("paneEnabled()");
    }
    expect(TERM_SRC).not.toMatch(/setTimeout\(reconcile,/);
  });
  test("the startup reconcile runs only inside the stored-choice branch", () => {
    expect(TERM_SRC).toMatch(/if \(_paneEnabled\) \{\s*reconcile\(\);/);
  });
});

describe("tabs", () => {
  test("sorted by agent name", () => {
    const ctx: any = vm.createContext({});
    vm.runInContext(slice("sortedAgents") + ";this.s = sortedAgents;", ctx);
    expect(ctx.s(["worker-2", "Orchestrator", "tester-1", "alpha", "worker-10"])).toEqual(["alpha", "Orchestrator", "tester-1", "worker-10", "worker-2"]);
  });

  test("a tab select opens /terminal/<agent> and nothing else", async () => {
    const pty = loadPty();
    const opened: string[] = [];
    const tab: any = { socket: null };
    const ctx: any = vm.createContext({
      tabs: new Map([["alice", tab]]), setTimeout, clearTimeout, console,
      openTerminalSocket: (agent: string) => { opened.push(agent); return { isControl: false, close() {} }; },
      ensureControlBar: () => {}, removeTab() {}, reconcile() {},
    });
    vm.runInContext(slice("closeSocket") + slice("attachOutputListener", true) + ";this.attach = attachOutputListener;", ctx);
    await ctx.attach("alice");
    expect(opened).toEqual(["alice"]);
    expect(tab.socket).not.toBeNull();
    expect(pty.terminalWsUrl("http://127.0.0.1:8123", "tok", "alice", 100, 30)).toBe("ws://127.0.0.1:8123/terminal/alice?token=tok&cols=100&rows=30");
  });
});

describe("the socket client", () => {
  test("opens ws://<hub>/terminal/<agent> with the token, read-only", () => {
    const pty = loadPty();
    pty.openTerminalSocket("a b", {});
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].url).toBe("ws://127.0.0.1:8123/terminal/a%20b?token=human-secret");
  });

  test("sends nothing but control frames, and input only after the hub says you control", () => {
    const pty = loadPty();
    const events: string[] = [];
    const s = pty.openTerminalSocket("alice", { onControl: (by: string) => events.push(`control:${by}`), onReadOnly: () => events.push("read-only") });
    const ws = FakeSocket.all[0];
    expect(s.isControl).toBe(false);
    s.take(120, 40);
    expect(JSON.parse(ws.sent[0])).toEqual({ t: "take", cols: 120, rows: 40 });
    ws.frame({ t: "control", by: "you" });
    expect(s.isControl).toBe(true);
    s.input("ls\r");
    expect(JSON.parse(ws.sent[1])).toEqual({ t: "in", d: btoa("ls\r") });
    s.resize(100, 30);
    expect(JSON.parse(ws.sent[2])).toEqual({ t: "resize", cols: 100, rows: 30 });
    ws.frame({ t: "control", by: "other" });
    expect(s.isControl).toBe(false);
    ws.frame({ t: "error", e: "read-only" });
    s.handBack();
    expect(JSON.parse(ws.sent[3])).toEqual({ t: "hand_back" });
    expect(events).toEqual(["control:you", "control:other", "read-only"]);
  });

  test("binary frames are output bytes", () => {
    const pty = loadPty();
    const got: number[][] = [];
    pty.openTerminalSocket("alice", { onOutput: (b: Uint8Array) => got.push([...b]) });
    FakeSocket.all[0].bytes([104, 105]);
    expect(got).toEqual([[104, 105]]);
  });

  test("a close ends control and reaches the pane", () => {
    const pty = loadPty();
    let code = -1;
    const s = pty.openTerminalSocket("alice", { onClose: (e: { code: number }) => { code = e.code; } });
    FakeSocket.all[0].frame({ t: "control", by: "you" });
    FakeSocket.all[0].onclose?.({ code: 1000 });
    expect(code).toBe(1000);
    expect(s.isControl).toBe(false);
  });
});

describe("typing", () => {
  const run = (isControl: boolean) => {
    const sent: string[] = [];
    const flashed: number[] = [];
    const t: any = { socket: { isControl, input: (d: string) => sent.push(d) } };
    const ctx: any = vm.createContext({ flashReadOnly: () => flashed.push(1) });
    vm.runInContext(slice("sendKeys") + ";this.send = sendKeys;", ctx);
    ctx.send(t, "x");
    return { sent, flashed };
  };
  test("Typing before Take control sends nothing and shows the read-only note", () => {
    expect(run(false)).toEqual({ sent: [], flashed: [1] });
  });
  test("Typing after Take control sends the keys", () => {
    expect(run(true)).toEqual({ sent: ["x"], flashed: [] });
  });
});

describe("the roster shows held: N", () => {
  test("noteHeld writes the count of each agent row", () => {
    const row = (agent: string) => { const el: any = { hidden: true, textContent: "" }; return { agent, el, t: { tabEl: { querySelector: () => el } } }; };
    const a = row("alice"), b = row("bob");
    const win: any = {};
    const ctx: any = vm.createContext({ window: win, tabs: new Map([["alice", a.t], ["bob", b.t]]) });
    vm.runInContext(TERM_SRC.match(/  window\.noteHeld = function noteHeld\(held\) \{[\s\S]*?\n  \};\n/)![0], ctx);
    win.noteHeld({ alice: 2 });
    expect([a.el.hidden, a.el.textContent]).toEqual([false, "held: 2"]);
    expect([b.el.hidden, b.el.textContent]).toEqual([true, ""]);
    win.noteHeld({});
    expect([a.el.hidden, a.el.textContent]).toEqual([true, ""]);
  });
  test("main.js passes the held map of every presence event", () => {
    expect(readFileSync("ui/main.js", "utf8")).toContain("window.noteHeld?.(data.held || {})");
  });
});

describe("the shell no longer carries the terminal", () => {
  test("pty_write and pty_resize are not registered", () => {
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(lib).not.toMatch(/pty::pty_write|pty::pty_resize/);
  });
  test("the pane code has no Tauri output event", () => {
    expect(TERM_SRC).not.toMatch(/pty:\/\/|ptyEventName|ptyWrite|ptyResize|listen\(/);
  });
  test("the composer's slash mode writes through the hub", () => {
    const sc = readFileSync("ui/features/slash-command.js", "utf8");
    expect(sc).toContain("pty.ptyInput(");
    expect(sc).not.toContain("ptyWrite");
  });
});
