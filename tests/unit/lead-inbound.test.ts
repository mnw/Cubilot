import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRegistry } from "../../hub/core/agents";
import { createLeadInbound, LEAD_INBOUND_KINDS } from "../../hub/core/lead-inbound";

const HOUR = Date.parse("2026-10-29T13:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch {} rmSync(d, { recursive: true, force: true }); } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lead-inbound-")); dirs.push(d); return d; };
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const LEADS = [{ room: "r", lead: "Orchestrator" }];

describe("lead inbound", () => {
  test("Hourly line", () => {
    const file = join(tmp(), "metrics", "lead-inbound.jsonl");
    const m = createLeadInbound({ file, leads: () => LEADS });
    const entry = { kind: "ticket.new", text: "x".repeat(300) };
    const size = Buffer.byteLength(JSON.stringify(entry));
    for (let i = 0; i < 3; i++) m.record("Orchestrator", entry);
    m.record("worker-1", entry);
    m.flush(HOUR);
    const [line] = lines(file);
    expect(line.ticket).toEqual({ count: 3, bytes: 3 * size });
    expect(line.hour).toBe("2026-10-29T13:00:00Z");
    expect(line.room).toBe("r");
    expect(line.lead).toBe("Orchestrator");
    expect(JSON.stringify(line)).not.toContain("xxx");
  });

  test("a line has all ten keys and an hour with no entries gives zeros", () => {
    const file = join(tmp(), "l.jsonl");
    const m = createLeadInbound({ file, leads: () => LEADS });
    m.flush(HOUR);
    const [line] = lines(file);
    expect(Object.keys(line).sort()).toEqual(["hour", "room", "lead", ...LEAD_INBOUND_KINDS].sort());
    expect(Object.keys(line)).toHaveLength(10);
    for (const k of LEAD_INBOUND_KINDS) expect(line[k]).toEqual({ count: 0, bytes: 0 });
  });

  test("counters reset after a flush and each lead gets a line", () => {
    const file = join(tmp(), "l.jsonl");
    const leads = [...LEADS, { room: "s", lead: "Lead2" }];
    const m = createLeadInbound({ file, leads: () => leads });
    m.record("Lead2", { kind: "handoff.new" });
    m.flush(HOUR);
    m.flush(HOUR + 3_600_000);
    const all = lines(file);
    expect(all).toHaveLength(4);
    expect(all[1].handoff.count).toBe(1);
    expect(all[3].handoff.count).toBe(0);
  });

  test("entries sort into the seven kinds", () => {
    const file = join(tmp(), "l.jsonl");
    const m = createLeadInbound({ file, leads: () => LEADS });
    for (const e of [{ type: "briefing" }, { kind: "ticket.update" }, { kind: "handoff.update" }, { kind: "interrupt.new" }, { text: "hi" }, { kind: "stage.queued" }, { kind: "permission.new" }]) m.record("Orchestrator", e);
    m.flush(HOUR);
    const [line] = lines(file);
    for (const k of LEAD_INBOUND_KINDS) expect(line[k].count).toBe(1);
  });

  test("a read-only folder does not throw", () => {
    const d = tmp();
    const ro = join(d, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const logged: string[] = [];
    const m = createLeadInbound({ file: join(ro, "sub", "l.jsonl"), leads: () => LEADS, log: (s) => logged.push(s) });
    m.record("Orchestrator", { kind: "ticket.new" });
    expect(() => m.flush(HOUR)).not.toThrow();
    expect(existsSync(join(ro, "sub"))).toBe(false);
    expect(logged.join()).toContain("write failed");
  });

  test("the registry counts each queued entry for a lead", () => {
    const file = join(tmp(), "l.jsonl");
    const m = createLeadInbound({ file, leads: () => LEADS });
    const reg = createAgentRegistry({ defaultRoom: "r", staleMs: 60_000, queueMax: 10, resolveRoom: (r) => r ?? "r", onRosterChange() {}, onPresenceChange() {}, onEnqueue: (n, e) => m.record(n, e) });
    reg.ensure("Orchestrator", "r");
    reg.ensure("worker-1", "r");
    reg.enqueueFor("Orchestrator", { kind: "ticket.new" });
    reg.enqueueFor("worker-1", { kind: "ticket.new" });
    m.flush(HOUR);
    expect(lines(file)[0].ticket.count).toBe(1);
  });
  test("a late timer writes every missing full hour in order", () => {
    const file = join(tmp(), "l.jsonl");
    let clock = HOUR + 600_000; // 13:10
    const real = globalThis.setTimeout;
    let fire: (() => void) | null = null;
    globalThis.setTimeout = ((fn: () => void) => { fire = fn; return { unref() {} }; }) as unknown as typeof setTimeout;
    const m = createLeadInbound({ file, leads: () => LEADS, now: () => clock });
    try {
      m.start();
      m.record("Orchestrator", { kind: "ticket.new" });
      clock = HOUR + 3 * 3_600_000 + 60_000; // the 14:00 callback runs at 16:01
      fire!();
    } finally { globalThis.setTimeout = real; m.stop(); }
    const all = lines(file);
    expect(all.map((l) => l.hour)).toEqual(["2026-10-29T13:00:00Z", "2026-10-29T14:00:00Z", "2026-10-29T15:00:00Z"]);
    expect(all[0].ticket.count).toBe(1);
    expect(all[1].ticket.count).toBe(0);
  });

  test("a failed write keeps the counts for the next line", () => {
    const d = tmp();
    const ro = join(d, "ro");
    mkdirSync(ro);
    const file = join(ro, "sub", "l.jsonl");
    const m = createLeadInbound({ file, leads: () => LEADS, log() {} });
    m.record("Orchestrator", { kind: "ticket.new" });
    chmodSync(ro, 0o500);
    m.flush(HOUR);
    chmodSync(ro, 0o700);
    m.flush(HOUR + 3_600_000);
    expect(lines(file)[0].ticket.count).toBe(1);
  });

  test("Lead change", () => {
    const file = join(tmp(), "l.jsonl");
    let lead = "old";
    let clock = HOUR;
    const m = createLeadInbound({ file, leads: () => [{ room: "r", lead }], now: () => clock });
    m.record("old", { kind: "ticket.new" });
    lead = "new";
    clock += 1000;
    m.record("new", { kind: "ticket.new" });
    m.flush(HOUR);
    const [line] = lines(file);
    expect(line.lead).toBe("new");
    expect(line.ticket.count).toBe(1);
    expect(line.ticket.bytes).toBeGreaterThan(0);
  });
});
