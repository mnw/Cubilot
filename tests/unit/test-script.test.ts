// scripts/test.sh and the step limit of tests/helpers/bounded.ts (t_599ea1dca6be60e0). The endless tests are written to
// a temp folder outside tests/ and run as child processes, so the normal run never contains one. Every nested
// scripts/test.sh run gets its own lock path: a nested run never touches /tmp/cubilot-heavy.lock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/test.sh");
const BOUNDED = join(ROOT, "tests/helpers/bounded.ts");
const REAL_LOCK = "/tmp/cubilot-heavy.lock";

let dir: string;
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cubilot-test-script-"));
  realLockBefore = lockState();
  const f = (name: string, body: string) => writeFileSync(join(dir, name), `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\n${body}\n`);
  f("ok.test.ts", `test("ok", () => {});`);
  f("endless-clock.test.ts", `import { stepLimit } from ${JSON.stringify(BOUNDED)};
test("a fake clock that never ends", () => { const tick = stepLimit("endless clock"); const log: number[] = []; for (;;) { tick(); log.push(1); } });`);
  // A synchronous loop: bun's own per-test time-out cannot interrupt it. The sleep is an owned descendant.
  f("hang.test.ts", `test("hang", () => { const p = Bun.spawn(["sleep", "300"]); writeFileSync(process.env.PIDFILE!, String(p.pid)); for (;;) {} });`);
  // The same loop, but the process ignores TERM: the wrapper must go on to KILL.
  f("ignore-term.test.ts", `test("ignore term", () => { process.on("SIGTERM", () => {}); const p = Bun.spawn(["sleep", "300"]); writeFileSync(process.env.PIDFILE!, String(p.pid)); for (;;) {} });`);
  f("memory.test.ts", `test("memory", async () => {
  const p = Bun.spawn(["sleep", "300"]); writeFileSync(process.env.PIDFILE!, String(p.pid));
  const keep: Buffer[] = [];
  for (let i = 0; i < 8; i++) { keep.push(Buffer.alloc(50 * 1024 * 1024, 1)); await Bun.sleep(300); }   // about 400 MB in steps
  await Bun.sleep(60000);
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
async function run(args: string[], env: Record<string, string> = {}, lock = join(dir, `lock-${n++}`)) {
  const started = Date.now();
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, ...env },
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
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, CUBILOT_HEAVY_LOCK: lock, PIDFILE: pidfile },
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
      const r = await run([join(dir, "hang.test.ts")], { CUBILOT_TEST_TIMEOUT_S: "120", PIDFILE: pidfile, PATH: `${shim}:${dirname(process.execPath)}:${process.env.PATH}` });
      expect(r.code).toBe(1);
      expect(r.ms).toBeLessThan(12000);
      expect(r.out).toContain("process query (ps)");
      expect(await gone(Number(readFileSync(pidfile, "utf8")))).toBe(true);
      expect(alive(sentinel.pid)).toBe(true);
      expect(existsSync(r.lock)).toBe(false);
    }, 30000);
  }

  test("a test process that ignores TERM is killed after the 5 s wait, and its descendant is gone", async () => {
    const pidfile = join(dir, "ignore-term.pid");
    const r = await run([join(dir, "ignore-term.test.ts")], { CUBILOT_TEST_TIMEOUT_S: "2", PIDFILE: pidfile });
    expect(r.code).toBe(124);
    expect(r.ms).toBeGreaterThanOrEqual(6500);
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

  test("a nested run never touches /tmp/cubilot-heavy.lock", () => {
    expect(lockState()).toBe(realLockBefore);
  });
});
