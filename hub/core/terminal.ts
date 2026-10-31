// One viewer of one tmux session: a Bun.Terminal (raw PTY) running `tmux attach -t =<agent>` (hub-first-browser,
// design decision 3). Never `tmux -C`. A read-only viewer attaches with `-f read-only,ignore-size`, so it cannot type
// and its size does not change the session. The controller attaches without flags and sets the size.

import { sessionTarget, type Tmux } from "./tmux";

export type AttachOpts = {
  readOnly?: boolean;
  cols?: number;
  rows?: number;
  /** Raw PTY bytes. */
  onData: (chunk: Uint8Array) => void;
  /** The attach client ended (the session ended or the viewer closed). */
  onExit?: () => void;
};

export type Viewer = {
  write: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  exited: Promise<number>;
};

export function attachArgv(tmux: Pick<Tmux, "bin" | "socket">, agent: string, readOnly = false): string[] {
  const flags = readOnly ? ["-f", "read-only,ignore-size"] : [];
  return [tmux.bin, "-S", tmux.socket, "attach", ...flags, "-t", sessionTarget(agent)];
}

export function createTerminal(tmux: Tmux) {
  async function attach(agent: string, opts: AttachOpts): Promise<Viewer> {
    if (!(await tmux.hasSession(agent))) throw new Error(`no session: ${agent}`); // validates the name first
    await tmux.ensureRgb().catch(() => {});
    const readOnly = opts.readOnly ?? false;
    const proc = Bun.spawn(attachArgv(tmux, agent, readOnly), {
      env: tmux.clientEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
      terminal: {
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        name: "xterm-256color",
        data: (_t, chunk) => opts.onData(chunk),
      },
    });
    proc.exited.then(() => opts.onExit?.());
    return {
      write: (d) => proc.terminal!.write(d),
      resize: (c, r) => proc.terminal!.resize(c, r),
      close: () => {
        try { proc.kill(); proc.terminal?.close(); } catch { /* gone */ }
      },
      exited: proc.exited,
    };
  }
  return { attach };
}

export type Terminal = ReturnType<typeof createTerminal>;
