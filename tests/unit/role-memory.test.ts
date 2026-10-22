// terminal/role-memory.js: the remembered role, grid choice and launch harness of an agent name (task 9.5).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/terminal/role-memory.js", "utf8"))(win);
const rm = win.__CUBILOT_TERM__.roleMemory;
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("role memory", () => {
  test("stores and recalls the harness with the choice", () => {
    const s = store();
    rm.remember(s, "w1", "worker", { model: "gpt-5.6-sol", provider: "openai-codex", effort: "low", harness: "pi" });
    expect(rm.recall(s, "w1")).toEqual({ role: "worker", model: "gpt-5.6-sol", provider: "openai-codex", effort: "low", harness: "pi" });
  });
  test("an entry without a harness recalls an empty one; None forgets the agent", () => {
    const s = store();
    rm.remember(s, "w1", "worker", { model: "opus" });
    expect(rm.recall(s, "w1").harness).toBe("");
    rm.remember(s, "w1", "", { harness: "pi" });
    expect(rm.recall(s, "w1")).toBeNull();
  });
});
