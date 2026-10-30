// tmux primitives of the hub (hub-first-browser, design decision 3). Same behaviour as src-tauri/src/pty.rs:
// the socket is <app data>/tmux.sock, a session target is `=name` (exact, never a prefix), LANG and LC_ALL are a UTF-8
// locale on every tmux call, new-session is `-d -x 80 -y 24`, and the hub never kills a session on exit.

import { join } from "node:path";
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

  /** The argv of `new-session`. `command` stays ONE argv element (quoted-path safety). -x 80 -y 24 is load-bearing: no controlling TTY. */
  function newSessionArgv({ name, cwd, command, env: extra = [] }: NewSession): string[] {
    const l = lang();
    const argv = ["new-session", "-d", "-s", name];
    for (const e of ["TERM=xterm-256color", "COLORTERM=truecolor", `LANG=${l}`, `LC_ALL=${l}`, ...extra]) argv.push("-e", e);
    argv.push("-x", "80", "-y", "24", "-c", cwd, command);
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

  return { bin, socket, lang, clientEnv, exec, run, newSessionArgv, newSession, hasSession, listSessions, killSession, reconfigure, ensureRgb };
}

export type Tmux = ReturnType<typeof createTmux>;
