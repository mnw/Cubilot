// P6-10: the room lead's briefing ignores stage sessions. The hub knows a stage session from its own launch record,
// never from what a session sends. Real hub, a fake shell client on GET /launches/stream.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "lb";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAST_DEBOUNCE_MS = 1200; // the dispatcher debounce is 500 ms

async function until<T>(f: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v !== undefined) return v;
    await sleep(25);
  }
  throw new Error("timeout");
}

// Opens an agent stream and drains it (openSSE connects only when read).
function join(hub: HubHandle, path: string, into: any[] = []) {
  const sse = openSSE(hub, path);
  void (async () => { try { for await (const e of sse.events) into.push(e); } catch { /* closed */ } })();
  return sse;
}

describe("lead briefing and stage sessions", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  const leadEvents: any[] = [];
  const leadBriefings = () => leadEvents.filter((e) => e.type === "briefing");
  let session = "";
  let stageId = "";

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    open.push(join(hub, `/agent-stream?agent=Orchestrator&room=${ROOM}`, leadEvents));
    open.push(join(hub, "/launches/stream", launches));
    await sleep(300);

    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Lead ticket", acceptance_criteria: "c", blast_radius: "low", priority: "high" });
    expect(t.status).toBe(201);
    const ticket = (t.json as any).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "worker", task: `work ${ticket}`, context: { ticket_id: ticket } })).status).toBe(201);
    const req = await until(() => launches.find((l) => l.kind === "launch"));
    session = req.session;
    stageId = req.stage_id;
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    await until(() => (leadBriefings().length > 0 ? true : undefined));
    await sleep(PAST_DEBOUNCE_MS);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("Stage session joins: the launched session does not re-brief the lead", async () => {
    const before = leadBriefings().length;
    open.push(join(hub, `/agent-stream?agent=${encodeURIComponent(session)}&room=${ROOM}&stage=${stageId}`));
    await sleep(PAST_DEBOUNCE_MS);
    expect(leadBriefings()).toHaveLength(before);
  });

  test("a session that sends a stage id but is not in the hub's launch record is ignored as a stage peer", async () => {
    const before = leadBriefings().length;
    open.push(join(hub, `/agent-stream?agent=lb-impostor&room=${ROOM}&stage=${stageId}`));
    await until(() => (leadBriefings().length > before ? true : undefined));
  });

  test("a non-stage agent joining still re-briefs the lead", async () => {
    const before = leadBriefings().length;
    open.push(await registerAgent(hub, "lb-bob", { room: ROOM }));
    await until(() => (leadBriefings().length > before ? true : undefined));
  });
});

// Ledger-backed binding (t_31fec1a3f4c3da46): the hub loads the bindings at start, before it accepts agent streams.
describe("lead briefing and stage sessions across a hub restart", () => {
  const RROOM = "lbr";
  type Case = { name: string; sql: string | null; expectQuiet: boolean };

  async function firstRun(): Promise<{ hub: HubHandle; session: string; stageId: string }> {
    const hub = await spawnHub();
    await giveProjectHttp(hub, RROOM);
    const launches: any[] = [];
    const lead = join(hub, `/agent-stream?agent=Orchestrator&room=${RROOM}`);
    const s = join(hub, "/launches/stream", launches);
    await sleep(300);
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Restart ticket", acceptance_criteria: "c", blast_radius: "low", priority: "high" });
    const ticket = (t.json as any).snapshot.id;
    await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "worker", task: `work ${ticket}`, context: { ticket_id: ticket } });
    const req = await until(() => launches.find((l) => l.kind === "launch"));
    expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    await sleep(300);
    lead.close();
    s.close();
    return { hub, session: req.session, stageId: req.stage_id };
  }

  // Kills the first hub, edits the stage row, boots a second hub on the same ledger. Returns the lead briefing count after
  // the stage session reconnects (after the lead has its briefing and the debounce is over).
  async function afterRestart(sql: string | null, sendStage: boolean, nameOverride?: string): Promise<number> {
    const first = await firstRun();
    await first.hub.kill();
    if (sql) {
      const db = new Database(first.hub.ledgerPath);
      db.run(sql.replaceAll("$ID", first.stageId));
      db.close();
    }
    const hub = await spawnHub({ restartOf: first.hub });
    const leadEvents: any[] = [];
    const open = [join(hub, `/agent-stream?agent=Orchestrator&room=${RROOM}`, leadEvents)];
    try {
      await until(() => (leadEvents.some((e) => e.type === "briefing") ? true : undefined));
      await sleep(PAST_DEBOUNCE_MS);
      const before = leadEvents.filter((e) => e.type === "briefing").length;
      const name = nameOverride ?? first.session;
      open.push(join(hub, `/agent-stream?agent=${encodeURIComponent(name)}&room=${RROOM}${sendStage ? `&stage=${first.stageId}` : ""}`));
      await sleep(PAST_DEBOUNCE_MS);
      return leadEvents.filter((e) => e.type === "briefing").length - before;
    } finally {
      for (const c of open) c.close();
      await hub.kill();
    }
  }

  test("(a) a running stage keeps the lead signature when its session reconnects after the restart", async () => {
    expect(await afterRestart(null, true)).toBe(0);
  });
  test("(c) a retrying stage with an unreleased session keeps the lead signature", async () => {
    expect(await afterRestart("UPDATE stage SET status = 'retrying', attempt = 2 WHERE id = '$ID'", true)).toBe(0);
  });
  test("(d) a retrying stage with a released session is an ordinary peer and re-briefs the lead", async () => {
    expect(await afterRestart("UPDATE stage SET status = 'retrying', attempt = 2, session_released_at_ms = 1 WHERE id = '$ID'", true)).toBeGreaterThan(0);
  });
  test("a passed stage is not bound", async () => {
    expect(await afterRestart("UPDATE stage SET status = 'passed' WHERE id = '$ID'", true)).toBeGreaterThan(0);
  });
  test("security: a session with no stored binding stays an ordinary peer, whatever it sends", async () => {
    expect(await afterRestart(null, true, "worker-99")).toBeGreaterThan(0);
  });
});

describe("the release mark in the ledger", () => {
  test("a final launch-error ack sets it with the stage change; a bind clears it", async () => {
    const hub = await spawnHub();
    const launches: any[] = [];
    const s = join(hub, "/launches/stream", launches);
    const lead = join(hub, "/agent-stream?agent=Orchestrator&room=lbm");
    try {
      await giveProjectHttp(hub, "lbm");
      await sleep(300);
      const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Mark ticket", acceptance_criteria: "c", blast_radius: "low", priority: "high" });
      const ticket = (t.json as any).snapshot.id;
      await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "worker", task: `work ${ticket}`, context: { ticket_id: ticket } });
      const req = await until(() => launches.find((l) => l.kind === "launch"));
      const mark = () => {
        const db = new Database(hub.ledgerPath, { readonly: true });
        try { return db.query<{ m: number | null; st: string }, [string]>("SELECT session_released_at_ms AS m, status AS st FROM stage WHERE id = ?").get(req.stage_id)!; } finally { db.close(); }
      };
      expect(mark().m).toBeNull();
      // Attempt 1 fails: the retry launches again and the bind clears the mark. Attempt 2 fails: the stage ends, the mark stays.
      expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "error", error: "no tmux" })).status).toBe(200);
      const second = await until(() => launches.filter((l) => l.kind === "launch")[1]);
      await until(() => (mark().st === "launching" ? true : undefined));
      expect(mark().m).toBeNull();
      expect((await postJson(hub, `/launches/${second.id}/ack`, { result: "error", error: "no tmux" })).status).toBe(200);
      const end = await until(() => { const r = mark(); return r.st === "failed" ? r : undefined; });
      expect(end.m).not.toBeNull();
    } finally {
      lead.close();
      s.close();
      await hub.kill();
    }
  });
});
