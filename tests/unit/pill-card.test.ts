// The hover card of a roster pill (ui/features/pill-card.js): the same five fields for every agent.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/features/pill-card.js", "utf8"))(win);
const { pillCardFields } = win;
const keys = (f: string[][]) => f.map((r) => r[0]);
const ORDER = ["Role", "Harness", "Model", "Provider", "Effort"];

describe("pillCardFields", () => {
  test("a Claude role agent: provider is anthropic", () => {
    const f = pillCardFields({ role: "worker", model: "opus", provider: "" }, "claude");
    expect(keys(f)).toEqual(ORDER);
    expect(f.map((r: string[]) => r[1])).toEqual(["worker", "claude", "opus", "anthropic", "-"]);
  });
  test("a Pi role agent", () => {
    const f = pillCardFields({ role: "reviewer", model: "gpt-5.6-sol", provider: "openai-codex" }, "pi", "high");
    expect(keys(f)).toEqual(ORDER);
    expect(f.map((r: string[]) => r[1])).toEqual(["reviewer", "pi", "gpt-5.6-sol", "openai-codex", "high"]);
  });
  test("an agent with no role and an external agent with no metadata", () => {
    for (const f of [pillCardFields(undefined, null), pillCardFields({}, undefined), pillCardFields(undefined, "claude")]) {
      expect(keys(f)).toEqual(ORDER);
    }
    // launched by this app without a role: "no role"; model and effort not recorded: "-" ("default" only when recorded)
    expect(pillCardFields({ role: "", model: "", provider: "", effort: "", harness: "pi" }).map((r: string[]) => r[1])).toEqual(["no role", "pi", "-", "-", "-"]);
    // external agent, no metadata at all: "-" everywhere
    expect(pillCardFields(undefined, null).map((r: string[]) => r[1])).toEqual(["-", "-", "-", "-", "-"]);
  });
  test("every field can come from the recorded info alone", () => {
    const f = pillCardFields({ role: "", model: "gpt-5.6-sol", provider: "openai-codex", effort: "xhigh", harness: "pi" });
    expect(f.map((r: string[]) => r[1])).toEqual(["no role", "pi", "gpt-5.6-sol", "openai-codex", "xhigh"]);
    const c = pillCardFields({ role: "", model: "", provider: "", effort: "", harness: "claude" });
    expect(c.map((r: string[]) => r[1])).toEqual(["no role", "claude", "-", "anthropic", "-"]);
  });
  test("an unknown harness value shows '-' and the provider is not guessed", () => {
    const f = pillCardFields({ role: "worker", model: "m", provider: "" }, "other");
    expect(f[1][1]).toBe("-");
    expect(f[3][1]).toBe("-");
  });
});
