// context-pack 3.1: buildPack runs `graphify query` with budget 1500 in the room's project folder; no model call.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, containNamed, namedPaths, GRAPH_BUDGET_TOKENS, packCommandCount, COMMAND_LIMIT_MS } from "../../hub/core/context-pack";
import { repoWithBranch, stubBin, stubBinAdd, stubGraphify, withEnv, writeGraph } from "../helpers/pack-fixture";

const PATH = process.env.PATH ?? "";

describe("graph part of the pack (3.1)", () => {
  test("a stub graphify returns text: the pack holds it, called with the question and --budget 1500 in the project folder", async () => {
    const { project, worktree } = repoWithBranch();
    writeGraph(project);
    const bin = stubGraphify('echo "ARGS: $*"; pwd');
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "add the thing", worktree, projectFolder: project }));
    expect(pack.text.graph).toContain("Graph status: fresh");
    expect(pack.text.graph).toContain(`ARGS: query add the thing --budget ${GRAPH_BUDGET_TOKENS}`);
    expect(pack.text.graph).toContain(project.replace(/^\/private/, ""));
  });

  test("output over the budget is cut to 4 bytes per token", async () => {
    const { project, worktree } = repoWithBranch();
    writeGraph(project);
    const bin = stubGraphify("head -c 20000 /dev/zero | tr '\\0' x");
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree, projectFolder: project }));
    const body = pack.text.graph!.split("\n").slice(2).join("\n");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(GRAPH_BUDGET_TOKENS * 4);
  }, 60000);

  test("a question that starts with a dash is not passed as an option", async () => {
    const { project, worktree } = repoWithBranch();
    writeGraph(project);
    const bin = stubGraphify('echo "FIRST: $2"');
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "--graph /etc/passwd", worktree, projectFolder: project }));
    expect(pack.text.graph).toContain("FIRST: graph /etc/passwd");
  });

  test("a failing graphify gives no graph text and the other parts still build", async () => {
    const { project, worktree } = repoWithBranch();
    writeGraph(project);
    const bin = stubGraphify("exit 3");
    const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role: "worker", question: "q", worktree, projectFolder: project }));
    expect(pack.text.graph).toBeUndefined();
    expect(pack.graphStatus).toBe("missing");
  });

  test("roles without graph depth run no graphify (tester, editor)", async () => {
    const { project, worktree } = repoWithBranch();
    writeGraph(project);
    const bin = stubGraphify("echo should-not-run");
    for (const role of ["tester", "editor"]) {
      const pack = await withEnv({ PATH: `${bin}:${PATH}` }, () => buildPack({ role, question: "q", worktree, projectFolder: project }));
      expect(pack.text.graph).toBeUndefined();
    }
  });

  test("worst-case delay: command count by role", () => {
    expect(packCommandCount("worker")).toBe(3); // git log, graphify query, one ctags run
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

// 3.3: signatures of the named files. Serena has no callable interface for the hub, so the only tool is universal-ctags.
const CTAGS_JSON = String.raw`printf '%s\n' '{"_type":"tag","name":"hello","path":"./src.ts","kind":"function","signature":"(a: number)","line":3}'`;

describe("signatures part of the pack (3.3)", () => {
  const emptyBin = () => mkdtempSync(join(tmpdir(), "pack-nobin-"));
  const sys = "/usr/bin:/bin";

  test("with a ctags stub: signatures for a named file and none for a missing one, labelled ctags", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    const bin = stubBin("ctags", `echo "ARGS: $*" >&2; ${CTAGS_JSON}`);
    const pack = await withEnv({ PATH: `${bin}:${sys}` }, () => buildPack({ role: "worker", question: "q", worktree, files: ["src.ts", "gone.ts"] }));
    const t = pack.text.signatures!;
    expect(t.split("\n")[0]).toBe("signatures (ctags)");
    expect(t).toContain("src.ts:\n  function hello(a: number) :3");
    expect(t).toContain("gone.ts: none");
  }, 60000);

  test("ctags argv is fixed: json output, relative ./ paths, no shell", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "-rf.ts"), "x");
    const seen: string[][] = [];
    const bin = stubBin("ctags", "true");
    await withEnv({ PATH: `${bin}:${sys}` }, () =>
      buildPack({ role: "worker", question: "q", worktree, files: ["-rf.ts"] }, async (argv) => { seen.push(argv); return { ok: true, stdout: "" }; }));
    const c = seen.find((a) => a[0].endsWith("ctags"))!;
    expect(c.slice(1)).toEqual(["--output-format=json", "--fields=+nS", "-f", "-", "./-rf.ts"]);
  });

  test("a file ctags knows nothing about is none", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "other.ts"), "x");
    const bin = stubBin("ctags", "true");
    const pack = await withEnv({ PATH: `${bin}:${sys}` }, () => buildPack({ role: "worker", question: "q", worktree, files: ["other.ts"] }));
    expect(pack.text.signatures).toContain("other.ts: none");
  });

  test("neither Serena nor ctags: the part says missing, on every host", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    const seen: string[][] = [];
    const pack = await buildPack({ role: "worker", question: "q", worktree, files: ["src.ts"], findCtags: () => null }, async (a) => { seen.push(a); return { ok: true, stdout: "" }; });
    expect(pack.text.signatures).toContain("missing");
    expect(seen.some((a) => a[0].includes("ctags"))).toBe(false);
  });

  test("a ctags that fails (the BSD ctags of macOS) marks only the signatures part missing", async () => {
    const { project, worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    writeGraph(project);
    const bin = stubBin("ctags", "exit 1");
    stubBinAdd(bin, "graphify", "echo G");
    const pack = await withEnv({ PATH: `${bin}:${sys}` }, () => buildPack({ role: "worker", question: "q", worktree, projectFolder: project, files: ["src.ts"], findCtags: () => join(bin, "ctags") }));
    expect(pack.text.signatures).toContain("missing");
    expect(pack.text.graph).toContain("G");
  });

  test("a ctags that sleeps past the limit marks only its part missing", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    const bin = stubBin("ctags", "sleep 30");
    const t0 = Date.now();
    const pack = await withEnv({ PATH: `${bin}:${sys}` }, () => buildPack({ role: "worker", question: "q", worktree, files: ["src.ts"], limitMs: 300, findCtags: () => join(bin, "ctags") }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(pack.text.signatures).toContain("missing");
  });

  test("roles without signatures in the depth table run no ctags", async () => {
    const { worktree } = repoWithBranch();
    writeFileSync(join(worktree, "src.ts"), "x");
    const bin = stubBin("ctags", CTAGS_JSON);
    for (const role of ["tester", "validator", "editor"]) {
      const pack = await withEnv({ PATH: `${bin}:${sys}` }, () => buildPack({ role, question: "q", worktree, files: ["src.ts"] }));
      expect(pack.text.signatures).toBeUndefined();
    }
  });

  test("no file named: no part", async () => {
    const { worktree } = repoWithBranch();
    const pack = await buildPack({ role: "worker", question: "q", worktree, files: [] });
    expect(pack.text.signatures).toBeUndefined();
  });

  test("no rg or grep fallback in context-pack.ts", () => {
    const src = readFileSync(new URL("../../hub/core/context-pack.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/["'`](rg|grep|ripgrep|egrep)["'`]/);
    expect(src).not.toMatch(/ripgrep|\bgrep\b/);
  });
});

describe("path containment (5b)", () => {
  function tree() {
    const { worktree } = repoWithBranch();
    const outside = mkdtempSync(join(tmpdir(), "pack-out-"));
    writeFileSync(join(outside, "secret.ts"), "s");
    mkdirSync(join(worktree, "src"));
    writeFileSync(join(worktree, "src", "ok.ts"), "x");
    return { worktree, outside };
  }

  test("a normal relative path is kept", () => {
    const { worktree } = tree();
    expect(containNamed(["src/ok.ts"], worktree).keep).toEqual(["src/ok.ts"]);
  });
  test("an absolute path outside is dropped", () => {
    const { worktree, outside } = tree();
    expect(containNamed([join(outside, "secret.ts"), "/etc/hosts"], worktree)).toEqual({ keep: [], missing: [] });
  });
  test("a parent path that leaves the worktree is dropped", () => {
    const { worktree, outside } = tree();
    expect(containNamed(["../../etc/hosts", `../${outside}/secret.ts`], worktree)).toEqual({ keep: [], missing: [] });
  });
  test("a symlink to an outside file is dropped", () => {
    const { worktree, outside } = tree();
    symlinkSync(join(outside, "secret.ts"), join(worktree, "link.ts"));
    expect(containNamed(["link.ts"], worktree)).toEqual({ keep: [], missing: [] });
  });
  test("a symlink to an outside folder is dropped, also for a file below it", () => {
    const { worktree, outside } = tree();
    symlinkSync(outside, join(worktree, "dir"));
    expect(containNamed(["dir", "dir/secret.ts"], worktree)).toEqual({ keep: [], missing: [] });
  });
  test("a dropped path never reaches the command", async () => {
    const { worktree, outside } = tree();
    symlinkSync(join(outside, "secret.ts"), join(worktree, "link.ts"));
    const seen: string[][] = [];
    const bin = stubBin("ctags", "true");
    const pack = await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, () =>
      buildPack({ role: "worker", question: "q", worktree, files: ["link.ts", join(outside, "secret.ts"), "../x.ts"] }, async (a) => { seen.push(a); return { ok: true, stdout: "" }; }));
    expect(seen.filter((a) => a[0].endsWith("ctags"))).toEqual([]);
    expect(pack.text.signatures).toBeUndefined();
  });
  test("a missing file inside the worktree is named as missing, a folder is dropped", () => {
    const { worktree } = tree();
    expect(containNamed(["src/gone.ts", "src"], worktree)).toEqual({ keep: [], missing: ["src/gone.ts"] });
  });
});

describe("spec paths in the named files (3.3, item 2)", () => {
  // The merge of criteria paths and spec paths is made by the stage seam (tests/unit/context-pack-launch.test.ts);
  // here every path of the merged list goes through the same containment.
  test("a spec path inside the worktree reaches the signature command once, also when the criteria name it", async () => {
    const { worktree } = repoWithBranch();
    mkdirSync(join(worktree, "hub"));
    writeFileSync(join(worktree, "hub", "a.ts"), "x");
    const seen: string[][] = [];
    await buildPack({ role: "worker", question: "q", worktree, files: ["hub/a.ts", "hub/a.ts", "./hub/a.ts"], findCtags: () => "/stub/ctags" }, async (a) => { seen.push(a); return { ok: true, stdout: "" }; });
    const c = seen.find((a) => a[0] === "/stub/ctags")!;
    expect(c.filter((x) => x.endsWith("a.ts"))).toEqual(["./hub/a.ts"]);
  });
  test("a spec path outside the worktree (absolute, parent, symlink to a file) is dropped", async () => {
    const { worktree } = repoWithBranch();
    const outside = mkdtempSync(join(tmpdir(), "pack-out-"));
    writeFileSync(join(outside, "s.ts"), "s");
    symlinkSync(join(outside, "s.ts"), join(worktree, "l.ts"));
    const seen: string[][] = [];
    const pack = await buildPack({ role: "worker", question: "q", worktree, files: [join(outside, "s.ts"), "../s.ts", "l.ts"], findCtags: () => "/stub/ctags" }, async (a) => { seen.push(a); return { ok: true, stdout: "" }; });
    expect(seen.filter((a) => a[0] === "/stub/ctags")).toEqual([]);
    expect(pack.text.signatures).toBeUndefined();
  });
});

describe("named paths of a criteria text", () => {
  test("path-like tokens only", () => {
    expect(namedPaths("Edit `hub/core/context-pack.ts`, see tasks.md. e.g. fast; then (tests/unit/a.test.ts).")).toEqual([
      "hub/core/context-pack.ts", "tasks.md", "tests/unit/a.test.ts",
    ]);
  });
});
