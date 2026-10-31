// An edit that leaves a ticket queued and ready starts its stage (stage-start-on-edit). Real hub, fake shell.

import { describe, test, expect, afterEach } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: "launch" | "close"; stage_id?: string; session: string };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function boot(room: string) {
  const hub = await spawnHub();
  cleanup.push(() => hub.kill());
  await giveProjectHttp(hub, room);
  const orch = await registerAgent(hub, "Orchestrator", { room });
  cleanup.push(() => orch.close());
  const reqs: Req[] = [];
  const sse = openLaunchStream(hub);
  cleanup.push(() => sse.close());
  void (async () => { try { for await (const e of sse.events) reqs.push(e as Req); } catch { /* closed */ } })();
  await sleep(100);
  return { hub, launches: () => reqs.filter((r) => r.kind === "launch") };
}

async function mk(hub: HubHandle, extra: Record<string, unknown> = {}): Promise<string> {
  const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", ...extra });
  expect(t.status).toBe(201);
  return (t.json as { snapshot: { id: string } }).snapshot.id;
}
const edit = async (hub: HubHandle, id: string, body: Record<string, unknown>) => (await postJson(hub, `/tickets/${id}/edit`, { by: "Orchestrator", ...body })).status;
const stagesOf = async (hub: HubHandle, id: string) =>
  ((await getJson(hub, "/stages?status=all")).json as Array<{ ticket_id: string; status: string; role: string }>).filter((s) => s.ticket_id === id);
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 25 && !pred(); i++) await sleep(25);
}

describe("an edit that leaves a ticket ready starts its stage", () => {
  test("role edit on a queued ticket starts its stage", async () => {
    const { hub, launches } = await boot("se1");
    const id = await mk(hub);
    await sleep(150);
    expect(await stagesOf(hub, id)).toHaveLength(0);
    expect(await edit(hub, id, { role: "worker" })).toBe(200);
    await until(() => launches().length >= 1);
    expect(launches()).toHaveLength(1);
    expect(await stagesOf(hub, id)).toMatchObject([{ role: "worker" }]);
  });

  test("removal of the last blocker starts the stage", async () => {
    const { hub, launches } = await boot("se2");
    const blocker = await mk(hub);
    const id = await mk(hub, { role: "worker", blocked_by: [blocker] });
    await sleep(150);
    expect(launches()).toHaveLength(0);
    expect(await edit(hub, id, { blocked_by: [] })).toBe(200);
    await until(() => launches().length >= 1);
    expect(launches()).toHaveLength(1);
    expect((await stagesOf(hub, id)).length).toBe(1);
  });

  test("edit back to draft starts nothing", async () => {
    const { hub, launches } = await boot("se3");
    const blocker = await mk(hub);
    const id = await mk(hub, { role: "worker", blocked_by: [blocker] });
    expect((await postJson(hub, `/tickets/${id}/transition`, { by: hub.humanName, to: "draft" })).status).toBe(200);
    expect(await edit(hub, id, { blocked_by: [] })).toBe(200);
    await sleep(250);
    expect(launches()).toHaveLength(0);
    expect((await stagesOf(hub, id)).filter((s) => s.status !== "cancelled")).toHaveLength(0);
  });
});
