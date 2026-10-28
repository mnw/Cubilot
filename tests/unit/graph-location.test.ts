// context-pack 3.1, 3.2: the graph is the one of the room's project folder (graphify-out/ is git-excluded, so a stage
// worktree has none). A stub Runner records argv and cwd.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, GRAPH_BASE_NOTE, type Runner } from "../../hub/core/context-pack";
import { stubGraphify, withEnv, writeGraph } from "../helpers/pack-fixture";

const PATH = process.env.PATH ?? "";
const dir = (p: string) => mkdtempSync(join(tmpdir(), p));

/** HEAD of every folder was committed `headAgeSec` ago; graphify answers "hit". */
function stubRunner(headAgeSec: number): { run: Runner; calls: { argv: string[]; cwd: string }[] } {
  const calls: { argv: string[]; cwd: string }[] = [];
  const run: Runner = async (argv, cwd) => {
    calls.push({ argv, cwd });
    if (argv[0] === "git") return { ok: true, stdout: `${Math.floor(Date.now() / 1000) - headAgeSec}\n` };
    return { ok: true, stdout: "hit\n" };
  };
  return { run, calls };
}

const build = (project: string | null | undefined, worktree: string, run: Runner) =>
  withEnv({ PATH: `${stubGraphify("echo unused")}:${PATH}` }, () =>
    buildPack({ role: "worker", question: "q", worktree, projectFolder: project }, run));

describe("graph location (room project folder)", () => {
  test("(a) graph in the project folder, newer than its HEAD: fresh, query cwd is the project folder", async () => {
    const project = dir("gl-proj-"), worktree = dir("gl-wt-");
    writeGraph(project, 0);
    const { run, calls } = stubRunner(100);
    const p = await build(project, worktree, run);
    expect(p.graphStatus).toBe("fresh");
    const query = calls.find((c) => c.argv[1] === "query")!;
    expect(query.cwd).toBe(project);
    expect(calls.find((c) => c.argv[0] === "git")!.cwd).toBe(project);
    expect(calls.every((c) => c.cwd === project)).toBe(true);
  });

  test("(b) graph older than the HEAD of the project folder: stale", async () => {
    const project = dir("gl-proj-"), worktree = dir("gl-wt-");
    writeGraph(project, 3600);
    const { run } = stubRunner(100);
    const p = await build(project, worktree, run);
    expect(p.graphStatus).toBe("stale");
    expect(p.text.graph).toStartWith("Graph status: stale\n");
  });

  test("(c) no graph in the project folder: missing, no command", async () => {
    const project = dir("gl-proj-"), worktree = dir("gl-wt-");
    const { run, calls } = stubRunner(100);
    const p = await build(project, worktree, run);
    expect(p).toEqual({ text: {}, graphStatus: "missing" });
    expect(calls).toEqual([]);
  });

  test("(d) graph only in the worktree: missing, no command", async () => {
    const project = dir("gl-proj-"), worktree = dir("gl-wt-");
    writeGraph(worktree, 0);
    const { run, calls } = stubRunner(100);
    const p = await build(project, worktree, run);
    expect(p).toEqual({ text: {}, graphStatus: "missing" });
    expect(calls).toEqual([]);
  });

  test("(e) no projectFolder: missing, the Runner records no call, even with a graph in the worktree", async () => {
    const worktree = dir("gl-wt-");
    writeGraph(worktree, 0);
    for (const project of [null, undefined, ""]) {
      const { run, calls } = stubRunner(100);
      const p = await build(project, worktree, run);
      expect(p).toEqual({ text: {}, graphStatus: "missing" });
      expect(calls).toEqual([]);
    }
  });

  test("(f) the graph line says the graph describes the room base, not the ticket branch", async () => {
    const project = dir("gl-proj-"), worktree = dir("gl-wt-");
    writeGraph(project, 0);
    const { run } = stubRunner(100);
    const p = await build(project, worktree, run);
    expect(GRAPH_BASE_NOTE).toContain("room base");
    expect(GRAPH_BASE_NOTE).toContain("not the ticket branch");
    expect(p.text.graph!.split("\n")[1]).toBe(GRAPH_BASE_NOTE);
  });
});
