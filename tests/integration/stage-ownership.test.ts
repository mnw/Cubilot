// stage-sessions 2.5: ticket ownership on launch, through a real hub with a fake shell client on the launch stream.
// One-transaction proof (stage.launching + ticket.assigned commit or roll back together): tests/unit/stage-assign.test.ts:83-98.
// No-wake delivery of an entry from `system`: tests/unit/bridge-core.test.ts:477-484.
// Lowest-free session name: tests/unit/stage-retry.test.ts:175-177 and tests/unit/stage-assign.test.ts:71-80.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "so";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a worker launch owns the ticket for the launched session", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    open.push(await registerAgent(hub, "so-alice", { room: ROOM }));
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  /** Every ticket.assigned event of one ticket, oldest first. */
  const assigned = (ticket: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db
        .query<{ actor: string; payload_json: string }, [string]>("SELECT actor, payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.assigned' ORDER BY seq")
        .all(ticket)
        .map((e) => ({ actor: e.actor, ...(JSON.parse(e.payload_json) as { from: string | null; to: string }) }));
    } finally {
      db.close();
    }
  };
  const waitFor = async <T>(f: () => T | undefined | false, what: string): Promise<T> => {
    for (let i = 0; i < 50; i++) {
      const v = f();
      if (v) return v;
      await sleep(100);
    }
    throw new Error(`timeout: ${what}`);
  };
  const assigneeOf = (ticket: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db.query<{ assignee: string | null }, [string]>("SELECT assignee FROM tickets WHERE id = ?").get(ticket)?.assignee;
    } finally {
      db.close();
    }
  };
  const launchesOf = async (ticket: string) => {
    const stages = ((await getJson(hub, "/stages?status=all")).json as any[]).filter((s) => s.ticket_id === ticket).map((s) => s.id);
    return launches.filter((l) => l.kind === "launch" && stages.includes(l.stage_id));
  };

  test("launch: assignee is the launched session name and exactly one ticket.assigned event has actor system", async () => {
    const made = await postJson(hub, "/tickets", { by: "so-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: "worker" });
    expect(made.status).toBe(201);
    const id = (made.json as { snapshot: { id: string } }).snapshot.id;
    await waitFor(() => launches.some((l) => l.kind === "launch"), "launch request");
    const req = (await launchesOf(id))[0];
    expect(req.session).toMatch(/^worker-\d+$/);
    expect(assigned(id)).toEqual([{ actor: "system", from: null, to: req.session }]);
    expect(assigneeOf(id)).toBe(req.session);
  });

  test("retry: attempt 2 assigns the ticket to the session name of attempt 2 (whichever nextSessionName chose)", async () => {
    const made = await postJson(hub, "/tickets", { by: "so-alice", title: "t2", acceptance_criteria: "c", blast_radius: "low", role: "worker" });
    const id = (made.json as { snapshot: { id: string } }).snapshot.id;
    await waitFor(() => launches.length > 1, "first launch");
    const first = (await launchesOf(id))[0];
    const ack = await postJson(hub, `/launches/${first.id}/ack`, { result: "error", error: "tmux down" });
    expect(ack.status).toBe(200);
    await waitFor(() => launches.some((l) => l.kind === "launch" && l.stage_id === first.stage_id && l.id !== first.id), "relaunch");
    const second = launches.filter((l) => l.kind === "launch" && l.stage_id === first.stage_id).at(-1);
    const events = assigned(id);
    // The final assignee is the session of attempt 2.
    expect(assigneeOf(id)).toBe(second.session);
    expect(events.at(-1)).toMatchObject({ actor: "system", to: second.session });
    // One event per change of name: a new name writes one more event, the same name writes none.
    expect(events).toHaveLength(second.session === first.session ? 1 : 2);
  });
});
