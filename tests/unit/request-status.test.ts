import { describe, test, expect } from "bun:test";
import { requestListStatus, type StatusTicket } from "../../hub/core/request-status";

const t = (status: string, mergedIntoMain = false): StatusTicket => ({ status, mergedIntoMain });
const f = (tickets: StatusTicket[], needsApprove = false, approved = false) => requestListStatus({ needsApprove, approved, tickets });

describe("requestListStatus", () => {
  test("no ticket is draft", () => expect(f([])).toBe("draft"));
  test("no ticket is draft even when it needs the Approve", () => expect(f([], true)).toBe("draft"));
  test("only cancelled tickets is cancelled", () => expect(f([t("cancelled"), t("cancelled")], true)).toBe("cancelled"));
  test("needs the Approve and has none is waiting_for_approve", () => expect(f([t("draft")], true, false)).toBe("waiting_for_approve"));
  test("a draft ticket and no Approve needed is draft", () => expect(f([t("draft"), t("queued")])).toBe("draft"));
  test("approved with an open ticket is building", () => expect(f([t("draft"), t("in_progress")], true, true)).toBe("building"));
  test("no Approve needed with a queued ticket is building", () => expect(f([t("queued")])).toBe("building"));
  test("all done or cancelled, not in main, is ready_for_test", () => expect(f([t("done"), t("cancelled")], true, true)).toBe("ready_for_test"));
  test("one done ticket not in main is ready_for_test", () => expect(f([t("done", true), t("done", false)], true, true)).toBe("ready_for_test"));
  test("every done ticket in main is merged", () => expect(f([t("done", true), t("cancelled"), t("done", true)], true, true)).toBe("merged"));
});
