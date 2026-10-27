// context-pack 2.1: the first message is the stable block, then the ticket block (ticket, notes, pack, handoff section).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFirstMessage } from "../../hub/core/first-message";
import { renderStable } from "../../hub/core/primer";

const dir = mkdtempSync(join(tmpdir(), "order-"));
mkdirSync(join(dir, "docs"));
const write = (t: string) => writeFileSync(join(dir, "docs", "PRIMER.md"), t);
write("# Primer\nPRIMER-BODY\n");
const room = (nutshell = "NUTSHELL-BODY") => ({ projectFolder: dir, nutshell });
const t = (id: string) => ({ id, title: `Title ${id}`, acceptance_criteria: `Criteria ${id}`, blast_radius: "low", request_id: "r-1" });
const msg = (id: string, stage: string, stable: string) =>
  renderFirstMessage({
    stable, stageId: stage, role: "worker", ticket: t(id), branch: `ticket/${id}`, worktree: `/w/${id}`,
    notes: [{ source: "planning", role: null, notes: "NOTES-BODY" }], pack: { graph: "PACK-BODY" },
    handoff: { id: "h_1", from: "Orchestrator", task: "HANDOFF-TASK", context: {} }, reason: "REASON-LINE",
  });

describe("first message order", () => {
  test("two Worker stages on two tickets start with identical stable bytes", () => {
    const stable = renderStable(room());
    const a = msg("t_a", "s_a", renderStable(room()));
    const b = msg("t_b", "s_b", renderStable(room()));
    expect(a.startsWith(stable)).toBe(true);
    expect(b.startsWith(stable)).toBe(true);
    expect(a.slice(stable.length)).not.toBe(b.slice(stable.length));
  });

  test("the stable block has no stage, ticket, worktree, session or time field", () => {
    const s = renderStable(room());
    expect(s).toBe("# Primer\nPRIMER-BODY\n\n## Nutshell\nNUTSHELL-BODY\n\n");
  });

  test("order: stable, ticket, notes, pack, handoff section, with nothing stable after the ticket block", () => {
    const m = msg("t_a", "s_a", renderStable(room()));
    const at = (x: string) => m.indexOf(x);
    const order = ["PRIMER-BODY", "NUTSHELL-BODY", "- Ticket: t_a", "Criteria t_a", "NOTES-BODY", "PACK-BODY", "## Handoff", "HANDOFF-TASK", "REASON-LINE"].map(at);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(m.endsWith("REASON-LINE\n")).toBe(true);
  });

  test("the stable block changes only when docs/PRIMER.md or the Nutshell changes", () => {
    const base = renderStable(room());
    expect(renderStable(room())).toBe(base);
    expect(renderStable(room("other nutshell"))).not.toBe(base);
    write("# Primer\nPRIMER-CHANGED\n");
    expect(renderStable(room())).not.toBe(base);
    write("# Primer\nPRIMER-BODY\n");
    expect(renderStable(room())).toBe(base);
  });

  test("no stable block: the message is the ticket block as before", () => {
    const m = renderFirstMessage({ stageId: "s", role: "worker", ticket: t("t_a"), branch: null, worktree: "/w" });
    expect(m.startsWith("You are the worker")).toBe(true);
  });
});
