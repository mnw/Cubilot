// context-pack 3.5 through the real hub: while a pack command sleeps, the hub still answers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { sh } from "../helpers/pack-fixture";

const ROOM = "cpl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the hub answers while the pack builds", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const oldPath = process.env.PATH;
  let started = "";
  let release = "";

  beforeAll(async () => {
    // A project folder that holds graphify-out/graph.json, so graphify runs there.
    const project = mkdtempSync(join(tmpdir(), "cpl-proj-"));
    sh(project, "git", "init", "-q", "-b", "staging");
    sh(project, "git", "config", "user.email", "t@t");
    sh(project, "git", "config", "user.name", "t");
    mkdirSync(join(project, "graphify-out"));
    writeFileSync(join(project, "graphify-out", "graph.json"), "{}");
    sh(project, "git", "add", "-f", ".");
    sh(project, "git", "commit", "-qm", "graph");
    const bin = mkdtempSync(join(tmpdir(), "cpl-bin-"));
    // The stub blocks until the test creates the release file (15 s safety cap), then prints its text.
    started = join(bin, "started");
    release = join(bin, "release");
    writeFileSync(join(bin, "graphify"), `#!/bin/sh\ntouch "${started}"\ni=0\nwhile [ ! -e "${release}" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done\necho STUB-GRAPH-TEXT\n`);
    chmodSync(join(bin, "graphify"), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    hub = await spawnHub();
    process.env.PATH = oldPath;
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ project_folder: project }) });
    expect(put.status).toBe(200);
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    for (const c of open) c.close();
    await hub.kill();
  });

  test("GET /agents and POST /post answer within 1 s while graphify sleeps 15 s; the launch follows with the pack", async () => {
    const launches: any[] = [];
    const stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "pack ticket", acceptance_criteria: "c", blast_radius: "low", role: null });
    const ticket = (t.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "worker", task: "go", context: { ticket_id: ticket } })).status).toBe(201);
    for (let i = 0; i < 100 && !existsSync(started); i++) await sleep(50); // the stage is launching; graphify is blocked
    expect(existsSync(started)).toBe(true);
    expect(launches).toHaveLength(0);

    for (const call of [
      () => authedFetch(hub, "/agents"),
      () => postJson(hub, "/post", { from: "Orchestrator", to: "all", text: "ping" }),
    ]) {
      const t0 = Date.now();
      const r = await call();
      expect(Date.now() - t0).toBeLessThan(1000);
      expect((r as Response).status ?? (r as { status: number }).status).toBe(200);
    }
    expect(launches).toHaveLength(0); // still building
    writeFileSync(release, "");

    for (let i = 0; i < 300 && launches.length === 0; i++) await sleep(100);
    stream.close();
    expect(launches).toHaveLength(1);
    expect(launches[0].prompt).toContain("STUB-GRAPH-TEXT");
  }, 60_000);
});
