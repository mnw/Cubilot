// `role_models` in config.yml: the human picks the harness, model, provider and effort of a stage role. The hub reads the
// file at each stage launch (an edit applies at the next launch, no Reload) and puts the values in the launch request.
// The shell only passes them on; pty_spawn checks the values as it checks a modal choice.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export type RoleModel = { harness?: "claude" | "pi"; model?: string; provider?: string; effort?: string };

/** `entry` is null when the role has none. `error` is a shape error of the entry of this role. */
export type RoleModelLookup = { entry: RoleModel | null } | { error: string };

const FIELDS = ["harness", "model", "provider", "effort"] as const;

const configPath = () => join(process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot"), "config.yml");

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The role_models map, or {} (and one log line) when the file or the key cannot be used. Never throws. */
function readMap(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch (e) {
    console.log(`[role-models] config.yml not read, no role models: ${(e as Error).message}`);
    return {};
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    console.log(`[role-models] config.yml is not valid YAML, no role models: ${(e as Error).message.split("\n")[0]}`);
    return {};
  }
  if (!isMap(doc) || !("role_models" in doc)) return {};
  const m = doc.role_models;
  if (!isMap(m)) {
    console.log("[role-models] role_models is not a map, no role models");
    return {};
  }
  return m;
}

/**
 * The entry of `role`. Empty strings count as not set. A key that is not in `roles` is logged and has no effect.
 * Only the entry of `role` is checked: a shape error of another role does not touch this launch.
 */
export function roleModelFor(role: string, roles: readonly string[]): RoleModelLookup {
  const map = readMap();
  for (const key of Object.keys(map)) {
    if (!roles.includes(key)) console.log(`[role-models] role_models.${key} is not a role, ignored`);
  }
  if (!Object.hasOwn(map, role)) return { entry: null };
  const raw = map[role];
  const bad = (what: string) => ({ error: `role_models.${role}: ${what}` });
  if (!isMap(raw)) return bad("the entry is not a map");
  const entry: RoleModel = {};
  for (const k of Object.keys(raw)) {
    if (!(FIELDS as readonly string[]).includes(k)) return bad(`unknown field ${k}`);
  }
  for (const k of FIELDS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return bad(`${k} is not a string`);
    const s = v.trim();
    if (s === "") continue;
    if (k === "harness") {
      if (s !== "claude" && s !== "pi") return bad(`harness must be claude or pi, not ${JSON.stringify(s)}`);
      entry.harness = s;
    } else {
      entry[k] = s;
    }
  }
  return { entry: Object.keys(entry).length ? entry : null };
}
