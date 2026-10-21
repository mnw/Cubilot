// SSE infrastructure: bounded queue with drop-oldest semantics and the
// ReadableStream-backed response wrapper with a 15s heartbeat.

import { corsHeaders } from "./auth";

export const HEARTBEAT_MS = 15_000;

// Drop-oldest queue — when full, the oldest item is evicted instead of blocking
// the producer. Prevents a slow subscriber from growing hub memory indefinitely.
export class DropQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  constructor(private readonly max: number) {}

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) {
      w(v);
      return;
    }
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(v);
  }

  // Gives back an item a reader had already taken but will not use (it was aborted in between): it goes to
  // the first waiting reader, else to the FRONT of the queue, so the order is kept. Same overflow rule as
  // push(): when the queue is full the oldest item (this one) is the one dropped.
  requeueFront(v: T): void {
    const w = this.waiters.shift();
    if (w) {
      w(v);
      return;
    }
    if (this.items.length >= this.max) return;
    this.items.unshift(v);
  }

  // Like pull(), for a reader that can be taken over: the item it receives is only on LOAN until it calls
  // take(). If the signal aborts first, the item goes back to the front of the queue AT THE ABORT, in the
  // same synchronous run, so a successor that starts before the old reader's continuation runs still
  // sees the queue in its original order. take() returns false when that already happened: the reader
  // must then drop the item and end. Resolves null when aborted while nothing had arrived.
  claim(signal: AbortSignal): Promise<{ item: T; take(): boolean } | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let held = false;
      let item!: T;
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        if (held) {
          held = false;
          this.requeueFront(item);
        } else {
          resolve(null);
        }
      };
      const hold = (v: T) => {
        item = v;
        held = true;
        resolve({
          item: v,
          take: () => {
            if (!held) return false;
            held = false;
            signal.removeEventListener("abort", onAbort);
            return true;
          },
        });
      };
      const waiter = (v: T) => hold(v);
      if (this.items.length) hold(this.items.shift()!);
      else this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async pull(signal?: AbortSignal): Promise<T> {
    if (this.items.length) return this.items.shift()!;
    return new Promise<T>((resolve, reject) => {
      const waiter = (v: T) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      this.waiters.push(waiter);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export type SSESend = (obj: unknown, id?: number | string) => void;

export function makeSSE(
  setup: (send: SSESend, signal: AbortSignal) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const ac = new AbortController();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SSESend = (obj, id) => {
        if (closed) return;
        try {
          const idLine = id !== undefined ? `id: ${id}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(obj)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {}

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      ac.signal.addEventListener("abort", () => clearInterval(heartbeat), {
        once: true,
      });

      try {
        await setup(send, ac.signal);
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error("[sse]", e);
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      closed = true;
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    },
  });
}
