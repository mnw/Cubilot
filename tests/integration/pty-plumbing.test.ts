// Integration tests for the tmux plumbing pty.rs builds on.
//
// These do NOT drive pty.rs through Tauri; they verify the tmux primitives
// directly, so the helpers we extract in §3-§5 (v098-pty-refactor) have a
// safety net. Locale resolution is a pure Rust function — not covered here,
// `cargo check` is its only guard.
//
// Each test uses a hermetic PID-scoped socket under /tmp/ and runs
// kill-server on teardown.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmuxSocket, type TmuxHarness } from "../helpers/tmux";

let h: TmuxHarness;

beforeEach(async () => {
  h = await tmuxSocket();
});

afterEach(async () => {
  await h.teardown();
});

describe("pty plumbing — tmux session contract", () => {
  test("create + has-session reports live", async () => {
    await h.spawnSession("probe-1", ["-c", "/tmp"]);
    const r = await h.run(["has-session", "-t", "probe-1"]);
    expect(r.exitCode).toBe(0);
  });

  test("kill-session + has-session reports gone within 500ms", async () => {
    await h.spawnSession("probe-2", ["-c", "/tmp"]);
    const kill = await h.run(["kill-session", "-t", "probe-2"]);
    expect(kill.exitCode).toBe(0);

    const deadline = Date.now() + 500;
    let gone = false;
    while (Date.now() < deadline) {
      const check = await h.run(["has-session", "-t", "probe-2"]);
      if (check.exitCode !== 0) {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gone).toBe(true);
  });

  test("remain-on-exit can be toggled via set-option", async () => {
    // Session created with -d inherits the global remain-on-exit default.
    // Our helper will override to "off" on attach for sessions that may have
    // had it "on" from legacy builds. This test verifies the toggle works.
    await h.spawnSession("probe-3", ["-c", "/tmp"]);

    const setOn = await h.run(["set-option", "-t", "probe-3", "remain-on-exit", "on"]);
    expect(setOn.exitCode).toBe(0);
    const showOn = await h.run(["show-option", "-t", "probe-3", "-v", "remain-on-exit"]);
    expect(showOn.stdout.trim()).toBe("on");

    const setOff = await h.run(["set-option", "-t", "probe-3", "remain-on-exit", "off"]);
    expect(setOff.exitCode).toBe(0);
    const showOff = await h.run(["show-option", "-t", "probe-3", "-v", "remain-on-exit"]);
    expect(showOff.stdout.trim()).toBe("off");
  });

  test("set-environment propagates UTF-8 locale to the session", async () => {
    // This is the behaviour configure_existing_session relies on when
    // reattaching to a session spawned before the locale fix. The attach
    // client must be able to override the session env.
    await h.spawnSession("probe-4", ["-c", "/tmp"]);

    const setLang = await h.run(["set-environment", "-t", "probe-4", "LANG", "en_US.UTF-8"]);
    expect(setLang.exitCode).toBe(0);

    const showEnv = await h.run(["show-environment", "-t", "probe-4", "LANG"]);
    expect(showEnv.stdout.trim()).toBe("LANG=en_US.UTF-8");
  });

  test("session dimensions are 80x24 when created with -x/-y", async () => {
    // Load-bearing: tmux otherwise probes the invoking TTY's dims. The
    // Rust shell has no controlling TTY so the default would be wrong.
    await h.spawnSession("probe-5", ["-c", "/tmp"]);
    const dims = await h.run([
      "display-message", "-p", "-t", "probe-5",
      "#{window_width}x#{window_height}",
    ]);
    expect(dims.stdout.trim()).toBe("80x24");
  });

  test(
    "attach-session is raw-PTY, NOT control-mode (v0.6 regression guard)",
    async () => {
      // This is THE scenario that catches the v0.6 `tmux -C` class of bug.
      // A raw attach client forwards bytes transparently; -C framing emits
      // %output / %begin / %end on stdout. CLAUDE.md pins raw-PTY as the
      // hard rule — this test is its automated enforcement.
      await h.spawnSession("probe-6", ["-c", "/tmp"]);

      const { proc } = h.attachReader("probe-6");

      // Give the attach client a moment to connect and emit any framing.
      await new Promise((r) => setTimeout(r, 150));

      // We haven't sent any input; with raw-PTY, stdout should be whatever
      // tmux paints (blank screen control codes, maybe a status line), NOT
      // lines beginning with "%output" / "%begin" / "%end".
      proc.kill();
      const out = await new Response(proc.stdout).text();

      expect(out).not.toContain("%output");
      expect(out).not.toContain("%begin ");
      expect(out).not.toContain("%end ");

      await proc.exited;
    },
  );

  test("list-sessions reports names created on the hermetic socket", async () => {
    await h.spawnSession("probe-7a", ["-c", "/tmp"]);
    await h.spawnSession("probe-7b", ["-c", "/tmp"]);

    const r = await h.run(["list-sessions", "-F", "#S"]);
    expect(r.exitCode).toBe(0);
    const names = r.stdout.trim().split("\n").filter(Boolean).sort();
    expect(names).toEqual(["probe-7a", "probe-7b"]);
  });

  // AUDIT-R11: a bare `-t Dev` is a PREFIX match in tmux. pty.rs builds `=name` for a session-only
  // target and `=name:` for a pane/window/option target (see tmux_session / tmux_pane).
  describe("exact session targets (prefix safety)", () => {
    const exact = (cmd: string[], name: string) =>
      cmd.map((a) => a.replace("{S}", `=${name}`).replace("{P}", `=${name}:`));
    // The calls pty.rs makes, with {S} = session-only target, {P} = pane/window/option target.
    const calls: Array<{ label: string; argv: string[]; mustFailForPrefix: boolean }> = [
      { label: "has-session", argv: ["has-session", "-t", "{S}"], mustFailForPrefix: true },
      { label: "set @cubilot_harness", argv: ["set-option", "-t", "{P}", "@cubilot_harness", "pi"], mustFailForPrefix: true },
      { label: "show-options @cubilot_harness", argv: ["show-options", "-v", "-t", "{P}", "@cubilot_harness"], mustFailForPrefix: true },
      { label: "list-panes", argv: ["list-panes", "-t", "{P}", "-F", "#{pane_start_command}"], mustFailForPrefix: true },
      { label: "set-option", argv: ["set-option", "-t", "{P}", "status", "off"], mustFailForPrefix: true },
      { label: "set-option -w", argv: ["set-option", "-w", "-t", "{P}", "window-size", "latest"], mustFailForPrefix: true },
      { label: "set-environment", argv: ["set-environment", "-t", "{S}", "FOO", "1"], mustFailForPrefix: true },
      { label: "resize-window", argv: ["resize-window", "-t", "{P}", "-A"], mustFailForPrefix: true },
      { label: "capture-pane", argv: ["capture-pane", "-p", "-t", "{P}"], mustFailForPrefix: true },
      { label: "pipe-pane", argv: ["pipe-pane", "-t", "{P}"], mustFailForPrefix: true },
    ];

    test("the exact forms reach the live session", async () => {
      await h.spawnSession("Dev1", ["-c", "/tmp"]);
      for (const c of calls) {
        const r = await h.run(exact(c.argv, "Dev1"));
        expect([c.label, r.exitCode, r.stderr.trim()]).toEqual([c.label, 0, ""]);
      }
    });

    test("with only Dev1 alive, the target Dev reaches nothing", async () => {
      await h.spawnSession("Dev1", ["-c", "/tmp"]);
      // The bug being fixed: a bare name is a prefix match.
      expect((await h.run(["has-session", "-t", "Dev"])).exitCode).toBe(0);
      for (const c of calls) {
        const r = await h.run(exact(c.argv, "Dev"));
        expect([c.label, r.exitCode !== 0]).toEqual([c.label, c.mustFailForPrefix]);
      }
      // display-message answers nothing for an unmatched pane: pane_current_path turns that into an error.
      const d = await h.run(["display-message", "-p", "-t", "=Dev:", "#{pane_current_path}"]);
      expect(d.stdout.trim()).toBe("");
      // kill-session and attach-session must not touch Dev1.
      expect((await h.run(["kill-session", "-t", "=Dev"])).exitCode).not.toBe(0);
      expect((await h.run(["has-session", "-t", "=Dev1"])).exitCode).toBe(0);
    });

    test("a session named Dev can be created beside Dev1 and each is addressed exactly", async () => {
      await h.spawnSession("Dev1", ["-c", "/tmp"]);
      await h.spawnSession("Dev", ["-c", "/tmp"]);
      expect((await h.run(["set-option", "-t", "=Dev:", "@cubilot_harness", "pi"])).exitCode).toBe(0);
      expect((await h.run(["set-option", "-t", "=Dev1:", "@cubilot_harness", "claude"])).exitCode).toBe(0);
      expect((await h.run(["show-options", "-v", "-t", "=Dev:", "@cubilot_harness"])).stdout.trim()).toBe("pi");
      expect((await h.run(["show-options", "-v", "-t", "=Dev1:", "@cubilot_harness"])).stdout.trim()).toBe("claude");
      expect((await h.run(["kill-session", "-t", "=Dev"])).exitCode).toBe(0);
      expect((await h.run(["has-session", "-t", "=Dev1"])).exitCode).toBe(0);
    });
  });
});
