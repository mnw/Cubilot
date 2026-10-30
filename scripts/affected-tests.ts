// Selects the test files that a change affects. Used by scripts/test-affected.sh.
//   bun scripts/affected-tests.ts <base commit>
// Prints one test file path per line (relative to the repo root). Exit 1 on an error.
// Selection: a changed test file, every test file that imports a changed file or a file that re-exports a changed file
// (one level), and all of tests/contract/. Import scan: static `import ... from` and `export ... from` lines of .ts files
// under hub/, ui/ and tests/. git runs with fixed arguments; no file name goes through a shell.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ROOTS = ["hub", "ui", "tests"];
const FROM_RE = /^\s*(import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const SKIP_DIR = new Set(["node_modules", "vendor"]);

const base = process.argv[2];
if (!base) {
  console.error("usage: affected-tests.ts <base commit>");
  process.exit(1);
}

const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
};

const walk = (dir: string, out: string[]): void => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
};

const resolveSpec = (from: string, spec: string, known: Set<string>): string | null => {
  if (!spec.startsWith(".")) return null;
  const p = normalize(join(dirname(from), spec));
  for (const c of [p, `${p}.ts`, p.replace(/\.js$/, ".ts"), join(p, "index.ts")]) if (known.has(c)) return c;
  return null;
};

try {
  git("rev-parse", "--verify", `${base}^{commit}`);
  const changed = new Set(git("diff", "--name-only", "--diff-filter=d", base, "HEAD").split("\n").filter(Boolean));
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);
  const known = new Set(files);

  const imports = new Map<string, Set<string>>(); // file -> files it imports or re-exports
  const reexports = new Map<string, Set<string>>(); // file -> files it re-exports
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const all = new Set<string>();
    const re = new Set<string>();
    for (const m of src.matchAll(FROM_RE)) {
      const t = resolveSpec(f, m[2] ?? m[3] ?? "", known);
      if (!t) continue;
      all.add(t);
      if (m[1] === "export") re.add(t);
    }
    imports.set(f, all);
    reexports.set(f, re);
  }

  const affected = new Set(changed);
  for (const [f, re] of reexports) for (const t of re) if (changed.has(t)) affected.add(f);

  const isTest = (f: string) => f.startsWith("tests/") && f.endsWith(".test.ts");
  const picked = new Set<string>();
  for (const f of files) {
    if (!isTest(f)) continue;
    if (changed.has(f) || f.startsWith("tests/contract/")) picked.add(f);
    else for (const t of imports.get(f) ?? []) if (affected.has(t)) picked.add(f);
  }
  for (const f of [...picked].sort()) console.log(f);
} catch (e) {
  console.error(`affected-tests: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
