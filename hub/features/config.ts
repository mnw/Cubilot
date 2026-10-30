// Config reads for the launch form. Read-only: the hub never writes config.yml.

import type { HubFeature } from "../core/types";
import { defaultModels } from "../core/default-model";

export function createConfigFeature(): HubFeature {
  return {
    routes: [
      {
        method: "GET",
        path: "/config/default-model",
        auth: "read",
        handler: () => Response.json({ default_model: defaultModels() }),
      },
    ],
  };
}
