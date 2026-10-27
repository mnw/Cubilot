// context-pack 2.3: the depth table decides which parts of the ticket block fill.
import { describe, expect, test } from "bun:test";
import { packDepth } from "../../hub/core/pack-depth";
import { renderFirstMessage, renderSpecFirstMessage } from "../../hub/core/first-message";

const ticket = { id: "t_1", title: "T", acceptance_criteria: "Do it.", blast_radius: "low", request_id: "r-1" };
const pack = { graph: "GRAPH-TEXT", signatures: "SIG-TEXT", diffStat: "STAT-TEXT", changedFiles: "FILES-TEXT" };
const notes = [{ source: "stage" as const, role: "worker", notes: "NOTE-TEXT" }];
const render = (role: string) => renderFirstMessage({ stageId: "s_1", role, ticket, branch: "ticket/t_1", worktree: "/w", pack, notes });
const has = (m: string) => ["GRAPH-TEXT", "SIG-TEXT", "STAT-TEXT", "FILES-TEXT", "NOTE-TEXT"].filter((x) => m.includes(x));

describe("pack depth", () => {
  test("Tester: notes and changed files, no graph and no signatures", () => {
    expect(has(render("tester"))).toEqual(["FILES-TEXT", "NOTE-TEXT"]);
    expect(packDepth("tester").has("graph")).toBe(false);
    expect(packDepth("tester").has("signatures")).toBe(false);
  });
  test("code Validator: diff stat and changed files, notes, no graph", () => {
    expect(has(render("validator"))).toEqual(["STAT-TEXT", "FILES-TEXT", "NOTE-TEXT"]);
  });
  test("Editor: neither pack nor diff nor notes", () => {
    expect(has(render("editor"))).toEqual([]);
  });
  test("Worker, Writer and Reviewer: notes, graph and signatures, no diff", () => {
    for (const r of ["worker", "writer", "reviewer"]) expect(has(render(r))).toEqual(["GRAPH-TEXT", "SIG-TEXT", "NOTE-TEXT"]);
  });
  test("an unknown role gets nothing", () => {
    expect(has(render("nobody"))).toEqual([]);
    expect([...packDepth("__proto__")]).toEqual([]);
  });
  test("spec first message: graph only; a code Validator's depth does not apply", () => {
    const spec = renderSpecFirstMessage({ stageId: "s", requestId: "r", worktree: "/w", recipient: "O", requestText: "x", specPaths: [], scope: [], pack });
    expect(has(spec)).toEqual(["GRAPH-TEXT"]);
    expect(has(renderSpecFirstMessage({ stageId: "s", requestId: "r", worktree: "/w", recipient: "O", requestText: "x", specPaths: [], scope: [] }))).toEqual([]);
  });
  test("a template cannot widen a role: an Editor template with all placeholders stays empty", () => {
    const t = "{{acceptance_criteria}}\n{{notes}}\n{{pack}}\n{{diff}}\n";
    expect(renderFirstMessage({ stageId: "s", role: "editor", ticket, branch: null, worktree: "/w", pack, notes }, t)).toBe("Do it.\n");
  });
  test("note text with {{name}} is not expanded again", () => {
    const m = renderFirstMessage({ stageId: "s", role: "worker", ticket, branch: null, worktree: "/w", notes: [{ source: "planning", role: null, notes: "keep {{ticket_id}} as written" }] });
    expect(m).toContain("keep {{ticket_id}} as written");
  });
});
