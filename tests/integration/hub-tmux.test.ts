// hub/core/tmux.ts and hub/core/terminal.ts against a real tmux on a hermetic socket (hub-first-browser, group 5).
// Never <app data>/tmux.sock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminal, attachArgv } from "../../hub/core/terminal";
import { createTmux, tmuxFromEnv } from "../../hub/core/tmux";
import { resolveTmuxBin } from "../helpers/tmux";

let dir: string;
let socket: string;
const bin = resolveTmuxBin();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cubilot-hub-tmux-"));
  socket = join(dir, "tmux.sock");
});

afterEach(async () => {
  Bun.spawnSync([bin, "-S", socket, "kill-server"]);
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(40);
  }
  return false;
}

describe("hub tmux", () => {
  test("Blank locale: the new-session call carries a UTF-8 LANG and LC_ALL", async () => {
    const tmux = createTmux({ bin, socket, env: { ...process.env, LANG: "", LC_ALL: "" } });
    const argv = tmux.newSessionArgv({ name: "w1", cwd: "/tmp", command: "sleep 30" });
    expect(argv).toContain("LANG=en_US.UTF-8");
    expect(argv).toContain("LC_ALL=en_US.UTF-8");
    await tmux.newSession({ name: "w1", cwd: "/tmp", command: "sleep 30" });
    const env = await tmux.run(["show-environment", "-t", "=w1", "LC_ALL"]);
    expect(env.trim()).toBe("LC_ALL=en_US.UTF-8");
  });

  test("a new session is 80x24, has remain-on-exit off and the command is one argv element", async () => {
    const tmux = createTmux({ bin, socket });
    const cmd = "sleep 30 # '/path with spaces'";
    const argv = tmux.newSessionArgv({ name: "w1", cwd: "/tmp", command: cmd });
    expect(argv.slice(-7)).toEqual(["-x", "80", "-y", "24", "-c", "/tmp", cmd]);
    await tmux.newSession({ name: "w1", cwd: "/tmp", command: cmd });
    expect((await tmux.run(["display-message", "-p", "-t", "=w1:", "#{window_width}x#{window_height}"])).trim()).toBe("80x24");
    expect((await tmux.run(["show-options", "-wv", "-t", "=w1:", "remain-on-exit"])).trim()).not.toBe("on");
  });

  test("the tmux path comes from CUBILOT_TMUX and the socket from CUBILOT_DATA_DIR", () => {
    expect(tmuxFromEnv({ CUBILOT_TMUX: "/x/tmux", CUBILOT_DATA_DIR: "/d" })).toMatchObject({ bin: "/x/tmux", socket: "/d/tmux.sock" });
    expect(() => tmuxFromEnv({ CUBILOT_DATA_DIR: "/d" })).toThrow(/CUBILOT_TMUX/);
  });

  test("Hub exit keeps sessions: a process that creates a session and ends leaves it alive", async () => {
    const script = join(dir, "make.ts");
    writeFileSync(
      script,
      `import { createTmux } from ${JSON.stringify(join(import.meta.dir, "../../hub/core/tmux"))};
       const t = createTmux({ bin: ${JSON.stringify(bin)}, socket: ${JSON.stringify(socket)} });
       await t.newSession({ name: "w1", cwd: "/tmp", command: "sleep 30" });`
    );
    const p = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
    const r = Bun.spawnSync([bin, "-S", socket, "has-session", "-t", "=w1"]);
    expect(r.exitCode).toBe(0);
  });

  test("Invalid name: refused before any tmux call", async () => {
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake-tmux");
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`);
    chmodSync(fake, 0o755);
    const tmux = createTmux({ bin: fake, socket });
    for (const name of ["a/b", "", "a;b", "-x ", "you"]) {
      await expect(tmux.newSession({ name, cwd: "/tmp", command: "true" })).rejects.toThrow(/invalid session name/);
      await expect(tmux.hasSession(name)).rejects.toThrow(/invalid session name/);
      await expect(tmux.killSession(name)).rejects.toThrow(/invalid session name/);
      await expect(tmux.reconfigure(name)).rejects.toThrow(/invalid session name/);
    }
    expect(existsSync(log)).toBe(false);
  });

  test("listSessions is empty without a server; hasSession answers false, not an error", async () => {
    const tmux = createTmux({ bin, socket });
    expect(await tmux.listSessions()).toEqual([]);
    expect(await tmux.hasSession("w1")).toBe(false);
    expect(await tmux.killSession("w1")).toBe(false);
    expect(await tmux.reconfigure("w1")).toBe(false);
  });

  test("an exact target: with only w10 alive, w1 is absent and a kill of w1 touches nothing", async () => {
    const tmux = createTmux({ bin, socket });
    await tmux.newSession({ name: "w10", cwd: "/tmp", command: "sleep 30" });
    expect(await tmux.hasSession("w1")).toBe(false);
    expect(await tmux.killSession("w1")).toBe(false);
    expect(await tmux.listSessions()).toEqual(["w10"]);
  });

  test("a new session sets the RGB terminal feature once", async () => {
    const tmux = createTmux({ bin, socket });
    await tmux.newSession({ name: "w1", cwd: "/tmp", command: "sleep 30" });
    await tmux.newSession({ name: "w2", cwd: "/tmp", command: "sleep 30" });
    await tmux.reconfigure("w1");
    const feat = await tmux.run(["show-options", "-sv", "terminal-features"]);
    expect(feat.split("xterm-256color:RGB").length - 1).toBe(1);
  });

  test("read-only: attach adds -f read-only,ignore-size and a 40x20 viewer leaves the session 120x40", async () => {
    const tmux = createTmux({ bin, socket });
    expect(attachArgv(tmux, "w1", true)).toEqual([bin, "-S", socket, "attach", "-f", "read-only,ignore-size", "-t", "=w1"]);
    expect(attachArgv(tmux, "w1")).toEqual([bin, "-S", socket, "attach", "-t", "=w1"]);
    await tmux.newSession({ name: "w1", cwd: "/tmp", command: "cat" });
    const term = createTerminal(tmux);
    const size = async () => (await tmux.run(["display-message", "-p", "-t", "=w1:", "#{window_width}x#{window_height}"])).trim();
    const controller = await term.attach("w1", { cols: 120, rows: 40, onData() {} });
    try {
      expect(await until(async () => (await size()) === "120x40")).toBe(true);
      const phone = await term.attach("w1", { readOnly: true, cols: 40, rows: 20, onData() {} });
      try {
        expect(await until(async () => (await tmux.run(["list-clients", "-F", "#{client_flags}"])).includes("read-only"))).toBe(true);
        await sleep(300);
        expect(await size()).toBe("120x40");
        // a read-only client cannot type
        phone.write("typed-by-phone\r");
        await sleep(300);
        expect(await tmux.run(["capture-pane", "-p", "-t", "=w1:"])).not.toContain("typed-by-phone");
      } finally {
        phone.close();
      }
    } finally {
      controller.close();
    }
  }, 20000);
});
