// scripts/test.sh and the step limit of tests/helpers/bounded.ts (t_599ea1dca6be60e0). The endless tests are written to
// a temp folder outside tests/ and run as child processes, so the normal run never contains one. Every nested
// scripts/test.sh run gets its own lock path: a nested run never touches /tmp/cubilot-heavy.lock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/test.sh");
const BOUNDED = join(ROOT, "tests/helpers/bounded.ts");
const REAL_LOCK = "/tmp/cubilot-heavy.lock";

let dir: string;
let stubCargo: string;
const sentinels: Array<ReturnType<typeof Bun.spawn>> = [];
let realLockBefore: string | null;

const lockState = () => (existsSync(REAL_LOCK) ? readFileSync(join(REAL_LOCK, "owner"), "utf8") : null);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 3000) {
  for (let t = 0; t < ms && alive(pid); t += 50) await Bun.sleep(50);
  return !alive(pid);
}

// True when no process has `needle` in its command line (waits up to ms for the last one to end).
async function noProcessWith(needle: string, ms = 3000) {
  const found = () => Bun.spawnSync(["pgrep", "-f", "--", needle]).exitCode === 0;
  for (let t = 0; t < ms && found(); t += 50) await Bun.sleep(50);
  return !found();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cubilot-test-script-"));
  realLockBefore = lockState();
  const f = (name: string, body: string) => writeFileSync(join(dir, name), `import { test } from "bun:test";\nimport { appendFileSync, writeFileSync } from "node:fs";\n${body}\n`);
  f("ok.test.ts", `test("ok", () => {});`);
  f("mark.test.ts", `test("mark", () => { appendFileSync(process.env.CARGO_LOG!, "bun\\n"); });`);
  // A stub cargo first on PATH: no nested run compiles Rust. It logs its call and exits with STUB_CARGO_EXIT.
  stubCargo = join(dir, "stub-cargo");
  mkdirSync(stubCargo);
  writeFileSync(join(stubCargo, "cargo"), `#!/bin/sh\necho "cargo $*" >> "\${CARGO_LOG:-/dev/null}"\n[ "\${STUB_CARGO_EXIT:-0}" = 0 ] || echo "error: stub cargo failed" >&2\nexit \${STUB_CARGO_EXIT:-0}\n`, { mode: 0o755 });
  f("endless-clock.test.ts", `import { stepLimit } from ${JSON.stringify(BOUNDED)};
test("a fake clock that never ends", () => { const tick = stepLimit("endless clock"); const log: number[] = []; for (;;) { tick(); log.push(1); } });`);
  // A synchronous loop: bun's own per-test time-out cannot interrupt it. The sleep is an owned descendant.
  f("hang.test.ts", `test("hang", () => { const p = Bun.spawn(["sleep", "300"]); writeFileSync(process.env.PIDFILE!, String(p.pid)); for (;;) {} });`);
  // The same loop, but the process ignores TERM: the wrapper must go on to KILL. The descendant is a shell that writes
  // TERMFILE when the group gets TERM: the test reads the moment of TERM from it. It runs until the KILL.
  f("ignore-term.test.ts", `test("ignore term", () => { process.on("SIGTERM", () => {}); const p = Bun.spawn(["sh", "-c", "trap 'echo > $TERMFILE' TERM; while :; do sleep 0.05; done"]); writeFileSync(process.env.PIDFILE!, String(p.pid)); for (;;) {} });`);
  f("memory.test.ts", `test("memory", async () => {
  const p = Bun.spawn(["sleep", "300"]); writeFileSync(process.env.PIDFILE!, String(p.pid));
  // Random data does not compress, and every page is written again at each step: under host memory pressure the macOS
  // compressor cannot take these pages out of the RSS of the group.
  const keep: Buffer[] = [];
  const touch = () => { for (const b of keep) for (let o = 0; o < b.length; o += 4096) b[o] ^= 1; };
  for (let i = 0; i < 8; i++) {   // about 400 MB in steps
    const b = Buffer.allocUnsafe(50 * 1024 * 1024);
    for (let o = 0; o < b.length; o += 65536) crypto.getRandomValues(b.subarray(o, o + 65536));
    keep.push(b); touch(); await Bun.sleep(300);
  }
  for (let i = 0; i < 600; i++) { touch(); await Bun.sleep(100); }
}, 120000);`);
});

afterAll(() => {
  for (const s of sentinels) s.kill();
  rmSync(dir, { recursive: true, force: true });
});

// A PATH folder whose `ps` fails (status 1) or prints nothing (status 0): a broken process query.
function psShim(name: string, body: string) {
  const shim = join(dir, name);
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "ps"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return shim;
}

let n = 0;
async function run(args: string[], env: Record<string, string> = {}, lock = join(dir, `lock-${n++}`), cwd = dir) {
  const started = Date.now();
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd,
    env: { ...process.env, PATH: `${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err, ms: Date.now() - started, lock };
}

describe("step limit", () => {
  test("a fake clock that never ends fails by the step limit, with a clear message", async () => {
    const proc = Bun.spawn([process.execPath, "test", join(dir, "endless-clock.test.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(out + err).toContain('fake "endless clock" ran more than 10000 steps');
  }, 30000);
});

describe("scripts/test.sh", () => {
  test("a passing run forwards its arguments, exits 0 and removes its own lock", async () => {
    const r = await run([join(dir, "ok.test.ts")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 pass");
    expect(existsSync(r.lock)).toBe(false);
  }, 30000);

  test("it prints the effective memory limit at start: 2048 MB by default, the override when set", async () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.CUBILOT_TEST_MAX_RSS_MB;
    const base = await Bun.spawn(["bash", SCRIPT, join(dir, "ok.test.ts")], {
      cwd: dir,
      env: { ...env, PATH: `${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: join(dir, `lock-${n++}`) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e, c] = await Promise.all([new Response(base.stdout).text(), new Response(base.stderr).text(), base.exited]);
    expect(c).toBe(0);
    expect(o + e).toContain("memory limit 2048 MB");
    const r = await run([join(dir, "ok.test.ts")], { CUBILOT_TEST_MAX_RSS_MB: "1024" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("memory limit 1024 MB");
    expect(r.out).not.toContain("memory limit 2048 MB");
  }, 30000);

  test("it builds the Rust tests once, before the bun run, and prints the build time", async () => {
    const log = join(dir, "order.log");
    const r = await run([join(dir, "mark.test.ts")], { CARGO_LOG: log });
    expect(r.code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^cargo test --manifest-path .+src-tauri\/Cargo\.toml --lib --no-run$/);
    expect(lines[1]).toBe("bun");
    expect(r.out).toMatch(/rust pre-build: \d+ s/);
  }, 30000);

  test("a failing pre-build stops the run with a non-zero exit, the cargo error and no bun run", async () => {
    const log = join(dir, "fail.log");
    const r = await run([join(dir, "mark.test.ts")], { CARGO_LOG: log, STUB_CARGO_EXIT: "7" });
    expect(r.code).toBe(7);
    expect(r.out).toContain("error: stub cargo failed");
    expect(readFileSync(log, "utf8")).not.toContain("bun");
    expect(existsSync(r.lock)).toBe(false);
  }, 30000);

  test("a TERM during the pre-build stops cargo and its child, and no bun run starts", async () => {
    const slow = join(dir, "slow-cargo");
    mkdirSync(slow, { recursive: true });
    writeFileSync(join(slow, "cargo"), `#!/bin/sh\nsleep 300 &\necho $! > "$CHILD_PIDFILE"\nwait\n`, { mode: 0o755 });
    const pidfile = join(dir, "build-child.pid");
    const log = join(dir, "term-build.log");
    const lock = join(dir, "lock-term-build");
    const proc = Bun.spawn(["bash", SCRIPT, join(dir, "mark.test.ts")], {
      cwd: dir,
      env: { ...process.env, PATH: `${slow}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, CHILD_PIDFILE: pidfile, CARGO_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let t = 0; t < 10000 && !existsSync(pidfile); t += 50) await Bun.sleep(50);
    expect(existsSync(pidfile)).toBe(true);
    await Bun.sleep(200);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(await gone(Number(readFileSync(pidfile, "utf8").trim()))).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  }, 30000);

  test("CUBILOT_TEST_PEAK=1 prints the peak RSS on success", async () => {
    const r = await run([join(dir, "ok.test.ts")], { CUBILOT_TEST_PEAK: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/peak RSS \d+ MB/);
  }, 30000);

  test("default time limit is 520 s", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/^TIMEOUT_S=\$\{CUBILOT_TEST_TIMEOUT_S:-520\}$/m);
    expect(script).toContain("(default 520)");
    expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).toContain("`CUBILOT_TEST_TIMEOUT_S` (default 520 s)");
  });

  test("a bad setting exits 2 with a message and takes no lock", async () => {
    for (const env of [{ CUBILOT_TEST_TIMEOUT_S: "abc" }, { CUBILOT_TEST_MAX_RSS_MB: "0" }, { CUBILOT_TEST_TIMEOUT_S: "-5" }]) {
      const r = await run([join(dir, "ok.test.ts")], env);
      expect(r.code).toBe(2);
      expect(r.out).toContain("positive integer");
      expect(existsSync(r.lock)).toBe(false);
    }
  }, 30000);

  test("the time limit stops a hung run within 12 s, kills its descendant and leaves an unrelated process alone", async () => {
    const sentinel = Bun.spawn(["sleep", "300"]);
    sentinels.push(sentinel);
    const pidfile = join(dir, "hang.pid");
    const r = await run([join(dir, "hang.test.ts")], { CUBILOT_TEST_TIMEOUT_S: "5", PIDFILE: pidfile });
    expect(r.code).toBe(124);
    expect(r.ms).toBeLessThan(12000);
    expect(r.out).toContain("time limit of 5s");
    const child = Number(readFileSync(pidfile, "utf8"));
    expect(await gone(child)).toBe(true);
    expect(alive(sentinel.pid)).toBe(true);
    expect(existsSync(r.lock)).toBe(false);
  }, 30000);

  test("the memory limit stops a run that allocates about 400 MB when the limit is 200 MB", async () => {
    const sentinel = Bun.spawn(["sleep", "300"]);
    sentinels.push(sentinel);
    const pidfile = join(dir, "memory.pid");
    const r = await run([join(dir, "memory.test.ts")], { CUBILOT_TEST_MAX_RSS_MB: "200", PIDFILE: pidfile });
    expect(r.code).toBe(125);
    expect(r.out).toContain("memory limit");
    expect(r.ms).toBeLessThan(20000);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    expect(alive(sentinel.pid)).toBe(true);
    expect(existsSync(r.lock)).toBe(false);
  }, 40000);

  test("a TERM to the script stops the run and its descendant", async () => {
    const pidfile = join(dir, "term.pid");
    const lock = join(dir, "lock-term");
    const proc = Bun.spawn(["bash", SCRIPT, join(dir, "hang.test.ts")], {
      cwd: dir,
      env: { ...process.env, PATH: `${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, PIDFILE: pidfile },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let t = 0; t < 10000 && !existsSync(pidfile); t += 50) await Bun.sleep(50);
    expect(existsSync(pidfile)).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  }, 30000);


  // The process query is broken while bun test runs: the wrapper must fail explicitly, stop only what it started,
  // end by itself (the long time limit is not what ends it) and release its lock.
  for (const [label, body] of [["a ps that fails", "exit 1"], ["a ps that prints nothing", "exit 0"]] as const) {
    test(`${label}: the wrapper stops its run, exits 1 with a message and leaves an unrelated process alone`, async () => {
      const sentinel = Bun.spawn(["sleep", "300"]);
      sentinels.push(sentinel);
      const pidfile = join(dir, `ps-${label.replace(/\W+/g, "-")}.pid`);
      const shim = psShim(`ps-${label.replace(/\W+/g, "-")}`, body);
      const r = await run([join(dir, "hang.test.ts")], { CUBILOT_TEST_TIMEOUT_S: "120", PIDFILE: pidfile, PATH: `${shim}:${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}` });
      expect(r.code).toBe(1);
      expect(r.ms).toBeLessThan(12000);
      expect(r.out).toContain("process query (ps)");
      // The wrapper can stop the run at its first ps check, before bun starts the test file and writes the pid file.
      if (existsSync(pidfile)) expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
      else expect(await noProcessWith(join(dir, "hang.test.ts"))).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      expect(existsSync(r.lock)).toBe(false);
    }, 30000);
  }

  test("a test process that ignores TERM is killed after the 5 s wait, and its descendant is gone", async () => {
    const pidfile = join(dir, "ignore-term.pid");
    const termfile = join(dir, "ignore-term.term");
    // The wait starts at the TERM, not at the start of the run: scripts/test.sh counts the time limit in whole seconds
    // (date +%s), so TERM comes between 1 and 2 s after the start for a 2 s limit. The test times the wait from the
    // moment the descendant sees the TERM, and the run from there to its end. The poll is 20 ms, the trap is up to 50 ms.
    const running = run([join(dir, "ignore-term.test.ts")], { CUBILOT_TEST_TIMEOUT_S: "2", PIDFILE: pidfile, TERMFILE: termfile });
    let termAt = 0;
    let ended = false;
    const end = running.then((r) => ((ended = true), { r, endAt: Date.now() }));
    while (!ended && !termAt) {
      if (existsSync(termfile)) termAt = Date.now();
      else await Bun.sleep(20);
    }
    const { r, endAt } = await end;
    console.log(`TIMES total=${r.ms} term_to_end=${endAt - termAt}`);
    expect(termAt).toBeGreaterThan(0);
    expect(r.code).toBe(124);
    // The kill follows the TERM by the 5 s wait (50 polls of 0.1 s) less the 70 ms of the observation.
    expect(endAt - termAt).toBeGreaterThanOrEqual(4900);
    expect(endAt - termAt).toBeLessThan(13000);
    expect(r.ms).toBeLessThan(15000);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    expect(existsSync(r.lock)).toBe(false);
  }, 30000);

  test("a lock held by another owner is waited for, then the run exits 3 and leaves that lock as it was", async () => {
    const lock = join(dir, "lock-held");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "other 1 1\n");
    const r = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CUBILOT_LOCK_WAIT_S: "2" }, lock);
    expect(r.code).toBe(3);
    expect(r.ms).toBeGreaterThanOrEqual(2000);
    expect(r.out).toContain("other 1 1");
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("other 1 1\n");
  }, 30000);

  // Owner liveness (t_3493000837a2eb27). A dead pid is that of a child that has exited.
  async function deadPid() {
    const p = Bun.spawn(["true"]);
    await p.exited;
    return p.pid;
  }
  const seedLock = (name: string, owner: string) => {
    const lock = join(dir, `lock-${name}-${n++}`);
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), owner);
    return lock;
  };
  const takeovers = (out: string) => out.split("\n").filter((l) => l.startsWith("stale heavy lock from "));

  test("a lock whose owner pid is dead is taken over within 5 s, with one takeover line", async () => {
    const pid = await deadPid();
    const lock = seedLock("dead", `other ${pid} 1\n`);
    const r = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1" }, lock);
    expect(r.code).toBe(0);
    expect(takeovers(r.out)).toEqual([`stale heavy lock from other ${pid} taken over`]);
    expect(existsSync(lock)).toBe(false);
  }, 30000);

  test("a lock whose owner pid is alive is waited for, then the run exits 3 and the lock is unchanged", async () => {
    const live = Bun.spawn(["sleep", "300"]);
    try {
      const lock = seedLock("live", `other ${live.pid} 1\n`);
      const r = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CUBILOT_LOCK_WAIT_S: "2" }, lock);
      expect(r.code).toBe(3);
      expect(takeovers(r.out)).toHaveLength(0);
      expect(readFileSync(join(lock, "owner"), "utf8")).toBe(`other ${live.pid} 1\n`);
    } finally {
      live.kill();
    }
  }, 30000);

  test("an owner file that is missing or has no pid is waited for, never taken over", async () => {
    for (const owner of [null, "garbage\n", "other abc 1\n", "other 0 1\n"]) {
      const lock = seedLock("odd", owner ?? "");
      if (owner === null) rmSync(join(lock, "owner"));
      const r = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CUBILOT_LOCK_WAIT_S: "1" }, lock);
      expect(r.code).toBe(3);
      expect(takeovers(r.out)).toHaveLength(0);
      expect(existsSync(lock)).toBe(true);
    }
  }, 30000);

  test("a HUP to a run that holds the lock stops it with exit 129 and removes the lock", async () => {
    const pidfile = join(dir, "hup.pid");
    const lock = join(dir, "lock-hup");
    const proc = Bun.spawn(["bash", SCRIPT, join(dir, "hang.test.ts")], {
      cwd: dir,
      env: { ...process.env, PATH: `${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, PIDFILE: pidfile },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let t = 0; t < 10000 && !existsSync(pidfile); t += 50) await Bun.sleep(50);
    expect(existsSync(lock)).toBe(true);
    proc.kill("SIGHUP");
    expect(await proc.exited).toBe(129);
    expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  }, 30000);

  test("an owner name with inner spaces: a live owner is kept, a dead owner is taken over, the own lock is released", async () => {
    const live = Bun.spawn(["sleep", "300"]);
    try {
      const liveLock = seedLock("sp-live", `worker one ${live.pid} 1\n`);
      const a = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CUBILOT_LOCK_WAIT_S: "1" }, liveLock);
      expect(a.code).toBe(3);
      expect(takeovers(a.out)).toHaveLength(0);
      expect(readFileSync(join(liveLock, "owner"), "utf8")).toBe(`worker one ${live.pid} 1\n`);
    } finally {
      live.kill();
    }
    const pid = await deadPid();
    const deadLock = seedLock("sp-dead", `worker one ${pid} 1\n`);
    const b = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CHATBRIDGE_AGENT: "worker one" }, deadLock);
    expect(b.code).toBe(0);
    expect(takeovers(b.out)).toEqual([`stale heavy lock from worker one ${pid} taken over`]);
    expect(existsSync(deadLock)).toBe(false); // released by the run whose owner name has a space
  }, 30000);

  test("two runs on the same stale lock: one takes it over, the other waits for it, both pass", async () => {
    const pid = await deadPid();
    const lock = seedLock("race", `other ${pid} 1\n`);
    const [a, b] = await Promise.all([1, 2].map(() => run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1", CUBILOT_LOCK_WAIT_S: "60" }, lock)));
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(takeovers(a.out).length + takeovers(b.out).length).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`) && statSync(`${lock}.takeover`).isDirectory()).toBe(false);
  }, 60000);

  test("a dead owner and a stale $LOCK.takeover directory: the run takes the lock, one takeover line, no directory stays", async () => {
    const pid = await deadPid();
    const lock = seedLock("stale-mutex", `other ${pid} 1\n`);
    mkdirSync(`${lock}.takeover`);
    const t0 = Date.now();
    const r = await run([join(dir, "ok.test.ts")], { CUBILOT_LOCK_RETRY_S: "1" }, lock);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30000);
    expect(takeovers(r.out)).toEqual([`stale heavy lock from other ${pid} taken over`]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`) && statSync(`${lock}.takeover`).isDirectory()).toBe(false);
  }, 60000);

  test("a nested run never touches /tmp/cubilot-heavy.lock", () => {
    expect(lockState()).toBe(realLockBefore);
  });
});

// A split run (t_b6e1f135d7a727a1): the files of a fake root, split into parts that run at the same time.
describe("scripts/test.sh split run", () => {
  const { fileSeconds, splitFiles } = require("../../scripts/split-tests") as typeof import("../../scripts/split-tests");
  const files = (names: string[]) => names.map((f) => `tests/${f}.test.ts`);

  test("the split balances the parts by the seconds of the report", () => {
    const xml = [["a", 10], ["b", 9], ["c", 1], ["d", 1]]
      .map(([f, t]) => `<testcase name="x" time="${Number(t) / 2}" file="tests/${f}.test.ts" /><testcase name="y" time="${Number(t) / 2}" file="tests/${f}.test.ts" />`)
      .join("\n");
    const secs = fileSeconds(xml);
    expect(secs.get("tests/a.test.ts")).toBe(10);
    const parts = splitFiles(files(["a", "b", "c", "d"]), secs, 2);
    const sum = (p: string[]) => p.reduce((s, f) => s + (secs.get(f) ?? 0), 0);
    expect(parts.map(sum).sort()).toEqual([10, 11]);
    expect(parts.flat().sort()).toEqual(files(["a", "b", "c", "d"]));
  });

  test("a file that is not in the report goes to the part with the lowest sum", () => {
    const secs = new Map([["tests/a.test.ts", 10], ["tests/b.test.ts", 2]]);
    const parts = splitFiles(files(["a", "b", "new"]), secs, 2);
    expect(parts.find((p) => p.includes("tests/new.test.ts"))).toEqual(["tests/b.test.ts", "tests/new.test.ts"]);
    expect(parts.find((p) => p.includes("tests/a.test.ts"))).toEqual(["tests/a.test.ts"]);
  });

  let root: string;
  const mkRoot = (name: string, tests: Record<string, string>) => {
    root = join(dir, `root-${name}-${n++}`);
    mkdirSync(join(root, "tests"), { recursive: true });
    for (const [f, body] of Object.entries(tests)) writeFileSync(join(root, "tests", `${f}.test.ts`), `import { test } from "bun:test";\nimport { appendFileSync, writeFileSync } from "node:fs";\n${body}\n`);
    return root;
  };
  const split = (env: Record<string, string> = {}) => run([], { CUBILOT_TEST_ROOT: root, CUBILOT_TEST_REPORT: join(root, "none.xml"), CUBILOT_TEST_PARTS: "3", ...env });
  const envFile = (root: string) => join(root, "env.log");
  const probe = `test("probe", () => { appendFileSync(process.env.ENVLOG!, [process.env.CUBILOT_TEST_RUN_ID, process.env.TMPDIR, process.env.CUBILOT_TEST_TMUX_DIR].join("|") + "\\n"); });`;

  test("the summary adds the parts, each part has its own run id, TMPDIR and tmux folder, the exit code is 0", async () => {
    mkRoot("sum", { a: probe, b: probe, c: probe, d: `test("d", () => {});` });
    const r = await split({ ENVLOG: envFile(root), CUBILOT_TEST_PEAK: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(" 4 pass\n");
    expect(r.out).toContain(" 0 fail\n");
    expect(r.out).toContain("Ran 4 tests across 4 files in 3 parts.");
    expect(r.out).toMatch(/peak RSS \d+ MB/);
    const rows = readFileSync(envFile(root), "utf8").trim().split("\n").map((l) => l.split("|"));
    expect(rows).toHaveLength(3);
    for (const col of [0, 1, 2]) expect(new Set(rows.map((x) => x[col])).size).toBe(3);
    for (const [, tmp, sock] of rows) {
      expect(existsSync(tmp)).toBe(false);
      expect(existsSync(sock)).toBe(false);
    }
  }, 60000);

  test("a failed part gives a non-zero exit, the sum of the fails and the test files of that part", async () => {
    mkRoot("fail", { a: `test("a", () => {});`, b: `test("b", () => { throw new Error("boom"); });`, c: `test("c", () => {});` });
    const r = await split({ CUBILOT_TEST_PARTS: "2" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(" 1 fail\n");
    expect(r.out).toContain(" 2 pass\n");
    expect(r.out).toMatch(/part \d failed with exit \d+; test files of part \d:\n(  .*\n)*  \.\/tests\/b\.test\.ts/);
    expect(r.out).toContain("(fail) b");
    const logs = r.out.match(/logs of the parts: (\S+)/)?.[1];
    expect(logs).toBeTruthy();
    rmSync(logs!, { recursive: true, force: true });
  }, 60000);

  test("the memory limit defaults to 2048 MB times the parts, and an environment value replaces it", async () => {
    mkRoot("mem", { a: `test("a", () => {});`, b: `test("b", () => {});` });
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.CUBILOT_TEST_MAX_RSS_MB;
    const one = await split({ CUBILOT_TEST_MAX_RSS_MB: "" }).catch(() => null);
    expect(one?.code).toBe(2);
    const r3 = await run([], { CUBILOT_TEST_ROOT: root, CUBILOT_TEST_REPORT: join(root, "none.xml"), CUBILOT_TEST_PARTS: "3", CUBILOT_TEST_MAX_RSS_MB: "1500" });
    expect(r3.out).toContain("memory limit 1500 MB");
    const p = Bun.spawn(["bash", SCRIPT], {
      cwd: dir,
      env: { ...env, PATH: `${stubCargo}:${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: join(dir, `lock-${n++}`), CUBILOT_TEST_ROOT: root, CUBILOT_TEST_REPORT: join(root, "none.xml"), CUBILOT_TEST_PARTS: "3" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    expect(out).toContain("memory limit 6144 MB");
  }, 60000);

  test("one limit on the summed RSS of all parts stops the run with exit 125", async () => {
    const hold = `test("hold", async () => {
  const b = Buffer.allocUnsafe(120 * 1024 * 1024);
  for (let o = 0; o < b.length; o += 4096) b[o] = 1;
  for (let i = 0; i < 400; i++) { for (let o = 0; o < b.length; o += 4096) b[o] ^= 1; await Bun.sleep(50); }
}, 60000);`;
    mkRoot("sumrss", { a: hold, b: hold });
    const alone = await split({ CUBILOT_TEST_PARTS: "1", CUBILOT_TEST_MAX_RSS_MB: "300", CUBILOT_TEST_TIMEOUT_S: "8" });
    expect(alone.code).toBe(124); // one part under the limit: only the time limit ends it
    const r = await split({ CUBILOT_TEST_PARTS: "2", CUBILOT_TEST_MAX_RSS_MB: "300" });
    expect(r.code).toBe(125);
    expect(r.out).toContain("memory limit reached");
    expect(r.out).toMatch(/stopping process groups \d+ \d+/);
  }, 90000);

  test("the time limit covers the whole run and stops all parts", async () => {
    const hang = `test("hang", () => { const p = Bun.spawn(["sleep", "301"]); for (;;) {} });`;
    mkRoot("time", { a: hang, b: hang });
    const r = await split({ CUBILOT_TEST_PARTS: "2", CUBILOT_TEST_TIMEOUT_S: "3" });
    expect(r.code).toBe(124);
    expect(r.out).toContain("time limit of 3s reached");
    expect(await noProcessWith("sleep 301")).toBe(true);
  }, 60000);

  test("a run with arguments is one part, whatever CUBILOT_TEST_PARTS says", async () => {
    mkRoot("args", { a: `test("a", () => {});` });
    const r = await run([join(root, "tests/a.test.ts")], { CUBILOT_TEST_PARTS: "3" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("memory limit 2048 MB");
    expect(r.out).not.toContain("in 3 parts");
    expect(r.out).toContain(" 1 pass\n");
  }, 60000);

  test("CUBILOT_TEST_PARTS=1 with no argument is one bun test process in the folder of the caller", async () => {
    mkRoot("one", { a: `test("a", () => {});`, b: `test("b", () => {});` });
    const r = await run([], { CUBILOT_TEST_PARTS: "1" }, undefined, root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("memory limit 2048 MB");
    expect(r.out).toContain(" 2 pass\n");
    expect(r.out).not.toContain("in 1 parts");
  }, 60000);

  test("a bad CUBILOT_TEST_PARTS exits 2", async () => {
    const r = await run([], { CUBILOT_TEST_PARTS: "0" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("PARTS");
  }, 30000);
});
