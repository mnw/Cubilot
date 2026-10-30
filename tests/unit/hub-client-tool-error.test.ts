import { describe, expect, test } from "bun:test";
import { PAUSED_LINE, toolError, type HubResponse } from "../../hub/channel/hub-client";

function messageOf(resp: HubResponse): string {
  try {
    toolError(resp, "send_handoff");
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("toolError did not throw");
}

const resp = (status: number, json: unknown): HubResponse => ({ status, json, body: JSON.stringify(json) });

describe("toolError", () => {
  test("errors list is shown", () => {
    const msg = messageOf(resp(400, { error: "result rejected", errors: ["summary missing", "notes too long"] }));
    expect(msg).toBe("send_handoff failed: 400 result rejected: summary missing; notes too long");
  });

  test("error only unchanged", () => {
    expect(messageOf(resp(400, { error: "bad input" }))).toBe("send_handoff failed: 400 bad input");
  });

  test("423 paused line", () => {
    expect(messageOf(resp(423, { error: "paused", errors: ["x"] }))).toBe(`send_handoff failed: ${PAUSED_LINE}`);
  });

  test("errors not a string list ignored", () => {
    for (const errors of ["text", 5, { a: 1 }, [1, "a"], [], null]) {
      expect(messageOf(resp(400, { error: "result rejected", errors }))).toBe("send_handoff failed: 400 result rejected");
    }
  });
});
