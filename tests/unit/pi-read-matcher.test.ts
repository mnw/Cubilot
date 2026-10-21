import { expect, test } from "bun:test";
import { createReadMatcher, runAnswered } from "../../hub/channel/pi-extension";

test("identical texts fire their callbacks FIFO, one per read", () => {
  const m = createReadMatcher();
  const fired: string[] = [];
  m.track("same", () => fired.push("A"));
  m.track("same", () => fired.push("B"));
  m.read("same");
  expect(fired).toEqual(["A"]);
  m.read("same");
  expect(fired).toEqual(["A", "B"]);
  m.read("same");
  expect(fired).toEqual(["A", "B"]);
});

test("an unrelated text fires nothing", () => {
  const m = createReadMatcher();
  const fired: string[] = [];
  m.track("one", () => fired.push("A"));
  m.read("two");
  expect(fired).toEqual([]);
});

test("runAnswered: an aborted or failed last assistant message is not an answer", () => {
  const msg = (stopReason: string) => [{ role: "user" }, { role: "assistant", stopReason }];
  expect(runAnswered(msg("stop"))).toBe(true);
  expect(runAnswered(msg("toolUse"))).toBe(true);
  expect(runAnswered(msg("aborted"))).toBe(false);
  expect(runAnswered(msg("error"))).toBe(false);
  // Only the last assistant message counts; later user/tool messages do not hide an abort.
  expect(runAnswered([...msg("aborted"), { role: "toolResult" }])).toBe(false);
  expect(runAnswered([{ role: "assistant", stopReason: "aborted" }, { role: "assistant", stopReason: "stop" }])).toBe(true);
  expect(runAnswered(undefined)).toBe(true);
  expect(runAnswered([])).toBe(true);
});
