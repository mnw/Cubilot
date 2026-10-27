// scripts/stage-prep.sh (t_7556d847551bbfe7). The script runs in a temp git repo whose path has a space, with a stubbed
// bun and stubbed build scripts. Each stub appends one line to a log, so a test counts the steps that ran.
// Every run gets its own CUBILOT_HEAVY_LOCK: no test touches /tmp/cubilot-heavy.lock.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/stage-prep.sh");

let base: string;
let repo: string;
let stubBin: string;
let signed: string;
let lock: string;
let log: string;

const TRIPLE = `$(rustc -Vv 2>/dev/null | awk '/host:/{print $2}')`;

function write(path: string, body: string, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
}

function setup() {
  rmSync(repo, { recursive: true, force: true });
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  write(join(repo, "scripts/stage-prep.sh"), readFileSync(SCRIPT, "utf8"));
  write(join(repo, "package.json"), "{}", 0o644);
  write(join(repo, "bun.lock"), "", 0o644);
  write(join(repo, "hub/a.ts"), "", 0o644);
  write(
    join(repo, "scripts/build-sidecars.sh"),
    `#!/bin/bash
cd "$(dirname "$0")/.."
bun --version > /dev/null || exit 9
echo build-sidecars >> "$LOG"
[ -n "\${SLEEP_BUILD:-}" ] && sleep "$SLEEP_BUILD"
T=${TRIPLE}; T=\${T:-aarch64-apple-darwin}
mkdir -p src-tauri/binaries src-tauri/resources
cp "$SIGNED" "src-tauri/binaries/cubilot-bin-$T"
echo x > src-tauri/resources/pi-extension.js
echo x > src-tauri/resources/chatbridge-mod.js
[ -n "\${RO_STAMPS:-}" ] && chmod a-w .stage-prep
[ "\${FAIL_STEP:-}" = sidecars ] && exit 1
exit 0
`,
  );
  write(
    join(repo, "scripts/build-tmux.sh"),
    `#!/bin/bash
cd "$(dirname "$0")/.."
echo build-tmux >> "$LOG"
mkdir -p src-tauri/resources
cp "$SIGNED" src-tauri/resources/tmux
exit 0
`,
  );
  rmSync(log, { force: true });
}

// The steps that ran, without the stub's `bun --version` probe.
function steps(): string[] {
  const out = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  rmSync(log, { force: true });
  return out.filter((s) => s !== "bun --version");
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${stubBin}:/usr/bin:/bin`,
    HOME: join(base, "home"),
    LOG: log,
    SIGNED: signed,
    CUBILOT_HEAVY_LOCK: lock,
    CUBILOT_LOCK_WAIT_S: "20",
    CUBILOT_LOCK_RETRY_S: "1",
    ...extra,
  };
}

const TESTER_CMD = `cd "$R" && ./scripts/stage-prep.sh; echo "stage-prep exit $?"`;

function run(extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(["/bin/bash", "-c", TESTER_CMD], { env: { ...env(extra), R: repo } });
  return { out: p.stdout.toString(), err: p.stderr.toString() };
}

function sourced(cmd: string, extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(["/bin/bash", "-c", `cd "$R" && . ./.stage-prep.env && ${cmd}`], { env: { ...env(extra), R: repo } });
  return p.stdout.toString().trim();
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "cubilot-stage-prep-"));
  repo = join(base, "a repo with space");
  stubBin = join(base, "stubbin");
  lock = join(base, "heavy.lock");
  log = join(base, "steps.log");
  mkdirSync(join(base, "home"));
  write(
    join(stubBin, "bun"),
    `#!/bin/bash
echo "bun $*" >> "$LOG"
if [ "$1" = install ]; then
  mkdir -p node_modules/.bin
  printf '#!/bin/sh\\n' > node_modules/.bin/tsc
  chmod +x node_modules/.bin/tsc
fi
exit 0
`,
  );
  signed = join(base, "signed-stub");
  copyFileSync("/usr/bin/true", signed);
  Bun.spawnSync(["codesign", "--force", "--sign", "-", signed]);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(setup);

describe("stage-prep.sh", () => {
  test("(a) cold run: each step once, exit 0, env file finds the tmux stub", () => {
    expect(run().out).toContain("stage-prep exit 0");
    expect(steps()).toEqual(["bun install --frozen-lockfile", "build-sidecars", "build-tmux"]);
    expect(sourced("command -v tmux")).toBe(join(repo, "src-tauri/resources/tmux"));
    expect(existsSync(lock)).toBe(false);
  });

  test("(b) second run: no step runs", () => {
    run();
    steps();
    expect(run().out).toContain("stage-prep exit 0");
    expect(steps()).toEqual([]);
  });

  test("(c) a newer input of the sidecar step: only that step runs", () => {
    run();
    steps();
    const t = new Date(Date.now() + 10_000);
    utimesSync(join(repo, "hub/a.ts"), t, t);
    run();
    expect(steps()).toEqual(["build-sidecars"]);
  });

  test("(d) a failing step: non-zero exit and the step name", () => {
    const r = run({ FAIL_STEP: "sidecars" });
    expect(r.out).toMatch(/stage-prep exit [1-9]/);
    expect(r.err).toContain("step sidecars");
  });

  test("(k) a stamp that cannot be written: non-zero exit and the step name", () => {
    const r = run({ RO_STAMPS: "1" });
    chmodSync(join(repo, ".stage-prep"), 0o755);
    expect(r.out).toMatch(/stage-prep exit [1-9]/);
    expect(r.err).toContain("step sidecars failed (stamp write)");
  });

  test("(l) an env file that cannot be written: non-zero exit and the step name", () => {
    mkdirSync(join(repo, ".stage-prep.env.tmp"));
    const r = run();
    expect(r.out).toMatch(/stage-prep exit [1-9]/);
    expect(r.err).toContain("step env failed");
    expect(existsSync(join(repo, ".stage-prep.env"))).toBe(false);
  });

  test("(e) a held lock: exit 3 and the other lock stays", () => {
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "other 99999 0\n");
    const r = run({ CUBILOT_LOCK_WAIT_S: "1" });
    expect(r.out).toContain("stage-prep exit 3");
    expect(r.err).toContain("other 99999 0");
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("other 99999 0\n");
  });

  test("(f) a second waiter that gets the lock after the first built: no rebuild", async () => {
    const e = { ...env({ SLEEP_BUILD: "2" }), R: repo };
    const a = Bun.spawn(["/bin/bash", "-c", TESTER_CMD], { env: e, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    const b = Bun.spawn(["/bin/bash", "-c", TESTER_CMD], { env: e, stdout: "pipe", stderr: "pipe" });
    const outs = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    expect(outs[0]).toContain("stage-prep exit 0");
    expect(outs[1]).toContain("stage-prep exit 0");
    const s = steps();
    expect(s.filter((x) => x === "build-sidecars").length).toBe(1);
    expect(s.filter((x) => x === "build-tmux").length).toBe(1);
  });

  test("(g) bun candidates: found outside PATH, or exit 4", () => {
    const cand = join(base, "cand");
    write(join(cand, "bun"), readFileSync(join(stubBin, "bun"), "utf8"));
    const noBun = { PATH: "/usr/bin:/bin" };
    const r = run({ ...noBun, STAGE_PREP_BUN_CANDIDATES: cand });
    expect(r.out).toContain("stage-prep exit 0");
    expect(steps()).toContain("build-sidecars");
    expect(sourced("command -v bun", noBun)).toBe(join(cand, "bun"));

    setup();
    const empty1 = join(base, "empty1");
    const empty2 = join(base, "empty2");
    mkdirSync(empty1, { recursive: true });
    mkdirSync(empty2, { recursive: true });
    const r2 = run({ ...noBun, STAGE_PREP_BUN_CANDIDATES: `${empty1}:${empty2}` });
    expect(r2.out).toContain("stage-prep exit 4");
    expect(r2.err).toContain("bun not found");
  });

  test("(j) a cargo env that prepends another bun does not displace the selected bun", () => {
    const decoy = join(base, "decoy");
    write(join(decoy, "bun"), '#!/bin/bash\necho decoy-bun >> "$LOG"\nexit 1\n');
    const cargoEnv = join(base, "home", ".cargo", "env");
    write(cargoEnv, `export PATH="${decoy}:$PATH"\n`, 0o644);
    try {
      const cand = join(base, "cand2");
      write(join(cand, "bun"), readFileSync(join(stubBin, "bun"), "utf8"));
      const r = run({ PATH: "/usr/bin:/bin", STAGE_PREP_BUN_CANDIDATES: cand });
      expect(r.out).toContain("stage-prep exit 0");
      const log2 = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(log2).not.toContain("decoy-bun");
      expect(steps()).toContain("build-sidecars");
    } finally {
      rmSync(join(base, "home", ".cargo"), { recursive: true, force: true });
    }
  });

  test("(h) a step that writes its output and then fails runs again", () => {
    expect(run({ FAIL_STEP: "sidecars" }).out).toMatch(/stage-prep exit [1-9]/);
    steps();
    expect(run().out).toContain("stage-prep exit 0");
    expect(steps()).toContain("build-sidecars");
  });

  test("(i) one deleted output: only its step runs", () => {
    run();
    steps();
    const cases: Array<[string, string]> = [
      ["node_modules", "bun install --frozen-lockfile"],
      ["src-tauri/binaries", "build-sidecars"],
      ["src-tauri/resources/tmux", "build-tmux"],
    ];
    for (const [path, step] of cases) {
      rmSync(join(repo, path), { recursive: true, force: true });
      expect(run().out).toContain("stage-prep exit 0");
      expect(steps()).toEqual([step]);
    }
  });
});
