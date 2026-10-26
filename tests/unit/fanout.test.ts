// The agents-ambient scope: only the named agents get the entry. Not the UI, not the chat log, not the transcript.

import { describe, expect, test } from "bun:test";
import { createFanout } from "../../hub/core/fanout";
import { DropQueue } from "../../hub/core/sse";
import type { Entry } from "../../hub/core/types";

function make() {
  const chatLog: Entry[] = [];
  const ui = new DropQueue<Entry>(10);
  const queues: Record<string, Entry[]> = { bob: [], alice: [] };
  const agents = {
    entries: () => Object.keys(queues).map((n) => [n, { name: n, room: "r1" }] as const)[Symbol.iterator](),
    isPermanent: () => false,
    enqueueFor: (n: string, e: Entry) => { queues[n]?.push(e); return true; },
  } as any;
  let id = 0;
  const f = createFanout({ chatLog, uiSubscribers: new Set([ui]), agents, historyLimit: 100, ledgerDb: null, nextEntryId: () => ++id });
  return { f, chatLog, ui, queues };
}

describe("fanout scope agents-ambient", () => {
  test("only the named agents receive it; the UI does not; the chat log does not keep it", async () => {
    const t = make();
    const entry: Entry = { type: "agent.reload", from: "system", to: "bob", room: "r1" };
    t.f.send(entry, { kind: "agents-ambient", agents: ["bob"] });
    expect(t.queues.bob).toEqual([entry]);
    expect(t.queues.alice).toEqual([]);
    expect(t.chatLog).toEqual([]);
    expect(entry.id).toBeUndefined(); // never persisted: no id, so no replay on a reconnect
    const got = await Promise.race([t.ui.pull(new AbortController().signal), new Promise((r) => setTimeout(() => r("none"), 50))]);
    expect(got).toBe("none");
  });
  test("control: a to-agents entry is kept in the chat log and reaches the UI", async () => {
    const t = make();
    t.f.send({ from: "system", to: "bob", text: "x", room: "r1" }, { kind: "to-agents", agents: ["bob"] });
    expect(t.chatLog).toHaveLength(1);
    expect(await t.ui.pull(new AbortController().signal)).toMatchObject({ text: "x" });
  });
});
