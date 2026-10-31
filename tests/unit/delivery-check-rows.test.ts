import { describe, expect, test } from "bun:test";
import { checkRows } from "../../hub/core/delivery-report";

const T = "t_0123456789abcdef";
const ids = (c: string) => checkRows(T, c).map((r) => r.check_id);

describe("checkRows with an Acceptance criteria heading", () => {
  const text = [
    "Story: As the human, I want x.",
    "Acceptance criteria:",
    "  1. First.",
    "  2. Second.",
    "Verify:",
    "  1. Worker: bun test.",
    "  2. Tester: run all.",
    "Out of scope: nothing.",
    "Notes:",
    "  1. Other.",
  ].join("\n");

  test("returns only the numbered lines of the block", () => {
    const rows = checkRows(T, text);
    expect(rows.map((r) => r.check_id)).toEqual([`${T}#1`, `${T}#2`]);
    expect(rows.map((r) => r.text)).toEqual(["First.", "Second."]);
  });

  test("lines under Verify or Out of scope make no check and no id repeats", () => {
    const withOos = text.replace("Out of scope: nothing.", "Out of scope:\n  1. Not a check.");
    const got = ids(withOos);
    expect(got).toEqual([`${T}#1`, `${T}#2`]);
    expect(new Set(got).size).toBe(got.length);
  });

  test("the block ends at another heading line, and the heading match ignores case and a trailing colon", () => {
    expect(ids("acceptance criteria\n1. A\n2. B\nSomething else:\n3. C")).toEqual([`${T}#1`, `${T}#2`]);
  });

  test("a heading with no numbered line under it gives one check with the whole text", () => {
    expect(checkRows(T, "Acceptance criteria:\nVerify:\n  1. x")).toEqual([
      { check_id: `${T}#1`, ticket_id: T, text: "Acceptance criteria:\nVerify:\n  1. x" },
    ]);
  });
});

describe("checkRows legacy criteria (no heading)", () => {
  test("takes every numbered line with its own number", () => {
    expect(ids("1. A\n2. B\n  3. C")).toEqual([`${T}#1`, `${T}#2`, `${T}#3`]);
  });

  test("two lists that start at 1 repeat an id (known limit)", () => {
    expect(ids("Verify:\n1. A\nOut of scope:\n1. B")).toEqual([`${T}#1`, `${T}#1`]);
  });

  test("no numbered line gives one check #1 with the whole text", () => {
    expect(checkRows(T, "  plain text  ")).toEqual([{ check_id: `${T}#1`, ticket_id: T, text: "plain text" }]);
  });
});
