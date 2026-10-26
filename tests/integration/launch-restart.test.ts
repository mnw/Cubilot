// A hub restart settles stages that were launching (4.1 review): the launch queue is in memory, so the request is
// gone, and the stage counts as a launch with no ack.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boots the hub again on an existing ledger (the helper always makes a new one). */
async function bootOn(ledgerPath: string, token: string): Promise<{ hub: HubHandle; kill: () => Promise<void> }> {
  const base = mkdtempSync(join(tmpdir(), "cubilot-restart-"));
  mkdirSync(join(base, "att"), { recursive: true });
  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env, PORT: "0", CUBILOT_TOKEN: token, CUBILOT_LEDGER_DB: ledgerPath,
      CUBILOT_ATTACHMENTS_DIR: join(base, "att"), CUBILOT_HUMAN_NAME: "human", CUBILOT_DEFAULT_ROOM: "default",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = proc.stdout!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 6000;
  let url = "";
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/listening on (http:\/\/[^\s]+)/);
    if (m) { url = m[1]; break; }
  }
  if (!url) { proc.kill(); throw new Error(`hub did not boot:\n${buf}`); }
  void (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
  const hub = { url, token, ledgerPath, attachmentsDir: join(base, "att"), humanName: "human", kill: async () => { proc.kill(); await proc.exited; } } as HubHandle;
  return { hub, kill: hub.kill };
}

describe("hub restart and launching stages", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const c of cleanup) await c(); });

  test("a stage left in launching is relaunched when the hub starts again; a running-free ledger is untouched", async () => {
    const first = await spawnHub();
    await giveProjectHttp(first, "lr");
    cleanup.push(first.kill);
    const a = await registerAgent(first, "lr-alice", { room: "lr" });
    // No shell is connected, so the launch request waits in memory and the stage stays launching.
    const t = (await postJson(first, "/tickets", { by: "lr-alice", title: "t", acceptance_criteria: "c", blast_radius: "low" })).json as any;
    const id = t.snapshot.id;
    expect((await postJson(first, "/handoffs", { from: "lr-alice", to_role: "tester", task: "x", context: { ticket_id: id } })).status).toBe(201);
    await sleep(400);
    const before = (await getJson(first, "/stages?status=all")).json as any[];
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: "launching", attempt: 1 });
    a.close();
    await first.kill();

    const second = await bootOn(first.ledgerPath, first.token);
    cleanup.push(second.kill);
    await sleep(300);
    const after = (await getJson(second.hub, "/stages?status=all")).json as any[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, status: "launching", attempt: 2 }); // retrying, then relaunched at once (5.3)
  });
});
