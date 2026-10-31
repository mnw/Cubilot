// GET /config/default-model through a real hub: the config read of the launch form. The hub reads
// $CUBILOT_DATA_DIR/config.yml at each request, so each test rewrites the file of the one hub.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson } from "../helpers/fetch";

describe("GET /config/default-model", () => {
  let hub: HubHandle;
  let configFile: string;
  beforeAll(async () => {
    hub = await spawnHub();
    const data = join(dirname(hub.ledgerPath), "data");
    mkdirSync(data, { recursive: true });
    configFile = join(data, "config.yml");
  });
  afterAll(async () => { await hub.kill(); });

  test("returns the configured models", async () => {
    writeFileSync(configFile, "default_model:\n  claude: opus\n  pi: m1\n");
    const r = await getJson(hub, "/config/default-model");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ default_model: { claude: "opus", pi: "m1" } });
  });

  test("unknown harness and non-string values are dropped, the route still answers", async () => {
    writeFileSync(configFile, "default_model:\n  claude: [a]\n  pi: m1\n  other: x\n");
    const r = await getJson(hub, "/config/default-model");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ default_model: { pi: "m1" } });
  });

  test("a missing key or file gives an empty map", async () => {
    writeFileSync(configFile, "theme: default\n");
    expect((await getJson(hub, "/config/default-model")).json).toEqual({ default_model: {} });
    rmSync(configFile, { force: true });
    expect((await getJson(hub, "/config/default-model")).json).toEqual({ default_model: {} });
  });

  test("needs read auth", async () => {
    const r = await fetch(`${hub.url}/config/default-model`);
    expect(r.status).toBe(401);
  });
});
