// 5.4: an interrupt on a stage session changes nothing: the stage stays running, no event is written for it,
// and no close or launch request is queued.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { insertEvent } from "../../hub/core/events";
import { createInterruptKind } from "../../hub/kinds/interrupt";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const HUMAN = "human";

function setup() {
  const db = new Database(":memory:");
  migrateLedger(db);
  const interrupts = createInterruptKind(db);
  createTicketKind(db).migrate(db);
  interrupts.migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const roster: Record<string, string | null> = { [HUMAN]: null, alice: "r1", "worker-1": "r1" };
  const emitted: { entry: Entry; scope: Scope }[] = [];
  const cap = {
    db,
    agents: {
      get: (n: string) => (n in roster ? { name: n, room: roster[n]!, permanent: n === HUMAN } : null),
      isPermanent: (n: string) => n === HUMAN,
      isPaused: () => false,
      all: () => Object.entries(roster).map(([name, room]) => ({ name, room, permanent: name === HUMAN })),
      ensure: () => null,
    },
    sse: { emit: (entry: Entry, scope: Scope) => emitted.push({ entry, scope }) },
    events: { insert: insertEvent },
    config: { humanName: HUMAN, defaultRoom: "r1" },
    briefing: { refresh: () => {} },
  } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  const ac = new AbortController();
  rt.queue.attach((r) => sent.push(r), ac.signal, cap);

  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
     VALUES ('t_0000000000000001', 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 1, 1, 1)`,
  );
  const stage = rt.api.create({ ticket_id: "t_0000000000000001", role: "worker" }, "system", cap);
  rt.enqueueLaunch({ stage_id: stage.id, session: "worker-1", room: "r1", harness: "claude", cwd: null, prompt: "p" }, cap);
  rt.queue.ack(sent[0].id, { result: "spawned" }, cap);

  const post = async (path: string, body: unknown) => {
    const url = new URL(`http://hub.test${path}`);
    for (const r of interrupts.routes) {
      if (r.method !== "POST") continue;
      const m = typeof r.path === "string" ? (r.path === url.pathname ? [] : null) : url.pathname.match(r.path);
      if (!m) continue;
      const res = await r.handler(
        new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
        cap,
        { id: (m as string[])[1] ?? "" },
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    }
    throw new Error(`no route ${path}`);
  };
  const stageEvents = () =>
    db.query<{ kind: string }, [string]>("SELECT kind FROM events WHERE entity_id = ? ORDER BY seq").all(stage.id).map((e) => e.kind);
  return { rt, stage, sent, post, stageEvents, row: () => db.query("SELECT * FROM stage WHERE id = ?").get(stage.id), stop: () => { ac.abort(); rt.queue.dispose(); } };
}

describe("an interrupt on a stage session", () => {
  test("changes no stage state, writes no stage event and queues no launch or close", async () => {
    const e = setup();
    const before = { row: e.row(), events: e.stageEvents(), sent: e.sent.length, queue: e.rt.queue.size() };
    expect(e.rt.api.load(e.stage.id)!.status).toBe("running");

    const made = await e.post("/interrupts", { from: "alice", to: "worker-1", text: "stop and re-read the ticket" });
    expect(made.status).toBe(201);
    expect((await e.post(`/interrupts/${made.json.id}/ack`, { by: "worker-1" })).status).toBe(200);
    // the human interrupts the session too, and so does a bulk interrupt of the room
    expect((await e.post("/interrupts", { from: HUMAN, to: "worker-1", text: "pause" })).status).toBe(201);
    expect((await e.post("/interrupts", { from: HUMAN, rooms: ["r1"], text: "everyone stop" })).status).toBe(201);

    const after = e.rt.api.load(e.stage.id)!;
    expect(after.status).toBe("running");
    expect(after.session).toBe("worker-1");
    expect(e.row()).toEqual(before.row);
    expect(e.stageEvents()).toEqual(before.events);
    expect(e.sent).toHaveLength(before.sent); // no close, no second launch
    expect(e.rt.queue.size()).toEqual(before.queue);
    e.stop();
  });

  test("the interrupt code does not touch the stage kind or the launch queue", async () => {
    const src = await Bun.file(new URL("../../hub/kinds/interrupt.ts", import.meta.url)).text();
    expect(src).not.toMatch(/stage|launch/i);
  });
});
