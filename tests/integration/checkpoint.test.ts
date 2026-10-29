// Checkpoint kind (P6-15): the human starts one, the lead writes a note, the hub clears the lead through the shell and the
// lead restarts from the note and the state summary. Real hub; the test plays the lead (its hooks) and the shell.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOOKS = join(import.meta.dir, "../../factory/orchestrator/hooks");
const LEAD = "boss";

const dataDir = (hub: HubHandle) => join(dirname(hub.ledgerPath), "data");
const summaryFile = (hub: HubHandle, agent = LEAD) => join(dataDir(hub), "checkpoints", `${agent}.md`);
const writeContext = (hub: HubHandle, pct: number, agent = LEAD) => {
  mkdirSync(join(dataDir(hub), "context"), { recursive: true });
  writeFileSync(join(dataDir(hub), "context", `${agent}.json`), JSON.stringify({ context_window: { used_percentage: pct } }));
};
const waitFor = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(50);
  }
};

type Cp = { id: string; status: string; note: string | null; trigger: string; context_pct_before: number | null; context_pct_after: number | null; summary_bytes: number | null; started_at_ms: number; reason: string | null; note_asked: boolean };

/** A hub with a Claude lead `boss` in room r1, the lead's agent stream, and a fake shell on the launch stream. */
async function boot(env: Record<string, string> = {}) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const hub = await spawnHub();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const lead = await registerAgent(hub, LEAD, { room: "r1" });
  expect((await postJson(hub, "/rooms/r1/lead", { by: hub.humanName, agent: LEAD })).status).toBe(200);
  // The lead's own stream: what the hub sends to the lead.
  const leadSse = openSSE(hub, `/agent-stream?agent=${LEAD}&room=r1`);
  const leadGot: any[] = [];
  void (async () => { try { for await (const e of leadSse.events) leadGot.push(e); } catch { /* closed */ } })();
  // The fake shell: reads the launch stream, acks every request, keeps what it got.
  const shellSse = openSSE(hub, "/launches/stream");
  const shellGot: any[] = [];
  void (async () => {
    try {
      for await (const r of shellSse.events) {
        shellGot.push(r);
        await postJson(hub, `/launches/${r.id}/ack`, { result: "spawned" });
      }
    } catch { /* closed */ }
  })();
  await sleep(150);
  const start = () => postJson(hub, "/checkpoints", { by: hub.humanName, room: "r1" });
  const turnEnd = (agent = LEAD) => postJson(hub, `/agents/${encodeURIComponent(agent)}/turn-end`, { by: agent });
  const note = (text: string, agent = LEAD) => postJson(hub, `/agents/${encodeURIComponent(agent)}/checkpoint-note`, { by: agent, text });
  const list = async () => ((await getJson(hub, "/checkpoints?room=r1")).json as { checkpoints: Cp[] }).checkpoints;
  const close = async () => { leadSse.close(); shellSse.close(); lead.close(); await hub.kill(); };
  return { hub, leadGot, shellGot, start, turnEnd, note, list, close };
}

describe("checkpoint", () => {
  let t: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { t = await boot({ CUBILOT_CHECKPOINT_TIMEOUT_MS: "60000", CUBILOT_CHECKPOINT_SWEEP_MS: "100" }); });
  afterAll(async () => { await t.close(); });

  const events = (id: string) =>
    new (require("bun:sqlite").Database)(t.hub.ledgerPath, { readonly: true }).query("SELECT kind FROM events WHERE entity_id = ? ORDER BY seq").all(id).map((e: any) => e.kind) as string[];

  test("Record", async () => {
    writeContext(t.hub, 62);
    const s = await t.start();
    expect(s.status).toBe(201);
    const id = (s.json as { id: string }).id;
    // The first turn end asks the lead for a note.
    const before = t.leadGot.length;
    expect(((await t.turnEnd()).json as any).action).toBe("note_asked");
    await waitFor(() => t.leadGot.length > before);
    expect(JSON.stringify(t.leadGot.slice(before))).toContain("checkpoint-note.sh");
    expect((await t.note("Open: the install of P6-15. Ask the human about the Pi lead.")).status).toBe(200);
    expect(((await t.turnEnd()).json as any).action).toBe("clearing");
    const input = await waitFor(() => t.shellGot.find((r) => r.kind === "input"));
    expect(input).toMatchObject({ kind: "input", session: LEAD, text: "/clear" });
    const size = statSync(summaryFile(t.hub)).size;
    // The SessionStart hook returns the file and removes it. The context is small again.
    writeContext(t.hub, 7);
    const hook = Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], {
      env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) }, stdin: new TextEncoder().encode("{}"),
    });
    expect(hook.exitCode).toBe(0);
    await waitFor(async () => (await t.list()).find((c) => c.id === id)?.status === "done");
    const cp = (await t.list()).find((c) => c.id === id)!;
    expect(cp).toMatchObject({ trigger: "human", status: "done", context_pct_before: 62, context_pct_after: 7, summary_bytes: size });
    expect(cp.started_at_ms).toBeGreaterThan(0);
    expect(events(id)).toEqual(["checkpoint.started", "checkpoint.note_asked", "checkpoint.noted", "checkpoint.clearing", "checkpoint.done"]);
    expect(((await getJson(t.hub, `/checkpoints/${id}`)).json as any).snapshot.id).toBe(id);
  });

  test("Clear (fake shell): the first context holds the note and the state summary, and the file is gone", async () => {
    const inputs = () => t.shellGot.filter((r) => r.kind === "input").length;
    const was = inputs();
    await t.start();
    await t.turnEnd();
    await t.note("NOTE-MARKER open point");
    await t.turnEnd();
    await waitFor(() => inputs() === was + 1);
    expect(existsSync(summaryFile(t.hub))).toBe(true);
    const hook = Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], {
      env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) },
    });
    const out = JSON.parse(hook.stdout.toString());
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("NOTE-MARKER open point");
    expect(out.hookSpecificOutput.additionalContext).toContain("State summary");
    expect(existsSync(summaryFile(t.hub))).toBe(false);
    await waitFor(async () => (await t.list())[0].status === "done");
  });

  test("No note", async () => {
    await t.start();
    expect(((await t.turnEnd()).json as any).action).toBe("note_asked");
    // The lead ends the next turn without a note: the checkpoint goes on.
    expect(((await t.turnEnd()).json as any).action).toBe("clearing");
    const cp = (await t.list())[0];
    expect(cp.note).toBeNull();
    expect(readFileSync(summaryFile(t.hub), "utf8")).toContain("Last note of the Orchestrator\n  none");
    Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], { env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) } });
    await waitFor(async () => (await t.list())[0].status === "done");
  });

  test("300-word note stored as 200 words", async () => {
    await t.start();
    await t.turnEnd();
    const words = Array.from({ length: 300 }, (_, i) => `w${i + 1}`);
    expect((await t.note(words.join(" "))).status).toBe(200);
    const cp = (await t.list())[0];
    expect(cp.note!.split(/\s+/)).toEqual(words.slice(0, 200));
    await t.turnEnd();
    Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], { env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) } });
    await waitFor(async () => (await t.list())[0].status === "done");
  });

  test("Summary file mode 0600", async () => {
    await t.start();
    await t.turnEnd();
    await t.turnEnd();
    expect(statSync(summaryFile(t.hub)).mode & 0o777).toBe(0o600);
    Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], { env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) } });
    await waitFor(async () => (await t.list())[0].status === "done");
  });

  test("a note needs a request, a turn end of another agent changes nothing, and one checkpoint is active at a time", async () => {
    expect((await t.note("too early")).status).toBe(409); // no checkpoint
    const s = await t.start();
    expect((await t.note("before the request")).status).toBe(409); // not asked yet
    expect(((await t.turnEnd("somebody-else")).json as any).action).toBe("none");
    expect((await t.list())[0].note_asked).toBe(false);
    expect((await t.start()).status).toBe(409);
    expect((await postJson(t.hub, "/checkpoints", { by: LEAD, room: "r1" })).status).toBe(403); // human only
    expect((await postJson(t.hub, `/agents/${LEAD}/turn-end`, { by: "somebody-else" })).status).toBe(403);
    await t.turnEnd();
    await t.turnEnd();
    Bun.spawnSync(["bash", join(HOOKS, "checkpoint-session-start.sh")], { env: { ...process.env, CHATBRIDGE_AGENT: LEAD, CUBILOT_DATA_DIR: dataDir(t.hub) } });
    await waitFor(async () => (await t.list())[0].status === "done");
    expect((s.json as any).snapshot.trigger).toBe("human");
  });
});

describe("checkpoint failures", () => {
  test("Clear time-out fails", async () => {
    const t = await boot({ CUBILOT_CHECKPOINT_TIMEOUT_MS: "400", CUBILOT_CHECKPOINT_SWEEP_MS: "100" });
    try {
      await t.start();
      await t.turnEnd();
      await t.turnEnd();
      expect(existsSync(summaryFile(t.hub))).toBe(true);
      // No hook removes the file: the checkpoint fails and the file is removed.
      const cp = await waitFor(async () => (await t.list())[0].status === "failed" && (await t.list())[0]);
      expect(cp.reason).toContain("2 minutes");
      expect(existsSync(summaryFile(t.hub))).toBe(false);
      // A failed checkpoint frees the lead for a new one.
      expect((await t.start()).status).toBe(201);
    } finally {
      await t.close();
    }
  });

  test("the note command is shell-safe for a factory path with spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cubilot factory "));
    mkdirSync(join(dir, "v1", "orchestrator"), { recursive: true });
    const t = await boot({ CUBILOT_FACTORY_DIR: dir, CUBILOT_FACTORY_VERSION: "v1" });
    try {
      writeContext(t.hub, 10);
      await t.start();
      const before = t.leadGot.length;
      await t.turnEnd();
      await waitFor(() => t.leadGot.length > before);
      const text = JSON.stringify(t.leadGot.slice(before));
      const m = text.match(/Run: (bash '[^']+')/);
      expect(m).not.toBeNull();
      // The shell reads the quoted path as one word.
      const argv = Bun.spawnSync(["bash", "-c", `set -- ${m![1].slice(5)}; echo $#`]).stdout.toString().trim();
      expect(argv).toBe("1");
      expect(m![1]).toContain(join(dir, "v1", "orchestrator", "hooks", "checkpoint-note.sh"));
    } finally {
      await t.close();
    }
  });

  test("an agent route refuses an empty, malformed or foreign body", async () => {
    const t = await boot();
    try {
      for (const path of ["turn-end", "checkpoint-note"]) {
        const url = `/agents/${encodeURIComponent(LEAD)}/${path}`;
        expect((await postJson(t.hub, url, {})).status).toBe(403);
        expect((await postJson(t.hub, url, { by: "someone-else" })).status).toBe(403);
        const bad = await fetch(`${t.hub.url}${url}`, { method: "POST", body: "{", headers: { Authorization: `Bearer ${t.hub.token}` } });
        expect(bad.status).toBe(400);
      }
    } finally {
      await t.close();
    }
  });

  test("Pi lead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cubilot-factory-"));
    mkdirSync(join(dir, "v1", "orchestrator"), { recursive: true });
    writeFileSync(join(dir, "v1", "orchestrator", "harness"), "pi\n");
    const t = await boot({ CUBILOT_FACTORY_DIR: dir, CUBILOT_FACTORY_VERSION: "v1" });
    try {
      const s = await t.start();
      expect(s.status).toBe(400);
      expect(JSON.stringify(s.json)).toContain("Pi lead");
      expect(await t.list()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  test("a room with no lead is refused", async () => {
    const t = await boot();
    try {
      expect((await postJson(t.hub, "/checkpoints", { by: t.hub.humanName, room: "empty-room" })).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe("checkpoint migration", () => {
  test("Migration twice: a restart on the same ledger keeps the rows", async () => {
    const t = await boot();
    await t.start();
    const rows = await t.list();
    await t.close();
    const hub2 = await spawnHub({ restartOf: t.hub });
    try {
      expect(((await getJson(hub2, "/checkpoints?room=r1")).json as any).checkpoints).toEqual(rows);
    } finally {
      await hub2.kill();
    }
  });
});
