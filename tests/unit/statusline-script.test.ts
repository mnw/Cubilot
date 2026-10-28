import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "factory/shared/scripts/statusline.sh";

async function run(agent: string | undefined, input: string, dir: string) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, CUBILOT_DATA_DIR: dir };
  delete env.CHATBRIDGE_AGENT;
  if (agent !== undefined) env.CHATBRIDGE_AGENT = agent;
  const p = Bun.spawn(["bash", SCRIPT], { env, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { out, code: p.exitCode };
}

test("the file has the input JSON, mode 0600, and the output is one short line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-"));
  const input = '{"context_window":{"used_percentage":42.5}}';
  const r = await run("worker-1", input, dir);
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n").length).toBe(1);
  expect(r.out.length).toBeLessThan(80);
  const file = join(dir, "context", "worker-1.json");
  expect(readFileSync(file, "utf8")).toBe(input);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dir, "context"))).toEqual(["worker-1.json"]);
});

test("a second write replaces the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-"));
  await run("a", '{"x":1}', dir);
  await run("a", '{"x":2}', dir);
  expect(readFileSync(join(dir, "context", "a.json"), "utf8")).toBe('{"x":2}');
});

test("no agent name or a path in it writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-"));
  for (const a of [undefined, "", "../x", "a/b", ".hid"]) {
    const r = await run(a, "{}", dir);
    expect(r.code).toBe(0);
  }
  expect(existsSync(join(dir, "context"))).toBe(false);
});
