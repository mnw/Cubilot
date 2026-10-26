// The test hub must not write into the real app data. It writes room transcripts to a temp folder next to its ledger.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, postJson, registerAgent } from "../helpers/fetch";

const REAL_DIR = join(homedir(), "Library", "Application Support", "Cubilot", "transcripts");
const listReal = () => (existsSync(REAL_DIR) ? readdirSync(REAL_DIR).sort() : []);

describe("test hub transcripts", () => {
  let hub: HubHandle;
  let agent: { close: () => void };
  const before = listReal();

  beforeAll(async () => {
    // A hub of this test file, started without the variable that other test files set for themselves.
    delete process.env.CUBILOT_TRANSCRIPTS_DIR;
    hub = await spawnHub();
    agent = await registerAgent(hub, "iso-alice", { room: "iso" });
  });
  afterAll(async () => {
    agent.close();
    await hub.kill();
  });

  test("a persisted room writes its JSONL into the temp folder, not the real app data", async () => {
    expect(hub.transcriptsDir.startsWith(join(hub.ledgerPath, "..")), hub.transcriptsDir).toBe(true);
    const on = await authedFetch(hub, "/rooms/iso/settings", { method: "PUT", body: JSON.stringify({ persist_transcript: true }) });
    expect(on.status).toBe(200);
    const sent = await postJson(hub, "/post", { from: "iso-alice", to: "all", text: "one persisted message" });
    expect(sent.status).toBe(200);

    const files = existsSync(hub.transcriptsDir) ? readdirSync(hub.transcriptsDir).filter((f) => f.endsWith("-iso.jsonl")) : [];
    expect(files).toHaveLength(1);
    expect(readFileSync(join(hub.transcriptsDir, files[0]), "utf8")).toContain("one persisted message");
    expect(listReal()).toEqual(before);   // the real transcripts folder gained no file
  });
});
