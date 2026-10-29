import { describe, expect, test } from "bun:test";
import { renderEvent, resultSummary, type BridgeEvent } from "../../hub/channel/core";

const FINDING_TEXT = "SECRET-FINDING-TEXT the lead must not see";
const resultEvent = (over: Partial<BridgeEvent> = {}, context: Record<string, unknown> = {}): BridgeEvent => ({
  id: 7,
  from: "validator-1",
  to: "Orchestrator",
  room: "r1",
  kind: "handoff.new",
  handoff_id: "h_0123456789abcdef",
  lead: "Orchestrator",
  text: JSON.stringify({
    id: "h_0123456789abcdef",
    task: "result t_0123456789abcdef",
    context: {
      ticket_id: "t_0123456789abcdef",
      verdict: "FAIL",
      notes: "long notes",
      findings: [
        ...Array.from({ length: 4 }, (_, i) => ({ ticket_id: "t_0123456789abcdef", severity: "blocking", text: `${FINDING_TEXT} ${i}` })),
        ...Array.from({ length: 2 }, (_, i) => ({ ticket_id: "t_0123456789abcdef", severity: "suggestion", text: `${FINDING_TEXT} s${i}` })),
      ],
      ...context,
    },
  }),
  ...over,
});

describe("result summary for the lead", () => {
  test("FAIL result", () => {
    const text = renderEvent(resultEvent(), "Orchestrator", "r1");
    expect(text).toContain("t_0123456789abcdef");
    expect(text).toContain("FAIL");
    expect(text).toContain("6 findings (4 blocking, 2 suggestion)");
    expect(text).toContain("h_0123456789abcdef");
    expect(text).not.toContain("SECRET-FINDING-TEXT");
    expect(text).not.toContain("long notes");
  });

  test("a spec review result names the request id", () => {
    const text = renderEvent(resultEvent({}, { ticket_id: undefined, request_id: "r-1", verdict: "PASS", findings: [] }), "Orchestrator", "r1");
    expect(text).toContain("request r-1, PASS, 0 findings");
  });

  test("findings without a severity are counted without a split", () => {
    const text = renderEvent(resultEvent({}, { findings: [{ ticket_id: "t_0123456789abcdef", text: "x" }] }), "Orchestrator", "r1");
    expect(text).toContain("1 findings.");
  });

  test("an agent that is not the lead gets the full result", () => {
    const evt = resultEvent({ to: "bob" });
    expect(resultSummary(evt, "bob")).toBeNull();
    expect(renderEvent(evt, "bob", "r1")).toContain(FINDING_TEXT);
  });

  test("the lead gets the full text of a handoff with no verdict", () => {
    const evt = resultEvent({}, { verdict: undefined });
    expect(resultSummary(evt, "Orchestrator")).toBeNull();
    expect(renderEvent(evt, "Orchestrator", "r1")).toContain(FINDING_TEXT);
  });

  test("a handoff update and a handoff to someone else are not summarised", () => {
    expect(resultSummary(resultEvent({ kind: "handoff.update" }), "Orchestrator")).toBeNull();
    expect(resultSummary(resultEvent({ to: "bob" }), "Orchestrator")).toBeNull();
  });
});
