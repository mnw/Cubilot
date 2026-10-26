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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // An agent name may hold spaces (and dots). The pane streams the attach client's output and ends with the
  // session; pty.rs emits the output and exit events from that stream under a hex-encoded event name
  // (pty_event / ptyEventName), so the name never reaches Tauri's event-name rules. Here: the tmux side of it,
  // with a spaced name and the exact target forms pty.rs uses (`=name`).
  test(
    "an agent name with a space streams output through the attach client and the stream ends with the session",
    async () => {
      const name = "orchestrator-Test room";
      await h.spawnSession(name, ["-c", "/tmp", "echo STREAM-MARK-1; sleep 2"]);
      expect((await h.run(["has-session", "-t", `=${name}`])).exitCode).toBe(0);
      // `script` gives the attach client the terminal it needs (pty.rs uses a real PTY pair).
      const proc = Bun.spawn(["script", "-q", "/dev/null", h.tmux, "-S", h.sock, "attach-session", "-t", `=${name}`], {
        stdout: "pipe", stderr: "pipe", stdin: Bun.file("/dev/null"),
      });
      const out = await new Response(proc.stdout).text(); // the exit event: the stream ends when the session ends
      await proc.exited;
      expect(out).toContain("STREAM-MARK-1");
      expect((await h.run(["has-session", "-t", `=${name}`])).exitCode).not.toBe(0);
    },
    15000,
  );

  // Known limit, found with the event-name fix: tmux itself rewrites a '.' in a session NAME to '_', and a target
  // `=a.b` then parses `.b` as a pane. A dotted agent name therefore does not round-trip through tmux.
  test("tmux rewrites a dot in a session name (a dotted agent name does not round-trip)", async () => {
    await h.run(["new-session", "-d", "-s", "t a.b", "-x", "80", "-y", "24"]);
    const names = (await h.run(["list-sessions", "-F", "#{session_name}"])).stdout.trim().split("\n");
    expect(names).toEqual(["t a_b"]);
    expect((await h.run(["has-session", "-t", "=t a.b"])).exitCode).not.toBe(0);
    expect((await h.run(["has-session", "-t", "=t a_b"])).exitCode).toBe(0);
  });

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

// The Dock case (pi-path): the app has launchd's minimal PATH, so a Pi shim that needs `node` fails there. pty.rs puts
// `PATH='<login-shell PATH>'` in front of a Pi spawn command (with_pi_path), the way it does CHATBRIDGE_AGENT. Not
// `new-session -e PATH=...`: tmux keeps that value in the session but starts the pane command with the server's PATH.
// Here a cold tmux server with a minimal PATH stands for the app, and a fake tool found only on the resolved PATH
// stands for node. The Rust unit test pins the command text; this one pins what tmux and the shell do with it.
describe("pty plumbing — Pi session PATH", () => {
  const MINIMAL = "/usr/bin:/bin";

  test("a Pi command with a PATH prefix sees the resolved PATH and its tool; a Claude command keeps the server PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cubilot-pi-path-"));
    try {
      const tools = join(dir, "tools");
      mkdirSync(tools);
      const tool = join(tools, "cubilot-fake-node");
      writeFileSync(tool, "#!/bin/sh\necho ok\n");
      chmodSync(tool, 0o755);
      const probe = join(dir, "probe.sh");
      writeFileSync(probe, `command -v cubilot-fake-node >/dev/null 2>&1; echo $? > "${dir}/$1.rc"; printf '%s' "$PATH" > "${dir}/$1.path"\n`);
      const tmuxBin = Bun.which(h.tmux) ?? h.tmux;
      // Cold server: the first new-session starts it, with the minimal PATH in its environment (the app's case).
      const env = { HOME: process.env.HOME ?? dir, SHELL: "/bin/sh", PATH: MINIMAL, TERM: "xterm-256color" };
      const start = async (name: string, prefix: string, envPairs: string[] = []) => {
        const cmd = `${prefix}/bin/sh '${probe}' ${name}`;
        const argv = [tmuxBin, "-S", h.sock, "new-session", "-d", "-s", name, ...envPairs.flatMap((e) => ["-e", e]), "-x", "80", "-y", "24", "-c", "/tmp", cmd];
        const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
        const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        expect(await p.exited, err).toBe(0);
        const deadline = Date.now() + 5000;
        while (!existsSync(`${dir}/${name}.path`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        return { rc: readFileSync(`${dir}/${name}.rc`, "utf8").trim(), path: readFileSync(`${dir}/${name}.path`, "utf8") };
      };
      const resolved = `${tools}:${MINIMAL}`;
      const pi = await start("pi-probe", `PATH='${resolved}' `);
      expect(pi.path).toBe(resolved);
      expect(pi.rc).toBe("0"); // the shim dependency is found
      const claude = await start("claude-probe", "");
      expect(claude.path).toBe(MINIMAL); // no PATH change
      expect(claude.rc).not.toBe("0");
      // why it is a prefix: `-e PATH=` reaches the session environment but not the pane command (tmux 3.5a)
      const viaE = await start("e-probe", "", [`PATH=${resolved}`]);
      expect(viaE.path).toBe(MINIMAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// C6b: a role launch with a skill off names `<key>.view/...` in BOTH of its --skill flags (Pi) or BOTH of its --plugin-dir
// flags (Claude); a launch with an empty off-list names the agent link and no view (the pinned command). The Rust tests pin the
// command text (pty.rs) and the view build and mode parser (skills.rs). These scenarios pin what tmux and the kernel do with
// it: the pane start command keeps every path, a process that names the paths sees only the skills that are on, and a symlink
// swap changes what the same paths list (the reload boundary).
describe("pty plumbing — skill view", () => {
  const KEY = "6162"; // hex of "ab"

  // <agents>/<KEY>.view-<gen>/{worker,shared}/skills/<skill>, the published link <KEY>.view, and the agent link <KEY> -> v
  // with every skill (the empty off-list case names the link).
  async function layout(dir: string) {
    const { symlinkSync } = await import("node:fs");
    const agents = join(dir, "agents");
    const full = { worker: ["a", "b"], shared: ["s"] };
    const filtered = { worker: ["b"], shared: ["s"] };
    const swapped = { worker: ["a", "b"], shared: [] as string[] };
    for (const [gen, sel] of [[1, filtered], [2, swapped]] as const) {
      for (const [g, skills] of Object.entries(sel)) {
        mkdirSync(join(agents, `${KEY}.view-${gen}`, g, "skills"), { recursive: true });
        for (const k of skills) mkdirSync(join(agents, `${KEY}.view-${gen}`, g, "skills", k));
      }
    }
    for (const [g, skills] of Object.entries(full)) {
      for (const k of skills) mkdirSync(join(dir, "v", g, "skills", k), { recursive: true });
    }
    symlinkSync(join(dir, "v"), join(agents, KEY));
    symlinkSync(`${KEY}.view-1`, join(agents, `${KEY}.view`));
    return { agents };
  }

  // A probe that lists each path it is given, waits for `go`, lists them again.
  function probe(dir: string) {
    const f = join(dir, "probe.sh");
    writeFileSync(
      f,
      `i=0; for p in "$@"; do i=$((i+1)); ls "$p" > "${dir}/before-$i.txt"; done\nwhile [ ! -e "${dir}/go" ]; do sleep 0.1; done\n` +
        `i=0; for p in "$@"; do i=$((i+1)); ls "$p" > "${dir}/after-$i.txt"; done\nsleep 30\n`
    );
    return f;
  }
  const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  const waitFor = async (f: string) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(f) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };

  // flags: each element is "<flag> '<path>'" in the shape pty.rs writes
  for (const harness of ["pi", "claude"] as const) {
    test(`${harness}: the start command keeps both view paths, both list only what is on, and a symlink swap changes what they list`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cubilot-skill-view-"));
      try {
        const { agents } = await layout(dir);
        const { symlinkSync, renameSync } = await import("node:fs");
        const view = join(agents, `${KEY}.view`);
        // Pi: --skill <view>/<role>/skills and <view>/shared/skills. Claude: --plugin-dir <view>/<role> and <view>/shared.
        const [flag, a, b] =
          harness === "pi" ? ["--skill", `${view}/worker/skills`, `${view}/shared/skills`] : ["--plugin-dir", `${view}/worker`, `${view}/shared`];
        const listed = harness === "pi" ? [a, b] : [`${a}/skills`, `${b}/skills`];
        const cmd = `CHATBRIDGE_ROLE='worker' /bin/sh '${probe(dir)}' ${listed.map((p) => `'${p}'`).join(" ")} ${flag} '${a}' ${flag} '${b}'`;
        const r = await h.run(["new-session", "-d", "-s", "ab-view", "-x", "80", "-y", "24", "-c", "/tmp", cmd]);
        expect(r.exitCode, r.stderr).toBe(0);
        await waitFor(`${dir}/before-2.txt`);
        expect(lines(`${dir}/before-1.txt`)).toEqual(["b"]);
        expect(lines(`${dir}/before-2.txt`)).toEqual(["s"]);
        const start = await h.run(["list-panes", "-t", "ab-view", "-F", "#{pane_start_command}"]);
        expect(start.stdout).toContain(`${flag} '${a}' ${flag} '${b}'`);
        // tmux prints the one-argument command as ONE double-quoted word: skills::mode_from_command splits it twice for this
        // (pinned on a real pane by the Rust test the_mode_is_read_back_from_a_real_pane_for_both_harnesses)
        expect(start.stdout.trim()).toMatch(/^".*"$/);
        // the hub's swap: a temp link, then a rename over the published link
        symlinkSync(`${KEY}.view-2`, join(agents, `${KEY}.view.tmp`));
        renameSync(join(agents, `${KEY}.view.tmp`), view);
        writeFileSync(`${dir}/go`, "");
        await waitFor(`${dir}/after-2.txt`);
        expect(lines(`${dir}/after-1.txt`)).toEqual(["a", "b"]);
        expect(lines(`${dir}/after-2.txt`)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${harness}: an empty off-list names the agent link and no view; both paths list every skill`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cubilot-skill-link-"));
      try {
        const { agents } = await layout(dir);
        const link = join(agents, KEY);
        const [flag, a, b] =
          harness === "pi" ? ["--skill", `${link}/worker/skills`, `${link}/shared/skills`] : ["--plugin-dir", `${link}/worker`, `${link}/shared`];
        const listed = harness === "pi" ? [a, b] : [`${a}/skills`, `${b}/skills`];
        const cmd = `CHATBRIDGE_ROLE='worker' /bin/sh '${probe(dir)}' ${listed.map((p) => `'${p}'`).join(" ")} ${flag} '${a}' ${flag} '${b}'`;
        const r = await h.run(["new-session", "-d", "-s", "ab-link", "-x", "80", "-y", "24", "-c", "/tmp", cmd]);
        expect(r.exitCode, r.stderr).toBe(0);
        await waitFor(`${dir}/before-2.txt`);
        expect(lines(`${dir}/before-1.txt`)).toEqual(["a", "b"]);
        expect(lines(`${dir}/before-2.txt`)).toEqual(["s"]);
        const start = await h.run(["list-panes", "-t", "ab-link", "-F", "#{pane_start_command}"]);
        expect(start.stdout).toContain(`${flag} '${a}' ${flag} '${b}'`);
        expect(start.stdout).not.toContain(".view");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
