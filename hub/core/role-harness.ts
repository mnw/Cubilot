// The harness a stage session of a role launches on, else claude. The shell refuses a role on a harness other than its
// own without a chosen model, so the hub never overrides it.
//
// Where it is kept: the app stages each role as `<factory dir>/<version>/<role>/` with `role.md` WITHOUT frontmatter, so
// the harness is in the staged file `<role>/harness` (written by factory.rs stage_role). Only a run without the app
// (no CUBILOT_FACTORY_DIR: tests, the hub alone) reads the frontmatter of the repo's `factory/<role>/<role>.md`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function roleHarness(role: string, factoryDir = process.env.CUBILOT_FACTORY_DIR, version = process.env.CUBILOT_FACTORY_VERSION): "claude" | "pi" {
  // The role comes from the stage table, but it names a path here: only a plain name is read.
  if (!/^[a-z][a-z0-9-]*$/.test(role)) return "claude";
  try {
    if (factoryDir && version) {
      return readFileSync(join(factoryDir.trim(), version.trim(), role, "harness"), "utf8").trim() === "pi" ? "pi" : "claude";
    }
    const head = readFileSync(join(import.meta.dir, "../../factory", role, `${role}.md`), "utf8").split(/^---\s*$/m)[1] ?? "";
    return /^harness:\s*(\S+)\s*$/m.exec(head)?.[1] === "pi" ? "pi" : "claude";
  } catch {
    return "claude"; // no role file: the default
  }
}
