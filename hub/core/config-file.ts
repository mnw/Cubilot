// One shared reader of the human's config.yml. Every hub setting reads through it, at each use (an edit applies at the next
// use, no Reload). A missing file, bad YAML or a top level that is not a map gives {} and one log line. Never throws.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export const configPath = () =>
  join(process.env.CUBILOT_DATA_DIR || join(homedir(), "Library", "Application Support", "Cubilot"), "config.yml");

export const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The parsed settings of config.yml, or {} when the file cannot be used. `tag` names the caller in the log line.
 * With `key`, a document that lacks the key also gives {} and one log line.
 */
export function readConfig(tag = "config", key?: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch (e) {
    console.log(`[${tag}] config.yml not read, no settings: ${(e as Error).message}`);
    return {};
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    console.log(`[${tag}] config.yml is not valid YAML, no settings: ${(e as Error).message.split("\n")[0]}`);
    return {};
  }
  if (!isMap(doc)) {
    console.log(`[${tag}] config.yml is not a map, no settings`);
    return {};
  }
  if (key !== undefined && !(key in doc)) {
    console.log(`[${tag}] ${key} is not set in config.yml, no settings`);
    return {};
  }
  return doc;
}
