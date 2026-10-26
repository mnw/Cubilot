// One throwaway git repository per test process: the project folder of a room in tests that launch stage sessions.
// The hub makes a worktree from it for every launch (stage-sessions 4.5).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { setRoomSettings } from "../../hub/core/ledger";

let repo: string | null = null;

// Worktrees go under CUBILOT_DATA_DIR. Point it at a temp folder before the first launch, never at the real app data.
// Always set: a session inside the app inherits CUBILOT_DATA_DIR from the real one.
// Templates come from the repo files in these tests, not from the app's staged factory the session may inherit.
delete process.env.CUBILOT_FACTORY_DIR;
process.env.CUBILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "cubilot-data-"));

export function projectRepo(): string {
  if (repo) return repo;
  const dir = mkdtempSync(join(tmpdir(), "proj-"));
  const sh = (...a: string[]) => {
    const r = Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  };
  sh("git", "init", "-q", "-b", "main");
  sh("git", "config", "user.email", "t@t");
  sh("git", "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "1");
  sh("git", "add", ".");
  sh("git", "commit", "-qm", "one");
  return (repo = dir);
}

/** Gives rooms a project folder in a ledger the test owns. */
export function giveProject(db: Database, ...rooms: string[]): void {
  for (const r of rooms) setRoomSettings(db, r, { project_folder: projectRepo() });
}

/** The same through the hub's settings route, for tests that run a real hub. */
export async function giveProjectHttp(hub: { url: string; token: string }, ...rooms: string[]): Promise<void> {
  for (const r of rooms) {
    const res = await fetch(`${hub.url}/rooms/${encodeURIComponent(r)}/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project_folder: projectRepo() }),
    });
    if (!res.ok) throw new Error(`project_folder for ${r}: ${res.status} ${await res.text()}`);
  }
}
