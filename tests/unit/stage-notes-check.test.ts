// context-pack 1.3: checkResult requires context.notes (non-empty, at most 400 words) on stage results, spec results included.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, notesError } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

function makeEnv(spec = false) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
     VALUES ('t_0000000000000001', 'r1', 'T', 'c', 'low', 'medium', 'a', ?, 'req-1', 1, 1, 1)`,
    [spec ? "draft" : "in_progress"],
  );
  const s = spec
    ? rt.api.create({ request_id: "req-1", review: "spec", role: "validator" }, "system", cap, (ctx) => {
        ctx.tx.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, 't_0000000000000001')", [ctx.next.id]);
      })
    : rt.api.create({ ticket_id: "t_0000000000000001", role: "writer" }, "system", cap);
  rt.api.move(s.id, { to: "launching", session: "s-1" }, "system", cap);
  rt.api.move(s.id, { to: "running" }, "system", cap);
  const base: Record<string, unknown> = spec
    ? { stage_id: s.id, review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] }
    : { stage_id: s.id, ticket_id: "t_0000000000000001" };
  const check = (notes?: unknown) => rt.hooks.checkResult("s-1", notes === undefined ? base : { ...base, notes }, cap, spec ? "Orchestrator" : "alice");
  const rejected = () => emitted.filter((x) => x.e.kind === "stage.rejected");
  return { rt, db, cap, stage: s.id, check, rejected, status: () => rt.api.load(s.id)!.status };
}

describe("notesError", () => {
  test("accepts 1 and 400 words; refuses missing, empty, blank, non-string and 401 words", () => {
    expect(notesError("done")).toBeNull();
    expect(notesError(words(400))).toBeNull();
    for (const bad of [undefined, "", "  \n ", 5, null, ["x"]]) expect(notesError(bad)).toContain("context.notes");
    expect(notesError(words(401))).toContain("401 words");
  });
});

for (const spec of [false, true]) {
  describe(`checkResult notes (${spec ? "spec result" : "stage result"})`, () => {
    for (const [name, notes] of [["missing", undefined], ["empty", ""], ["blank", "   "], ["401 words", words(401)]] as const) {
      test(`${name} notes: refused with the field name; stage.rejected to the same session; stage stays running`, () => {
        const e = makeEnv(spec);
        const errors = e.check(notes)!;
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("context.notes");
        expect(e.rejected()).toHaveLength(1);
        expect(e.rejected()[0].s).toEqual({ kind: "to-agents", agents: ["s-1"] });
        expect(e.status()).toBe("running");
      });
    }
    test("valid notes (400 words) pass; no stage.rejected", () => {
      const e = makeEnv(spec);
      expect(e.check(words(400))).toEqual([]);
      expect(e.rejected()).toHaveLength(0);
    });
    test("notes do not hide other errors: a wrong stage_id and missing notes give both", () => {
      const e = makeEnv(spec);
      const errors = e.rt.hooks.checkResult("s-1", { ...(spec ? { review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] } : {}), stage_id: "s_0000000000000000" }, e.cap, spec ? "Orchestrator" : "alice")!;
      expect(errors.some((x) => x.includes("stage_id"))).toBe(true);
      expect(errors.some((x) => x.includes("context.notes"))).toBe(true);
    });
  });
}

describe("handoffs without a running stage", () => {
  test("a session with no running stage (a named-agent handoff) needs no notes", () => {
    const e = makeEnv();
    expect(e.rt.hooks.checkResult("alice", { task: "x" }, e.cap, "bob")).toBeNull();
  });
});
