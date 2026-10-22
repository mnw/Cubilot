import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "../../hub/channel/host";
import { nodeHost } from "../../hub/channel/node-host";
import { runHandoffGate } from "../../hub/channel/core";
import { findTool } from "../../hub/channel/tools";

// A Host with a scripted gate result: records what exec got.
function fake(gate: string | null, exec?: Host["exec"]) {
  const logs: string[] = [];
  const execs: Array<{ command: string; stdin: string; timeoutMs: number }> = [];
  const host = {
    handoffGate: async () => gate,
    exec: exec ?? (async (command, stdin, timeoutMs) => { execs.push({ command, stdin, timeoutMs }); return { code: 0, stderr: "", timedOut: false }; }),
    log: (m: string) => logs.push(m),
    readText: async (p: string) => (p.endsWith("hub.url") ? "http://hub.test" : "tok"),
    request: async (url: string) => { posted.push(url); return { status: 201, text: '{"id":"h_0123456789abcdef"}' }; },
  } as unknown as Host;
  return { host, logs, execs };
}
const posted: string[] = [];
const input = { to: "reviewer", task: "t", context: { path: "/x.md" } };

describe("runHandoffGate (core)", () => {
  test("gate unset: nothing runs", async () => {
    const f = fake(null);
    await runHandoffGate(f.host, input);
    expect(f.execs).toHaveLength(0);
  });
  test("exit 0: passes, the gate gets the hook-shaped event on stdin", async () => {
    const f = fake("my-gate");
    await runHandoffGate(f.host, input);
    expect(f.execs).toHaveLength(1);
    expect(f.execs[0].command).toBe("my-gate");
    expect(JSON.parse(f.execs[0].stdin)).toEqual({ tool_name: "mcp__chatbridge__send_handoff", tool_input: input });
    expect(f.execs[0].timeoutMs).toBeGreaterThan(0);
  });
  test("exit 2: blocks with the gate's stderr", async () => {
    const f = fake("g", async () => ({ code: 2, stderr: "fix the doc\n", timedOut: false }));
    await expect(runHandoffGate(f.host, input)).rejects.toThrow("fix the doc");
  });
  test("exit 2 with an empty stderr still blocks, with a default line", async () => {
    const f = fake("g", async () => ({ code: 2, stderr: "", timedOut: false }));
    await expect(runHandoffGate(f.host, input)).rejects.toThrow("blocked");
  });
  test("another exit code, a timeout and a start failure are gate faults: logged, the handoff goes on", async () => {
    for (const exec of [
      async () => ({ code: 1, stderr: "x", timedOut: false }),
      async () => ({ code: null, stderr: "", timedOut: true }),
      async () => { throw new Error("spawn failed"); },
    ] as Host["exec"][]) {
      const f = fake("g", exec);
      await runHandoffGate(f.host, input);
      expect(f.logs).toHaveLength(1);
    }
  });
});

describe("send_handoff tool", () => {
  const send = (host: Host) => findTool("send_handoff")!.handler({ agent: "ed", hubEnv: "", host, room: "r" }, input);
  test("a blocked handoff is never posted to the hub", async () => {
    posted.length = 0;
    const f = fake("g", async () => ({ code: 2, stderr: "no", timedOut: false }));
    await expect(send(f.host)).rejects.toThrow("no");
    expect(posted).toHaveLength(0);
  });
  test("a passed handoff is posted", async () => {
    posted.length = 0;
    const f = fake("g");
    expect((await send(f.host)).content[0].text).toBe("handoff_id=h_0123456789abcdef");
    expect(posted).toHaveLength(1);
  });
});

describe("nodeHost.exec (the pi host)", () => {
  const h = nodeHost(async () => {}, async () => {});
  test("exit codes, stderr and stdin", async () => {
    expect(await h.exec("exit 0", "", 5000)).toMatchObject({ code: 0, timedOut: false });
    expect(await h.exec("cat >&2; exit 2", "hello", 5000)).toMatchObject({ code: 2, stderr: "hello" });
  });
  test("a gate that hangs is killed at the bound", async () => {
    const t0 = Date.now();
    const r = await h.exec("sleep 30", "", 200);
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("a gate that ignores stdin does not break the write", async () => {
    expect((await h.exec("exit 0", "x".repeat(1_000_000), 5000)).code).toBe(0);
  });
  test("handoffGate reads CHATBRIDGE_HANDOFF_GATE; unset or empty is null", async () => {
    const was = process.env.CHATBRIDGE_HANDOFF_GATE;
    process.env.CHATBRIDGE_HANDOFF_GATE = " g ";
    expect(await h.handoffGate()).toBe("g");
    process.env.CHATBRIDGE_HANDOFF_GATE = "";
    expect(await h.handoffGate()).toBeNull();
    if (was === undefined) delete process.env.CHATBRIDGE_HANDOFF_GATE; else process.env.CHATBRIDGE_HANDOFF_GATE = was;
  });
});

// The Editor's own gate, run as the Editor plugin would stage it (hooks/ + skills/asd-ste100 from the shared folder).
describe("factory/editor/hooks/ste-gate.py as the gate", () => {
  let root = "";
  let docs = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gate-plugin-"));
    docs = mkdtempSync(join(tmpdir(), "gate-docs-"));
    mkdirSync(join(root, "hooks"));
    cpSync("factory/editor/hooks/ste-gate.py", join(root, "hooks", "ste-gate.py"));
    cpSync("factory/shared/skills/asd-ste100", join(root, "skills", "asd-ste100"), { recursive: true });
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(docs, { recursive: true, force: true }); });

  const gate = () => `CLAUDE_PLUGIN_ROOT='${root}' python3 '${root}/hooks/ste-gate.py'`;
  const h = nodeHost(async () => {}, async () => {});
  const host = (): Host => ({ ...h, handoffGate: async () => gate(), log: () => {} });

  test("a doc with a hard violation blocks a handoff to the reviewer", async () => {
    const bad = join(docs, "bad.md");
    // Semicolons and a long sentence are hard STE violations.
    writeFileSync(bad, "# T\n\nThe operator shall open the valve; then the pressure, which was too high for the old pump that the crew had installed last year, drops.\n");
    await expect(runHandoffGate(host(), { to: "reviewer", task: "t", context: { path: bad } })).rejects.toThrow(/ASD-STE100|blocked/);
  });
  test("a clean doc passes; a handoff to another agent passes; no context.path to the reviewer is blocked", async () => {
    const ok = join(docs, "ok.md");
    writeFileSync(ok, "# Title\n\nOpen the valve.\n");
    await runHandoffGate(host(), { to: "reviewer", task: "t", context: { path: ok } });
    await runHandoffGate(host(), { to: "someone", task: "t" });
    await expect(runHandoffGate(host(), { to: "reviewer", task: "t" })).rejects.toThrow("context.path");
  });
});
