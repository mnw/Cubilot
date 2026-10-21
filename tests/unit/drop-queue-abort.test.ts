import { describe, expect, test } from "bun:test";
import { DropQueue } from "../../hub/core/sse";

// What a stream takeover relies on: aborting a waiting reader consumes nothing, and an item
// that was already handed to a reader is that reader's, never lost in between.
describe("DropQueue and abort", () => {
  test("aborting a pending pull removes the waiter: the next item goes to the next reader", async () => {
    const q = new DropQueue<string>(10);
    const oldAc = new AbortController();
    const old = q.pull(oldAc.signal).then(() => "old got it", () => "old aborted");
    const fresh = q.pull(new AbortController().signal);   // the newer stream, second in line
    oldAc.abort();                                          // the takeover
    q.push("event");
    expect(await old).toBe("old aborted");
    expect(await fresh).toBe("event");
  });

  test("an item queued while no reader waits is kept for the next reader", async () => {
    const q = new DropQueue<string>(10);
    const oldAc = new AbortController();
    const old = q.pull(oldAc.signal).catch(() => "aborted");
    oldAc.abort();
    q.push("kept");
    expect(await old).toBe("aborted");
    expect(await q.pull(new AbortController().signal)).toBe("kept");
  });

  test("an item already handed to a reader stays its own: a later abort does not take it back", async () => {
    const q = new DropQueue<string>(10);
    const ac = new AbortController();
    const reader = q.pull(ac.signal);
    q.push("handed");           // resolves the waiting reader at once
    ac.abort();                 // the takeover lands right after
    expect(await reader).toBe("handed");
    q.push("next");
    expect(await q.pull(new AbortController().signal)).toBe("next");
  });

  test("requeueFront gives an item back to the first waiting reader, else to the front of the queue", async () => {
    const q = new DropQueue<string>(10);
    const waiting = q.pull(new AbortController().signal);
    q.requeueFront("to-the-waiter");
    expect(await waiting).toBe("to-the-waiter");
    q.push("second");
    q.requeueFront("first");                                  // taken earlier, so it goes ahead of newer items
    expect(await q.pull()).toBe("first");
    expect(await q.pull()).toBe("second");
  });

  test("requeueFront follows the overflow rule of push: a full queue drops the oldest, which is the returned item", async () => {
    const q = new DropQueue<string>(2);
    q.push("a"); q.push("b");
    q.requeueFront("old");
    expect(await q.pull()).toBe("a");
    expect(await q.pull()).toBe("b");
  });

  test("claim: an item on loan goes back to the front AT THE ABORT, before any later reader pulls", async () => {
    const q = new DropQueue<string>(10);
    const ac = new AbortController();
    const lease = q.claim(ac.signal);              // waiting
    q.push("first");                                // handed to the waiting reader
    q.push("second");                               // queued behind it
    ac.abort();                                     // synchronous: "first" is back in front now
    expect(await q.pull()).toBe("first");           // a successor that starts before the old continuation sees the order
    expect(await q.pull()).toBe("second");
    expect((await lease)!.take()).toBe(false);      // and the old reader must drop what it was given
  });

  test("claim: take() commits the item; a later abort takes nothing back", async () => {
    const q = new DropQueue<string>(10);
    const ac = new AbortController();
    const lease = (await (async () => { const l = q.claim(ac.signal); q.push("mine"); return l; })())!;
    expect(lease.item).toBe("mine");
    expect(lease.take()).toBe(true);
    ac.abort();
    q.push("next");
    expect(await q.pull()).toBe("next");            // "mine" was not requeued
  });

  test("claim: aborted while nothing arrived resolves null and leaves the queue alone", async () => {
    const q = new DropQueue<string>(10);
    const ac = new AbortController();
    const lease = q.claim(ac.signal);
    ac.abort();
    expect(await lease).toBeNull();
    q.push("kept");
    expect(await q.pull()).toBe("kept");
    expect(await q.claim(AbortSignal.abort())).toBeNull();   // already aborted: nothing is taken
  });

  test("claim: an item already queued is on loan too", async () => {
    const q = new DropQueue<string>(10);
    q.push("a"); q.push("b");
    const ac = new AbortController();
    const lease = q.claim(ac.signal);               // takes "a" from the queue
    ac.abort();
    expect(await q.pull()).toBe("a");
    expect(await q.pull()).toBe("b");
    expect((await lease)!.take()).toBe(false);
  });
});

