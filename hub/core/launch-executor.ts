// The hub's own launch executor (hub-first-browser 7.2). It takes the `launch`, `close` and `input` requests of the
// launch queue, does the work with launch-role.ts (setup), launch-command.ts (command) and tmux.ts (session), and
// answers each request with the same ack the Rust shell sent before. It decides nothing: the stage logic decides what
// a launch is (hub/kinds/stage.ts), and this file never runs git.
//
// The queue gives the executor a `host`: attach a consumer, ack a request, send the failed closes again. A test
// replaces the executor with a module named by CUBILOT_LAUNCH_EXECUTOR (tests/helpers/fake-executor.ts); that module
// exports a `start(host)` function. No session is ever killed on hub exit.

import { prepareLaunch, type LaunchDeps } from "./launch-role";
import { startAgentSession } from "./session-create";
import { createTerminal } from "./terminal";
import { createTmux, tmuxFromEnv, type Tmux } from "./tmux";
import type { AckOutcome, AckStatus, LaunchRequest } from "./launch-types";

type Env = Record<string, string | undefined>;

export type ExecutorHost = {
  /** The newest consumer replaces the older one. Requests that were never delivered are sent at once. */
  attach(send: (req: LaunchRequest) => void, signal: AbortSignal): void;
  ack(id: string, outcome: AckOutcome): { status: AckStatus; message?: string };
  /** Sends again every close that has no ack. */
  resendCloses(): void;
};

export type ExecutorModule = { start(host: ExecutorHost, env: Env): void | Promise<void> };

/** The text must be one line of at most 1024 bytes without a control character (pty.rs input_line). */
export function inputLine(text: string): string | null {
  if (!text || Buffer.byteLength(text) > 1024 || /\p{Cc}/u.test(text)) return null;
  return `${text}\r`;
}

/** Same ack bodies as the shell: killed -> spawned, no such session -> absent, tmux failure -> plain error. */
export function closeAck(outcome: { ok: boolean } | { error: string }): AckOutcome {
  if ("error" in outcome) return { result: "error", error: outcome.error };
  return outcome.ok ? { result: "spawned" } : { result: "error", error: "no such session", absent: true };
}

export type ExecutorDeps = {
  /** Null: tmux is not available; every request is answered with an error. */
  tmux: Tmux | null;
  env?: Env;
  prepare?: typeof prepareLaunch;
  launchDeps?: LaunchDeps;
  /** How often one ack is sent again when the hub could not record it (default 10) and the pause (default 1 s). The hub drops a launch with no ack in 15 s. */
  ackTries?: number;
  ackPauseMs?: number;
  /** A close that failed stays pending; it is sent again after this time (default 5 s). */
  closeRetryMs?: number;
  /** The input session stays attached this long after the write (default 150 ms). */
  inputHoldMs?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startLaunchExecutor(host: ExecutorHost, deps: ExecutorDeps): { stop(): void } {
  const env = deps.env ?? process.env;
  const prepare = deps.prepare ?? prepareLaunch;
  const tries = deps.ackTries ?? 10;
  const pause = deps.ackPauseMs ?? 1000;
  const retryMs = deps.closeRetryMs ?? 5000;
  const hold = deps.inputHoldMs ?? 150;
  const ac = new AbortController();

  /** Session names with a launch in progress. A close for the name waits until the launch ends (no "no such session" before new-session). */
  const launching = new Map<string, Promise<void>>();
  /** Close ids that ended for good (killed, or absent): a repeated id only sends the stored ack again. */
  const closed = new Map<string, AckOutcome>();
  const closing = new Set<string>();

  /** Sends one answer until the hub records it. The work is never repeated because an ack failed. */
  async function reply(id: string, outcome: AckOutcome): Promise<void> {
    for (let n = 1; n <= tries && !ac.signal.aborted; n++) {
      let r: { status: AckStatus; message?: string };
      try {
        r = host.ack(id, outcome);
      } catch (e) {
        r = { status: "error", message: (e as Error).message };
      }
      if (r.status === "pending") {
        // A close that failed: the hub keeps it pending. Send it again later.
        const t = setTimeout(() => host.resendCloses(), retryMs);
        (t as { unref?: () => void }).unref?.();
        return;
      }
      if (r.status !== "error") return;
      console.error(`[launch-executor] ack ${id}: ${r.message ?? "not recorded"} (try ${n} of ${tries})`);
      if (n < tries) await sleep(pause);
    }
  }

  async function runLaunch(req: Extract<LaunchRequest, { kind: "launch" }>): Promise<AckOutcome> {
    try {
      if (!deps.tmux) throw new Error("tmux is not available");
      if (!req.cwd) throw new Error("the launch has no working folder");
      const plan = await prepare(
        {
          agent: req.session, room: req.room, role: req.role, cwd: req.cwd, harness: req.harness as "claude" | "pi",
          model: req.model, provider: req.provider, effort: req.effort,
          stageId: req.stage_id, firstMessage: req.prompt || null,
        },
        env,
        deps.launchDeps,
      );
      await startAgentSession(deps.tmux, plan);
      return { result: "spawned" };
    } catch (e) {
      return { result: "error", error: (e as Error).message };
    }
  }

  async function runClose(req: Extract<LaunchRequest, { kind: "close" }>): Promise<void> {
    const stored = closed.get(req.id);
    if (stored) return void (await reply(req.id, stored));
    if (closing.has(req.id)) return; // already waiting or running: the repeat adds nothing
    closing.add(req.id);
    try {
      const wait = launching.get(req.session);
      if (wait) await wait;
      let outcome: AckOutcome;
      try {
        if (!deps.tmux) throw new Error("tmux is not available");
        outcome = closeAck({ ok: await deps.tmux.killSession(req.session) });
        closed.set(req.id, outcome); // final: never kill again for this id
      } catch (e) {
        outcome = closeAck({ error: (e as Error).message }); // a tmux failure is not final
      }
      await reply(req.id, outcome);
    } finally {
      closing.delete(req.id);
    }
  }

  async function runInput(req: Extract<LaunchRequest, { kind: "input" }>): Promise<AckOutcome> {
    try {
      const line = inputLine(req.text);
      if (!line) throw new Error("the input is empty, too long or holds a control character");
      if (!deps.tmux) throw new Error("tmux is not available");
      if (!(await deps.tmux.hasSession(req.session))) throw new Error(`unknown session: ${req.session}`);
      // Raw PTY write to a client of that one session; never `tmux send-keys`.
      const viewer = await createTerminal(deps.tmux).attach(req.session, { onData: () => {} });
      try {
        viewer.write(line);
        await sleep(hold);
      } finally {
        viewer.close();
      }
      return { result: "spawned" };
    } catch (e) {
      return { result: "error", error: (e as Error).message };
    }
  }

  function handle(req: LaunchRequest): void {
    if (req.kind === "close") {
      void runClose(req);
    } else if (req.kind === "input") {
      void runInput(req).then((o) => reply(req.id, o));
    } else {
      const work = runLaunch(req);
      launching.set(req.session, work.then(() => {}));
      void work.then(async (o) => {
        launching.delete(req.session);
        await reply(req.id, o);
      });
    }
  }

  host.attach(handle, ac.signal);
  return { stop: () => ac.abort() };
}

/** What the hub starts: the test module of CUBILOT_LAUNCH_EXECUTOR, else the real executor on the tmux of the env. */
export async function startExecutor(host: ExecutorHost, env: Env = process.env): Promise<void> {
  const path = env.CUBILOT_LAUNCH_EXECUTOR?.trim();
  if (path) {
    const mod = (await import(path)) as ExecutorModule;
    await mod.start(host, env);
    return;
  }
  let tmux: Tmux | null = null;
  try {
    tmux = createTmux(tmuxFromEnv(env));
  } catch (e) {
    console.error("[launch-executor] tmux is not available:", (e as Error).message);
  }
  startLaunchExecutor(host, { tmux, env });
}
