// The radius rule (design decision 3): the lowest blast radius a ticket text may have. A term matches as a whole word
// without case, a path matches as a substring. The terms and paths come from `radius_rule` in config.yml, read at each
// call. A missing or malformed block gives the defaults and one log line.

import { isMap, readConfig } from "./config-file";

export type RuleRadius = { radius: "low" | "high"; reasons: string[] };

export const DEFAULT_TERMS: readonly string[] = [
  "launch", "ownership", "assignee", "permission", "permissions", "read-only", "worktree", "migration",
  "data loss", "delete", "backup", "restore", "secret", "token",
];
export const DEFAULT_PATHS: readonly string[] = [
  "hub/core/launch-queue.ts", "src-tauri/src/launches.rs", "src-tauri/src/pty.rs", "hub/kinds/permission.ts",
  "hub/core/worktrees.ts", "hub/core/auth.ts", "hub/core/ledger.ts", "hub/core/store.ts",
];

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).map((s) => s.trim()).filter(Boolean) : null;

function settings(): { terms: readonly string[]; paths: readonly string[] } {
  const defaults = { terms: DEFAULT_TERMS, paths: DEFAULT_PATHS };
  const doc = readConfig("radius-rule", "radius_rule");
  if (!("radius_rule" in doc)) return defaults; // the reader logged the line
  const block = doc.radius_rule;
  if (!isMap(block)) {
    console.log("[radius-rule] radius_rule is not a map, default terms");
    return defaults;
  }
  const terms = block.terms === undefined ? [...DEFAULT_TERMS] : strings(block.terms);
  const paths = block.paths === undefined ? [...DEFAULT_PATHS] : strings(block.paths);
  if (!terms || !paths) {
    console.log("[radius-rule] radius_rule.terms and radius_rule.paths must be lists of strings, default terms");
    return defaults;
  }
  return { terms, paths };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `high` with the matched terms and paths, or `low` with none. A `termsCount: false` call matches paths only. */
export function ruleRadius(text: string, termsCount = true): RuleRadius {
  const { terms, paths } = settings();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  for (const t of termsCount ? terms : []) {
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u").test(lower) && !reasons.includes(t)) reasons.push(t);
  }
  for (const p of paths) {
    if (lower.includes(p.toLowerCase()) && !reasons.includes(p)) reasons.push(p);
  }
  return { radius: reasons.length ? "high" : "low", reasons };
}

/** The rule over a ticket text. A title that starts with `[doc]` only describes rules: its terms do not count, its paths do. */
export function ticketRadius(title: string, criteria: string, note: string | null): RuleRadius {
  return ruleRadius([title, criteria, note ?? ""].join("\n"), !/^\s*\[doc\]/i.test(title));
}
