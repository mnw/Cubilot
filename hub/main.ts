#!/usr/bin/env bun
/**
 * Cubilot sidecar entry point.
 *
 *   A2A_MODE=hub  → start the HTTP/SSE hub (listens on PORT env)
 *
 * The Rust shell sets A2A_MODE=hub when spawning the hub sidecar.
 */

// Module marker: top-level await below needs ES-module semantics under tsc.
export {};

const mode = process.env.A2A_MODE ?? "";

if (mode === "hub") {
  await import("./hub.ts");
} else {
  console.error(
    `a2a-bin: unknown mode ${JSON.stringify(mode)} — set A2A_MODE=hub`,
  );
  process.exit(1);
}
