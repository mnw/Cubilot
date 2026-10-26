// ui/kinds/stage.js: which stages the "Finished" list shows, and how it reads and updates. Runs the real file against a
// tiny fake DOM (bun has no DOM); the layout itself was checked in a browser.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

class El {
  children: El[] = [];
  className = "";
  textContent = "";
  title = "";
  dataset: Record<string, string> = {};
  constructor(public tag = "div") {}
  append(...c: El[]) { this.children.push(...c); }
  appendChild(c: El) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}

function setup(opts: { tickets: any[]; passed: any[]; failed: any[]; room?: string }) {
  const els: Record<string, El> = {
    "terminal-finished": new El(), "terminal-finished-list": new El("ul"), "terminal-finished-count": new El("span"),
  };
  const observers: Record<string, (e: any) => void> = {};
  const g: any = {
    document: { getElementById: (id: string) => els[id] ?? null, createElement: (t: string) => new El(t), addEventListener() {} },
    SELECTED_ROOM: opts.room ?? "r1",
    ROOM_ALL: "__ALL__",
    KindCardRenderer: { observe: (p: string, fn: (e: any) => void) => { observers[p] = fn; } },
    authedFetch: async (path: string) => {
      const body = path.startsWith("/tickets") ? opts.tickets : path.includes("status=passed") ? opts.passed : opts.failed;
      return { ok: true, json: async () => body };
    },
    globalThis: {} as any,
    setTimeout, clearTimeout, console,
  };
  const src = readFileSync("ui/kinds/stage.js", "utf8") + "\nreturn FinishedSessions;";
  const api = new Function(...Object.keys(g), src)(...Object.values(g));
  const rows = () => els["terminal-finished-list"].children.map((li) => li.text());
  return { api, rows, count: () => els["terminal-finished-count"].textContent, observers, g };
}

const stage = (over: Record<string, unknown>) => ({
  id: "s_x", ticket_id: "t1", request_id: null, review: null, verdict: null, role: "worker", attempt: 1,
  status: "passed", session: "worker-1", slot_seq: 1, version: 1, ...over,
});
const tickets = [{ id: "t1", title: "Ticket one", request_id: "req-a" }, { id: "t2", title: "Ticket two", request_id: null }];

describe("finished sessions list", () => {
  test("shows closed stages with a session of this room, newest first", async () => {
    const t = setup({
      tickets,
      passed: [stage({ id: "s1", version: 5 }), stage({ id: "s2", ticket_id: "t2", session: "tester-1", role: "tester", version: 9 })],
      failed: [stage({ id: "s3", status: "failed", session: "worker-2", version: 7 })],
    });
    await t.api.load();
    expect(t.count()).toBe("3");
    expect(t.rows().map((r: string) => r.split(" ")[0])).toEqual(["tester-1", "worker-2", "worker-1"]);
  });

  test("leaves out a running stage, a failed stage with no session, and a stage of another room", async () => {
    const t = setup({
      tickets,
      passed: [stage({ id: "s1" }), stage({ id: "s4", ticket_id: "t_other", session: "worker-9" })],
      failed: [stage({ id: "s5", status: "failed", session: null })],
    });
    await t.api.load();
    t.observers.stage({ snapshot: stage({ id: "s6", status: "running", session: "tester-2", version: 20 }) });
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toContain("worker-1");
  });

  test("a spec-review stage appears by its request id and shows its verdict", async () => {
    const t = setup({
      tickets,
      passed: [stage({ id: "s7", ticket_id: null, request_id: "req-a", review: "spec", verdict: "FAIL", session: "validator-1" }),
               stage({ id: "s8", ticket_id: null, request_id: "req-zzz", review: "spec", verdict: "PASS", session: "validator-2" })],
      failed: [],
    });
    await t.api.load();
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toContain("FAIL");
    expect(t.rows()[0]).toContain("Spec review of req-a");
  });

  test("a stage event adds a stage that closes; an older read never replaces a newer event; a relaunch removes it", async () => {
    const t = setup({ tickets, passed: [], failed: [] });
    await t.api.load();
    expect(t.rows()[0]).toContain("No finished sessions yet");
    t.observers.stage({ snapshot: stage({ id: "s1", version: 10 }) });
    expect(t.count()).toBe("1");
    t.observers.stage({ snapshot: stage({ id: "s1", version: 3, status: "running" }) }); // stale: ignored
    expect(t.count()).toBe("1");
    t.observers.stage({ snapshot: stage({ id: "s1", version: 11, status: "retrying" }) });
    expect(t.count()).toBe("0");
  });

  test("all rooms shows a hint and no rows", async () => {
    const t = setup({ tickets, passed: [stage({ id: "s1" })], failed: [], room: "__ALL__" });
    await t.api.load();
    expect(t.count()).toBe("0");
    expect(t.rows()[0]).toContain("Pick a room");
  });
});
