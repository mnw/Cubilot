// The Tauri event name of an agent's pane (ui/terminal/pty.js). The same vectors are pinned in pty.rs
// (pty_event_names_are_hex_of_the_agent_name_and_only_use_allowed_characters): both sides give the same string.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = { __CUBILOT_TERM__: {} };
new Function("window", readFileSync("ui/terminal/pty.js", "utf8"))(win);
const ev: (k: string, a: string) => string = win.__CUBILOT_TERM__.pty.ptyEventName;

describe("pty event name", () => {
  test("same strings as the Rust helper", () => {
    expect(ev("output", "alice")).toBe("pty://output/616c696365");
    expect(ev("exit", "orchestrator-Test room")).toBe("pty://exit/6f7263686573747261746f722d5465737420726f6f6d");
    expect(ev("output", "t a.b")).toBe("pty://output/7420612e62");
    expect(ev("output", "é")).toBe("pty://output/c3a9");
  });

  test("only characters Tauri accepts, and injective", () => {
    const ok = /^pty:\/\/(output|exit)\/[a-z0-9]+$/;
    const names = ["a b", "a.b", "a_b", "a-b", "A b", "a  b", "orchestrator-Test room"];
    for (const n of names) expect(ev("output", n)).toMatch(ok);
    expect(new Set(names.map((n) => ev("output", n))).size).toBe(names.length);
    expect(ev("output", "a")).not.toBe(ev("exit", "a"));
  });
});
