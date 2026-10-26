// C6b, the hub half of the skill switches: relink publishes the prepared build at the reload boundary, under the
// publication lock; the selection that a reload applies is the one bound to its attempt. Real hub, real files.
// Design: factory/brief/04a-c6-design.md, sections 2a, 3 (point 3) and 5; tests: section 6, point 3.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { agentKey } from "../../hub/features/factory";
import { ffi, recoveryHook, releaseLock, takeLock } from "../../hub/features/factory-skills";
import { postJson } from "../helpers/fetch";

const V1 = "v-1111111111111111";
const V2 = "v-2222222222222222";
const INV = ["shared/s", "worker/a", "worker/b"];

describe("skills records and publication in /factory/relink and /factory/applied", () => {
  let hub: HubHandle;
  let dir: string;
  const saved = { dir: process.env.CUBILOT_FACTORY_DIR, version: process.env.CUBILOT_FACTORY_VERSION };
  const kids: ChildProcess[] = [];

  const p = (name: string, suffix: string) => join(dir, "agents", `${agentKey(name)}${suffix}`);
  const json = (name: string, suffix: string) => JSON.parse(readFileSync(p(name, suffix), "utf8"));
  const link = (name: string) => readlinkSync(p(name, ".view"));
  const relink = (name: string) => postJson(hub, "/factory/relink", { agent: name, force: true });
  const applied = (name: string, attempt: unknown, extra: object = {}) => postJson(hub, "/factory/applied", { agent: name, version: V2, attempt, ...extra });

  // An agent the app launched: link to V1, published and applied records, gen 1 view published.
  function launched(name: string, off: string[] = [], skills: string[] = INV) {
    const key = agentKey(name);
    symlinkSync(join(dir, V1), join(dir, "agents", key));
    mkdirSync(p(name, ".view-1"), { recursive: true });
    symlinkSync(`${key}.view-1`, p(name, ".view"));
    const rec = { version: V1, gen: 1, off, skills };
    writeFileSync(p(name, ".skills-published"), JSON.stringify(rec));
    writeFileSync(p(name, ".skills-applied"), JSON.stringify(rec));
  }
  // What the app does on a click: a build folder and `.skills-prepared`. Publishes nothing.
  function prepare(name: string, gen: number, off: string[], skills: string[] = INV) {
    mkdirSync(p(name, `.view-${gen}`), { recursive: true });
    writeFileSync(p(name, ".skills-prepared"), JSON.stringify({ gen, off, skills, kind: "view" }));
  }
  function owner(holder = "hub"): { child: ChildProcess; line: string } {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    kids.push(child);
    const start = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim();
    return { child, line: `${holder} ${child.pid} ${start}` };
  }
  const setLock = (name: string, line: string | null) => {
    mkdirSync(p(name, ".skills-lock"), { recursive: true });
    if (line !== null) writeFileSync(join(p(name, ".skills-lock"), "owner"), `${line}\n`);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "skills-factory-"));
    mkdirSync(join(dir, V1)); mkdirSync(join(dir, V2)); mkdirSync(join(dir, "agents"));
    process.env.CUBILOT_FACTORY_DIR = dir;
    process.env.CUBILOT_FACTORY_VERSION = V2;
    hub = await spawnHub();
  });
  afterAll(async () => {
    for (const k of kids) { try { k.kill(); } catch {} }
    await hub.kill();
    for (const [k, v] of [["CUBILOT_FACTORY_DIR", saved.dir], ["CUBILOT_FACTORY_VERSION", saved.version]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("a busy agent keeps its paths until relink; relink publishes and binds the selection to the attempt; a success applies it", async () => {
    launched("sk-busy");
    prepare("sk-busy", 2, ["worker/a"]);
    // the click only prepared: nothing published
    expect(link("sk-busy")).toBe(`${agentKey("sk-busy")}.view-1`);
    expect(json("sk-busy", ".skills-published").gen).toBe(1);
    expect(existsSync(p("sk-busy", ".skills-pending"))).toBe(false);
    // the bridge reaches its idle point and calls relink
    const r = await relink("sk-busy");
    expect(r.status).toBe(200);
    const attempt = (r.json as any).attempt;
    expect(link("sk-busy")).toBe(`${agentKey("sk-busy")}.view-2`);
    expect(json("sk-busy", ".skills-published")).toMatchObject({ gen: 2, off: ["worker/a"], skills: INV, version: V2 });
    expect(json("sk-busy", ".skills-pending")).toMatchObject({ attempt, gen: 2, off: ["worker/a"], skills: INV });
    expect(readFileSync(p("sk-busy", ".pending"), "utf8").split("\n")[2]).toBe(attempt);
    expect(json("sk-busy", ".skills-applied").gen).toBe(1); // not yet
    expect((await applied("sk-busy", attempt)).status).toBe(200);
    expect(json("sk-busy", ".skills-applied")).toEqual({ version: V2, gen: 2, off: ["worker/a"], skills: INV });
    expect(existsSync(p("sk-busy", ".skills-pending"))).toBe(false);
    expect(existsSync(p("sk-busy", ".pending"))).toBe(false);
    expect(lstatSync(p("sk-busy", ".skills-lock"), { throwIfNoEntry: false })).toBeUndefined(); // released
  });

  test("a checkbox change during a reload does not change what that reload applies; the next reload publishes it", async () => {
    launched("sk-click");
    prepare("sk-click", 2, ["worker/a"]);
    const a = await relink("sk-click");
    prepare("sk-click", 3, ["worker/a", "worker/b"]); // a click during the reload
    expect(json("sk-click", ".skills-pending").gen).toBe(2);
    expect(json("sk-click", ".skills-published").gen).toBe(2);
    expect(link("sk-click")).toBe(`${agentKey("sk-click")}.view-2`);
    expect((await applied("sk-click", (a.json as any).attempt)).status).toBe(200);
    expect(json("sk-click", ".skills-applied")).toMatchObject({ gen: 2, off: ["worker/a"] }); // A, not B
    expect(json("sk-click", ".skills-prepared").gen).toBe(3); // still waiting
    const b = await relink("sk-click");
    expect(link("sk-click")).toBe(`${agentKey("sk-click")}.view-3`);
    expect((await applied("sk-click", (b.json as any).attempt)).status).toBe(200);
    expect(json("sk-click", ".skills-applied")).toMatchObject({ gen: 3, off: ["worker/a", "worker/b"] });
  });

  test("a late or duplicate completion gets 409 and changes nothing", async () => {
    launched("sk-late");
    prepare("sk-late", 2, ["worker/b"]);
    const a = await relink("sk-late");
    const attempt = (a.json as any).attempt;
    const before = readFileSync(p("sk-late", ".skills-applied"), "utf8");
    expect((await applied("sk-late", "0000000000000000")).status).toBe(409);
    expect(readFileSync(p("sk-late", ".skills-applied"), "utf8")).toBe(before);
    expect(link("sk-late")).toBe(`${agentKey("sk-late")}.view-2`);
    expect((await applied("sk-late", attempt)).status).toBe(200);
    const after = readFileSync(p("sk-late", ".skills-applied"), "utf8");
    expect((await applied("sk-late", attempt)).status).toBe(409); // a duplicate
    expect(readFileSync(p("sk-late", ".skills-applied"), "utf8")).toBe(after);
  });

  test("a failed reload keeps applied and published; a retry with no checkbox change records the same selection; a failed re-enable stays not loaded", async () => {
    // applied says b is NOT loaded (off); the human has re-enabled b, so a build with b on is waiting
    launched("sk-fail", ["worker/b"]);
    prepare("sk-fail", 2, []);
    const a = await relink("sk-fail");
    expect((await postJson(hub, "/factory/applied", { agent: "sk-fail", failed: true, attempt: (a.json as any).attempt })).status).toBe(200);
    expect(json("sk-fail", ".skills-applied")).toMatchObject({ gen: 1, off: ["worker/b"] }); // b stays not_loaded
    expect(json("sk-fail", ".skills-published")).toMatchObject({ gen: 2, off: [] }); // the swapped build is on disk
    expect(existsSync(p("sk-fail", ".skills-pending"))).toBe(false);
    // the bridge retries: no new preparation, no checkbox change
    const b = await relink("sk-fail");
    expect((b.json as any).attempt).not.toBe((a.json as any).attempt);
    expect(json("sk-fail", ".skills-pending")).toMatchObject({ attempt: (b.json as any).attempt, gen: 2, off: [] });
    expect((await applied("sk-fail", (b.json as any).attempt)).status).toBe(200);
    expect(json("sk-fail", ".skills-applied")).toMatchObject({ gen: 2, off: [] }); // b loads now
  });

  test("a new skill is in the applied inventory only after a reload that publishes it", async () => {
    launched("sk-new");
    expect(json("sk-new", ".skills-applied").skills).not.toContain("worker/new");
    prepare("sk-new", 2, [], [...INV, "worker/new"]);
    const a = await relink("sk-new");
    expect(json("sk-new", ".skills-applied").skills).not.toContain("worker/new"); // not before the success
    await applied("sk-new", (a.json as any).attempt);
    expect(json("sk-new", ".skills-applied").skills).toContain("worker/new");
  });

  test("a plain agent: an inventory record is published without a view swap, so a skill that a version added becomes loaded after a success (Validator)", async () => {
    // a plain launch: records at gen 0, no view link, no build
    const key = agentKey("sk-plain");
    symlinkSync(join(dir, V1), join(dir, "agents", key));
    const rec0 = { version: V1, gen: 0, off: [], skills: INV };
    writeFileSync(p("sk-plain", ".skills-published"), JSON.stringify(rec0));
    writeFileSync(p("sk-plain", ".skills-applied"), JSON.stringify(rec0));
    // the version added worker/new; the click prepared the inventory only
    writeFileSync(p("sk-plain", ".skills-prepared"), JSON.stringify({ gen: 1, off: [], skills: [...INV, "worker/new"], kind: "inventory", version: V2 }));
    const a = await relink("sk-plain");
    expect(a.status).toBe(200);
    expect(existsSync(p("sk-plain", ".view"))).toBe(false); // nothing swapped
    expect(json("sk-plain", ".skills-published")).toMatchObject({ gen: 1, off: [], version: V2 });
    expect(json("sk-plain", ".skills-published").skills).toContain("worker/new");
    expect((await applied("sk-plain", (a.json as any).attempt)).status).toBe(200);
    expect(json("sk-plain", ".skills-applied").skills).toContain("worker/new");
    // a second Reload with no new preparation keeps the record (a retry swaps nothing)
    const b = await relink("sk-plain");
    expect(json("sk-plain", ".skills-pending")).toMatchObject({ attempt: (b.json as any).attempt, gen: 1 });
  });

  test("an agent without skills records gets no skills-pending, and a success writes no skills-applied", async () => {
    symlinkSync(join(dir, V1), join(dir, "agents", agentKey("sk-none")));
    const a = await relink("sk-none");
    expect(a.json).toMatchObject({ reload: true });
    expect(existsSync(p("sk-none", ".skills-pending"))).toBe(false);
    expect((await applied("sk-none", (a.json as any).attempt)).status).toBe(200);
    expect(existsSync(p("sk-none", ".skills-applied"))).toBe(false);
  });

  test("an unwritable .skills-applied: the success report answers 500, .applied is not written, the order stays, the same attempt works later", async () => {
    launched("sk-wa");
    prepare("sk-wa", 2, ["worker/a"]);
    const a = await relink("sk-wa");
    const attempt = (a.json as any).attempt;
    rmSync(p("sk-wa", ".skills-applied"));
    mkdirSync(p("sk-wa", ".skills-applied")); // a folder where the file belongs: the rename onto it fails
    const bad = await applied("sk-wa", attempt);
    expect(bad.status).toBe(500);
    expect(String((bad.json as any).error)).toContain("skills applied write failed");
    expect(existsSync(p("sk-wa", ".applied"))).toBe(false);
    expect(existsSync(p("sk-wa", ".pending"))).toBe(true);
    rmSync(p("sk-wa", ".skills-applied"), { recursive: true });
    expect((await applied("sk-wa", attempt)).status).toBe(200);
    expect(json("sk-wa", ".skills-applied")).toMatchObject({ gen: 2, off: ["worker/a"] });
  });

  test("an unwritable .skills-pending: relink answers 500, writes no .pending, undoes the swap; the prepared build publishes at the next relink", async () => {
    launched("sk-wp");
    prepare("sk-wp", 2, ["worker/a"]);
    const pub = readFileSync(p("sk-wp", ".skills-published"), "utf8");
    mkdirSync(p("sk-wp", ".skills-pending"));
    const bad = await relink("sk-wp");
    expect(bad.status).toBe(500);
    expect(existsSync(p("sk-wp", ".pending"))).toBe(false);
    expect(link("sk-wp")).toBe(`${agentKey("sk-wp")}.view-1`); // swapped back
    expect(readFileSync(p("sk-wp", ".skills-published"), "utf8")).toBe(pub); // the previous record
    expect(existsSync(p("sk-wp", ".skills-prepared"))).toBe(true); // kept
    rmSync(p("sk-wp", ".skills-pending"), { recursive: true });
    const ok = await relink("sk-wp");
    expect(ok.status).toBe(200);
    expect(link("sk-wp")).toBe(`${agentKey("sk-wp")}.view-2`);
  });

  test("a .pending write failure after the swap restores the previous view and record (the B form of the settings-restore case)", async () => {
    launched("sk-pp");
    prepare("sk-pp", 2, ["worker/b"]);
    const pub = readFileSync(p("sk-pp", ".skills-published"), "utf8");
    mkdirSync(p("sk-pp", ".pending")); // the fault: relink must write this path
    const bad = await relink("sk-pp");
    // a folder at .pending reads as "no running reload" (no version line), so relink goes on to the write and fails there
    expect(bad.status).toBe(500);
    expect(link("sk-pp")).toBe(`${agentKey("sk-pp")}.view-1`);
    expect(readFileSync(p("sk-pp", ".skills-published"), "utf8")).toBe(pub);
    expect(existsSync(p("sk-pp", ".skills-pending"))).toBe(false);
    expect(existsSync(p("sk-pp", ".skills-prepared"))).toBe(true);
    rmSync(p("sk-pp", ".pending"), { recursive: true });
    expect((await relink("sk-pp")).status).toBe(200);
    expect(link("sk-pp")).toBe(`${agentKey("sk-pp")}.view-2`);
  });

  test("a prepared build whose folder is gone is refused with 500 and nothing is swapped", async () => {
    launched("sk-gone");
    writeFileSync(p("sk-gone", ".skills-prepared"), JSON.stringify({ gen: 2, off: [], skills: INV, kind: "view" }));
    const bad = await relink("sk-gone");
    expect(bad.status).toBe(500);
    expect(link("sk-gone")).toBe(`${agentKey("sk-gone")}.view-1`);
    expect(existsSync(p("sk-gone", ".pending"))).toBe(false);
  });

  // ---- the lock ----
  test("a lock with a live owner, even an old one, is not taken: 503 after the wait, lock and owner line unchanged, no .pending", async () => {
    launched("sk-live");
    prepare("sk-live", 2, ["worker/a"]);
    const { line } = owner("app");
    setLock("sk-live", line);
    const old = new Date(Date.now() - 3600_000);
    utimesSync(p("sk-live", ".skills-lock"), old, old);
    const t0 = Date.now();
    const r = await relink("sk-live");
    expect(r.status).toBe(503);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(readFileSync(join(p("sk-live", ".skills-lock"), "owner"), "utf8").trim()).toBe(line);
    expect(existsSync(p("sk-live", ".pending"))).toBe(false);
    expect(link("sk-live")).toBe(`${agentKey("sk-live")}.view-1`);
  });

  test("a lock whose owner is dead, or a live pid with another start time, is removed and taken", async () => {
    launched("sk-dead");
    prepare("sk-dead", 2, ["worker/a"]);
    const { child, line } = owner("app");
    child.kill();
    await new Promise((r) => child.once("exit", r));
    setLock("sk-dead", line);
    expect((await relink("sk-dead")).status).toBe(200);
    expect(existsSync(p("sk-dead", ".skills-lock"))).toBe(false); // released after the call

    launched("sk-reused");
    prepare("sk-reused", 2, ["worker/a"]);
    const live = owner("hub");
    setLock("sk-reused", `hub ${live.child.pid} Mon Jan  1 00:00:00 2001`);
    expect((await relink("sk-reused")).status).toBe(200);
  });

  test("an unparsable owner line, or a missing owner file, is not removed", async () => {
    launched("sk-junk");
    prepare("sk-junk", 2, ["worker/a"]);
    setLock("sk-junk", "this is not an owner line");
    expect((await relink("sk-junk")).status).toBe(503);
    expect(readFileSync(join(p("sk-junk", ".skills-lock"), "owner"), "utf8").trim()).toBe("this is not an owner line");
    launched("sk-noown");
    prepare("sk-noown", 2, ["worker/a"]);
    setLock("sk-noown", null);
    expect((await relink("sk-noown")).status).toBe(503);
    expect(existsSync(p("sk-noown", ".skills-lock"))).toBe(true);
  });

  test("a live pid with a garbage start time is not a dead owner: 503, lock and owner line unchanged (Validator)", async () => {
    launched("sk-garbage");
    prepare("sk-garbage", 2, ["worker/a"]);
    const { child } = owner("hub");
    const line = `hub ${child.pid} garbage`;
    setLock("sk-garbage", line);
    expect((await relink("sk-garbage")).status).toBe(503);
    expect(readFileSync(join(p("sk-garbage", ".skills-lock"), "owner"), "utf8").trim()).toBe(line);
    expect(link("sk-garbage")).toBe(`${agentKey("sk-garbage")}.view-1`);
  });

  test("a dead owner whose lock cannot be removed ends at the deadline with 503, not in a loop (Validator)", async () => {
    launched("sk-stuck");
    prepare("sk-stuck", 2, ["worker/a"]);
    const { child, line } = owner("app");
    child.kill();
    await new Promise((r) => child.once("exit", r));
    setLock("sk-stuck", line);
    const lock = p("sk-stuck", ".skills-lock");
    chmodSync(lock, 0o500); // the owner file cannot be unlinked
    try {
      const t0 = Date.now();
      const r = await relink("sk-stuck");
      // Only root ignores folder permissions. Anyone else must get the 503; a 200 is a failure, not a skip.
      if (process.getuid?.() === 0) return;
      expect(r.status).toBe(503);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(existsSync(join(lock, "owner"))).toBe(true);
    } finally {
      chmodSync(lock, 0o755);
    }
  });

  // Validator (lock review 3): recovery must not delete a lock that another contender took after our read.
  test("a second contender cannot act while a recovery is between its check and its removal; its owner file stays intact (Validator)", async () => {
    mkdirSync(join(dir, "agents"), { recursive: true });
    const key = agentKey("sk-mid");
    const lock = join(dir, "agents", `${key}.skills-lock`);
    const dead = owner("hub");
    dead.child.kill();
    await new Promise((r) => dead.child.once("exit", r));
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${dead.line}\n`);
    const a = owner("app"), b = owner("app");
    let bDone = false;
    let bOwnerOk = false;
    let bPromise: Promise<void> | null = null;
    let fired = false;
    recoveryHook.fn = async (l) => {
      if (l !== lock || fired) return;
      fired = true;
      // A is under the guard, its check says "dead", nothing is removed yet. B tries now.
      bPromise = takeLock(dir, key, 5000, "app", b.line).then((rel) => {
        bOwnerOk = readFileSync(join(lock, "owner"), "utf8").trim() === b.line;
        bDone = true;
        rel();
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(bDone).toBe(false); // B has neither acquired nor failed while A is inside the recovery
    };
    try {
      const releaseA = await takeLock(dir, key, 5000, "app", a.line);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe(a.line); // A's owner file is intact
      expect(bDone).toBe(false);
      releaseA();
      await bPromise;
      expect(bDone).toBe(true);
      expect(bOwnerOk).toBe(true); // B's owner file was intact while B held the lock
      expect(fired).toBe(true);
    } finally {
      recoveryHook.fn = null;
    }
  });

  test("four processes recover one dead lock and keep taking it: never two holders, never a lost owner file (Validator)", async () => {
    mkdirSync(join(dir, "agents"), { recursive: true });
    const key = agentKey("sk-stress");
    const lock = join(dir, "agents", `${key}.skills-lock`);
    const dead = owner("hub");
    dead.child.kill();
    await new Promise((r) => dead.child.once("exit", r));
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${dead.line}\n`);
    const log = join(dir, "stress.log");
    writeFileSync(log, "");
    const helper = join(import.meta.dir, "../helpers/skills-lock-contender.ts");
    const procs = Array.from({ length: 4 }, () => {
      const o = owner("app");
      return new Promise<number>((res) => {
        const c = spawn(process.execPath, ["run", helper, dir, key, o.line, "4", log], { stdio: "inherit" });
        c.once("exit", (code) => res(code ?? 1));
      });
    });
    expect(await Promise.all(procs)).toEqual([0, 0, 0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("VIOLATION"))).toEqual([]);
    let holder: string | null = null;
    let acquires = 0;
    for (const l of lines) {
      const [ev, ...rest] = l.split(" ");
      const id = rest.join(" ");
      if (ev === "acquire") {
        expect(holder).toBeNull(); // nobody else holds it now
        holder = id;
        acquires++;
      } else if (ev === "release") {
        expect(holder).toBe(id);
        holder = null;
      }
    }
    expect(acquires).toBe(16);
  });

  // C6-FFI-1 (Validator): flock unavailable. The call is refused with the original error, the descriptor is closed, and
  // nothing is taken, removed or published.
  test("flock unavailable: takeLock is refused with the original error, no descriptor stays open, nothing is published (C6-FFI-1)", async () => {
    launched("sk-ffi");
    prepare("sk-ffi", 2, ["worker/a"]);
    const dead = owner("hub");
    dead.child.kill();
    await new Promise((r) => dead.child.once("exit", r));
    setLock("sk-ffi", dead.line); // a dead owner: recovery needs the guard
    const published = readFileSync(p("sk-ffi", ".skills-published"), "utf8");
    const key = agentKey("sk-ffi");
    const fds = () => readdirSync("/dev/fd").length;
    const before = fds();
    ffi.flock = () => { throw new Error("flock is unavailable"); };
    try {
      for (let i = 0; i < 5; i++) {
        await expect(takeLock(dir, key, 500, "app")).rejects.toThrow("flock is unavailable");
      }
    } finally {
      ffi.flock = null;
    }
    expect(fds()).toBe(before); // the guard fd was closed on every throw
    expect(readFileSync(join(p("sk-ffi", ".skills-lock"), "owner"), "utf8").trim()).toBe(dead.line); // nothing removed or taken
    expect(readFileSync(p("sk-ffi", ".skills-published"), "utf8")).toBe(published);
    expect(link("sk-ffi")).toBe(`${key}.view-1`);
    expect(existsSync(p("sk-ffi", ".skills-pending"))).toBe(false);
    expect(existsSync(p("sk-ffi", ".pending"))).toBe(false);
    // the real flock works again afterwards: the dead owner's lock is recovered
    const rel = await takeLock(dir, key, 2000, "app");
    rel();
  });

  test("a relink that waits gets the lock when the owner dies inside the wait", async () => {
    launched("sk-wait");
    prepare("sk-wait", 2, ["worker/a"]);
    const { child, line } = owner("app");
    setLock("sk-wait", line);
    const pending = relink("sk-wait");
    await new Promise((r) => setTimeout(r, 400));
    child.kill();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(link("sk-wait")).toBe(`${agentKey("sk-wait")}.view-2`);
  });

  test("a release by a process that is not the owner leaves the lock", () => {
    const lock = join(dir, "agents", "release-test.skills-lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "hub 123 Mon Jan  1 00:00:00 2001\n");
    releaseLock(lock, "hub 456 Mon Jan  1 00:00:00 2001");
    expect(existsSync(join(lock, "owner"))).toBe(true);
    releaseLock(lock, "hub 123 Mon Jan  1 00:00:00 2001");
    expect(existsSync(lock)).toBe(false);
  });
});
