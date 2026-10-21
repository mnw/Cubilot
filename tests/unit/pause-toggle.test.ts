import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the production pause-indicator code from ui/terminal.js (sliced out of its IIFE)
// against a fake tab map and a fake hub, so the indicator is checked to follow the hub
// rather than the entry text.
const SRC = readFileSync("ui/terminal.js", "utf8");
const sliceFn = (name: string) => {
  const m = SRC.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
  if (!m) throw new Error(`${name} not found in terminal.js`);
  return m[0];
};
const sliceWindowFn = (name: string) => {
  const m = SRC.match(new RegExp(`\\n  window\\.${name} = function[\\s\\S]*?\\n  \\};\\n`));
  if (!m) throw new Error(`window.${name} not found in terminal.js`);
  return m[0];
};

class Btn {
  disabled = false;
  innerHTML = "";
  title = "";
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
}

let hubPaused: Record<string, boolean>;
let tabs: Map<string, { tabEl: { classList: { toggle: (c: string, on: boolean) => void }; querySelector: () => Btn }; btn: Btn; paused: boolean }>;
let ctx: vm.Context;

function addTab(agent: string) {
  const btn = new Btn();
  const t: any = { btn, paused: false };
  t.tabEl = { classList: { toggle: (_c: string, on: boolean) => { t.paused = on; } }, querySelector: () => btn };
  tabs.set(agent, t);
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  hubPaused = {};
  tabs = new Map();
  ctx = vm.createContext({
    tabs,
    window: {},
    isShell: (a: string) => a === "shell",
    authedFetch: async (path: string) => {
      const agent = decodeURIComponent(path.split("/")[2]);
      return { ok: true, json: async () => ({ agent, paused: !!hubPaused[agent] }) };
    },
  });
  vm.runInContext(
    "const PAUSED_AGENTS = new Set(); const PAUSE_ICON = 'P'; const PLAY_ICON = 'R';" +
      sliceFn("renderPauseToggle") + "let pauseReqSeq = 0;" + sliceFn("nextPauseSeq") +
      SRC.match(/\n  const isLatestPause = [^\n]*\n/)![0] + sliceFn("syncPauseState") +
      sliceWindowFn("syncAllPauseStates") + sliceWindowFn("notePauseEntry"),
    ctx,
  );
});

describe("pause indicator follows the hub", () => {
  test("a replayed [agent paused] entry does not restore a pause the hub no longer has", async () => {
    addTab("a");
    ctx.window.notePauseEntry({ from: "system", to: "a", text: "[agent paused]" });
    await settle();
    expect(tabs.get("a")!.paused).toBe(false);
    expect(tabs.get("a")!.btn.attrs["aria-pressed"]).toBe("false");
  });

  test("a stream reconnect after a hub restart clears every stale indicator", async () => {
    addTab("a"); addTab("b"); addTab("shell");
    hubPaused = { a: true, b: true };
    ctx.window.syncAllPauseStates();
    await settle();
    expect(tabs.get("a")!.paused).toBe(true);
    hubPaused = {};  // hub restart: all pauses gone
    ctx.window.syncAllPauseStates();
    await settle();
    expect(tabs.get("a")!.paused).toBe(false);
    expect(tabs.get("b")!.paused).toBe(false);
    expect(tabs.get("shell")!.btn.attrs["aria-pressed"]).toBeUndefined();
  });

  test("a delayed older reply does not overwrite a newer state", async () => {
    addTab("a");
    const replies: Array<(paused: boolean) => void> = [];
    ctx.authedFetch = (_path: string) =>
      new Promise((resolve) => replies.push((paused) => resolve({ ok: true, json: async () => ({ paused }) })));
    ctx.window.notePauseEntry({ from: "system", to: "a", text: "[agent paused]" });   // older read
    ctx.window.notePauseEntry({ from: "system", to: "a", text: "[agent resumed]" });  // newer read
    replies[1](false);  // newer reply arrives first
    await settle();
    replies[0](true);   // older reply arrives late
    await settle();
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("a reply for a replaced tab does not set the new tab", async () => {
    addTab("a");
    const replies: Array<(paused: boolean) => void> = [];
    ctx.authedFetch = (_path: string) =>
      new Promise((resolve) => replies.push((paused) => resolve({ ok: true, json: async () => ({ paused }) })));
    ctx.window.notePauseEntry({ from: "system", to: "a", text: "[agent paused]" });  // read for the old tab
    tabs.delete("a");
    addTab("a");                                                                      // tab replaced
    ctx.window.notePauseEntry({ from: "system", to: "a", text: "[agent resumed]" }); // read for the new tab
    replies[1](false);
    await settle();
    replies[0](true);   // the old tab's reply arrives late
    await settle();
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("the toggle is a keyboard-reachable button with a label", () => {
    expect(SRC).toContain('<button type="button" class="pause-toggle"></button>');
    addTab("a");
    vm.runInContext('renderPauseToggle("a")', ctx);
    expect(tabs.get("a")!.btn.attrs["aria-label"]).toContain("Pause this agent");
  });
});

describe("pause display after the hub drops an agent", () => {
  const ROSTER_SRC = readFileSync("ui/features/roster.js", "utf8");
  const applyRosterSrc = ROSTER_SRC.match(/\nfunction applyRoster\([\s\S]*?\n\}\n/)![0];

  test("pause, remove, roster update: the tab shows not paused, and one click pauses", async () => {
    addTab("a");
    const posts: boolean[] = [];
    ctx.authedFetch = async (path: string, init?: { method?: string; body?: string }) => {
      const agent = decodeURIComponent(path.split("/")[2]);
      if (init?.method === "POST") {
        const { paused, by } = JSON.parse(init.body!);
        expect(by).toBe("human"); // the hub refuses a pause POST without the human name
        posts.push(paused);
        hubPaused[agent] = paused;
        return { ok: true, json: async () => ({ agent, paused }) };
      }
      return { ok: true, json: async () => ({ agent, paused: !!hubPaused[agent] }) };
    };
    vm.runInContext(
      "const HUMAN_NAME = 'human';" + sliceFn("setAgentPaused") +
        "let activeAgent = null;" +
        // applyRoster's own dependencies, stubbed
        "var ROSTER = []; const NAMES = {}; const COLORS = {}; const BODY_COLORS = {};" +
        "const cap = (s) => s; const shade = (c) => c;" +
        "const renderLegend = () => {}; const renderTargetDropdown = () => {}; const renderRoomSwitcher = () => {};" +
        "const refreshRolePills = () => {};" +
        applyRosterSrc,
      ctx,
    );

    // The human pauses agent a; the tab shows it.
    await vm.runInContext('setAgentPaused("a", !PAUSED_AGENTS.has("a"))', ctx);
    expect(tabs.get("a")!.paused).toBe(true);

    // The hub drops the agent (stale timer, /remove): its pause goes with it, with no entry.
    hubPaused = {};
    vm.runInContext("applyRoster([])", ctx);
    await settle();
    expect(tabs.get("a")!.paused).toBe(false);
    expect(tabs.get("a")!.btn.attrs["aria-pressed"]).toBe("false");

    // One click on the toggle pauses (the click handler's expression).
    posts.length = 0;
    await vm.runInContext('setAgentPaused("a", !PAUSED_AGENTS.has("a"))', ctx);
    expect(posts).toEqual([true]);
    expect(tabs.get("a")!.paused).toBe(true);
  });

  test("removing a tab forgets its pause", () => {
    addTab("a");
    vm.runInContext(
      'PAUSED_AGENTS.add("a"); let activeAgent = null;' +
        'tabs.get("a").outputUnlisten = null; tabs.get("a").exitUnlisten = null; tabs.get("a").term = null;' +
        'tabs.get("a").tabEl.remove = () => {}; tabs.get("a").paneEl = { remove() {} };' +
        sliceFn("removeTab") + 'removeTab("a");',
      ctx,
    );
    expect(vm.runInContext('PAUSED_AGENTS.has("a")', ctx)).toBe(false);
    expect(tabs.has("a")).toBe(false);
  });
});

describe("pause toggle while a request is in flight", () => {
  const load = () => vm.runInContext("const HUMAN_NAME = 'human';" + sliceFn("setAgentPaused"), ctx);
  const click = () => vm.runInContext('setAgentPaused("a", !PAUSED_AGENTS.has("a"))', ctx);

  test("the button is disabled until the hub answers; a second click sends nothing", async () => {
    addTab("a");
    load();
    const replies: Array<() => void> = [];
    const posts: boolean[] = [];
    ctx.authedFetch = (_path: string, init: { body: string }) =>
      new Promise((resolve) => {
        const { paused } = JSON.parse(init.body);
        posts.push(paused);
        replies.push(() => resolve({ ok: true, json: async () => ({ paused }) }));
      });

    const first = click();
    const second = click();  // double click: same stale state, must be ignored
    await settle();
    expect(posts).toEqual([true]);
    expect(tabs.get("a")!.btn.disabled).toBe(true);

    replies[0]!();
    await first; await second;
    expect(tabs.get("a")!.btn.disabled).toBe(false);
    expect(tabs.get("a")!.paused).toBe(true);

    const third = click();   // the next click works and toggles back
    await settle();
    expect(posts).toEqual([true, false]);
    replies[1]!();
    await third;
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("a failed request re-enables the button", async () => {
    addTab("a");
    load();
    ctx.authedFetch = async () => { throw new Error("network"); };
    await click();
    expect(tabs.get("a")!.btn.disabled).toBe(false);
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("a refused request (403) re-enables the button and keeps the state", async () => {
    addTab("a");
    load();
    ctx.authedFetch = async () => ({ ok: false, json: async () => ({}) });
    await click();
    expect(tabs.get("a")!.btn.disabled).toBe(false);
    expect(tabs.get("a")!.paused).toBe(false);
  });
});

describe("a launch clears the pause", () => {
  test("clearPauseForLaunch tells the hub paused:false as the human and clears the indicator", async () => {
    addTab("a");
    const posts: Array<{ path: string; body: any }> = [];
    ctx.authedFetch = async (path: string, init: { body: string }) => { posts.push({ path, body: JSON.parse(init.body) }); return { ok: true }; };
    vm.runInContext("const HUMAN_NAME = 'human';" + sliceFn("clearPauseForLaunch"), ctx);
    vm.runInContext('PAUSED_AGENTS.add("a"); renderPauseToggle("a");', ctx);
    expect(tabs.get("a")!.paused).toBe(true);
    await vm.runInContext('clearPauseForLaunch("a")', ctx);
    expect(posts).toEqual([{ path: "/agents/a/pause", body: { paused: false, by: "human" } }]);
    expect(tabs.get("a")!.paused).toBe(false);
    expect(vm.runInContext('PAUSED_AGENTS.has("a")', ctx)).toBe(false);
  });

  test("an unreachable hub does not break the launch", async () => {
    addTab("a");
    ctx.authedFetch = async () => { throw new Error("down"); };
    vm.runInContext("const HUMAN_NAME = 'human';" + sliceFn("clearPauseForLaunch"), ctx);
    await vm.runInContext('clearPauseForLaunch("a")', ctx);
  });

  test("handleLaunch clears it; autoAttach (a plain re-attach) does not", () => {
    expect(SRC).toMatch(/const t = ensureTab\(agent\);\n    clearJoinWarning\(t\);\n    void clearPauseForLaunch\(agent\);/);
    const auto = SRC.match(/async function autoAttach\([\s\S]*?\n  \}\n/)![0];
    expect(auto).not.toContain("clearPauseForLaunch");
  });
});

describe("a launch against pause requests still in flight", () => {
  const load = () => vm.runInContext("const HUMAN_NAME = 'human';" + sliceFn("setAgentPaused") + sliceFn("clearPauseForLaunch"), ctx);
  const run = (code: string) => vm.runInContext(code, ctx);

  test("an older pause READ that answers after the launch cannot bring the indicator back", async () => {
    addTab("a");
    load();
    run('PAUSED_AGENTS.add("a")');
    let reply!: () => void;
    ctx.authedFetch = (_p: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? Promise.resolve({ ok: true })
        : new Promise((r) => (reply = () => r({ ok: true, json: async () => ({ paused: true }) })));
    const old = run('syncPauseState("a")');           // a read of the old session's state, still in flight
    await run('clearPauseForLaunch("a")');
    expect(run('PAUSED_AGENTS.has("a")')).toBe(false);
    reply(); await old;
    expect(run('PAUSED_AGENTS.has("a")')).toBe(false);
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("an older pause WRITE that reaches the hub after the launch's clear cannot leave the new session paused", async () => {
    addTab("a");
    load();
    let hubPaused = false;
    const posts: boolean[] = [];
    let reply!: () => void;
    ctx.authedFetch = (_p: string, init: { body: string }) => {
      const { paused } = JSON.parse(init.body);
      posts.push(paused);
      if (paused) return new Promise((r) => (reply = () => { hubPaused = true; r({ ok: true }); }));   // lands late
      hubPaused = false;
      return Promise.resolve({ ok: true });
    };
    const old = run('setAgentPaused("a", true)');      // the user paused just before relaunching; still in flight
    await run('clearPauseForLaunch("a")');             // the launch does not wait for it
    expect(hubPaused).toBe(false);
    reply(); await old;                                 // the old write lands after the clear...
    expect(hubPaused).toBe(false);                      // ...and the clear was sent again behind it
    expect(posts).toEqual([true, false, false]);
    expect(run('PAUSED_AGENTS.has("a")')).toBe(false);  // and its answer did not repaint the old state
    expect(tabs.get("a")!.btn.disabled).toBe(false);
  });

  test("with no older write in flight the clear is sent once", async () => {
    addTab("a");
    load();
    const posts: boolean[] = [];
    ctx.authedFetch = async (_p: string, init: { body: string }) => { posts.push(JSON.parse(init.body).paused); return { ok: true }; };
    await run('clearPauseForLaunch("a")');
    await settle();
    expect(posts).toEqual([false]);
  });

  test("a second launch takes over the correction: after the older write settles, one clear is sent, not two", async () => {
    addTab("a");
    load();
    const posts: boolean[] = [];
    let replyOld!: () => void;
    ctx.authedFetch = (_p: string, init?: { body?: string }) => {
      if (!init?.body) return Promise.resolve({ ok: true, json: async () => ({ paused: false }) });   // a re-read
      const { paused } = JSON.parse(init.body);
      posts.push(paused);
      if (posts.length === 1) return new Promise((r) => (replyOld = () => r({ ok: true })));       // the older write
      return Promise.resolve({ ok: true });
    };
    const old = run('setAgentPaused("a", true)');
    await run('clearPauseForLaunch("a")');       // first launch: posts false now, corrects later
    await run('clearPauseForLaunch("a")');       // second launch: posts false now and owns the correction
    replyOld(); await old; await settle();
    expect(posts).toEqual([true, false, false, false]);   // the old write, two launch clears, ONE correction
  });

  test("the older write's own audit read must not cancel the correction (the hub ends unpaused and so does the indicator)", async () => {
    addTab("a");
    load();
    let hubPaused = false;
    let reply!: () => void;
    ctx.authedFetch = (_p: string, init?: { body?: string }) => {
      if (!init?.body) return Promise.resolve({ ok: true, json: async () => ({ paused: hubPaused }) });
      const { paused } = JSON.parse(init.body);
      if (paused) {
        return new Promise((r) => (reply = () => {
          hubPaused = true;
          run('syncPauseState("a")');   // the hub's [agent paused] audit entry makes the UI re-read, before the POST answers
          r({ ok: true });
        }));
      }
      hubPaused = false;
      return Promise.resolve({ ok: true });
    };
    const old = run('setAgentPaused("a", true)');
    await run('clearPauseForLaunch("a")');
    reply(); await old; await settle(); await settle();
    expect(hubPaused).toBe(false);
    expect(run('PAUSED_AGENTS.has("a")')).toBe(false);
    expect(tabs.get("a")!.paused).toBe(false);
  });

  test("a replaced tab keeps its own newer pause: the old tab's correction does nothing", async () => {
    addTab("a");
    load();
    const posts: boolean[] = [];
    let replyOld!: () => void;
    ctx.authedFetch = (_p: string, init?: { body?: string }) => {
      if (!init?.body) return Promise.resolve({ ok: true, json: async () => ({ paused: true }) });
      posts.push(JSON.parse(init.body).paused);
      if (posts.length === 1) return new Promise((r) => (replyOld = () => r({ ok: true })));
      return Promise.resolve({ ok: true });
    };
    const old = run('setAgentPaused("a", true)');
    await run('clearPauseForLaunch("a")');       // posts false; its correction waits for the older write
    tabs.delete("a");                              // the tab is closed and a new one opened for the same agent
    addTab("a");
    replyOld(); await old; await settle();
    expect(posts).toEqual([true, false]);          // no correction: the successor tab owns the pause now
  });

  test("a failing second clear is swallowed", async () => {
    addTab("a");
    load();
    let n = 0;
    let replyOld!: () => void;
    ctx.authedFetch = (_p: string, _init: unknown) => {
      n++;
      if (n === 1) return new Promise((r) => (replyOld = () => r({ ok: true })));
      if (n === 3) return Promise.reject(new Error("down"));
      return Promise.resolve({ ok: true, json: async () => ({ paused: false }) });
    };
    const old = run('setAgentPaused("a", true)');
    await run('clearPauseForLaunch("a")');
    replyOld(); await old; await settle();                              // the third call rejects: no unhandled rejection
    expect(n).toBe(4);                                                  // old write, launch clear, failed correction, the re-read after it
  });
});
