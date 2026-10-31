// tmux primitives of the hub (hub-first-browser, design decision 3). Same behaviour as src-tauri/src/pty.rs:
// the socket is <app data>/tmux.sock, a session target is `=name` (exact, never a prefix), LANG and LC_ALL are a UTF-8
// locale on every tmux call, new-session is `-d -x 80 -y 24`, and the hub never kills a session on exit.

import { mkdirSync, readdirSync, realpathSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { validName } from "./ids";

export type TmuxEnv = Record<string, string | undefined>;
export type TmuxOpts = { bin: string; socket: string; env?: TmuxEnv };
export type NewSession = { name: string; cwd: string; command: string; env?: string[] };

/** launchd gives the app a blank or "C" locale; claude falls back to ASCII without UTF-8. Same rule as resolve_utf8_locale. */
export function resolveLocale(env: TmuxEnv = process.env): string {
  const lang = env.LANG;
  return lang && lang.toLowerCase().includes("utf") ? lang : "en_US.UTF-8";
}

/** tmux path from env CUBILOT_TMUX (the shell passes the bundled one), socket in the app data folder. */
export function tmuxFromEnv(env: TmuxEnv = process.env): TmuxOpts {
  const bin = env.CUBILOT_TMUX?.trim();
  const dir = env.CUBILOT_DATA_DIR?.trim();
  if (!bin) throw new Error("CUBILOT_TMUX is not set");
  if (!dir) throw new Error("CUBILOT_DATA_DIR is not set");
  return { bin, socket: join(dir, "tmux.sock"), env };
}

/** `=name` names a session exactly: a bare `-t Dev` is a prefix match. */
export const sessionTarget = (name: string) => `=${name}`;
/** A pane, window or option target needs the colon: `=name` alone is rejected there. */
export const paneTarget = (name: string) => `=${name}:`;

/** Constants of the turn capture. Same values as pty.rs (CAPTURE_*). */
export const CAPTURE = {
  cols: 240,
  rows: 100,
  resizeSettleMs: 200,
  pollMs: 50,
  defaultTimeoutMs: 15_000,
  keepRecent: 10,
  quiescenceMinMs: 1_500,
  quiescenceStableMs: 1_500,
  readMaxBytes: 256 * 1024,
  tapDefaultMs: 250,
  tapMaxMs: 2_000,
} as const;

export type CaptureStatus = "alt-exit" | "idle-prompt" | "quiescence" | "timeout";
export type CaptureResult = { log_path: string; name: string; start_ms: number; end_ms: number; status: CaptureStatus };
export type CaptureOpts = {
  /** The folder of this agent's capture logs. */
  dir: string;
  /** Sends the input to the pane. The caller owns the raw PTY: tmux.ts never uses send-keys for interactive input. */
  write: (input: string) => void | Promise<void>;
  timeoutMs?: number;
};

/** A capture name or path that leaves the capture folder. The route answers 400. */
export class CapturePathError extends Error {}

const ALT_SCREEN_ENTER = Buffer.from("\x1b[?1049h");
const ALT_SCREEN_EXIT = Buffer.from("\x1b[?1049l");
const CURSOR_SHOW = Buffer.from("\x1b[?25h");
const PROMPT_GLYPH = Buffer.from("❯ ");
const DIVIDER_GLYPH = Buffer.from("─");

/** The folder of the capture logs of one agent: <root>/<agent>/captures. */
export const capturesDir = (root: string, agent: string) => join(root, agent, "captures");

/** Inline-mode idle signature: a divider line (30 or more "─"), then a `❯ ` prompt, then CURSOR_SHOW within 256 bytes. */
export function detectIdlePrompt(buf: Buffer, from = 0): boolean {
  let searchFrom = from;
  for (;;) {
    const p = buf.indexOf(PROMPT_GLYPH, searchFrom);
    if (p < 0) return false;
    const promptLineStart = buf.lastIndexOf(0x0a, p - 1);
    if (promptLineStart > 0) {
      const aboveStart = buf.lastIndexOf(0x0a, promptLineStart - 1) + 1;
      const above = buf.subarray(aboveStart, promptLineStart);
      let dividers = 0;
      for (let i = above.indexOf(DIVIDER_GLYPH); i >= 0; i = above.indexOf(DIVIDER_GLYPH, i + DIVIDER_GLYPH.length)) dividers++;
      if (dividers >= 30 && buf.subarray(0, Math.min(p + 256, buf.length)).indexOf(CURSOR_SHOW, p) >= 0) return true;
    }
    searchFrom = p + PROMPT_GLYPH.length;
  }
}

/** Keeps the newest `keep` finished logs. A `.partial` file and a non-log file stay. */
export function pruneCaptures(dir: string, keep: number): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const logs = names
    .filter((n) => n.endsWith(".log") && !n.includes(".partial"))
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const l of logs.slice(keep)) {
    try { unlinkSync(join(dir, l.n)); } catch { /* gone */ }
  }
}

/** Reads a capture log. A bare name or a path is allowed, and the file must lie inside `dir` (symlinks resolved). */
export function readCapture(dir: string, nameOrPath: string, maxBytes: number = CAPTURE.readMaxBytes): string {
  const root = resolve(dir);
  const path = resolve(isAbsolute(nameOrPath) ? nameOrPath : join(root, nameOrPath));
  if (!path.startsWith(root + sep)) throw new CapturePathError(`path outside capture dir: ${nameOrPath}`);
  const real = realpathSync(path); // ENOENT: the route answers 404
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + sep)) throw new CapturePathError(`path outside capture dir: ${nameOrPath}`);
  const bytes = readFileSync(real);
  return bytes.subarray(0, maxBytes).toString("utf8");
}

const RGB_FEATURE = ",xterm-256color:RGB";

export function createTmux({ bin, socket, env = process.env }: TmuxOpts) {
  const lang = () => resolveLocale(env);

  /** Environment of a tmux client: the UTF-8 locale on every call (a client without it prints tabs of a -F format as "_"). */
  function clientEnv(extra: TmuxEnv = {}): Record<string, string> {
    const l = lang();
    return { ...(env as Record<string, string>), LANG: l, LC_ALL: l, ...(extra as Record<string, string>) };
  }

  async function exec(args: string[]) {
    const p = Bun.spawn([bin, "-S", socket, ...args], { env: clientEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  }

  async function run(args: string[]): Promise<string> {
    const r = await exec(args);
    if (r.code !== 0) throw new Error(`tmux ${JSON.stringify(args)} failed (exit ${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  function checkName(name: string) {
    if (!validName(name)) throw new Error(`invalid session name: ${name}`);
  }

  /** Raw PTY needs the RGB feature on the server, else tmux reduces truecolour to a 256-colour index (docs/spikes/terminal-transport.md). */
  async function ensureRgb(): Promise<void> {
    const have = await exec(["show-options", "-sv", "terminal-features"]);
    if (have.code === 0 && have.stdout.includes("xterm-256color:RGB")) return;
    await run(["set-option", "-sa", "terminal-features", RGB_FEATURE]);
  }

  /** `$SHELL -ic '<command>'` so `.zshrc` aliases resolve (the `claude` alias). Single-quote escaped; the result is ONE argv element. */
  function shellWrap(command: string): string {
    const sh = (env.SHELL?.trim() || "/bin/zsh").replace(/'/g, `'\\''`);
    return `'${sh}' -ic '${command.replace(/'/g, `'\\''`)}'`;
  }

  /** The argv of `new-session`. The wrapped command stays ONE argv element (quoted-path safety). -x 80 -y 24 is load-bearing: no controlling TTY. */
  function newSessionArgv({ name, cwd, command, env: extra = [] }: NewSession): string[] {
    const l = lang();
    const argv = ["new-session", "-d", "-s", name];
    for (const e of ["TERM=xterm-256color", "COLORTERM=truecolor", `LANG=${l}`, `LC_ALL=${l}`, ...extra]) argv.push("-e", e);
    argv.push("-x", "80", "-y", "24", "-c", cwd, shellWrap(command));
    return argv;
  }

  async function newSession(s: NewSession): Promise<void> {
    checkName(s.name);
    await run(newSessionArgv(s));
    await ensureRgb();
    await exec(["set-option", "-t", paneTarget(s.name), "status", "off"]); // best effort, like pty.rs
  }

  /** true: it exists. false: tmux says it does not (no session, no server, no socket). Throws: tmux could not answer. */
  async function hasSession(name: string): Promise<boolean> {
    checkName(name);
    const r = await exec(["has-session", "-t", sessionTarget(name)]);
    if (r.code === 0) return true;
    const e = r.stderr;
    if (e.includes("can't find session") || e.includes("no server running") || (e.includes("error connecting to") && e.includes("No such file"))) return false;
    throw new Error(`tmux has-session failed: ${e.trim()}`);
  }

  async function listSessions(): Promise<string[]> {
    const r = await exec(["list-sessions", "-F", "#{session_name}"]);
    if (r.code !== 0) return []; // no server: no sessions
    return r.stdout.split("\n").filter(Boolean);
  }

  /** true: killed. false: there was no such session. Throws: tmux failed, the session may live. */
  async function killSession(name: string): Promise<boolean> {
    if (!(await hasSession(name))) return false;
    try {
      await run(["kill-session", "-t", sessionTarget(name)]);
      return true;
    } catch (e) {
      if (!(await hasSession(name).catch(() => true))) return false; // it ended between the check and the kill
      throw e;
    }
  }

  /** ensure_session_configured: false when there is no session. The first three calls are critical, the rest best effort. */
  async function reconfigure(name: string): Promise<boolean> {
    if (!(await hasSession(name))) return false;
    const l = lang();
    const pane = paneTarget(name);
    const sess = sessionTarget(name);
    await run(["set-option", "-t", pane, "remain-on-exit", "off"]);
    // resize BEFORE `latest`: resize-window -A pins manual mode that `latest` would undo.
    await run(["resize-window", "-t", pane, "-A"]);
    await run(["set-option", "-w", "-t", pane, "window-size", "latest"]);
    const soft = [
      ["set-option", "-t", pane, "status", "off"],
      ["set-environment", "-t", sess, "TERM", "xterm-256color"],
      ["set-environment", "-t", sess, "COLORTERM", "truecolor"],
      ["set-environment", "-t", sess, "LANG", l],
      ["set-environment", "-t", sess, "LC_ALL", l],
      // Not extended-keys/CSI-u: xterm.js does not speak it and Shift+Enter breaks for claude.
      ["set-option", "-t", pane, "allow-passthrough", "on"],
      ["set-option", "-w", "-u", "-t", pane, "window-size"],
      ["refresh-client", "-t", name, "-S"],
    ];
    for (const a of soft) await exec(a);
    await ensureRgb().catch(() => {});
    return true;
  }

  /**
   * Idempotent heal: a stuck pane (an interrupted capture left window-size=manual) goes back to `latest`.
   * resize -A BEFORE `latest`; `latest` first would be undone by the resize. Best effort, like pty_heal_geometry.
   */
  async function healGeometry(name: string): Promise<void> {
    checkName(name);
    const pane = paneTarget(name);
    await exec(["resize-window", "-t", pane, "-A"]);
    await exec(["set-option", "-w", "-u", "-t", pane, "window-size"]);
    await exec(["set-option", "-w", "-t", pane, "window-size", "latest"]);
    await exec(["refresh-client", "-t", name, "-S"]);
  }

  /** `capture-pane -p` returns the FULL current screen. It waits `ms` (0..2000, default 250) first. A failed call gives "". */
  async function tapRead(name: string, ms: number = CAPTURE.tapDefaultMs): Promise<string> {
    checkName(name);
    const wait = Math.min(Math.max(Number.isFinite(ms) ? ms : CAPTURE.tapDefaultMs, 0), CAPTURE.tapMaxMs);
    if (wait > 0) await Bun.sleep(wait);
    const r = await exec(["capture-pane", "-p", "-t", paneTarget(name)]);
    return r.code === 0 ? r.stdout : "";
  }

  /**
   * The single TUI capture primitive: geometry 240x100 first (the resize redraw must not enter the log), then
   * pipe-pane to a log, then the input, then poll for a completion marker. On every exit pipe-pane goes off BEFORE the
   * geometry returns, so the restore redraw stays out of the log. A timeout log is kept for forensics.
   */
  async function captureTurn(name: string, input: string, { dir, write, timeoutMs = CAPTURE.defaultTimeoutMs }: CaptureOpts): Promise<CaptureResult> {
    checkName(name);
    if (!(await hasSession(name))) throw new Error(`no session: ${name}`);
    mkdirSync(dir, { recursive: true });
    const pane = paneTarget(name);
    let geometrySet = false;
    let pipeOn = false;
    try {
      await run(["set-option", "-w", "-t", pane, "window-size", "manual"]);
      geometrySet = true;
      await run(["resize-window", "-t", pane, "-x", String(CAPTURE.cols), "-y", String(CAPTURE.rows)]);
      await Bun.sleep(CAPTURE.resizeSettleMs);

      const startMs = Date.now();
      const logName = `turn-${startMs}.log`;
      const logPath = join(dir, logName);
      writeFileSync(logPath, "");
      await run(["pipe-pane", "-o", "-t", pane, `cat >> '${logPath.replace(/'/g, `'\\''`)}'`]);
      pipeOn = true;
      await write(input);

      let buf = Buffer.alloc(0);
      let read = 0;
      const t0 = performance.now();
      let lastChange = t0;
      let altSeen = false;
      let status: CaptureStatus = "timeout";
      while (performance.now() - t0 < timeoutMs) {
        const all = readFileSync(logPath);
        if (all.length > read) {
          buf = all;
          read = all.length;
          lastChange = performance.now();
        }
        if (!altSeen && buf.indexOf(ALT_SCREEN_ENTER) >= 0) altSeen = true;
        if (altSeen) {
          const lastEnter = buf.lastIndexOf(ALT_SCREEN_ENTER);
          if (buf.indexOf(ALT_SCREEN_EXIT, lastEnter + ALT_SCREEN_ENTER.length) >= 0) { status = "alt-exit"; break; }
        } else if (detectIdlePrompt(buf)) { status = "idle-prompt"; break; }
        const now = performance.now();
        if (buf.length > 0 && now - t0 >= CAPTURE.quiescenceMinMs && now - lastChange >= CAPTURE.quiescenceStableMs) { status = "quiescence"; break; }
        await Bun.sleep(CAPTURE.pollMs);
      }
      if (status !== "timeout") pruneCaptures(dir, CAPTURE.keepRecent);
      return { log_path: logPath, name: logName, start_ms: startMs, end_ms: Date.now(), status };
    } finally {
      if (pipeOn) await exec(["pipe-pane", "-t", pane]);
      if (geometrySet) await healGeometry(name);
    }
  }

  return { bin, socket, lang, clientEnv, exec, run, newSessionArgv, newSession, hasSession, listSessions, killSession, reconfigure, ensureRgb, healGeometry, tapRead, captureTurn };
}

export type Tmux = ReturnType<typeof createTmux>;
