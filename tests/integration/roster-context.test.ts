import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";

let hub: HubHandle;
let ctx: string;
const H = () => ({ Authorization: `Bearer ${hub.token}` });

async function roster(): Promise<any[]> {
  return (await fetch(`${hub.url}/agents`, { headers: H() })).json();
}
async function register(name: string) {
  const ac = new AbortController();
  const r = await fetch(`${hub.url}/agent-stream?agent=${name}`, { headers: H(), signal: ac.signal });
  void r.body?.getReader().read();
  return ac;
}

beforeAll(async () => {
  hub = await spawnHub();
  // The hub gets CUBILOT_DATA_DIR = <base>/data (tests/helpers/hub.ts); the ledger is <base>/ledger.db.
  ctx = join(hub.ledgerPath, "..", "data", "context");
  mkdirSync(ctx, { recursive: true });
});
afterAll(async () => { await hub.kill(); });

test("a file with 42.5 gives 42.5", async () => {
  writeFileSync(join(ctx, "ctx-a.json"), '{"context_window":{"used_percentage":42.5}}');
  const ac = await register("ctx-a");
  expect((await roster()).find((a) => a.name === "ctx-a").context_pct).toBe(42.5);
  ac.abort();
});

test("Empty value: no used_percentage gives null; so do a missing file and a bad file", async () => {
  writeFileSync(join(ctx, "ctx-b.json"), '{"context_window":{"used_percentage":null}}');
  writeFileSync(join(ctx, "ctx-c.json"), "not json");
  const acs = [await register("ctx-b"), await register("ctx-c"), await register("ctx-d")];
  const r = await roster();
  for (const n of ["ctx-b", "ctx-c", "ctx-d"]) expect(r.find((a) => a.name === n).context_pct).toBeNull();
  acs.forEach((a) => a.abort());
});
