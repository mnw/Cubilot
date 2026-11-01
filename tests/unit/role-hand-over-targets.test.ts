import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Writing chain (request r-2026-10-29-writing-chain-2, story 3): each role file names the one hub target of its hand-over,
// and no stage session accepts, declines or closes anything.
const read = (role: string) => readFileSync(join(import.meta.dir, "../../factory", role, `${role}.md`), "utf8");
// The [doc] flow only: the writer's [spec] flow is a manual hand-over to the Orchestrator.
const docFlow = (text: string) => text.slice(0, text.indexOf("## Flow for a `[spec]` ticket"));

describe("hand-over targets", () => {
  test("writer hands over to_role editor and never closes", () => {
    const text = docFlow(read("writer"));
    expect(text).toContain('`send_handoff` with `to_role: "editor"`');
    expect(text).not.toContain('to_role: "reviewer"');
    expect(text).toContain("Never move the ticket to `done`");
    expect(text).not.toContain("close handoff");
  });

  test("editor hands over to_role reviewer", () => {
    const text = read("editor");
    expect(text).toContain('`send_handoff` with `to_role: "reviewer"`');
    expect(text).toContain("{stage_id, ticket_id, commit, path, change_summary, open_questions, notes}");
    expect(text).toContain("Never move the ticket to `done`");
  });

  test("reviewer: PASS to the room lead, FAIL to_role writer, findings with severity", () => {
    const text = read("reviewer");
    expect(text).toContain('PASS: `send_handoff` to the room lead (the Orchestrator) with context `{verdict: "PASS", stage_id, ticket_id, commit, findings, notes}`');
    expect(text).toContain('FAIL: `send_handoff` with `to_role: "writer"` and context `{verdict: "FAIL", stage_id, ticket_id, commit, findings, notes}`');
    expect(text).toContain('`{severity, text}`');
    expect(text).toContain("Never move the ticket to `done`");
    expect(text).toContain("## Decision tree: blocking or suggestion");
  });

  for (const role of ["writer", "editor", "reviewer"]) {
    test(`${role}.md has no accept_handoff, decline_handoff or close hand-over`, () => {
      const text = docFlow(read(role));
      expect(text).not.toContain("accept_handoff");
      expect(text).not.toContain("decline_handoff");
      expect(text).not.toContain('task "close');
      expect(text).toMatch(/Do not accept or decline|Never accept or decline/);
    });
  }
});
