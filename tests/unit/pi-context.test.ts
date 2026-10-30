// Pi context use (pi 1.4.0): agent_end writes <app data>/context/<agent>.json in the statusline format.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextPct } from "../../hub/core/context-usage";

const data = mkdtempSync(join(tmpdir(), "pi-ctx-"));
const saved = { agent: process.env.CHATBRIDGE_AGENT, data: process.env.CUBILOT_DATA_DIR };
let ext: typeof import("../../hub/channel/pi-extension");
const handlers: Record<string, (...a: any[]) => void> = {};
const fakePi = { on: (e: string, h: (...a: any[]) => void) => (handlers[e] = h), registerTool: () => {}, registerCommand: () => {} };

beforeAll(async () => {
  process.env.CHATBRIDGE_AGENT = "validator-9";
  process.env.CUBILOT_DATA_DIR = data;
  ext = await import("../../hub/channel/pi-extension?pi-context"); // own module instance: AGENT is read at load
  ext.default(fakePi);
});
afterAll(() => {
  for (const [k, v] of [["CHATBRIDGE_AGENT", saved.agent], ["CUBILOT_DATA_DIR", saved.data]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const assistant = (totalTokens: number, stopReason = "stop") => ({ role: "assistant", stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens } });

test("agent_end writes the statusline file and readContextPct returns the percentage", () => {
  handlers.agent_end({ messages: [{ role: "user" }, assistant(1000), { role: "toolResult" }, assistant(50_000)] }, { model: { contextWindow: 200_000 } });
  const file = join(data, "context", "validator-9.json");
  expect(JSON.parse(readFileSync(file, "utf8")).context_window.used_percentage).toBe(25);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readContextPct("validator-9", join(data, "context"))).toBe(25);
  expect(readdirSync(join(data, "context"))).toEqual(["validator-9.json"]); // no tmpfile left
});

test("the model window falls back to getContextUsage; an aborted zero-usage message is skipped", () => {
  handlers.agent_end({ messages: [assistant(40_000), assistant(0, "aborted")] }, { getContextUsage: () => ({ contextWindow: 100_000 }) });
  expect(readContextPct("validator-9", join(data, "context"))).toBe(40);
});

test("contextPct is null without usage or window, and capped at 100", () => {
  expect(ext.contextPct([{ role: "user" }], 1000)).toBeNull();
  expect(ext.contextPct([assistant(5)], undefined)).toBeNull();
  expect(ext.contextPct([assistant(5)], 0)).toBeNull();
  expect(ext.contextPct([assistant(5000)], 1000)).toBe(100);
});

test("no usable usage leaves the file unchanged", () => {
  handlers.agent_end({ messages: [{ role: "user" }] }, { model: { contextWindow: 1000 } });
  expect(readContextPct("validator-9", join(data, "context"))).toBe(40);
});
