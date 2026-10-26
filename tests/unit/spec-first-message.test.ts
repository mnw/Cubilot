// The first message of a spec-review stage (spec-review-stage 2.5): ticket part only, no role prompt.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSpecFirstMessage } from "../../hub/core/first-message";

const base = {
  stageId: "s_0123456789abcdef",
  requestId: "req-1",
  worktree: "/w/request-req-1/validator-1",
  recipient: "Orchestrator",
  requestText: "Build the thing",
  specPaths: ["openspec/a.md"],
  commit: "abc1234def",
  scope: [
    { id: "t_aaaaaaaaaaaaaaaa", title: "First", acceptance_criteria: "does A", role: "worker", blast_radius: "high", blocked_by: [] as string[] },
    { id: "t_bbbbbbbbbbbbbbbb", title: "Second", acceptance_criteria: "does B", role: null, blast_radius: "low", blocked_by: ["t_aaaaaaaaaaaaaaaa"] },
  ],
};

describe("renderSpecFirstMessage", () => {
  test("holds the request text, scope tickets with criteria, role, blast radius and blocked_by, spec paths, worktree and commit", () => {
    const t = renderSpecFirstMessage(base);
    for (const part of ["Build the thing", "openspec/a.md", "/w/request-req-1/validator-1", "Commit: abc1234def", "Result goes to: Orchestrator", "does A", "does B"]) {
      expect(t).toContain(part);
    }
    expect(t).toContain("### t_aaaaaaaaaaaaaaaa: First\n- Role: worker\n- Blast radius: high\n- Blocked by: none");
    expect(t).toContain("### t_bbbbbbbbbbbbbbbb: Second\n- Role: none\n- Blast radius: low\n- Blocked by: t_aaaaaaaaaaaaaaaa");
  });

  test("earlier FAIL findings appear when there are some, and the section is absent when there are none", () => {
    expect(renderSpecFirstMessage(base)).not.toContain("earlier reviews");
    const t = renderSpecFirstMessage({ ...base, earlierFindings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "blocking", text: "no criteria\nfor X" }] });
    expect(t).toContain("## Findings of earlier reviews of this request");
    expect(t).toContain("- t_aaaaaaaaaaaaaaaa (blocking): no criteria for X");
  });

  test("the role prompt is absent: no line of factory/validator/validator.md is in the message", () => {
    const role = readFileSync(join(import.meta.dir, "../../factory/validator/validator.md"), "utf8");
    const body = role.split(/^---\s*$/m)[2] ?? role;
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 40);
    expect(lines.length).toBeGreaterThan(5);
    const t = renderSpecFirstMessage({ ...base, earlierFindings: [{ ticket_id: "t_aaaaaaaaaaaaaaaa", severity: "blocking", text: "x" }] });
    for (const l of lines) expect(t).not.toContain(l);
  });
});
