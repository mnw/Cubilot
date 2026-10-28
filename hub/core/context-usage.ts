// Context percentage of an agent: `context_window.used_percentage` of the status line JSON that
// factory/shared/scripts/statusline.sh keeps at <app data>/context/<agent>.json. null when the file or the value is missing.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function contextDir(): string {
  return join(process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot"), "context");
}

export function readContextPct(agent: string, dir: string = contextDir()): number | null {
  if (!agent || agent.startsWith(".") || agent.includes("/") || agent.includes("\\")) return null;
  try {
    const v = JSON.parse(readFileSync(join(dir, `${agent}.json`), "utf8"))?.context_window?.used_percentage;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
