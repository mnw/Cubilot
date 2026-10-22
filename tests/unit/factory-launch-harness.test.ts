// factory-launch.sh --harness (task 9.3): the launch harness is a choice; the role's model, provider and thinking
// apply only on the role's own harness; the tool limits come from the role file for the launch harness.
import { describe, test, expect } from "bun:test";

const run = (...a: string[]) => {
  const p = Bun.spawnSync(["factory/scripts/factory-launch.sh", ...a, "--dry-run"], { env: { ...process.env, CHATBRIDGE_ROOM: "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("factory-launch.sh --harness", () => {
  test("a claude role on pi needs --model, drops the role's model and uses excludeTools", () => {
    expect(run("worker", "x", "--harness", "pi").code).toBe(1);
    const r = run("worker", "x", "--harness", "pi", "--model", "gpt-5.6-sol", "--provider", "openai-codex");
    expect(r.code).toBe(0);
    expect(r.out).toContain("pi --no-skills");
    expect(r.out).toContain("--provider openai-codex --model gpt-5.6-sol");
    expect(r.out).not.toContain("sonnet");
    expect(r.out).toContain("--exclude-tools ack_permission");
  });

  test("a pi role on claude drops provider and thinking and blocks the file tools", () => {
    const r = run("validator", "x", "--harness", "claude", "--model", "opus");
    expect(r.code).toBe(0);
    expect(r.out).toContain("--model opus");
    expect(r.out).toContain("--disallowed-tools Edit,Write,NotebookEdit,Task,Agent,mcp__chatbridge__ack_permission");
    expect(r.out).not.toMatch(/openai-codex|--thinking/);
  });

  test("the role's own harness is unchanged; an unknown harness is an error", () => {
    expect(run("validator", "x").out).toContain("--model gpt-5.6-sol --thinking high --exclude-tools edit,write,ack_permission");
    expect(run("worker", "x").out).toContain("--model sonnet --disallowed-tools Task,Agent,mcp__chatbridge__ack_permission");
    expect(run("worker", "x", "--harness", "foo", "--model", "m").code).toBe(1);
  });
});
