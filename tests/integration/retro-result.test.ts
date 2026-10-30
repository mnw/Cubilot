// Part 21 group 5: the hub checks the result of a retrospective stage. In process, no mocks of the hub.
// A refused result returns the error list of checkResult and leaves the stage running.
// 2026-11-09 is a Monday: ISO week 2026-W46, window 2026-11-02 06:00 to 2026-11-09 06:00 (local time).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../helpers/repo"; // sets CUBILOT_DATA_DIR to a temp folder
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { buildKinds } from "../../hub/kinds";
import { createStageRuntime } from "../../hub/kinds/stage";
import { removesHumanGate } from "../../hub/core/retro";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const at = (day: number, h = 0, min = 0, month = 10) => new Date(2026, month, day, h, min).getTime();
const MON = at(9, 6);
const ROLE_LINE = "- Never commit on main.";

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let dir: string;
let savedDb: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retro-result-"));
  savedDb = process.env.CUBILOT_LEDGER_DB;
  process.env.CUBILOT_LEDGER_DB = join(dir, "ledger.db");
});
afterEach(() => {
  if (savedDb === undefined) delete process.env.CUBILOT_LEDGER_DB;
  else process.env.CUBILOT_LEDGER_DB = savedDb;
  rmSync(dir, { recursive: true, force: true });
});

/** A running retro stage of room A. `done` lists ids of done improvements (tickets of an earlier r-*-retro request). */
function env(done: string[] = []) {
  const project = mkdtempSync(join(dir, "proj-"));
  sh(project, "git", "init", "-q", "-b", "main");
  sh(project, "git", "config", "user.email", "t@t");
  sh(project, "git", "config", "user.name", "t");
  mkdirSync(join(project, "factory/worker"), { recursive: true });
  writeFileSync(join(project, "factory/worker/worker.md"), `# Worker\n\n  ${ROLE_LINE}  \n`);
  sh(project, "git", "add", ".");
  sh(project, "git", "commit", "-qm", "one");
  sh(project, "git", "branch", "staging");
  const db = new Database(":memory:");
  migrateLedger(db);
  for (const k of buildKinds(db)) k.migrate?.(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  setRoomSettings(db, "A", { project_folder: project });
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  rt.queue.attach(() => {}, new AbortController().signal, cap);
  const ticket = (id: string, status: string, request: string | null, when: number) => {
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'A', 'T', 'c', 'low', 'medium', 'a', ?, ?, ?, ?, 1)`,
      [id, status, request, when, when],
    );
    insertEvent(db, id, status === "done" ? "ticket.done" : "ticket.created", "Orchestrator", {}, when);
  };
  ticket("t_0000000000000001", "queued", null, at(5, 12));
  done.forEach((id) => ticket(id, "done", "r-2026-10-26-retro", at(4, 12)));
  rt.sweep(cap, MON);
  const stage = db.query<{ id: string; session: string }, []>("SELECT id, session FROM stage WHERE review = 'retro'").get()!;
  rt.api.move(stage.id, { to: "running" }, "system", cap);
  const check = (c: Record<string, unknown>) => rt.hooks.checkResult(stage.session, { stage_id: stage.id, notes: "n", verdicts: [], proposals: [], lessons: [], ...c }, cap) ?? ["no stage"];
  const status = () => db.query<{ status: string }, [string]>("SELECT status FROM stage WHERE id = ?").get(stage.id)!.status;
  return { check, status, ticket };
}

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Fewer idle tester hours",
  problem: "Testers idle 12 hours with ready tickets.",
  evidence: ["flow: tester idle 12 hours"],
  change: "Add a check before the human Approve",
  kind: "code-check",
  files: ["hub/core/flow.ts:10"],
  measure: { name: "tester_idle_hours", now: 12, target: 6 },
  risk: "Low.",
  ...over,
});

describe("the schema of a retro result", () => {
  test("an empty result and a good proposal pass", () => {
    const e = env();
    expect(e.check({})).toEqual([]);
    expect(e.check({ proposals: [proposal(), proposal(), proposal()] })).toEqual([]);
  });

  test("Unknown kind: 400 text, stage stays running", () => {
    const e = env();
    const errors = e.check({ proposals: [proposal({ kind: "process" })] });
    expect(errors.join("\n")).toContain("kind must be one of");
    expect(e.status()).toBe("running");
  });

  test("Four proposals", () => {
    const e = env();
    expect(e.check({ proposals: [proposal(), proposal(), proposal(), proposal()] })).toContain("at most 3 proposals");
    expect(e.status()).toBe("running");
  });

  test("Proposal with no evidence numbers", () => {
    const e = env();
    expect(e.check({ proposals: [proposal({ evidence: ["flow: testers seem slow"] })] }).join("\n")).toContain("evidence[0]");
    expect(e.status()).toBe("running");
  });

  test("lessons must be a list of strings", () => {
    const e = env();
    for (const bad of [undefined, "a lesson", [1], [""]]) expect(e.check({ lessons: bad }).join("\n")).toContain("context.lessons");
    expect(e.check({ lessons: ["When x, y, because z."] })).toEqual([]);
  });

  test("a proposal with no evidence item", () => {
    expect(env().check({ proposals: [proposal({ evidence: [] })] }).join("\n")).toContain("evidence needs at least one item");
  });

  test("an evidence item with a wrong section prefix", () => {
    const e = env();
    for (const bad of ["tests: 12 failures", "flows: 12", "12 hours of flow", "flow 12 hours"]) {
      expect(e.check({ proposals: [proposal({ evidence: [bad] })] }).join("\n")).toContain("evidence[0]");
    }
    for (const sec of ["flow", "stages", "findings", "human", "causes", "reports", "improvements"]) {
      expect(e.check({ proposals: [proposal({ evidence: [`${sec}: 3 items`] })] })).toEqual([]);
    }
  });
});

describe("the human-gate check", () => {
  test("Proposal removes a human gate", () => {
    const e = env();
    const errors = e.check({ proposals: [proposal({ change: "Remove the human Approve for factory requests" })] });
    expect(errors).toContain("a proposal cannot remove a human gate");
    expect(e.status()).toBe("running");
  });

  test("the title counts too", () => {
    expect(env().check({ proposals: [proposal({ title: "Skip the security review" })] })).toContain("a proposal cannot remove a human gate");
  });

  test("Add a check before the human Approve passes", () => {
    expect(env().check({ proposals: [proposal({ change: "Add a check before the human Approve" })] })).toEqual([]);
  });

  test("a semicolon does not end a sentence", () => {
    expect(removesHumanGate("Remove manual review; human Approve is obsolete.")).toBe(true);
  });

  test("the removal word and the gate word must share a sentence", () => {
    expect(removesHumanGate("Remove the stale lock. The human reads the report.")).toBe(false);
    expect(removesHumanGate("Remove the stale lock.\nThe human reads the report.")).toBe(false);
    expect(removesHumanGate("Merge to main without a review.")).toBe(true);
    expect(removesHumanGate("auto-approve every request")).toBe(true);
  });
});

describe("a role-file proposal", () => {
  const roleFile = (over: Record<string, unknown> = {}) => proposal({ kind: "role-file", files: ["factory/worker/worker.md:3"], replaces: ROLE_LINE, ...over });

  test("replaces equal to the line, trimmed, passes", () => {
    expect(env().check({ proposals: [roleFile()] })).toEqual([]);
    expect(env().check({ proposals: [roleFile({ replaces: `  ${ROLE_LINE}\t` })] })).toEqual([]);
  });

  test("Role-file proposal without the line it replaces", () => {
    const e = env();
    const p = roleFile();
    delete (p as Record<string, unknown>).replaces;
    expect(e.check({ proposals: [p] }).join("\n")).toContain("replaces is required");
    expect(e.status()).toBe("running");
  });

  test("a replaces that differs is refused", () => {
    expect(env().check({ proposals: [roleFile({ replaces: "- Commit on main." })] }).join("\n")).toContain("replaces must equal");
  });

  test("a line that does not exist, a second file and a path outside factory are refused", () => {
    const e = env();
    expect(e.check({ proposals: [roleFile({ files: ["factory/worker/worker.md:99"] })] }).join("\n")).toContain("does not exist");
    expect(e.check({ proposals: [roleFile({ files: ["factory/worker/worker.md:3", "factory/worker/worker.md:1"] })] }).join("\n")).toContain("one factory/**/*.md:<line>");
    expect(e.check({ proposals: [roleFile({ files: ["hub/hub.ts:1"] })] }).join("\n")).toContain("one factory/**/*.md:<line>");
    expect(e.check({ proposals: [roleFile({ files: ["factory/../hub/hub.ts:1"] })] }).join("\n")).toContain("one factory/**/*.md:<line>");
  });
});

describe("verdicts for done improvements", () => {
  const verdict = (improvement: string, v = "keep") => ({ improvement, measure: "m", before: 3.2, after: 2, verdict: v, note: "ok" });
  const A = "t_00000000000000a1";
  const B = "t_00000000000000b2";

  test("Week 2 result has a verdict for each improvement", () => {
    const e = env([A, B]);
    expect(e.check({ verdicts: [verdict(A)] })).toContain(`context.verdicts has no verdict for improvement ${B}`);
    expect(e.status()).toBe("running");
    expect(e.check({ verdicts: [verdict(A), verdict(B, "revert")] })).toEqual([]);
  });

  test("the done items are those of the evidence file, not the ledger after the launch", () => {
    const e = env([A]);
    e.ticket(B, "done", "r-2026-10-26-retro", at(4, 13));
    expect(e.check({ verdicts: [verdict(A)] })).toEqual([]);
    expect(e.check({ verdicts: [verdict(B)] })).toContain(`context.verdicts has no verdict for improvement ${A}`);
  });

  test("a verdict other than keep or revert is refused", () => {
    const e = env([A]);
    expect(e.check({ verdicts: [verdict(A, "maybe")] }).join("\n")).toContain("verdict must be keep or revert");
  });
});
