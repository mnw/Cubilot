// Launch-request queue between the hub and the Rust shell. The hub never starts a process: it queues a
// `launch` or `close` request, the shell reads the requests from one SSE stream, does the work and answers
// each request with an ack. This file holds the queue, the delivery and the ack timer only. It knows nothing
// about stages: the stage kind decides what an ack or a time-out means (hub/kinds/stage.ts).
//
// Only hub/kinds/stage.ts may import this file (tests/unit/launch-queue.test.ts greps for it): that keeps
// "one function queues launches, and only the stage logic calls it" true by code path.

import type { HubCapabilities } from "./types";

export type LaunchRequest =
  | {
      id: string;
      kind: "launch";
      stage_id: string;
      session: string;
      role: string;
      room: string;
      harness: string;
      cwd: string | null;
      prompt: string;
      env: Record<string, string>;
    }
  | { id: string; kind: "close"; session: string };

/**
 * `spawned` means done: the session started (launch) or was closed (close). `error` for a launch ends the attempt. For a
 * close, `error` keeps the request pending (it is sent again on the next connection) unless `absent` is true: the shell
 * reports that the session does not exist, so there is nothing left to close.
 */
export type AckOutcome = { result: "spawned" } | { result: "error"; error: string; absent?: boolean };

/** What happened to a launch request: the shell answered, or no answer came in time. */
export type LaunchEnd = { by: "ack"; outcome: AckOutcome } | { by: "timeout" };

export type LaunchQueueOpts = {
  /** A launch with no ack in this time (from its delivery to the shell) counts as failed. */
  ackMs: number;
  /** How long a finished request (with its prompt) stays in memory, for late or repeated acks. Default 10 min. */
  retainMs?: number;
  onLaunchEnd(req: Extract<LaunchRequest, { kind: "launch" }>, end: LaunchEnd, cap: HubCapabilities): void;
  /** A close is done: the shell closed the session, or reported that it does not exist. Never throws into the ack. */
  onCloseEnd?(session: string, cap: HubCapabilities): void;
};

export type AckStatus = "ok" | "idempotent" | "unknown" | "conflict" | "error" | "pending";

export type LaunchQueue = {
  /**
   * Queues a request. Delivered at once when the shell is connected, else when it connects.
   * Throws for a launch whose session name still has a close without an ack: the name is reserved until that close is
   * done, because a close that is sent again would kill the new session of the same name.
   */
  push(req: LaunchRequest): void;
  /** Session names that have a close without an ack. */
  pendingCloses(): string[];
  /**
   * Called by the stream route for one shell connection; the newest connection replaces the older one.
   * Requests that were never delivered are sent, and so is every `close` that has no ack yet.
   */
  attach(send: (req: LaunchRequest) => void, signal: AbortSignal, cap: HubCapabilities): void;
  ack(id: string, outcome: AckOutcome, cap: HubCapabilities): { status: AckStatus; message?: string };
  /** For the dashboard and the tests. */
  size(): { undelivered: number; awaitingAck: number; retained: number };
  dispose(): void;
};

type Entry = {
  req: LaunchRequest;
  timer: ReturnType<typeof setTimeout> | null;
  done: AckOutcome | "timeout" | null;
  cap: HubCapabilities | null;
};

const DEFAULT_RETAIN_MS = 600_000;

export function createLaunchQueue(opts: LaunchQueueOpts): LaunchQueue {
  const retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  const undelivered: LaunchRequest[] = [];
  const sent = new Map<string, Entry>();
  let active: { send: (req: LaunchRequest) => void; cap: HubCapabilities } | null = null;

  /** The request is finished: stop its timer, drop the prompt and env, and forget it after retainMs. */
  function finish(id: string, entry: Entry, how: AckOutcome | "timeout"): void {
    entry.done = how;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.req.kind === "launch") entry.req = { ...entry.req, prompt: "", env: {}, cwd: null };
    entry.timer = setTimeout(() => sent.delete(id), retainMs);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  function arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.done) return;
      const req = entry.req;
      if (req.kind === "close") {
        // Nothing to undo for a close: it is sent again when the shell reconnects. The timer only makes it visible.
        console.error(`[launch-queue] close ${req.session} has no ack after ${opts.ackMs} ms`);
        arm(entry);
        return;
      }
      try {
        opts.onLaunchEnd(req, { by: "timeout" }, entry.cap ?? active?.cap!);
        finish(req.id, entry, "timeout");
      } catch (e) {
        // The stage change failed: the request stays pending and the time-out is tried again.
        console.error("[launch-queue] timeout handler failed, will retry:", e);
        arm(entry);
      }
    }, opts.ackMs);
  }

  function deliver(req: LaunchRequest, to: NonNullable<typeof active>): void {
    const entry: Entry = sent.get(req.id) ?? { req, timer: null, done: null, cap: to.cap };
    entry.cap = to.cap;
    sent.set(req.id, entry);
    arm(entry);
    to.send(req);
  }

  function pendingCloses(): string[] {
    const names = new Set<string>();
    for (const e of sent.values()) if (!e.done && e.req.kind === "close") names.add(e.req.session);
    for (const r of undelivered) if (r.kind === "close") names.add(r.session);
    return [...names];
  }

  return {
    push(req) {
      if (req.kind === "launch" && pendingCloses().includes(req.session)) {
        throw new Error(`session name ${req.session} is reserved: its close has no ack yet`);
      }
      if (active) deliver(req, active);
      else undelivered.push(req);
    },

    pendingCloses,

    attach(send, signal, cap) {
      const me = { send, cap };
      active = me;
      signal.addEventListener(
        "abort",
        () => {
          if (active === me) active = null;
        },
        { once: true },
      );
      // A launch sent to an older connection and not acked keeps its timer and is not sent again: a second launch of
      // the same session could start it twice. A close is safe to repeat (killing a dead session does nothing), so
      // every close without an ack goes to the new connection.
      for (const e of sent.values()) if (!e.done && e.req.kind === "close") deliver(e.req, me);
      for (const req of undelivered.splice(0)) deliver(req, me);
    },

    ack(id, outcome, cap) {
      const entry = sent.get(id);
      if (!entry) return { status: "unknown" };
      if (entry.done === "timeout") return { status: "conflict", message: "the launch timed out" };
      if (entry.done) {
        return entry.done.result === outcome.result
          ? { status: "idempotent" }
          : { status: "conflict", message: `the request was already acked as ${entry.done.result}` };
      }
      if (entry.req.kind === "launch") {
        try {
          opts.onLaunchEnd(entry.req, { by: "ack", outcome }, cap);
        } catch (e) {
          // The stage change failed. The request stays pending (its timer still runs) so the shell can ack again.
          console.error("[launch-queue] ack handler failed, request stays pending:", e);
          return { status: "error", message: "could not record the ack; send it again" };
        }
      } else if (outcome.result === "error" && !outcome.absent) {
        // The close did not happen (for example tmux was unavailable). It stays pending, is sent again on the next
        // connection, and keeps its session name reserved. Only "the session does not exist" completes it.
        console.error(`[launch-queue] close ${entry.req.session} failed, stays pending: ${outcome.error}`);
        return { status: "pending", message: "the close failed and stays pending" };
      }
      finish(id, entry, outcome);
      if (entry.req.kind === "close") {
        try {
          opts.onCloseEnd?.(entry.req.session, cap);
        } catch (e) {
          console.error("[launch-queue] close-done handler failed:", e);
        }
      }
      return { status: "ok" };
    },

    size() {
      let awaitingAck = 0;
      let retained = 0;
      for (const e of sent.values()) {
        if (e.done) retained++;
        else if (e.req.kind === "launch") awaitingAck++;
      }
      return { undelivered: undelivered.length, awaitingAck, retained };
    },

    dispose() {
      for (const e of sent.values()) if (e.timer) clearTimeout(e.timer);
      sent.clear();
      undelivered.length = 0;
      active = null;
    },
  };
}
