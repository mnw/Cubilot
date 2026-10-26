// Spec result schema (spec-review-stage 3.1): checkResult for the session of a running spec stage.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

function makeEnv() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1"); // a spec stage gets a worktree like a ticket stage (spec-review 2.4)
  // The running spec stage counts against the room's validator limit (2.4): these tests are about the request rule, so allow more.
  db.run("INSERT INTO room_settings (room, role_limits, updated_at) VALUES ('r1', ?, 1) ON CONFLICT(room) DO UPDATE SET role_limits = excluded.role_limits", [
    JSON.stringify({ worker: 2, tester: 2, validator: 5, reviewer: 2, editor: 2, writer: 2 }),
  ]);
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  // The scope tickets exist in room r1: a spec stage has the room of its scope tickets (spec-review 2.4, 2.5b).
  for (const t of ["t_aaaaaaaaaaaaaaaa", "t_bbbbbbbbbbbbbbbb", "t_cccccccccccccccc", "t_dddddddddddddddd"]) {
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'draft', 'req-1', 1, 1, 1)`,
      [t],
    );
  }
  const stage = rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", cap, (ctx) => {
    for (const t of ["t_aaaaaaaaaaaaaaaa", "t_bbbbbbbbbbbbbbbb"]) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
  });
  rt.api.move(stage.id, { to: "launching", session: "validator-1" }, "system", cap);
  rt.api.move(stage.id, { to: "running" }, "system", cap);
  const valid = (over: Record<string, unknown> = {}) => ({
    stage_id: stage.id,
    review: "spec",
    request_id: "req-1",
    verdict: "PASS",
    findings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "suggestion", text: "rename it" }],
    suggestions: [],
    questions_for_human: [],
    ...over,
  });
  const check = (ctx: unknown, from = "validator-1") => rt.hooks.checkResult(from, ctx, cap);
  return { db, rt, cap, stage, valid, check, emitted };
}

describe("spec result schema", () => {
  test("a valid PASS and a valid FAIL with a blocking finding pass", () => {
    const e = makeEnv();
    expect(e.check(e.valid())).toEqual([]);
    expect(e.check(e.valid({ verdict: "FAIL", suggestions: undefined, findings: [{ ticket_id: "t_bbbbbbbbbbbbbbbb", severity: "blocking", text: "no criteria" }] }))).toEqual([]);
  });

  test("a sender that is no stage session is not checked", () => {
    const e = makeEnv();
    expect(e.check(e.valid(), "bob")).toBeNull();
  });

  test.each([
    ["wrong stage_id", { stage_id: "s_0000000000000000" }, "stage_id"],
    ["review missing", { review: undefined }, "review"],
    ["review not spec", { review: "code" }, "review"],
    ["request_id of another request", { request_id: "req-9" }, "request_id"],
    ["verdict lower case", { verdict: "pass" }, "verdict"],
    ["verdict missing", { verdict: undefined }, "verdict"],
    ["findings missing", { findings: undefined }, "findings"],
    ["finding ticket outside the scope", { findings: [{ ticket_id: "t_cccccccccccccccc", severity: "suggestion", text: "x" }] }, "scope"],
    ["finding severity unknown", { findings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "major", text: "x" }] }, "severity"],
    ["finding text empty", { findings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "suggestion", text: " " }] }, "text"],
    ["questions_for_human missing", { questions_for_human: undefined }, "questions_for_human"],
    ["questions_for_human not strings", { questions_for_human: [1] }, "questions_for_human"],
    ["suggestions missing on PASS", { suggestions: undefined }, "suggestions"],
    ["PASS with a blocking finding", { findings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "blocking", text: "x" }] }, "blocking"],
  ])("%s is refused", (_n, over, word) => {
    const e = makeEnv();
    const errors = e.check(e.valid(over as Record<string, unknown>));
    expect(errors?.length).toBeGreaterThan(0);
    expect(errors!.join(" ")).toContain(word as string);
  });

  test("a non-object context is refused", () => {
    const e = makeEnv();
    expect(e.check(null)?.length).toBe(1);
    expect(e.check([])?.length).toBe(1);
  });

  test("a schema error changes no stage and tells the same session (stage.rejected); the stage stays running", () => {
    const e = makeEnv();
    const events0 = e.db.query("SELECT COUNT(*) AS n FROM events").get();
    expect(e.check(e.valid({ verdict: "maybe" }))?.length).toBeGreaterThan(0);
    expect(e.rt.api.load(e.stage.id)?.status).toBe("running");
    expect(e.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(events0);
    expect(e.emitted.at(-1)!.e.kind).toBe("stage.rejected");
    expect(e.emitted.at(-1)!.s).toEqual({ kind: "to-agents", agents: ["validator-1"] });
    // the session may send a corrected result
    expect(e.check(e.valid())).toEqual([]);
  });
});

describe("one live spec stage per request (spec-review-stage 2.3)", () => {
  const mk = (e: ReturnType<typeof makeEnv>, request: string, tickets: string[]) =>
    e.rt.api.create({ request_id: request, review: "spec", role: "validator" }, "system", e.cap, (ctx) => {
      for (const t of tickets) ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [ctx.next.id, t]);
    });
  const launch = (e: ReturnType<typeof makeEnv>, id: string, session: string) =>
    e.rt.enqueueLaunch({ stage_id: id, session, room: "r1", harness: "claude", cwd: null, prompt: "" }, e.cap);

  test("a second spec stage of the request keeps its own scope and stays queued while the first is live; it starts after the first ends", () => {
    const e = makeEnv(); // the env already holds a running spec stage of req-1
    const second = mk(e, "req-1", ["t_cccccccccccccccc"]);
    expect(e.db.query("SELECT ticket_id FROM stage_scope WHERE stage_id = ?").all(second.id)).toEqual([{ ticket_id: "t_cccccccccccccccc" }]);
    const refused = launch(e, second.id, "validator-2");
    expect(refused.ok).toBe(false);
    expect(e.rt.api.load(second.id)?.status).toBe("queued");
    e.rt.api.move(e.stage.id, { to: "passed", verdict: "PASS" }, "system", e.cap);
    // The free-slot start (2.4) already launched the waiting stage when the first one ended.
    expect(e.rt.api.load(second.id)).toMatchObject({ status: "launching", session: "validator-1" });
  });

  test("a spec stage of another request is not held back", () => {
    const e = makeEnv();
    const other = mk(e, "req-2", ["t_dddddddddddddddd"]);
    expect(launch(e, other.id, "validator-2").ok).toBe(true);
  });
});
