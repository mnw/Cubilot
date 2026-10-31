// A late launch ack after a launch time-out (G4 follow-up). Real hub, fake shell: the test reads the fake executor stream and
// sends the acks itself. The time-out is lowered only through CUBILOT_LAUNCH_ACK_MS (hub/kinds/index.ts).

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ACK_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: "launch" | "close"; stage_id?: string; session: string };
type Stage = { id: string; ticket_id: string | null; role: string; status: string; attempt: number };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until(pred: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 25 && !pred(); i++) await sleep(25);
}

async function boot(room: string) {
  const prior = process.env.CUBILOT_LAUNCH_ACK_MS;
  process.env.CUBILOT_LAUNCH_ACK_MS = String(ACK_MS);
  const hub = await spawnHub();
  if (prior === undefined) delete process.env.CUBILOT_LAUNCH_ACK_MS; else process.env.CUBILOT_LAUNCH_ACK_MS = prior;
  cleanup.push(() => hub.kill());
  await giveProjectHttp(hub, room);
  const orch = await registerAgent(hub, "Orchestrator", { room });
  cleanup.push(() => orch.close());
  const reqs: Req[] = [];
  const sse = openLaunchStream(hub);
  cleanup.push(() => sse.close());
  void (async () => { try { for await (const e of sse.events) reqs.push(e as Req); } catch { /* closed */ } })();
  await sleep(100);
  const closes = (session: string) => reqs.filter((r) => r.kind === "close" && r.session === session);
  const launches = () => reqs.filter((r) => r.kind === "launch");
  const ack = async (id: string, body: Record<string, unknown>) => (await ackLaunch(hub, id, body)).status;
  return { hub, closes, launches, ack };
}

async function ticket(hub: HubHandle, role: string, title: string): Promise<string> {
  const t = await postJson(hub, "/tickets", { by: "Orchestrator", title, acceptance_criteria: "c", blast_radius: "low", role });
  expect(t.status).toBe(201);
  return (t.json as { snapshot: { id: string } }).snapshot.id;
}
const cancel = async (hub: HubHandle, id: string) => (await postJson(hub, `/tickets/${id}/transition`, { by: "Orchestrator", to: "cancelled" })).status;
const stageOf = async (hub: HubHandle, ticketId: string) => (((await getJson(hub, "/stages?status=all")).json as Stage[]).find((s) => s.ticket_id === ticketId))!;
const eventKinds = (hub: HubHandle, entityId: string) => {
  const db = new Database(hub.ledgerPath, { readonly: true });
  try { return db.query<{ kind: string }, [string]>("SELECT kind FROM events WHERE entity_id = ? ORDER BY seq").all(entityId).map((e) => e.kind); }
  finally { db.close(); }
};

for (const late of [{ result: "spawned" }, { result: "error", error: "failed after the session started" }]) {
  describe(`cancel, time-out, absent, late ${late.result}`, () => {
    test("second close queued; only its ack frees the name; the stage stays cancelled", async () => {
      const { hub, closes, launches, ack } = await boot(`late-${late.result}`);
      const t1 = await ticket(hub, "validator", "one");
      await until(() => launches().length >= 1);
      const l1 = launches()[0];
      expect(await cancel(hub, t1)).toBe(200);
      await until(() => closes("validator-1").length >= 1);
      const t2 = await ticket(hub, "validator", "two");
      await sleep(ACK_MS + 300); // the launch of t1 times out
      expect(await ack(closes("validator-1")[0].id, { result: "error", error: "no such session", absent: true })).toBe(200);
      await sleep(150);
      expect((await stageOf(hub, t2)).status).toBe("queued"); // absent before the late ack frees nothing
      expect(closes("validator-1")).toHaveLength(1);
      expect(await ack(l1.id, late)).toBe(200); // the late ack is accepted
      await until(() => closes("validator-1").length >= 2);
      expect(closes("validator-1")).toHaveLength(2);
      expect(await ack(l1.id, late)).toBe(200); // a repeat is idempotent and queues no third close
      await sleep(100);
      expect(closes("validator-1")).toHaveLength(2);
      expect((await stageOf(hub, t2)).status).toBe("queued");
      expect(await ack(closes("validator-1")[1].id, { result: "spawned" })).toBe(200);
      await until(() => launches().length >= 2);
      expect(launches()[1]).toMatchObject({ session: "validator-1" });
      expect(launches()).toHaveLength(2);
      const s1 = await stageOf(hub, t1);
      expect(s1).toMatchObject({ status: "cancelled", attempt: 1 });
      expect(eventKinds(hub, s1.id)).not.toContain("stage.retrying");
      expect(eventKinds(hub, s1.id)).not.toContain("stage.failed");
      expect(((await getJson(hub, "/handoffs?for=Orchestrator")).json as unknown[])).toHaveLength(0);
    });
  });
}

describe("not cancelled", () => {
  test("late ack of a timed-out attempt gets 409 and attempt two does not change", async () => {
    const { hub, launches, ack } = await boot("late-409");
    const t = await ticket(hub, "validator", "one");
    await until(() => launches().length >= 1);
    const first = launches()[0];
    await until(() => launches().length >= 2, ACK_MS * 8);
    const second = launches()[1];
    expect(second.stage_id).toBe(first.stage_id);
    const before = await stageOf(hub, t);
    expect(before.attempt).toBe(2);
    expect(await ack(first.id, { result: "spawned" })).toBe(409);
    expect(await ack(first.id, { result: "error", error: "late" })).toBe(409);
    expect(await stageOf(hub, t)).toEqual(before);
    expect(await ack(second.id, { result: "spawned" })).toBe(200);
    expect(await stageOf(hub, t)).toMatchObject({ status: "running", attempt: 2 });
  });
});
