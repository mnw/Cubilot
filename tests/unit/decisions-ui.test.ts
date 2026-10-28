// ui/features/decisions.js: the Needs-you lines of open and escalated decisions. Runs the real file against a tiny fake
// DOM (bun has no DOM); the layout was checked in a browser.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

class El {
  children: El[] = [];
  className = "";
  textContent = "";
  id = "";
  hidden = false;
  disabled = false;
  type = "";
  dataset: Record<string, string> = {};
  handlers: Record<string, () => void> = {};
  attrs: Record<string, string> = {};
  static active: El | null = null;
  constructor(public tag = "div") {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() { El.active = this; }
  append(...c: El[]) { this.children.push(...c); }
  appendChild(c: El) { this.children.push(c); return c; }
  replaceChildren(...c: El[]) { this.children = c; }
  addEventListener(e: string, fn: () => void) { this.handlers[e] = fn; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}

const T1 = "t_00000000000000a1";
const decision = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, status, room: "r1", ticket_id: T1, request_id: null,
  body: {
    block: `Block of ${id}.`, facts: ["1. Commit 9e2250b."], next: "The lead applies it.",
    options: [{ id: "A", label: "Keep", effect: "No change.", recommended: true }, { id: "B", label: "Widen", effect: "One ticket." }],
    human_actions: [{ ticket_id: T1, action: "Tell the lead." }],
  },
  ...over,
});

function setup(first: any[], room = "r1", postStatus = 200) {
  const root = new El();
  root.hidden = true;
  let list = first;
  const calls: Array<{ path: string; init?: any }> = [];
  const messages: any[] = [];
  const observers: Record<string, () => void> = {};
  const g: any = {
    document: { getElementById: (id: string) => (id === "decisions-needs" ? root : null), createElement: (t: string) => new El(t), addEventListener() {} },
    SELECTED_ROOM: room, ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
    KindCardRenderer: { observe: (p: string, fn: () => void) => { observers[p] = fn; } },
    addMessage: (m: any) => messages.push(m),
    authedFetch: async (path: string, init?: any) => {
      calls.push({ path, init });
      if (init?.method === "POST") return postStatus === 200 ? { ok: true, json: async () => ({}) } : { ok: false, status: postStatus, json: async () => ({ error: "only the human may answer a decision" }) };
      return { ok: true, json: async () => ({ room, decisions: list }) };
    },
    globalThis: {} as any, setTimeout, clearTimeout, console,
  };
  const api = new Function("g", "with (g) {" + readFileSync("ui/features/decisions.js", "utf8") + "\nreturn Decisions; }")(g);
  return { api, root, calls, messages, observers, setList: (l: any[]) => { list = l; }, g };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const lines = (root: El) => root.all().filter((x) => x.className.includes("decision-line"));

describe("decisions waiting for you (human-escalation 1.4)", () => {
  test("the region is a focusable named region above the board", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const tag = html.match(/<div[^>]*id="decisions-needs"[^>]*>/)![0];
    expect(tag).toContain('role="region"');
    expect(tag).toContain('aria-label="Decisions waiting for you"');
    expect(tag).toContain('tabindex="0"');
    expect(html.indexOf('id="decisions-needs"')).toBeLessThan(html.indexOf('id="ticket-board-columns"'));
    expect(html).toContain('<script src="features/decisions.js"></script>');
  });

  test("one line for each open or escalated decision, none for answered", async () => {
    const e = setup([decision("d_1", "open"), decision("d_2", "escalated"), decision("d_3", "answered"), decision("d_4", "applied")]);
    await flush();
    expect(e.calls[0].path).toBe("/decisions?room=r1");
    expect(e.root.hidden).toBe(false);
    const l = lines(e.root);
    expect(l).toHaveLength(2);
    expect(l.map((x) => x.textContent)).toEqual([`Needs you: Block of d_1. (${T1})`, `Needs you: Block of d_2. (${T1})`]);
    expect(e.root.text()).not.toContain("d_3");
  });

  test("an answered decision leaves; nothing left hides the region", async () => {
    const e = setup([decision("d_1", "open")]);
    await flush();
    e.setList([]);
    await e.api.load();
    expect(e.root.hidden).toBe(true);
    expect(e.root.children).toHaveLength(0);
  });

  test("the line is a button that opens the full decision; the answer buttons are the options", async () => {
    const e = setup([decision("d_1", "open")]);
    await flush();
    const line = lines(e.root)[0];
    expect(line.tag).toBe("button");
    expect(line.attrs["aria-expanded"]).toBe("false");
    expect(e.root.all().filter((x) => x.className.includes("decision-answer"))).toHaveLength(0);

    line.handlers.click();
    const open = lines(e.root)[0];
    expect(open.attrs["aria-expanded"]).toBe("true");
    expect(El.active).toBe(open);   // focus stays on the line after the toggle
    const t = e.root.text();
    expect(t).toContain("1. Commit 9e2250b.");
    expect(t).toContain("A: Keep. No change. (recommended)");
    expect(t).toContain(`${T1}: Tell the lead.`);
    expect(t).toContain("Next: The lead applies it.");
    const answers = e.root.all().filter((x) => x.className.includes("decision-answer"));
    expect(answers.map((b) => b.dataset.option)).toEqual(["A", "B"]);
    expect(answers.every((b) => b.tag === "button" && b.textContent.length > 0)).toBe(true);
  });

  test("an answer button calls the answer route with the option, then reads the list again", async () => {
    const e = setup([decision("d_1", "open")]);
    await flush();
    lines(e.root)[0].handlers.click();
    e.setList([]);
    e.root.all().find((x) => x.dataset.option === "B")!.handlers.click();
    await flush();
    const post = e.calls.find((c) => c.init?.method === "POST")!;
    expect(post.path).toBe("/decisions/d_1/answer");
    expect(JSON.parse(post.init.body)).toEqual({ by: "human", option: "B" });
    expect(e.root.hidden).toBe(true);
  });

  test("a refused answer shows its error in the chat and keeps the line", async () => {
    const e = setup([decision("d_1", "open")], "r1", 403);
    await flush();
    lines(e.root)[0].handlers.click();
    e.root.all().find((x) => x.dataset.option === "A")!.handlers.click();
    await flush();
    expect(e.messages[0].text).toContain("Answering d_1 failed: only the human may answer a decision");
    expect(lines(e.root)).toHaveLength(1);
  });

  test("a decision event reads the list again, with no timer of its own; All rooms shows nothing", async () => {
    const e = setup([decision("d_1", "open")]);
    await flush();
    expect(typeof e.observers.decision).toBe("function");
    e.setList([decision("d_1", "open"), decision("d_2", "open")]);
    e.observers.decision();
    await new Promise((r) => setTimeout(r, 300));
    expect(lines(e.root)).toHaveLength(2);

    e.g.SELECTED_ROOM = "__ALL__";
    await e.api.load();
    expect(e.root.hidden).toBe(true);
  });
});
