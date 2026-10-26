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
  constructor(public tag = "div") {}
  append(...c: El[]) { this.children.push(...c); }
  appendChild(c: El) { this.children.push(c); return c; }
  replaceChildren(...c: El[]) { this.children = c; }
  addEventListener(e: string, fn: () => void) { this.handlers[e] = fn; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}

const plan = (id: string, drafts: string[], high: string[]) => ({
  request_id: id, stage_id: "s_0123456789abcdef",
  high_tickets: high.map((t, i) => ({ id: `t_${i}`, title: t, status: "queued" })), draft_tickets: drafts,
});

function setup(first: any[], room = "r1", postStatus = 200, firstNeeds: any[] = []) {
  const root = new El();
  root.hidden = true;
  let waiting = first;
  let needs = firstNeeds;
  const calls: Array<{ path: string; init?: any }> = [];
  const messages: any[] = [];
  const observers: Record<string, () => void> = {};
  const held = { hold: false, queue: [] as Array<() => void> };
  const g: any = {
    document: { getElementById: (id: string) => (id === "plan-waiting" ? root : null), createElement: (t: string) => new El(t), addEventListener() {} },
    SELECTED_ROOM: room, ROOM_ALL: "__ALL__", HUMAN_NAME: "human",
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
  return { api, root, calls, messages, observers, setWaiting: (w: any[]) => { waiting = w; }, setNeeds: (n: any[]) => { needs = n; }, held, release: () => { const q = held.queue.splice(0); for (const r of q) r(); }, g };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("plan waits for your approval (spec-review 4.4)", () => {
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
    expect(rows[0].className).toBe("needs-row"); // above the approval row
    expect(rows[1].className).toBe("plan-row");
    const t = rows[0].text();
    expect(t).toContain("Needs you: req-7 failed its spec review 2 times");
    expect(t).toContain("Plan A: no criteria");
    expect(t).toContain("t_b: rename it"); // the id when the ticket has no title
    expect(rows[0].all().filter((x) => /^needs-finding( |$)/.test(x.className))).toHaveLength(2);
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
