// Pinned messages to the human (ui/features/pins-model.js): what is pinned, the room filter, the unpin store, dedup.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/features/pins-model.js", "utf8"))(win);
const { isPinned, createPins, firstLine } = win.__CUBILOT_PINS__;

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const e = (id: number, over: any = {}) => ({ id, from: "Orchestrator", to: "human", room: "r1", text: `m${id}`, ts: "10:00", ...over });

describe("isPinned", () => {
  test("to the human by name or by 'you'; not 'all'; not from the human; not without a hub id", () => {
    expect(isPinned(e(1), "human")).toBe(true);
    expect(isPinned(e(1, { to: "you" }), "human")).toBe(true);
    expect(isPinned(e(1, { to: "all" }), "human")).toBe(false);
    expect(isPinned(e(1, { to: "Worker2" }), "human")).toBe(false);
    expect(isPinned(e(1, { from: "human" }), "human")).toBe(false);
    expect(isPinned(e(1, { from: "you" }), "human")).toBe(false);
    expect(isPinned({ from: "system", to: "human", text: "x" }, "human")).toBe(false);
    expect(isPinned(e(1), "")).toBe(false);   // name not known yet: only "you" pins
    expect(isPinned(e(1, { to: "you" }), "")).toBe(true);
  });
});

describe("pins", () => {
  test("newest first, deduplicated by id (a replay does not pin twice)", () => {
    const p = createPins(store(), () => "human");
    expect(p.add(e(1))).toBe(true);
    expect(p.add(e(1))).toBe(false);
    p.add(e(3)); p.add(e(2));
    expect(p.list(null, true).pins.map((x: any) => x.id)).toEqual([3, 2, 1]);
  });
  test("room filter: a room shows its pins and untagged ones; All rooms shows every pin", () => {
    const p = createPins(store(), () => "human");
    p.add(e(1, { room: "r1" })); p.add(e(2, { room: "r2" })); p.add(e(3, { room: undefined }));
    expect(p.list("r1", true).pins.map((x: any) => x.id)).toEqual([3, 1]);
    expect(p.list(null, true).pins.map((x: any) => x.id)).toEqual([3, 2, 1]);
  });
  test("at most 3 shown; the rest are counted for the '+N more' toggle", () => {
    const p = createPins(store(), () => "human");
    for (let i = 1; i <= 5; i++) p.add(e(i));
    let l = p.list(null, false);
    expect(l.pins.map((x: any) => x.id)).toEqual([5, 4, 3]);
    expect(l.hidden).toBe(2);
    l = p.list(null, true);
    expect(l.pins).toHaveLength(5);
    expect(l.hidden).toBe(0);
    expect(createPins(store(), () => "human").list(null, false).total).toBe(0);   // empty: the strip hides
  });
  test("unpin survives a reload and a replay of the same message", () => {
    const s = store();
    const p = createPins(s, () => "human");
    p.add(e(1)); p.add(e(2));
    p.unpin(1);
    expect(p.list(null, true).pins.map((x: any) => x.id)).toEqual([2]);
    const q = createPins(s, () => "human");   // reload: the chat is replayed
    q.add(e(1)); q.add(e(2));
    expect(q.list(null, true).pins.map((x: any) => x.id)).toEqual([2]);
  });
  test("a broken store reads as empty; the unpinned list is capped", () => {
    const bad = { getItem: () => "{not json", setItem: () => {} };
    expect(createPins(bad, () => "human").list(null, true).total).toBe(0);
    const s = store();
    const p = createPins(s, () => "human");
    for (let i = 1; i <= 600; i++) p.unpin(i);
    expect(JSON.parse(s.getItem("cubilot_unpinned_pins")!)).toHaveLength(500);
  });
  test("first line: the first non-empty line", () => {
    expect(firstLine("\n\n  hello\nworld")).toBe("  hello");
    expect(firstLine(undefined)).toBe("");
  });
});
