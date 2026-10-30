import { test, expect } from "bun:test";
import { cardKind } from "../../hub/kinds/decision";

test("an arbiter ruling is a review, whatever the reason or the request", () => {
  for (const requestApproved of [true, false, null]) {
    for (const reason of ["scope", "feature", null] as const) {
      expect(cardKind({ decider: "arbiter", reason, requestApproved })).toBe("review");
    }
  }
});

test("a human decision of a request that has no Approve is an approve card", () => {
  expect(cardKind({ decider: "human", reason: "scope", requestApproved: false })).toBe("approve");
});

test("a human feature decision is an approve card unless the request is approved", () => {
  expect(cardKind({ decider: "human", reason: "feature", requestApproved: null })).toBe("approve");
  expect(cardKind({ decider: "human", reason: "feature", requestApproved: true })).toBe("choose");
});

test("any other human decision is a choose card", () => {
  expect(cardKind({ decider: "human", reason: "scope", requestApproved: true })).toBe("choose");
  expect(cardKind({ decider: "human", reason: "irreversible", requestApproved: null })).toBe("choose");
  expect(cardKind({ decider: "human", reason: null, requestApproved: null })).toBe("choose");
});
