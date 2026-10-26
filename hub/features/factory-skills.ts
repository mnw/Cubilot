// The hub's half of the per-agent skill switches (C6b; design: factory/brief/04a-c6-design.md, sections 2a and 5).
// The app prepares a build (`<hex>.view-<gen>` and `<hex>.skills-prepared`) and never publishes it. The hub publishes at
// the reload boundary, inside POST /factory/relink, under the publication lock. Files in `<dir>/agents/`:
//   <hex>.skills-prepared   { gen, off, skills, kind }          written by the app
//   <hex>.skills-published  { gen, off, skills, version }       what the paths on disk give now; survives every failure
//   <hex>.skills-pending    { attempt, ...published }           one copy for every accepted reload attempt
//   <hex>.skills-applied    { version, gen, off, skills }       written on a success report of the matching attempt
//   <hex>.view -> <hex>.view-<gen>                              the published build
//   <hex>.skills-lock/owner "<holder> <pid> <start>"            the publication lock (a folder)

import { dlopen, FFIType } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_WAIT_MS = 2000;

export class SkillsLockBusy extends Error {
  constructor() {
    super("the skills lock is busy");
  }
}

const agentsPath = (dir: string, key: string, suffix: string): string => join(dir, "agents", `${key}${suffix}`);

export type SkillsRecord = { gen: number; off: string[]; skills: string[]; version?: string; attempt?: string; kind?: string };

export function readRecord(path: string): SkillsRecord | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j.gen === "number" ? (j as SkillsRecord) : null;
  } catch {
    return null;
  }
}

// Mode 0600, temp file and rename. Throws on any error.
export const writeRecord = (path: string, body: unknown): void => writeText(path, JSON.stringify(body));

export function writeText(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ---- lock ----
function psStart(pid: number): string | null {
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const s = (r.stdout ?? "").trim();
  return r.status === 0 && s ? s : null;
}

// Confirmed dead only if the line parses and the pid is gone, or the pid has another start time. A line that does not
// parse, or a `ps` that fails or is unclear, means alive. A lock is never removed because of its age.
// `ps -o lstart=` prints e.g. "Sat Oct 24 22:28:48 2026" (day padded with a space below 10).
const LSTART_RE = /^[A-Za-z]{3} [A-Za-z]{3} [ 0-9]\d \d\d:\d\d:\d\d \d{4}$/;

export function ownerDead(line: string): boolean {
  const m = /^(app|hub) (\d+) (.+)$/.exec(line);
  if (!m) return false;
  const pid = Number(m[2]);
  // A start time that is not ps output cannot prove a reused pid: the owner stays alive.
  if (!(pid > 0) || !LSTART_RE.test(m[3].trim())) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  const start = psStart(pid);
  return start !== null && start !== m[3].trim();
}

const readOwner = (lock: string): string | null => {
  try {
    return readFileSync(join(lock, "owner"), "utf8").trim();
  } catch {
    return null;
  }
};

// Stale-lock recovery is the one place where a process deletes a lock it does not own, so it is serialised: an exclusive
// flock on `<key>.skills-lock.guard` (the app takes the same one, skills.rs). The kernel drops it when the process dies,
// so the guard cannot go stale and needs no recovery of its own. It is held only for the check-and-remove. The owner line
// is read again under the guard, and nobody else can remove or replace the folder meanwhile (a taker needs the folder to
// be gone, and only a recovery under this guard removes a dead owner's folder).
const LOCK_EX_NB = 2 | 4;
let flockFn: ((fd: number, op: number) => number) | null = null;
// Test seam: replaces the FFI call (a test makes flock unavailable by making it throw).
export const ffi: { flock: ((fd: number, op: number) => number) | null } = { flock: null };
function flock(fd: number, op: number): number {
  if (ffi.flock) return ffi.flock(fd, op);
  if (!flockFn) {
    const lib = dlopen("libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockFn = lib.symbols.flock as (fd: number, op: number) => number;
  }
  return flockFn(fd, op);
}

// Returns the held guard's release function, or null when the deadline passes first. On any throw (dlopen or flock
// unavailable) the descriptor is closed and the original error is kept.
async function takeGuard(path: string, deadline: number): Promise<(() => void) | null> {
  const fd = openSync(path, "a");
  try {
    for (;;) {
      if (flock(fd, LOCK_EX_NB) === 0) return () => closeSync(fd); // closing the fd drops the flock
      if (Date.now() >= deadline) {
        closeSync(fd);
        return null;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (e) {
    try {
      closeSync(fd);
    } catch {} // the original error is the one to report
    throw e;
  }
}

// Test seam: runs under the guard, after the owner line is confirmed dead and before anything is removed.
export const recoveryHook: { fn: ((lock: string) => Promise<void> | void) | null } = { fn: null };

// Returns the release function. Waits up to `waitMs`; a live or unclear owner means SkillsLockBusy. `lineOverride` is a
// test seam: the concurrency tests pass the owner line of a live helper process.
export async function takeLock(dir: string, key: string, waitMs = LOCK_WAIT_MS, holder = "hub", lineOverride?: string): Promise<() => void> {
  const lock = agentsPath(dir, key, ".skills-lock");
  const guardPath = agentsPath(dir, key, ".skills-lock.guard");
  let line = lineOverride ?? "";
  if (!lineOverride) {
    const start = psStart(process.pid);
    if (!start) throw new Error("cannot read the start time of this process");
    line = `${holder} ${process.pid} ${start}`;
  }
  const deadline = Date.now() + waitMs;
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A missing owner file is a taker that is still writing it: wait. A lock is never removed by age.
      const owner = readOwner(lock);
      if (owner !== null && ownerDead(owner)) {
        const release = await takeGuard(guardPath, deadline);
        if (release) {
          let retry = false;
          try {
            // Under the guard: decide again from a fresh read. Remove only a folder whose owner is the dead one we see
            // now; any other state (gone, new owner, unclear) is left alone.
            const now = readOwner(lock);
            if (now !== null && ownerDead(now)) {
              await recoveryHook.fn?.(lock);
              // Retry at once only if the folder is really gone and there is time left. A removal that fails falls
              // through to the deadline check below: no unbounded loop.
              try {
                rmSync(join(lock, "owner"), { force: true });
                rmdirSync(lock);
                retry = Date.now() < deadline;
              } catch {}
            } else {
              retry = Date.now() < deadline; // the state changed under us: look again
            }
          } finally {
            release();
          }
          if (retry) continue;
        }
      }
      if (Date.now() >= deadline) throw new SkillsLockBusy();
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    try {
      writeFileSync(join(lock, "owner"), `${line}\n`);
    } catch (e) {
      try {
        rmdirSync(lock);
      } catch {}
      throw e;
    }
    return () => releaseLock(lock, line);
  }
}

// Removes the lock only if its owner line is still `line`.
export function releaseLock(lock: string, line: string): void {
  if (readOwner(lock) !== line) return;
  rmSync(join(lock, "owner"), { force: true });
  try {
    rmdirSync(lock);
  } catch {}
}

// ---- publication ----
const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

// <hex>.view -> <target> by temp link and rename: a run reads a whole old view or a whole new one.
function swapView(dir: string, key: string, target: string | null): void {
  const link = agentsPath(dir, key, ".view");
  if (target === null) {
    rmSync(link, { force: true });
    return;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, link);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const viewTarget = (dir: string, key: string): string | null => {
  try {
    return readlinkSync(agentsPath(dir, key, ".view"));
  } catch {
    return null;
  }
};

// True when the agent has any skills record: only then relink takes the lock and runs the publication steps.
export const hasSkillsRecords = (dir: string, key: string): boolean =>
  existsSync(agentsPath(dir, key, ".skills-prepared")) || existsSync(agentsPath(dir, key, ".skills-published"));

// Steps 2 and 3 of the publication (design section 5, step 4). Call under the lock. Throws on a failure that it has
// already undone; the returned `undo` reverts a later failure of the same call (swap back first, record second).
export function publish(dir: string, key: string, version: string): { undo: () => string | null } {
  const preparedPath = agentsPath(dir, key, ".skills-prepared");
  const publishedPath = agentsPath(dir, key, ".skills-published");
  const prepared = readRecord(preparedPath);
  const published = readRecord(publishedPath);
  let undo = (): string | null => null;
  // Step 2: only a prepared build newer than the published one is swapped in. A retry, or a Reload with no checkbox
  // change, swaps nothing.
  if (prepared && prepared.gen > (published?.gen ?? -1)) {
    // kind "inventory": a plain agent with every skill on. No build to swap; only the record is refreshed.
    const swaps = prepared.kind !== "inventory";
    if (swaps && !isDir(agentsPath(dir, key, `.view-${prepared.gen}`))) throw new Error(`prepared build .view-${prepared.gen} is missing`);
    const prevTarget = viewTarget(dir, key);
    let prevText: string | null = null;
    try {
      prevText = readFileSync(publishedPath, "utf8");
    } catch {}
    if (swaps) swapView(dir, key, `${key}.view-${prepared.gen}`);
    // The undo is atomic for the record (temp file and rename) and reports what failed. If the swap-back fails the record
    // is not restored: it still describes the build that is on disk.
    undo = (): string | null => {
      try {
        if (swaps) swapView(dir, key, prevTarget);
      } catch (e) {
        return `view swap-back failed: ${(e as Error).message}`;
      }
      try {
        if (prevText === null) rmSync(publishedPath, { force: true });
        else writeText(publishedPath, prevText);
      } catch (e) {
        return `record restore failed: ${(e as Error).message}`;
      }
      return null;
    };
    try {
      writeRecord(publishedPath, { gen: prepared.gen, off: prepared.off, skills: prepared.skills, version });
    } catch (e) {
      const rb = undo();
      throw new Error(`${(e as Error).message}${rb ? `; rollback: ${rb}` : ""}`);
    }
  }
  // Step 3 is the caller's: writePending, once the attempt id exists.
  return { undo };
}

// Step 3: a copy of the published selection, bound to the attempt. An agent with no published record gets none.
export function writePending(dir: string, key: string, attempt: string): void {
  const published = readRecord(agentsPath(dir, key, ".skills-published"));
  if (!published) return;
  writeRecord(agentsPath(dir, key, ".skills-pending"), { attempt, ...published });
}

export const removePending = (dir: string, key: string): void => rmSync(agentsPath(dir, key, ".skills-pending"), { force: true });
export const readPendingRecord = (dir: string, key: string): SkillsRecord | null => readRecord(agentsPath(dir, key, ".skills-pending"));

// Success report: pending becomes applied. The caller has checked the attempt.
export function writeApplied(dir: string, key: string, pending: SkillsRecord): void {
  writeRecord(agentsPath(dir, key, ".skills-applied"), { version: pending.version, gen: pending.gen, off: pending.off, skills: pending.skills });
}
