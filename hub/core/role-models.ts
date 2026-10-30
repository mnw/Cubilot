// `role_models` in config.yml: the human picks the harness, model, provider and effort of a stage role. The hub reads the
// file at each stage launch (an edit applies at the next launch, no Reload) and puts the values in the launch request.
// The shell only passes them on; pty_spawn checks the values as it checks a modal choice.

import { isMap, readConfig } from "./config-file";

export type RoleModel = { harness?: "claude" | "pi"; model?: string; provider?: string; effort?: string };

/** `entry` is null when the role has none. `error` is a shape error of the entry of this role. */
export type RoleModelLookup = { entry: RoleModel | null } | { error: string };

const FIELDS = ["harness", "model", "provider", "effort"] as const;

/** The role_models map, or {} (and one log line) when the file or the key cannot be used. Never throws. */
function readMap(): Record<string, unknown> {
  const doc = readConfig("role-models");
  if (!("role_models" in doc)) return {};
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
  return parseEntry(`role_models.${role}`, map[role]);
}

/** One entry of a role-model pair (also `second_review`). `label` names the config key in a shape error. */
export function parseEntry(label: string, raw: unknown): RoleModelLookup {
  const bad = (what: string) => ({ error: `${label}: ${what}` });
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

/** The pair of the second Validator review when config.yml has no usable `second_review`. */
export const DEFAULT_SECOND_REVIEW: RoleModel = { harness: "claude", model: "opus", effort: "high" };

/**
 * `second_review` in config.yml, read at each use. A missing key or a bad value gives the default (a bad value is logged).
 * It replaces role_models.validator for the second review of a high ticket.
 */
export function secondReviewModel(): RoleModel {
  const doc = readConfig("second-review");
  if (!("second_review" in doc)) return DEFAULT_SECOND_REVIEW;
  const r = parseEntry("second_review", doc.second_review);
  if ("error" in r) {
    console.log(`[second-review] ${r.error}, default used`);
    return DEFAULT_SECOND_REVIEW;
  }
  return r.entry ?? DEFAULT_SECOND_REVIEW;
}
