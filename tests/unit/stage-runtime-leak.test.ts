// A stage runtime left running by one test file must not break another file's cleanup (ticket t_a71695432fb6a743).
// Reproduction: a retro launch with a short ack time-out is never disposed. The time-out retries the launch and writes a read-only
// worktree into the CUBILOT_DATA_DIR that is current at that time. Cleanup with a plain rmSync fails with EACCES.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject } from "../helpers/repo";
import { disposeRuntimes, removeTree, trackedRuntime } from "../helpers/stage-runtimes";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

afterEach(disposeRuntimes);

function retroLaunch() {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = trackedRuntime(db, { ackMs: 30 });
  rt.module.migrate(db);
  giveProject(db, "A");
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  rt.api.create({ review: "retro", role: "retrospective", room: "A" }, "system", cap);
  rt.module.onRoomLimitsChanged!("A", cap);
  return { sent };
}

const wait = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  return ok();
};
const retroDirs = (data: string) => (existsSync(join(data, "worktrees", "A")) ? readdirSync(join(data, "worktrees", "A")).filter((n) => n.startsWith("retro-")) : []);

test("a disposed runtime writes no retro folder after its test", async () => {
  const data = mkdtempSync(join(tmpdir(), "leak-data-"));
  const saved = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = data;
  try {
    const { sent } = retroLaunch();
    expect(sent.filter((r) => r.kind === "launch")).toHaveLength(1);
    const first = retroDirs(data).length;
    disposeRuntimes();
    await new Promise((r) => setTimeout(r, 200)); // 6 ack periods: a live timer would have retried by now
    expect(retroDirs(data)).toHaveLength(first);
  } finally {
    process.env.CUBILOT_DATA_DIR = saved;
    removeTree(data);
  }
});

test("removeTree removes a folder that holds a read-only retro worktree", async () => {
  const data = mkdtempSync(join(tmpdir(), "leak-data-"));
  const saved = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = data;
  try {
    retroLaunch(); // runtime stays live on purpose: the time-out retries and writes a second worktree
    expect(await wait(() => retroDirs(data).length >= 1)).toBe(true);
  } finally {
    process.env.CUBILOT_DATA_DIR = saved;
    disposeRuntimes();
  }
  removeTree(data);
  expect(existsSync(data)).toBe(false);
});
