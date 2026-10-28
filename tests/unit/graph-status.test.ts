// context-pack 3.2: graph status fresh | stale | missing; missing adds no placeholder text.
import { describe, expect, test } from "bun:test";
import { buildPack, runCommand, type Runner } from "../../hub/core/context-pack";
import { repoWithBranch, stubGraphify, withEnv, writeGraph } from "../helpers/pack-fixture";

const PATH = process.env.PATH ?? "";
const build = (worktree: string, bin: string, limitMs?: number) =>
  withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree, limitMs }));

describe("graph status (3.2)", () => {
  test("fresh: graph.json is not older than HEAD", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree, 0);
    const p = await build(worktree, stubGraphify("echo hit"));
    expect(p.graphStatus).toBe("fresh");
    expect(p.text.graph).toStartWith("Graph status: fresh\n");
  });

  test("stale: graph.json is older than the HEAD commit; the text says so", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree, 3600);
    const p = await build(worktree, stubGraphify("echo hit"));
    expect(p.graphStatus).toBe("stale");
    expect(p.text.graph).toStartWith("Graph status: stale\n");
  });

  test("absent file: missing, no graph text, graphify is not run", async () => {
    const { worktree } = repoWithBranch();
    const p = await build(worktree, stubGraphify("echo ran >&2; echo hit"));
    expect(p).toEqual({ text: {}, graphStatus: "missing" });
  });

  test("tool not found: missing, no graph text", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const empty = await withEnv({ PATH: "/usr/bin:/bin" }, () => buildPack({ role: "worker", question: "q", worktree }));
    expect(empty).toEqual({ text: {}, graphStatus: "missing" });
  });

  test("command timeout: the sleeping graphify is stopped, the part is missing, no placeholder", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const t0 = Date.now();
    // Not `exec`: the shell's child keeps the pipe open, so this also proves the build does not wait for the pipe.
    const p = await build(worktree, stubGraphify("sleep 30; echo late"), 400);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(p).toEqual({ text: {}, graphStatus: "missing" });
  });

  test("runCommand: ok, exit code, timeout, and a program that does not exist", async () => {
    expect(await runCommand(["echo", "x"], "/tmp", 2000)).toEqual({ ok: true, stdout: "x\n" });
    expect(await runCommand(["false"], "/tmp", 2000)).toEqual({ ok: false, timedOut: false });
    expect(await runCommand(["sleep", "10"], "/tmp", 200)).toEqual({ ok: false, timedOut: true });
    expect(await runCommand(["/no/such/program"], "/tmp", 2000)).toEqual({ ok: false, timedOut: false });
  });

  test("git cannot give the HEAD time: the graph is not shown as fresh", async () => {
    const { worktree } = repoWithBranch();
    writeGraph(worktree);
    const bin = stubGraphify("echo hit");
    const run: Runner = (argv, cwd, l) => (argv[0] === "git" ? Promise.resolve({ ok: false, timedOut: true }) : runCommand(argv, cwd, l));
    const p = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree }, run));
    expect(p.graphStatus).toBe("stale");
  });
});
