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

test("a file with 42.5 gives 43", async () => {
  writeFileSync(join(ctx, "ctx-a.json"), '{"context_window":{"used_percentage":42.5}}');
  const ac = await register("ctx-a");
  expect((await roster()).find((a) => a.name === "ctx-a").context_pct).toBe(43);
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

async function sseRosters(ac: AbortController): Promise<AsyncGenerator<any>> {
  const r = await fetch(`${hub.url}/stream`, { headers: { Authorization: `Bearer ${hub.humanToken}` }, signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  async function* gen() {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const m = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (!m) continue;
        try { const d = JSON.parse(m.slice(5)); if (d.type === "roster") yield d; } catch {}
      }
    }
  }
  return gen();
}

test("the SSE roster snapshot after GET /agents keeps context_pct 43, and a changed file reaches the next roster broadcast", async () => {
  writeFileSync(join(ctx, "ctx-e.json"), '{"context_window":{"used_percentage":42.5}}');
  const agent = await register("ctx-e");
  await roster();
  const ac = new AbortController();
  const it = await sseRosters(ac);
  const first = (await it.next()).value;
  expect(first.agents.find((a: any) => a.name === "ctx-e").context_pct).toBe(43);
  writeFileSync(join(ctx, "ctx-e.json"), '{"context_window":{"used_percentage":77}}');
  let seen: number | null = null;
  for (let i = 0; i < 5 && seen !== 77; i++) {
    seen = (await it.next()).value.agents.find((a: any) => a.name === "ctx-e").context_pct;
  }
  expect(seen).toBe(77);
  ac.abort();
  agent.abort();
}, 20000);
