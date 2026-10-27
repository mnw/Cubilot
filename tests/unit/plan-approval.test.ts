// ui/features/plan-approval.js: the waiting plans above the board and the Approve button. Runs the real file against a
// tiny fake DOM (bun has no DOM); the layout was checked in a browser.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

class El {
  children: El[] = [];
  className = "";
  textContent = "";
  title = "";
  hidden = false;
  disabled = false;
  type = "";
  dataset: Record<string, string> = {};
  handlers: Record<string, () => void> = {};
  attrs: Record<string, string> = {};
  focused = false;
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() { this.focused = true; }
  constructor(public tag = "div") {}
  append(...c: El[]) { this.children.push(...c); }
  appendChild(c: El) { this.children.push(c); return c; }
  replaceChildren(...c: El[]) { this.children = c; }
  addEventListener(e: string, fn: () => void) { this.handlers[e] = fn; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}

// A Storage stand-in. `fail` makes every call throw, as a blocked or full store does.
function fakeStore(initial: Record<string, string> = {}, fail = false, failSet = false) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k: string) => { if (fail) throw new Error("blocked"); return m.has(k) ? m.get(k)! : null; },
    setItem: (k: string, v: string) => { if (fail || failSet) throw new Error("blocked"); m.set(k, v); },
  };
}

const plan = (id: string, drafts: string[], high: string[]) => ({
  request_id: id, stage_id: "s_0123456789abcdef",
  high_tickets: high.map((t, i) => ({ id: `t_${i}`, title: t, status: "queued" })), draft_tickets: drafts,
});

function setup(first: any[], room = "r1", postStatus = 200, firstNeeds: any[] = [], store: any = fakeStore()) {
  const root = new El();
  const heading = new El("h3");
  root.hidden = true;
  let waiting = first;
  let needs = firstNeeds;
  const calls: Array<{ path: string; init?: any }> = [];
  const messages: any[] = [];
  const observers: Record<string, () => void> = {};
  const held = { hold: false, queue: [] as Array<() => void> };
  const g: any = {
    document: { getElementById: (id: string) => (id === "plan-waiting" ? root : null), querySelector: () => heading, createElement: (t: string) => new El(t), addEventListener() {} },
    localStorage: store, SELECTED_ROOM: room, ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
    KindCardRenderer: { observe: (p: string, fn: () => void) => { observers[p] = fn; } },
    addMessage: (m: any) => messages.push(m),
    authedFetch: async (path: string, init?: any) => {
      calls.push({ path, init });
      // A test can hold the GET answers (they come back later, in the order held) to model a slow hub.
      if (!init?.method && held.hold) {
        const snapshot = path.endsWith("/needs-you") ? { room: path.split("/")[2], requests: needs } : { room: path.split("/")[2], waiting };
        await new Promise<void>((r) => held.queue.push(r));
        return { ok: true, json: async () => snapshot };
      }
      if (init?.method === "POST") return postStatus === 200 ? { ok: true, json: async () => ({}) } : { ok: false, status: postStatus, json: async () => ({ error: "only the human may approve a request" }) };
      if (path.endsWith("/needs-you")) return { ok: true, json: async () => ({ room, requests: needs }) };
      return { ok: true, json: async () => ({ room, waiting }) };
    },
    globalThis: {} as any, setTimeout, clearTimeout, console,
  };
  // `with (g)`: the file's free names (SELECTED_ROOM ...) are looked up on g at each use, so a test can change the room.
  const api = new Function("g", "with (g) {" + readFileSync("ui/features/plan-approval.js", "utf8") + "\nreturn PlanApproval; }")(g);
  return { api, root, heading, store, calls, messages, observers, setWaiting: (w: any[]) => { waiting = w; }, setNeeds: (n: any[]) => { needs = n; }, held, release: () => { const q = held.queue.splice(0); for (const r of q) r(); }, g };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("plan waits for your approval (spec-review 4.4)", () => {
  test("the scroll area is a focusable named region with a height cap", () => {
    const html = readFileSync("ui/index.html", "utf8");
    const tag = html.match(/<div[^>]*id="plan-waiting"[^>]*>/)![0];
    expect(tag).toContain('role="region"');
    expect(tag).toContain('aria-label="Needs you and plans waiting"');
    expect(tag).toContain('tabindex="0"');
    const css = readFileSync("ui/styles/kinds.css", "utf8");
    expect(css).toContain("max-height: max(120px, 20vh); overflow-y: auto;");
    expect(css).toContain(".plan-waiting:focus-visible { outline:");
  });

  test("a waiting request shows its plan, what holds it and an Approve button; nothing waiting hides the strip", async () => {
    const e = setup([plan("req-1", ["t_a", "t_b"], ["Ship the release"])]);
    await flush();
    expect(e.root.hidden).toBe(false);
    const t = e.root.text();
    expect(t).toContain("Plan req-1 waits for your approval");
    expect(t).toContain("2 draft tickets wait.");
    expect(t).not.toContain("2 draft tickets waits");
    expect(t).toContain("Ship the release");
    expect(e.root.all().filter((x) => x.tag === "button" && x.textContent === "Approve")).toHaveLength(1);
    expect(e.calls[0].path).toBe("/requests/r1/waiting");

    e.setWaiting([]);
    await e.api.load();
    expect(e.root.hidden).toBe(true);
    expect(e.root.children).toHaveLength(0);
  });

  test("Approve posts to the approve route as the human, then reads the list again", async () => {
    const e = setup([plan("req-1", ["t_a"], ["Big one"])]);
    await flush();
    const btn = e.root.all().find((x) => x.tag === "button")!;
    e.setWaiting([]);
    btn.handlers.click();
    await flush();
    const post = e.calls.find((c) => c.init?.method === "POST")!;
    expect(post.path).toBe("/requests/r1/req-1/approve");
    expect(JSON.parse(post.init.body)).toEqual({ by: "human" });
    expect(e.root.hidden).toBe(true);
    expect(e.messages).toHaveLength(0);
  });

  test("a refused approval says why in the chat and keeps the row", async () => {
    const e = setup([plan("req-1", ["t_a"], ["Big one"])], "r1", 403);
    await flush();
    e.root.all().find((x) => x.tag === "button")!.handlers.click();
    await flush();
    expect(e.messages[0].text).toBe("Approving req-1 failed: only the human may approve a request");
    expect(e.root.hidden).toBe(false);
  });

  test("no room selected shows nothing and reads nothing", async () => {
    const e = setup([plan("req-1", ["t_a"], ["x"])], "__ALL__");
    await flush();
    expect(e.root.hidden).toBe(true);
    expect(e.calls).toHaveLength(0);
  });

  test("ticket and stage events reload the list", async () => {
    const e = setup([]);
    await flush();
    expect(Object.keys(e.observers).sort()).toEqual(["stage", "ticket"]);
    e.setWaiting([plan("req-2", ["t_a"], ["x"])]);
    e.observers.ticket();
    await new Promise((r) => setTimeout(r, 300));
    expect(e.root.hidden).toBe(false);
  });

  test("Needs you lists the findings of a request that failed twice, above the approvals; none hides it", async () => {
    const needs = [{
      request_id: "req-7", fail_count: 2,
      findings: [
        { ticket_id: "t_a", title: "Plan A", severity: "blocking", text: "no criteria" },
        { ticket_id: "t_b", title: null, severity: "suggestion", text: "rename it" },
      ],
    }];
    const e = setup([plan("req-1", ["t_a"], ["Big one"])], "r1", 200, needs);
    await flush();
    expect(e.root.hidden).toBe(false);
    const rows = e.root.children;
    expect(rows[0].className).toBe("plan-row"); // the Approve row comes first, so its button shows without a scroll
    expect(rows[1].className).toBe("needs-row");
    const t = rows[1].text();
    expect(t).toContain("Needs you: req-7 failed its spec review 2 times");
    expect(t).toContain("Plan A: no criteria");
    expect(t).toContain("t_b: rename it"); // the id when the ticket has no title
    expect(rows[1].all().filter((x) => /^needs-finding( |$)/.test(x.className))).toHaveLength(2);
    e.setNeeds([]);
    e.setWaiting([]);
    await e.api.load();
    expect(e.root.hidden).toBe(true);
  });

  test("Needs you alone shows without an approval row, and a failed needs-you read keeps the approvals", async () => {
    const e = setup([], "r1", 200, [{ request_id: "req-8", fail_count: 3, findings: [] }]);
    await flush();
    expect(e.root.hidden).toBe(false);
    expect(e.root.children).toHaveLength(1);
    expect(e.root.text()).toContain("failed its spec review 3 times");
    expect(e.root.text()).toContain("No findings were listed.");
  });

  test("the rows of the old room go at once when the room changes, and an old answer never comes back after All rooms", async () => {
    const e = setup([plan("req-1", ["t_a"], ["Big one"])], "A", 200, [{ request_id: "req-7", fail_count: 2, findings: [] }]);
    await flush();
    expect(e.root.hidden).toBe(false);
    // The hub is slow: room A is read again, the answer is held ...
    e.held.hold = true;
    const reload = e.api.load();
    await flush();
    // ... and the view moves to All rooms before the answer arrives.
    e.g.SELECTED_ROOM = "__ALL__";
    await e.api.load();
    expect(e.root.hidden).toBe(true); // cleared at once, no wait for any answer
    e.release();
    await reload;
    await flush();
    expect(e.root.hidden).toBe(true);
    expect(e.root.children).toHaveLength(0); // the late answer of room A did not draw its rows again
  });

  test("moving from room A to room B clears A's rows before B answers, and A's late answer is dropped", async () => {
    const e = setup([plan("req-1", ["t_a"], ["Big one"])], "A", 200, []);
    await flush();
    expect(e.root.text()).toContain("req-1");
    e.held.hold = true;
    e.setWaiting([plan("req-b", ["t_b"], ["B high"])]); // what the hub answers for room B
    e.g.SELECTED_ROOM = "B";
    const loadB = e.api.load();
    await flush();
    expect(e.root.hidden).toBe(true); // A's rows are gone while B has not answered
    e.release();
    await loadB;
    await flush();
    expect(e.root.text()).toContain("req-b");
    expect(e.root.text()).not.toContain("req-1");
  });

  test("the verb agrees with the number of draft tickets: one waits, two wait", async () => {
    const one = setup([plan("req-1", ["t_a"], ["Big one"])]);
    await flush();
    expect(one.root.text()).toContain("1 draft ticket waits.");
    expect(one.root.text()).not.toContain("1 draft ticket wait.");
    const two = setup([plan("req-2", ["t_a", "t_b"], ["Big one"])]);
    await flush();
    expect(two.root.text()).toContain("2 draft tickets wait.");
  });
});

// Needs you: Collapse and Clear (state in localStorage per room).
describe("Needs you collapse and clear", () => {
  const need = (id: string, stage: string) => ({
    request_id: id, fail_count: 2, latest_fail_stage_id: stage,
    findings: [
      { ticket_id: "t_a", title: "A", severity: "blocking", text: "one" },
      { ticket_id: "t_b", title: "B", severity: "suggestion", text: "two" },
    ],
  });
  const btn = (e: any, label: string) => e.root.all().find((x: El) => x.tag === "button" && x.attrs["aria-label"] === label);
  const rows = (e: any) => e.root.all().filter((x: El) => x.className === "needs-row").map((x: El) => x.dataset.request);

  test("Collapse: aria-expanded and name flip, the title and the count stay, the findings go; Expand reverses", async () => {
    const e = setup([], "r1", 200, [need("req-1", "s_1")]);
    await flush();
    const c = btn(e, "Collapse req-1");
    expect(c.attrs["aria-expanded"]).toBe("true");
    c.handlers.click();
    const x = btn(e, "Expand req-1");
    expect(x.attrs["aria-expanded"]).toBe("false");
    expect(x.focused).toBe(true);
    expect(e.root.text()).toContain("req-1 failed its spec review 2 times");
    expect(e.root.text()).toContain("2 open findings");
    expect(e.root.all().filter((n: El) => /^needs-finding( |$)/.test(n.className))).toHaveLength(0);
    expect(JSON.parse(e.store.m.get("cubilot.needs.collapsed.r1"))).toEqual({ "req-1": "s_1" });
    x.handlers.click();
    expect(btn(e, "Collapse req-1").attrs["aria-expanded"]).toBe("true");
    expect(e.root.all().filter((n: El) => /^needs-finding( |$)/.test(n.className))).toHaveLength(2);
  });

  test("a collapse is kept per room and request, and a newer FAIL (new stage id) expands the block again", async () => {
    const store = fakeStore({ "cubilot.needs.collapsed.r1": JSON.stringify({ "req-1": "s_1" }) });
    const same = setup([], "r1", 200, [need("req-1", "s_1")], store);
    await flush();
    expect(btn(same, "Expand req-1")).toBeTruthy();
    const newer = setup([], "r1", 200, [need("req-1", "s_2")], store);
    await flush();
    expect(btn(newer, "Collapse req-1")).toBeTruthy();
    const other = setup([], "r2", 200, [need("req-1", "s_1")], store);
    await flush();
    expect(btn(other, "Collapse req-1")).toBeTruthy();
  });

  test("Clear hides the block, keeps it hidden after a reload, and a newer FAIL shows it again", async () => {
    const store = fakeStore();
    const e = setup([], "r1", 200, [need("req-1", "s_1")], store);
    await flush();
    expect(btn(e, "Clear req-1").textContent).toBe("Clear");
    btn(e, "Clear req-1").handlers.click();
    expect(e.root.hidden).toBe(true);
    expect(JSON.parse(store.m.get("cubilot.needs.cleared.r1")!)).toEqual(["s_1"]);
    const again = setup([], "r1", 200, [need("req-1", "s_1")], store);
    await flush();
    expect(again.root.hidden).toBe(true);
    const newer = setup([], "r1", 200, [need("req-1", "s_2")], store);
    await flush();
    expect(rows(newer)).toEqual(["req-1"]);
  });

  test("focus after Clear: the next block's Collapse button, else the previous one's, else the first column heading", async () => {
    const e = setup([], "r1", 200, [need("a", "s_a"), need("b", "s_b"), need("c", "s_c")]);
    await flush();
    btn(e, "Clear b").handlers.click();
    expect(rows(e)).toEqual(["a", "c"]);
    expect(btn(e, "Collapse c").focused).toBe(true);
    btn(e, "Clear c").handlers.click();
    expect(btn(e, "Collapse a").focused).toBe(true);
    expect(e.heading.focused).toBe(false);
    btn(e, "Clear a").handlers.click();
    expect(e.heading.focused).toBe(true);
    expect(e.heading.attrs.tabindex).toBe("-1");
  });

  test("clear filter: a cleared id hides, a newer id shows; the collapse map resets on a new id", () => {
    const e = setup([]);
    const store = e.store;
    store.m.set("cubilot.needs.cleared.r1", JSON.stringify(["s_1"]));
    const list = [need("a", "s_1"), need("b", "s_2")];
    expect(e.api._visibleNeeds("r1", list).map((n: any) => n.request_id)).toEqual(["b"]);
    expect(e.api._visibleNeeds("r2", list)).toHaveLength(2);
    e.api._setCollapsed("r1", list[0], true);
    expect(e.api._isCollapsed("r1", list[0])).toBe(true);
    expect(e.api._isCollapsed("r1", need("a", "s_9"))).toBe(false);
  });

  test("malformed storage shows every block, expanded", () => {
    for (const bad of ["{not json", "42", '{"a":1}', '[1,2]', '"x"']) {
      const e = setup([], "r1", 200, [], fakeStore({ "cubilot.needs.cleared.r1": bad, "cubilot.needs.collapsed.r1": bad }));
      const list = [need("a", "s_1")];
      expect(e.api._visibleNeeds("r1", list)).toEqual(list);
      expect(e.api._isCollapsed("r1", list[0])).toBe(false);
    }
  });

  test("only setItem throws, a cleared id is stored: every block shown", async () => {
    const e = setup([], "r1", 200, [need("a", "s_1"), need("b", "s_2")],
      fakeStore({ "cubilot.needs.cleared.r1": JSON.stringify(["s_1"]) }, false, true));
    await flush();
    expect(rows(e)).toEqual(["b"]);
    btn(e, "Clear b").handlers.click();
    expect(rows(e)).toEqual(["a", "b"]);
  });

  test("getItem and setItem that throw: every block shown, Clear and Collapse do not break", async () => {
    const e = setup([], "r1", 200, [need("a", "s_1")], fakeStore({}, true));
    await flush();
    expect(rows(e)).toEqual(["a"]);
    btn(e, "Clear a").handlers.click();
    expect(rows(e)).toEqual(["a"]);
    btn(e, "Collapse a").handlers.click();
    expect(btn(e, "Collapse a")).toBeTruthy();
  });
});
