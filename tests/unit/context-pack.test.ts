// context-pack 3.1: buildPack runs `graphify query` with budget 1500 in the worktree; no model call.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPack, GRAPH_BUDGET_TOKENS, packCommandCount, COMMAND_LIMIT_MS } from "../../hub/core/context-pack";
import { repoWithBranch, stubGraphify, withEnv, writeGraph } from "../helpers/pack-fixture";

const PATH = process.env.PATH ?? "";

describe("graph part of the pack (3.1)", () => {
  test("a stub graphify returns text: the pack holds it, called with the question and --budget 1500 in the worktree", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify('echo "ARGS: $*"; pwd');
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "add the thing", worktree }));
    expect(pack.text.graph).toContain("Graph status: fresh");
    expect(pack.text.graph).toContain(`ARGS: query add the thing --budget ${GRAPH_BUDGET_TOKENS}`);
    expect(pack.text.graph).toContain(worktree.replace(/^\/private/, ""));
  });

  test("output over the budget is cut to 4 bytes per token", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify("head -c 20000 /dev/zero | tr '\\0' x");
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree }));
    const body = pack.text.graph!.split("\n").slice(1).join("\n");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(GRAPH_BUDGET_TOKENS * 4);
  });

  test("a question that starts with a dash is not passed as an option", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify('echo "FIRST: $2"');
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "--graph /etc/passwd", worktree }));
    expect(pack.text.graph).toContain("FIRST: graph /etc/passwd");
  });

  test("a failing graphify gives no graph text and the other parts still build", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify("exit 3");
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree }));
    expect(pack.text.graph).toBeUndefined();
    expect(pack.graphStatus).toBe("missing");
  });

  test("roles without graph depth run no graphify (tester, editor)", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify("echo should-not-run");
    for (const role of ["tester", "editor"]) {
      const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role, question: "q", worktree }));
      expect(pack.text.graph).toBeUndefined();
    }
  });

  test("worst-case delay: command count by role", () => {
    expect(packCommandCount("worker")).toBe(2);
    expect(packCommandCount("tester")).toBe(2);
    expect(packCommandCount("validator")).toBe(3);
    expect(packCommandCount("validator", "spec")).toBe(2);
    expect(packCommandCount("editor")).toBe(0);
    expect(COMMAND_LIMIT_MS).toBe(20_000);
  });

  test("context-pack.ts imports no model adapter and no shell string runner", () => {
    const src = readFileSync(new URL("../../hub/core/context-pack.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./first-message", "./pack-depth", "node:fs", "node:os", "node:path"].sort());
    expect(src).not.toMatch(/spawnSync|\bsh -c\b|\bbash -c\b|anthropic|claude-|openai|fetch\(/i);
  });
});
