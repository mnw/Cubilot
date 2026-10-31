// buildKinds reads CUBILOT_STAGE_SWEEP_MS for the stage sweep interval; unset, 0 or not a number keeps 30_000 ms.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateLedger } from "../../hub/core/ledger";
import { buildKinds } from "../../hub/kinds";
import type { HubCapabilities } from "../../hub/core/types";

const realSetInterval = globalThis.setInterval;
const saved = process.env.CUBILOT_STAGE_SWEEP_MS;
afterEach(() => {
  globalThis.setInterval = realSetInterval;
  if (saved === undefined) delete process.env.CUBILOT_STAGE_SWEEP_MS;
  else process.env.CUBILOT_STAGE_SWEEP_MS = saved;
});

/** The delays that the stage kind passes to setInterval in start(). The timer is never armed. */
function sweepDelays(env: string | undefined): unknown[] {
  if (env === undefined) delete process.env.CUBILOT_STAGE_SWEEP_MS;
  else process.env.CUBILOT_STAGE_SWEEP_MS = env;
  const db = new Database(":memory:");
  migrateLedger(db);
  const kinds = buildKinds(db);
  for (const k of kinds) k.migrate(db);
  const stage = kinds.find((k) => k.kind === "stage")!;
  const delays: unknown[] = [];
  globalThis.setInterval = ((_fn: unknown, ms?: number) => {
    delays.push(ms);
    return { unref() {} };
  }) as unknown as typeof setInterval;
  const cap = { db, sse: { emit() {} }, briefing: { refresh() {} } } as unknown as HubCapabilities;
  stage.start!(cap);
  globalThis.setInterval = realSetInterval;
  stage.dispose?.();
  return delays;
}

describe("CUBILOT_STAGE_SWEEP_MS", () => {
  test("a number sets the sweep interval", () => {
    expect(sweepDelays("500")).toContain(500);
  });
  test.each([undefined, "", "0", "abc"])("%p keeps 30_000 ms", (v) => {
    const d = sweepDelays(v);
    expect(d).toContain(30_000);
    expect(d).not.toContain(0);
  });
});
