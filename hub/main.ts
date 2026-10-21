#!/usr/bin/env bun
/**
 * Cubilot sidecar entry point.
 *
 *   CUBILOT_MODE=hub  → start the HTTP/SSE hub (listens on PORT env)
 *
 * The Rust shell sets CUBILOT_MODE=hub when spawning the hub sidecar.
 */

// Module marker: top-level await below needs ES-module semantics under tsc.
export {};

const mode = process.env.CUBILOT_MODE ?? "";

if (mode === "hub") {
  await import("./hub.ts");
} else {
  console.error(
    `cubilot-bin: unknown mode ${JSON.stringify(mode)} — set CUBILOT_MODE=hub`,
  );
  process.exit(1);
}
