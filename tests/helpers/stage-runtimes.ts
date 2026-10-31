// Stage runtimes made in a test file. disposeRuntimes() clears their launch ack timers and sweep timer, so none fires after the test
// (a late ack time-out would retry the launch and write a worktree into whatever CUBILOT_DATA_DIR is current by then).
import { createStageRuntime } from "../../hub/kinds/stage";
import { rmSync } from "node:fs";

type Runtime = ReturnType<typeof createStageRuntime>;
const made: Runtime[] = [];

export function trackedRuntime(...a: Parameters<typeof createStageRuntime>): Runtime {
  const rt = createStageRuntime(...a);
  made.push(rt);
  return rt;
}

export function disposeRuntimes(): void {
  for (const rt of made.splice(0)) rt.module.dispose?.();
}

/** Removes a temp folder that may hold a read-only worktree (a retro or validator worktree has no write bit). */
export function removeTree(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}
