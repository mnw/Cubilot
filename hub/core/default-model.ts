// `default_model` in config.yml: the model a new agent starts with, per harness ({claude: opus, pi: <model>}). The launch
// form reads it through GET /config/default-model. Read at each request (an edit applies at once, no Reload).
// Stage launches do not use it: role_models (role-models.ts) stays their source.

import { isMap, readConfig } from "./config-file";

const HARNESSES = ["claude", "pi"] as const;

export type DefaultModels = { claude?: string; pi?: string };

/**
 * The default model of each harness. A missing key gives {}. A value that is not a string, or a key that is not a harness,
 * is ignored with one log line. Empty strings count as not set. Never throws.
 */
export function defaultModels(): DefaultModels {
  const doc = readConfig("default-model");
  if (!("default_model" in doc)) return {};
  const m = doc.default_model;
  if (!isMap(m)) {
    console.log("[default-model] default_model is not a map, ignored");
    return {};
  }
  const out: DefaultModels = {};
  for (const [k, v] of Object.entries(m)) {
    if (!(HARNESSES as readonly string[]).includes(k)) {
      console.log(`[default-model] default_model.${k} is not a harness, ignored`);
    } else if (typeof v !== "string") {
      console.log(`[default-model] default_model.${k} is not a string, ignored`);
    } else if (v.trim() !== "") {
      out[k as keyof DefaultModels] = v.trim();
    }
  }
  return out;
}
