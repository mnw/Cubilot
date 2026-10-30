// Part 21 group 6: an accepted retro result becomes the request r-<window end date>-retro with draft tickets. In process, no mocks of the hub.
// 2026-11-09 is a Monday: ISO week 2026-W46, window 2026-11-02 06:00 to 2026-11-09 06:00 (local time). Week 2 ends 2026-11-16.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/repo"; // sets CUBILOT_DATA_DIR to a temp folder
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { buildKinds } from "../../hub/kinds";
import { createStageRuntime } from "../../hub/kinds/stage";
import { heldForApprove, needsApprove, requestFacts } from "../../hub/kinds/request";
import { evidencePath, parseMeasure, retroWeekAt } from "../../hub/core/retro";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const at = (day: number, h = 0, min = 0, month = 10) => new Date(2026, month, day, h, min).getTime();
const MON1 = at(9, 6);
const MON2 = at(16, 6);

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let dir: string;
let savedDb: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retro-tickets-"));
  savedDb = process.env.CUBILOT_LEDGER_DB;
  process.env.CUBILOT_LEDGER_DB = join(dir, "ledger.db");
});
afterEach(() => {
  if (savedDb === undefined) delete process.env.CUBILOT_LEDGER_DB;
  else process.env.CUBILOT_LEDGER_DB = savedDb;
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
  const kinds = buildKinds(db);
  for (const k of kinds) k.migrate?.(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  setRoomSettings(db, "A", { project_folder: project, role_limits: { retrospective: 2 } });
  const cap = {
    db,
    config: { humanName: "human", defaultRoom: "A" },
    agents: { isPaused: () => false, get: (n: string) => (n === "human" ? { name: "human", room: null } : null) },
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
  } as unknown as HubCapabilities;
  rt.queue.attach(() => {}, new AbortController().signal, cap);
  let n = 0;
  const ticket = (status: string, when: number, over: { title?: string; request?: string | null; criteria?: string } = {}) => {
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'A', ?, ?, 'low', 'medium', 'a', ?, ?, ?, ?, 1)`,
      [id, over.title ?? "T", over.criteria ?? "c", status, over.request ?? null, when, when],
    );
    insertEvent(db, id, status === "done" ? "ticket.done" : "ticket.created", "Orchestrator", {}, when);
    return id;
  };
  /** Starts the retro stage of the week of `now` and returns a function that sends its result. */
  const week = (now: number) => {
    rt.sweep(cap, now);
    const w = retroWeekAt(now)!;
    const stage = db.query<{ id: string; session: string }, [string]>("SELECT id, session FROM stage WHERE review = 'retro' AND retro_week = ?").get(w.week)!;
    rt.api.move(stage.id, { to: "running" }, "system", cap);
    const ctx = (c: Record<string, unknown>) => ({ stage_id: stage.id, notes: "n", verdicts: [], proposals: [], lessons: [], ...c });
    return {
      stageId: stage.id,
      check: (c: Record<string, unknown>) => rt.hooks.checkResult(stage.session, ctx(c), cap),
      send: (c: Record<string, unknown>) => {
        const full = ctx(c);
        expect(rt.hooks.checkResult(stage.session, full, cap)).toEqual([]);
        rt.hooks.onResult(stage.session, full, cap);
      },
    };
  };
  const requests = () => db.query<{ request_id: string; origin: string; source: string | null; features: string }, []>("SELECT request_id, origin, source, features FROM requests").all();
  const drafts = (request: string) =>
    db.query<{ id: string; title: string; acceptance_criteria: string; status: string; blast_radius: string }, [string]>("SELECT id, title, acceptance_criteria, status, blast_radius FROM tickets WHERE request_id = ? ORDER BY rowid").all(request);
  const cancel = async (id: string) => {
    const route = kinds.flatMap((k) => k.routes).find((r) => r.method === "POST" && r.path instanceof RegExp && r.path.test(`/tickets/${id}/transition`))!;
    const params = { id };
    return route.handler(new Request("http://x", { method: "POST", body: JSON.stringify({ by: "human", to: "cancelled" }) }), cap, params);
  };
  return { db, rt, cap, ticket, week, requests, drafts, cancel };
}

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Fewer idle tester hours",
  problem: "Testers idle 12 hours with ready tickets.",
  evidence: ["flow: tester idle 12 hours"],
  change: "Add a check before the human Approve",
  kind: "code-check",
  files: ["hub/core/flow.ts:10", "hub/kinds/stage.ts:20"],
  measure: { name: "tester_idle_hours", now: 12, target: 6 },
  risk: "Low.",
  ...over,
});
const verdict = (improvement: string, v: string, over: Record<string, unknown> = {}) => ({ improvement, measure: "tester_idle_hours", before: 12, after: 9, verdict: v, note: "Only a small gain.", ...over });

describe("the request of an accepted result", () => {
  test("request waits for the Approve", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    const w = e.week(MON1);
    w.send({ proposals: [proposal()] });
    const req = e.requests();
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ request_id: "r-2026-11-09-retro", origin: "factory", source: w.stageId });
    expect(JSON.parse(req[0].features)).toEqual(["retrospective"]);
    expect(needsApprove(requestFacts(e.db, "A", "r-2026-11-09-retro")!)).toBe(true);
    expect(heldForApprove(e.db, "A", "r-2026-11-09-retro")).toBe(true);
    const spec = e.db.query<{ status: string }, []>("SELECT status FROM stage WHERE review = 'spec'").all();
    expect(spec).toHaveLength(1);
    expect(spec[0].status).not.toBe("passed");
    const events = e.db.query<{ actor: string }, []>("SELECT actor FROM events WHERE kind = 'stage.queued' AND entity_id IN (SELECT id FROM stage WHERE review = 'spec')").all();
    expect(events.map((x) => x.actor)).toEqual(["system"]);
    for (const t of e.drafts("r-2026-11-09-retro")) expect(t.status).toBe("draft");
  });

  test("request id uses the window end date", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    e.week(MON1).send({ proposals: [proposal()] });
    expect(e.requests().map((r) => r.request_id)).toEqual(["r-2026-11-09-retro"]);
  });

  test("accepted proposals", async () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    const w = e.week(MON1);
    w.send({ proposals: [proposal(), proposal({ title: "Second change", measure: { name: "fails", now: 3, target: 1 }, files: ["x.ts:1"] })] });
    const list = e.drafts("r-2026-11-09-retro");
    expect(list).toHaveLength(2);
    const [a, b] = list;
    expect(a.title).toMatch(/^As the human, I want Fewer idle tester hours, so that /);
    expect(a.acceptance_criteria).toContain("Problem: Testers idle 12 hours with ready tickets.");
    expect(a.acceptance_criteria).toContain("Change: Add a check before the human Approve");
    expect(a.acceptance_criteria).toContain("hub/core/flow.ts:10, hub/kinds/stage.ts:20");
    expect(a.acceptance_criteria.split("\n").pop()).toBe(`Target measure: tester_idle_hours from 12 to 6 (retrospective ${w.stageId})`);
    expect(parseMeasure(b.acceptance_criteria)).toEqual({ name: "fails", before: 3, target: 1, stage_id: w.stageId });
    // A plain proposal stays low by the rule. Nothing is queued.
    expect(a.blast_radius).toBe("low");
    expect(e.db.query("SELECT 1 FROM events WHERE kind = 'ticket.queued'").all()).toHaveLength(0);
    const scope = e.db.query<{ ticket_id: string }, []>("SELECT ticket_id FROM stage_scope").all().map((r) => r.ticket_id).sort();
    expect(scope).toEqual([a.id, b.id].sort());
    // The human cancels one before the Approve.
    const r = await e.cancel(a.id);
    if (r.status !== 200) throw new Error(await r.text());
    expect(r.status).toBe(200);
    expect(e.drafts("r-2026-11-09-retro").map((t) => t.status)).toEqual(["cancelled", "draft"]);
  });

  test("the radius rule applies to a proposal that touches a gated file", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    e.week(MON1).send({ proposals: [proposal({ files: ["hub/kinds/permission.ts:1"], title: "Check the permission relay" })] });
    const t = e.drafts("r-2026-11-09-retro")[0];
    expect(t.blast_radius).toBe("high");
    expect(e.db.query<{ radius_rule: string; radius_source: string }, [string]>("SELECT radius_rule, radius_source FROM tickets WHERE id = ?").get(t.id)).toEqual({ radius_rule: "high", radius_source: "rule" });
  });

  test("revert verdict", () => {
    const e = env();
    const imp = e.ticket("done", at(4, 12), { title: "Add the idle check", request: "r-2026-10-26-retro", criteria: "x\nTarget measure: tester_idle_hours from 12 to 6 (retrospective s_0000000000000001)" });
    const keep = e.ticket("done", at(4, 13), { title: "Other", request: "r-2026-10-26-retro" });
    e.ticket("queued", at(5, 12));
    const w = e.week(MON1);
    w.send({ verdicts: [verdict(imp, "revert"), verdict(keep, "keep")] });
    const list = e.drafts("r-2026-11-09-retro");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe(`Revert ${imp}: Add the idle check`);
    expect(list[0].status).toBe("draft");
    expect(list[0].acceptance_criteria).toContain(`Undo the change of ticket ${imp}`);
    expect(list[0].acceptance_criteria.split("\n").pop()).toBe(`Target measure: tester_idle_hours from 9 to 12 (retrospective ${w.stageId})`);
  });

  test("empty result creates no request", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    const w = e.week(MON1);
    w.send({ lessons: ["When x, y, because z."] });
    expect(e.requests()).toEqual([]);
    expect(e.db.query("SELECT 1 FROM stage WHERE review = 'spec'").all()).toHaveLength(0);
    expect(e.db.query<{ status: string }, [string]>("SELECT status FROM stage WHERE id = ?").get(w.stageId)!.status).toBe("passed");
  });

  test("only keep verdicts create no request", () => {
    const e = env();
    const imp = e.ticket("done", at(4, 12), { request: "r-2026-10-26-retro" });
    e.ticket("queued", at(5, 12));
    e.week(MON1).send({ verdicts: [verdict(imp, "keep")] });
    expect(e.requests()).toEqual([]);
  });
});

describe("two weeks end to end", () => {
  test("week 2 judges week 1", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    const w1 = e.week(MON1);
    w1.send({ proposals: [proposal()] });
    const [t1] = e.drafts("r-2026-11-09-retro");
    // The Approve queues it; it is built and set to done during week 2.
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [t1.id]);
    insertEvent(e.db, t1.id, "ticket.done", "Orchestrator", {}, at(12, 12));
    e.ticket("queued", at(13, 12));
    const w2 = e.week(MON2);
    const file = JSON.parse(readFileSync(evidencePath(process.env.CUBILOT_LEDGER_DB!, "A", retroWeekAt(MON2)!.week), "utf8"));
    expect(file.improvements).toEqual([
      { ticket_id: t1.id, title: t1.title, status: "done", request_id: "r-2026-11-09-retro", measure: { name: "tester_idle_hours", before: 12, target: 6 } },
    ]);
    // The accepted result must judge it.
    expect((w2.check({ verdicts: [] }) ?? []).join("\n")).toContain(`no verdict for improvement ${t1.id}`);
    w2.send({ verdicts: [verdict(t1.id, "keep", { after: 5 })] });
    expect(e.requests().map((r) => r.request_id)).toEqual(["r-2026-11-09-retro"]);
  });

  test("week 2 revert becomes a draft in the request of week 2", () => {
    const e = env();
    e.ticket("queued", at(5, 12));
    e.week(MON1).send({ proposals: [proposal()] });
    const [t1] = e.drafts("r-2026-11-09-retro");
    e.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [t1.id]);
    insertEvent(e.db, t1.id, "ticket.done", "Orchestrator", {}, at(12, 12));
    e.ticket("queued", at(13, 12));
    const w2 = e.week(MON2);
    w2.send({ verdicts: [verdict(t1.id, "revert")] });
    const r = e.drafts("r-2026-11-16-retro");
    expect(r.map((t) => t.title)).toEqual([`Revert ${t1.id}: ${t1.title}`]);
  });
});
