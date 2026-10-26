// A session the shell attached (a hub stage launch) must get the exit and output listeners when the UI adopts it.
// Before: autoAttach answered "already attached" with setTabState('live') only, so the exit event of the closed
// session reached no listener and the tab stayed in the rail with a green dot for ever.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync("ui/terminal.js", "utf8");
const block = src.slice(src.indexOf("  async function autoAttach(agent, cwd) {"), src.indexOf("  setInterval(() => { if (paneEnabled()) reconcile(); }, 5000);"));

function run(spawnError: string | null, connectFails = false, opts: { listening?: boolean; inList?: boolean } = {}) {
  const tab: any = { state: "external" };
  if (opts.listening) { tab.outputUnlisten = () => {}; tab.exitUnlisten = () => {}; }
  const calls: string[] = [];
  const spawnArgs: any[][] = [];
  const ctx: any = vm.createContext({
    tabs: new Map([["worker-1", tab]]),
    cwdCache: {},
    window: {},
    console: { warn: () => {} },
    ptyList: async () => (opts.inList === false ? [] : ["worker-1"]),
    ptySpawn: async (...a: any[]) => { calls.push("spawn"); spawnArgs.push(a); if (spawnError) throw new Error(spawnError); },
    setTabState: (_a: string, st: string) => { tab.state = st; calls.push(`state:${st}`); },
    _connectLiveTab: async () => { calls.push("connect"); if (connectFails) throw new Error("boom"); tab.state = "live"; },
  });
  vm.runInContext(block + ";this.go = autoAttach;", ctx);
  return { tab, calls, spawnArgs, go: () => ctx.go("worker-1", "/w") as Promise<void> };
}

describe("autoAttach", () => {
  test("a session the shell already attached gets the listeners (the exit event can remove the tab)", async () => {
    const r = run("agent 'worker-1' already attached");
    await r.go();
    expect(r.calls).toContain("connect"); // the exit and output listeners are registered by _connectLiveTab
    expect(r.tab.state).toBe("live");
  });

  test("if registering the listeners fails the tab is still marked live", async () => {
    const r = run("agent 'worker-1' already attached", true);
    await r.go();
    expect(r.calls).toContain("connect");
    expect(r.tab.state).toBe("live");
  });

  test("a normal re-attach connects once; a vanished session leaves the tab external and connects nothing", async () => {
    const ok = run(null);
    await ok.go();
    expect(ok.calls.filter((c) => c === "connect")).toHaveLength(1);
    const gone = run("session not found");
    await gone.go();
    expect(gone.calls).not.toContain("connect");
    expect(gone.tab.state).toBe("external");
  });

  // "already attached" also happens for a normal agent (a window reload): its tab may already listen.
  test("a tab that already has both listeners gets no second pair; one missing listener is connected", async () => {
    const has = run("agent 'worker-1' already attached", false, { listening: true });
    await has.go();
    expect(has.calls).not.toContain("connect");
    expect(has.tab.state).toBe("live");
    const half = run("agent 'worker-1' already attached");
    half.tab.outputUnlisten = () => {}; // only the output listener exists
    await half.go();
    expect(half.calls).toContain("connect");
  });

  // A closed session's tab must never start a new agent of that name: attach-only, and nothing at all when the
  // session is not in tmux.
  test("autoAttach only ever attaches: attachOnly is true, and a session missing from pty_list is not spawned", async () => {
    const live = run(null);
    await live.go();
    expect(live.spawnArgs).toHaveLength(1);
    expect(live.spawnArgs[0][9]).toBe(true); // the attachOnly argument of ptySpawn
    const closed = run(null, false, { inList: false });
    await closed.go();
    expect(closed.calls).not.toContain("spawn");
    expect(closed.calls).not.toContain("state:launching");
  });
});
