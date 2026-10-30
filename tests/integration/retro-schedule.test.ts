// Part 21 group 4: the stage sweep creates one retrospective stage a week for each room with a ticket event. In process, no mocks of the hub.
// Dates are local time (the schedule is Monday 06:00 hub local time). 2026-11-09 is a Monday: ISO week 2026-W46, window 2026-11-02 06:00 to 2026-11-09 06:00.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/repo"; // sets CUBILOT_DATA_DIR to a temp folder
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { buildKinds } from "../../hub/kinds";
import { createStageRuntime } from "../../hub/kinds/stage";
import { retroWeekAt, retroWeekWindow } from "../../hub/core/retro";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const at = (day: number, h = 0, min = 0, month = 10) => new Date(2026, month, day, h, min).getTime(); // month 10 = November
const MON = (h = 6, min = 0) => at(9, h, min);

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retro-sched-"));
  saved = { db: process.env.CUBILOT_LEDGER_DB, fd: process.env.CUBILOT_FACTORY_DIR, fv: process.env.CUBILOT_FACTORY_VERSION };
  process.env.CUBILOT_LEDGER_DB = join(dir, "ledger.db");
});
afterEach(() => {
  for (const [k, v] of [["CUBILOT_LEDGER_DB", saved.db], ["CUBILOT_FACTORY_DIR", saved.fd], ["CUBILOT_FACTORY_VERSION", saved.fv]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function env() {
  const project = mkdtempSync(join(dir, "proj-"));
  sh(project, "git", "init", "-q", "-b", "main");
  sh(project, "git", "config", "user.email", "t@t");
  sh(project, "git", "config", "user.name", "t");
  writeFileSync(join(project, "a.txt"), "1");
  sh(project, "git", "add", ".");
  sh(project, "git", "commit", "-qm", "one");
  sh(project, "git", "branch", "staging");
  const db = new Database(":memory:");
  migrateLedger(db);
  for (const k of buildKinds(db)) k.migrate?.(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  for (const room of ["A", "B"]) setRoomSettings(db, room, { project_folder: project });
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  let n = 0;
  /** A ticket in `room` with one event of kind `ticket.created` at `when`. */
  const ticketEvent = (room: string, when: number, kind = "ticket.created") => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, ?, 'T', 'c', 'low', 'medium', 'a', 'queued', NULL, ?, ?, 1)`,
      [id, room, when, when],
    );
    insertEvent(db, id, kind, "Orchestrator", {}, when);
    return id;
  };
  const retroStages = (room?: string) =>
    db.query<{ id: string; room: string; retro_week: string; status: string }, []>("SELECT id, room, retro_week, status FROM stage WHERE review = 'retro' ORDER BY rowid").all().filter((s) => !room || s.room === room);
  const launches = () => sent.filter((x): x is Extract<LaunchRequest, { kind: "launch" }> => x.kind === "launch");
  return { project, db, rt, cap, sent, ticketEvent, retroStages, launches };
}

describe("the week and its window", () => {
  test("Monday 06:00 starts the week; before it nothing is built; the label is the ISO week", () => {
    expect(retroWeekAt(MON(5, 59))).toBeNull();
    const w = retroWeekAt(MON())!;
    expect(w).toEqual({ week: "2026-W46", since: at(2, 6), until: MON() });
    expect(retroWeekAt(at(10, 12))!.week).toBe("2026-W46"); // Tuesday
    expect(retroWeekAt(at(15, 23, 59))!.week).toBe("2026-W46"); // Sunday
    expect(retroWeekAt(at(16, 6))!.week).toBe("2026-W47");
  });

  test("the label maps back to the same window; year edges follow ISO", () => {
    expect(retroWeekWindow("2026-W46")).toEqual(retroWeekAt(MON()));
    expect(retroWeekWindow("2026-W99")).toBeNull();
    expect(retroWeekWindow("bad")).toBeNull();
    // Monday 2026-12-28 is in 2026-W53; Monday 2027-01-04 is in 2027-W01.
    expect(retroWeekAt(new Date(2026, 11, 28, 7).getTime())!.week).toBe("2026-W53");
    expect(retroWeekAt(new Date(2027, 0, 4, 7).getTime())!.week).toBe("2027-W01");
    expect(retroWeekWindow("2026-W53")!.until).toBe(new Date(2026, 11, 28, 6).getTime());
  });
});

describe("the weekly schedule", () => {
  test("a room with a ticket event in the window gets one stage and its evidence file; the second sweep adds nothing", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12));
    e.rt.sweep(e.cap, MON(6, 0));
    const [s] = e.retroStages();
    expect(s).toMatchObject({ room: "A", retro_week: "2026-W46" });
    const file = join(dir, "retro", "A", "2026-W46.json");
    expect(existsSync(file)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["room", "since", "until", "flow", "stages", "findings", "human", "causes", "reports", "improvements"]);
    e.rt.sweep(e.cap, MON(6, 0));
    e.rt.sweep(e.cap, at(12, 9));
    expect(e.retroStages()).toHaveLength(1);
    expect(e.launches()).toHaveLength(1);
  });

  test("a cancelled stage of the week leaves room for a new one; a live one does not", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12));
    e.rt.sweep(e.cap, MON());
    e.rt.api.move(e.retroStages()[0].id, { to: "cancelled", reason: "x" }, "system", e.cap);
    // The sweep of this week was done in memory; a new runtime (a hub restart) looks again.
    const rt2 = createStageRuntime(e.db, { ackMs: 60_000 });
    rt2.module.migrate(e.db);
    rt2.sweep(e.cap, at(11, 8));
    expect(e.retroStages().filter((s) => s.status !== "cancelled")).toHaveLength(1);
  });

  test("a restarted hub does not make a second stage for the week", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12));
    e.rt.sweep(e.cap, MON());
    const rt2 = createStageRuntime(e.db, { ackMs: 60_000 });
    rt2.module.migrate(e.db);
    rt2.sweep(e.cap, at(11, 8));
    expect(e.retroStages()).toHaveLength(1);
  });

  test("a room with no ticket event in the window gets no stage and no file", () => {
    const e = env();
    e.ticketEvent("A", at(1, 12)); // before the window (Nov 2 06:00)
    e.ticketEvent("B", MON(6, 0)); // at the end bound: outside [since, until)
    e.rt.sweep(e.cap, MON(6, 1));
    expect(e.retroStages()).toHaveLength(0);
    expect(existsSync(join(dir, "retro"))).toBe(false);
  });

  test("a hub started on Tuesday creates the stage of the current week; a missed week is not built later", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12)); // week W46 window
    e.ticketEvent("A", at(20, 12)); // week W47 window is Nov 9 06:00 .. Nov 16 06:00; this is W48's
    e.rt.sweep(e.cap, MON(5, 59)); // Monday before 06:00: nothing yet
    expect(e.retroStages()).toHaveLength(0);
    e.rt.sweep(e.cap, at(10, 14)); // Tuesday
    expect(e.retroStages().map((s) => s.retro_week)).toEqual(["2026-W46"]);
    // The hub was down for the whole of W47. It starts in W48: only W48 is built, W47 never.
    const e2 = env();
    e2.ticketEvent("A", at(12, 12));
    e2.ticketEvent("A", at(19, 12));
    e2.rt.sweep(e2.cap, at(24, 9)); // Tuesday of W48; window Nov 16 06:00 .. Nov 23 06:00
    expect(e2.retroStages().map((s) => s.retro_week)).toEqual(["2026-W48"]);
  });

  test("each room with activity gets its own stage and file", () => {
    const e = env();
    e.ticketEvent("A", at(3, 12));
    e.ticketEvent("B", at(4, 12), "ticket.done");
    e.rt.sweep(e.cap, MON());
    expect(e.retroStages().map((s) => s.room)).toEqual(["A", "B"]);
    expect(readdirSync(join(dir, "retro")).sort()).toEqual(["A", "B"]);
  });

  test("the schedule uses no model: no network call, and the only launch is the retrospective stage", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12));
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((..._a: unknown[]) => {
      calls++;
      throw new Error("no network in the schedule");
    }) as unknown as typeof fetch;
    try {
      e.rt.sweep(e.cap, MON());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
    const l = e.launches();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ role: "retrospective", room: "A" });
    expect(e.db.query("SELECT COUNT(*) AS n FROM stage WHERE review IS NOT 'retro'").get()).toEqual({ n: 0 });
    // The code of the schedule imports no model client.
    for (const f of ["hub/core/retro.ts"]) expect(readFileSync(join(import.meta.dir, "../..", f), "utf8")).not.toMatch(/anthropic|openai|fetch\(/i);
  });
});

describe("the first message", () => {
  test("it holds the evidence file of the week and the proposal titles of the previous retrospective", () => {
    const factory = join(dir, "factory");
    Bun.spawnSync(["mkdir", "-p", join(factory, "v1", "retrospective")]);
    writeFileSync(join(factory, "v1", "retrospective", "first-message.md"), readFileSync(join(import.meta.dir, "../../factory/retrospective/first-message.md"), "utf8"));
    process.env.CUBILOT_FACTORY_DIR = factory;
    process.env.CUBILOT_FACTORY_VERSION = "v1";
    const e = env();
    // The previous week: a passed stage with a result that holds two proposals.
    e.db.run("INSERT INTO stage (id, review, role, status, room, retro_week) VALUES ('s_00000000000000aa', 'retro', 'retrospective', 'passed', 'A', '2026-W45')");
    e.db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES ('h_1', 'retrospective-1', 'Orchestrator', 'result', ?, 'accepted', ?, ?)",
      [JSON.stringify({ stage_id: "s_00000000000000aa", proposals: [{ title: "As the lead, I want a lock wait limit" }, { title: "As the human, I want fewer Approve waits" }] }), at(3), at(4)],
    );
    // The week's improvement: a ticket of a retro request with a measure line.
    e.db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES ('t_00000000000000ab', 'A', 'As the lead, I want a lock wait limit', 'Target measure: lock_wait_s from 60 to 20 (retrospective s_00000000000000aa)', 'low', 'medium', 'a', 'queued', 'r-2026-11-03-retro', ?, ?, 1)`,
      [at(3), at(3)],
    );
    insertEvent(e.db, "t_00000000000000ab", "ticket.created", "Orchestrator", {}, at(3));
    e.rt.sweep(e.cap, MON());
    const [req] = e.launches();
    expect(req.prompt).toContain("2026-W46.json");
    expect(req.prompt).toContain('"improvements"');
    expect(req.prompt).toContain("lock_wait_s");
    expect(req.prompt).toContain("- As the lead, I want a lock wait limit");
    expect(req.prompt).toContain("- As the human, I want fewer Approve waits");
    expect(req.prompt).toContain(e.retroStages().find((x) => x.retro_week === "2026-W46")!.id);
    expect(req.prompt).not.toContain("{{");
    // The text is the file of the sweep.
    expect(req.prompt).toContain(readFileSync(join(dir, "retro", "A", "2026-W46.json"), "utf8").trim());
  });

  test("an earlier retrospective with no proposals hides the older proposals", () => {
    const e = env();
    e.db.run("INSERT INTO stage (id, review, role, status, room, retro_week) VALUES ('s_00000000000000a1', 'retro', 'retrospective', 'passed', 'A', '2026-W44')");
    e.db.run("INSERT INTO stage (id, review, role, status, room, retro_week) VALUES ('s_00000000000000a2', 'retro', 'retrospective', 'passed', 'A', '2026-W45')");
    const ins = (id: string, stage: string, ctx: object, t: number) =>
      e.db.run("INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'retrospective-1', 'Orchestrator', 'result', ?, 'accepted', ?, ?)", [id, JSON.stringify({ stage_id: stage, ...ctx }), at(t), at(t + 1)]);
    ins("h_w44", "s_00000000000000a1", { proposals: [{ title: "As the lead, I want old proposal" }] }, 1);
    ins("h_w45", "s_00000000000000a2", { proposals: [] }, 3);
    e.ticketEvent("A", at(5, 12));
    e.rt.sweep(e.cap, MON());
    const [req] = e.launches();
    expect(req.prompt).toMatch(/## Proposals of the previous retrospective\nnone/);
    expect(req.prompt).not.toContain("old proposal");
  });

  test("with no earlier retrospective the proposals part says none", () => {
    const e = env();
    e.ticketEvent("A", at(5, 12));
    e.rt.sweep(e.cap, MON());
    const [req] = e.launches();
    expect(req.prompt).toMatch(/## Proposals of the previous retrospective\nnone/);
  });
});
