// No session launch from tools (stage-sessions 6.2, brief test 8): no chatbridge tool starts or closes a session.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CHATBRIDGE_TOOLS } from "../../hub/channel/tools";
import { buildKinds } from "../../hub/kinds";

const LAUNCH_WORD = /launch|spawn|start|close|session|stage|harness|cwd|prompt|enqueue/i;
// to_role and role pick a role for a ticket or a handoff; the hub's evaluator decides if a stage starts.
const PROPERTY_OK = new Set(["role", "to_role"]);

describe("no launch tool", () => {
  test("no tool name names a launch, start, close or session", () => {
    const bad = CHATBRIDGE_TOOLS.map((t) => t.name).filter((n) => LAUNCH_WORD.test(n));
    expect(bad).toEqual([]);
  });

  test("no tool takes a launch-like argument", () => {
    for (const t of CHATBRIDGE_TOOLS) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      const bad = props.filter((k) => !PROPERTY_OK.has(k) && LAUNCH_WORD.test(k));
      expect({ tool: t.name, bad }).toEqual({ tool: t.name, bad: [] });
    }
  });

  test("the tool names the kinds advertise are exactly the registered tools", () => {
    const advertised = buildKinds(new Database(":memory:")).flatMap((k) => k.toolNames).sort();
    const registered = CHATBRIDGE_TOOLS.map((t) => t.name).filter((n) => !["post", "post_file"].includes(n)).sort();
    expect(advertised).toEqual(registered);
  });

  test("orchestrator.md says that no tool starts a session and that only the hub does", () => {
    const md = readFileSync(join(import.meta.dir, "../../factory/orchestrator/orchestrator.md"), "utf8");
    expect(md).toContain("No chatbridge tool starts or closes a session. Only the hub does it");
  });
});
