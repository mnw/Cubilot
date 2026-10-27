// G4: a ticket cancel cancels every open stage (stage-cancelled-status). Real hub, fake shell: the test reads /launches/stream
// and sends the acks itself.

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: "launch" | "close"; stage_id?: string; session: string; cwd?: string | null };
type Stage = { id: string; ticket_id: string | null; role: string; status: string; session: string | null; reason: string | null; attempt: number };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 25 && !pred(); i++) await sleep(25);
}

type Shell = { reqs: Req[]; closes: (session: string) => Req[]; launches: () => Req[]; ack: (id: string, body: Record<string, unknown>) => Promise<number>; stop: () => void };

function openShell(hub: HubHandle): Shell {
  const reqs: Req[] = [];
  const sse = openSSE(hub, "/launches/stream");
  void (async () => { try { for await (const e of sse.events) reqs.push(e as Req); } catch { /* closed */ } })();
  return {
    reqs,
    closes: (session) => reqs.filter((r) => r.kind === "close" && r.session === session),
    launches: () => reqs.filter((r) => r.kind === "launch"),
    ack: async (id, body) => (await postJson(hub, `/launches/${id}/ack`, body)).status,
    stop: () => sse.close(),
  };
}

async function boot(room: string, opts: { shell?: boolean; limits?: Record<string, number> } = {}) {
  const hub = await spawnHub();
  cleanup.push(() => hub.kill());
  await giveProjectHttp(hub, room);
  if (opts.limits) await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: opts.limits }) });
  const orch = await registerAgent(hub, "Orchestrator", { room });
  cleanup.push(() => orch.close());
  const shell = opts.shell === false ? null : openShell(hub);
  if (shell) cleanup.push(() => shell.stop());
  await sleep(100);
  return { hub, shell: shell as Shell };
}

async function ticket(hub: HubHandle, role: string, title = "T"): Promise<string> {
  const t = await postJson(hub, "/tickets", { by: "Orchestrator", title, acceptance_criteria: "c", blast_radius: "low", role });
  expect(t.status).toBe(201);
  return (t.json as { snapshot: { id: string } }).snapshot.id;
}
const cancel = async (hub: HubHandle, id: string) => (await postJson(hub, `/tickets/${id}/transition`, { by: "Orchestrator", to: "cancelled" })).status;
const stagesOf = async (hub: HubHandle): Promise<Stage[]> => (await getJson(hub, "/stages?status=all")).json as Stage[];
const stageOf = async (hub: HubHandle, ticketId: string) => (await stagesOf(hub)).find((s) => s.ticket_id === ticketId)!;

/**
 * Item 9 (d): no lead handoff, no retry, no FAIL count, no Needs-you line, no failure record, no diagnosis input.
 * `handoffs` and `retries` count what the case itself caused before the cancel (a passed stage's result, a launch error).
 * The hub has no diagnosis feature yet (planned: stage-diagnosis): its input is a failure record, so any failure or
 * diagnosis event or a stage.failed row is a diagnosis input.
 */
async function expectNoFailureTrail(hub: HubHandle, room: string, opts: { handoffs?: number; retries?: number } = {}) {
  const hand = (await getJson(hub, "/handoffs?for=Orchestrator")).json as unknown[];
  expect(hand).toHaveLength(opts.handoffs ?? 0);
  const needs = (await getJson(hub, `/requests/${room}/needs-you`)).json as { requests: unknown[] };
  expect(needs.requests).toHaveLength(0);
  const db = new Database(hub.ledgerPath, { readonly: true });
  try {
    const kinds = (db.query("SELECT kind FROM events WHERE kind IN ('stage.failed', 'stage.retrying')").all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(Array(opts.retries ?? 0).fill("stage.retrying"));
    expect((db.query("SELECT COUNT(*) AS n FROM stage WHERE verdict = 'FAIL' OR status IN ('failed', 'retrying')").get() as { n: number }).n).toBe(0);
    // no diagnosis input: no failure record, no diagnosis event
    expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind LIKE '%diagnos%' OR kind LIKE '%failure%'").get() as { n: number }).n).toBe(0);
  } finally {
    db.close();
  }
}

describe("a ticket cancel cancels its open stages", () => {
  test("(a) queued: cancelled with the reason, no close, no launch", async () => {
    const { hub, shell } = await boot("ca");
    const t1 = await ticket(hub, "validator", "one"); // takes the only validator slot
    const t2 = await ticket(hub, "validator", "two"); // queued: the limit is 1
    await until(() => shell.launches().length >= 1);
    expect((await stageOf(hub, t2)).status).toBe("queued");
    expect(await cancel(hub, t2)).toBe(200);
    await sleep(150);
    const s2 = await stageOf(hub, t2);
    expect(s2).toMatchObject({ status: "cancelled", reason: "ticket cancelled", session: null });
    expect(shell.reqs.filter((r) => r.kind === "close")).toHaveLength(0);
    expect(shell.launches()).toHaveLength(1); // only t1's launch
    expect((await stageOf(hub, t1)).status).toBe("launching");
    const one = (await getJson(hub, `/stages/${s2.id}`)).json as Stage;
    expect(one).toMatchObject({ status: "cancelled", reason: "ticket cancelled" });
    expect((((await getJson(hub, "/stages?status=cancelled")).json) as Stage[]).map((s) => s.id)).toEqual([s2.id]);
    // a stage that is not cancelled has no reason
    expect((await getJson(hub, `/stages/${(await stageOf(hub, t1)).id}`)).json).toMatchObject({ reason: null });
    await cancel(hub, t1);
    await sleep(150);
    // the slot of t1 is held by its close: nothing starts, and a second cancel changes nothing
    expect(await cancel(hub, t2)).toBe(200);
    await expectNoFailureTrail(hub, "ca");
  });

  test("(b) launching, delayed spawned: one close after the ack, no running move, name and slot stay reserved until that close ack", async () => {
    const { hub, shell } = await boot("cb", { limits: { validator: 2 } });
    const t1 = await ticket(hub, "validator", "one");
    await until(() => shell.launches().length >= 1);
    const l1 = shell.launches()[0];
    expect(l1.session).toBe("validator-1");
    expect(await cancel(hub, t1)).toBe(200);
    await until(() => shell.closes("validator-1").length >= 1);
    expect(shell.closes("validator-1")).toHaveLength(1); // close before the mark
    expect((await stageOf(hub, t1)).status).toBe("cancelled");
    const t2 = await ticket(hub, "validator", "two");
    const t3 = await ticket(hub, "validator", "three");
    await until(() => shell.launches().length >= 2);
    expect(shell.launches()[1].session).toBe("validator-2"); // validator-1 is reserved
    expect((await stageOf(hub, t3)).status).toBe("queued"); // the held slot counts against the limit
    const first = shell.closes("validator-1")[0];

    expect(await shell.ack(l1.id, { result: "spawned" })).toBe(200); // the late spawned ack
    await until(() => shell.closes("validator-1").length >= 2);
    expect(shell.closes("validator-1")).toHaveLength(2); // one more close
    expect((await stageOf(hub, t1)).status).toBe("cancelled"); // no running move
    expect((await stageOf(hub, t3)).status).toBe("queued");

    // the first close acks: its ack releases nothing, the later close is the one that counts
    expect(await shell.ack(first.id, { result: "spawned" })).toBe(200);
    await sleep(150);
    expect((await stageOf(hub, t3)).status).toBe("queued");
    expect(existsSync(l1.cwd ?? "")).toBe(true);
    expect(await shell.ack(shell.closes("validator-1")[1].id, { result: "spawned" })).toBe(200);
    await until(() => shell.launches().length >= 3);
    expect(shell.launches()[2]).toMatchObject({ session: "validator-1" });
    expect(existsSync(l1.cwd ?? "")).toBe(false); // (g) a validator worktree goes at the releasing ack
    expect((await stageOf(hub, t2)).status).toBe("launching");
    await expectNoFailureTrail(hub, "cb");
  });

  test("(b1) the first close acks absent before the delayed spawned: all stays reserved, the spawn gets a second close, only its ack releases", async () => {
    const { hub, shell } = await boot("cb1");
    const t1 = await ticket(hub, "validator", "one");
    await until(() => shell.launches().length >= 1);
    const l1 = shell.launches()[0];
    expect(await cancel(hub, t1)).toBe(200);
    await until(() => shell.closes("validator-1").length >= 1);
    const t2 = await ticket(hub, "validator", "two");
    await sleep(100);
    expect(await shell.ack(shell.closes("validator-1")[0].id, { result: "error", error: "no such session", absent: true })).toBe(200);
    await sleep(150);
    expect((await stageOf(hub, t2)).status).toBe("queued"); // nothing is released: the launch is still in flight
    expect(shell.launches()).toHaveLength(1);
    expect(await shell.ack(l1.id, { result: "spawned" })).toBe(200);
    await until(() => shell.closes("validator-1").length >= 2);
    expect(shell.closes("validator-1")).toHaveLength(2);
    expect((await stageOf(hub, t2)).status).toBe("queued");
    expect(await shell.ack(shell.closes("validator-1")[1].id, { result: "spawned" })).toBe(200);
    await until(() => shell.launches().length >= 2);
    expect(shell.launches()[1]).toMatchObject({ session: "validator-1" });
    expect((await stageOf(hub, t1)).status).toBe("cancelled");
    await expectNoFailureTrail(hub, "cb1");
  });

  test("(b2) a launch error after the session exists: one more close, release at its ack, no retry", async () => {
    const { hub, shell } = await boot("cb2");
    const t1 = await ticket(hub, "validator", "one");
    await until(() => shell.launches().length >= 1);
    const l1 = shell.launches()[0];
    expect(await cancel(hub, t1)).toBe(200);
    await until(() => shell.closes("validator-1").length >= 1);
    const t2 = await ticket(hub, "validator", "two");
    expect(await shell.ack(l1.id, { result: "error", error: "tmux failed after the session started" })).toBe(200);
    await until(() => shell.closes("validator-1").length >= 2);
    expect(shell.closes("validator-1")).toHaveLength(2);
    expect(shell.launches()).toHaveLength(1); // no relaunch of t1
    expect((await stageOf(hub, t2)).status).toBe("queued");
    expect(await shell.ack(shell.closes("validator-1")[0].id, { result: "spawned" })).toBe(200);
    await sleep(100);
    expect((await stageOf(hub, t2)).status).toBe("queued"); // the first close does not release
    expect(await shell.ack(shell.closes("validator-1")[1].id, { result: "spawned" })).toBe(200);
    await until(() => shell.launches().length >= 2);
    expect(shell.launches()[1]).toMatchObject({ session: "validator-1" });
    await expectNoFailureTrail(hub, "cb2");
  });

  test("(b2, ruling 1479) close 1 acks absent, then the launch errors after the session exists: a second close, all reserved until its ack", async () => {
    const { hub, shell } = await boot("cb2r");
    const t1 = await ticket(hub, "validator", "one");
    await until(() => shell.launches().length >= 1);
    const l1 = shell.launches()[0];
    expect(await cancel(hub, t1)).toBe(200); // 1. cancel while launching
    await until(() => shell.closes("validator-1").length >= 1);
    const t2 = await ticket(hub, "validator", "two");
    const first = shell.closes("validator-1")[0];
    expect(await shell.ack(first.id, { result: "error", error: "no such session", absent: true })).toBe(200); // 2. close 1 acks absent
    await sleep(100);
    expect((await stageOf(hub, t2)).status).toBe("queued"); // launch still in flight: nothing released
    expect(await shell.ack(l1.id, { result: "error", error: "failed after the session started" })).toBe(200); // 3. launch errors
    await until(() => shell.closes("validator-1").length >= 2); // 4. second close
    expect(shell.closes("validator-1")).toHaveLength(2);
    expect(shell.launches()).toHaveLength(1); // no retry
    await sleep(100);
    expect((await stageOf(hub, t2)).status).toBe("queued"); // 5. all reserved until its ack
    expect(existsSync(l1.cwd ?? "")).toBe(true);
    expect(await shell.ack(shell.closes("validator-1")[1].id, { result: "spawned" })).toBe(200); // 6. release
    await until(() => shell.launches().length >= 2);
    expect(shell.launches()[1]).toMatchObject({ session: "validator-1" });
    expect(existsSync(l1.cwd ?? "")).toBe(false);
    await expectNoFailureTrail(hub, "cb2r");
  });

  test("(b3) an undelivered launch is dropped and everything is released at once", async () => {
    const { hub } = await boot("cb3", { shell: false });
    const t1 = await ticket(hub, "validator", "one");
    await sleep(200);
    expect((await stageOf(hub, t1)).status).toBe("launching");
    expect(await cancel(hub, t1)).toBe(200);
    await sleep(100);
    expect((await stageOf(hub, t1)).status).toBe("cancelled");
    const t2 = await ticket(hub, "validator", "two");
    const shell = openShell(hub);
    cleanup.push(() => shell.stop());
    await until(() => shell.launches().length >= 1);
    expect(shell.reqs).toHaveLength(1); // t1's launch was dropped and no close was queued
    expect(shell.reqs[0]).toMatchObject({ kind: "launch", session: "validator-1" });
    expect((await stageOf(hub, t2)).status).toBe("launching");
    await expectNoFailureTrail(hub, "cb3");
  });

  test("(c) running: the close is queued before the mark; (e) a passed stage stays passed", async () => {
    const { hub, shell } = await boot("cc");
    const t1 = await ticket(hub, "tester", "one");
    const t2 = await ticket(hub, "tester", "two");
    await until(() => shell.launches().length >= 2);
    for (const l of shell.launches()) expect(await shell.ack(l.id, { result: "spawned" })).toBe(200);
    await sleep(100);
    expect((await stageOf(hub, t1)).status).toBe("running");
    // t2's tester passes its stage with a result
    const agent2 = shell.launches()[1];
    const reg = await registerAgent(hub, agent2.session, { room: "cc" });
    cleanup.push(() => reg.close());
    const s2 = await stageOf(hub, t2);
    expect((await postJson(hub, "/handoffs", { from: agent2.session, to: "Orchestrator", task: "result", context: { stage_id: s2.id, ticket_id: t2 } })).status).toBe(201);
    expect((await stageOf(hub, t2)).status).toBe("passed");

    expect(await cancel(hub, t1)).toBe(200);
    expect(await cancel(hub, t2)).toBe(200);
    await sleep(150);
    const s1 = await stageOf(hub, t1);
    expect(s1).toMatchObject({ status: "cancelled", reason: "ticket cancelled" });
    expect(shell.closes(shell.launches()[0].session)).toHaveLength(1);
    expect((await stageOf(hub, t2)).status).toBe("passed");
    expect((await stageOf(hub, t2)).reason).toBeNull();
    // the close ack releases the slot: acked once, idempotent
    expect(await shell.ack(shell.closes(shell.launches()[0].session)[0].id, { result: "spawned" })).toBe(200);
    await expectNoFailureTrail(hub, "cc", { handoffs: 1 }); // the one handoff is t2's passed result
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'stage.cancelled'").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("(c) retrying: its own close is the one close; the ticket cancel cancels it and the old session's close releases it", async () => {
    const { hub, shell } = await boot("cr");
    const t1 = await ticket(hub, "tester", "one");
    await until(() => shell.launches().length >= 1);
    // a launch error on attempt 1 ends the attempt: retrying, relaunched at once as attempt 2
    expect(await shell.ack(shell.launches()[0].id, { result: "error", error: "boom" })).toBe(200);
    await until(() => shell.launches().length >= 2);
    expect(await shell.ack(shell.launches()[1].id, { result: "spawned" })).toBe(200);
    expect(await cancel(hub, t1)).toBe(200);
    await sleep(150);
    const s = await stageOf(hub, t1);
    expect(s).toMatchObject({ status: "cancelled", attempt: 2 });
    expect(shell.closes(s.session!)).toHaveLength(1);
    // no final failure: attempt 1 ended as retrying (one event), nothing was reported
    await expectNoFailureTrail(hub, "cr", { retries: 1 });
  });

  test("(c2) two roles on two tickets: both are cancelled", async () => {
    const { hub, shell } = await boot("cc2");
    const w = await ticket(hub, "worker", "w");
    const v = await ticket(hub, "validator", "v");
    await until(() => shell.launches().length >= 2);
    for (const l of shell.launches()) await shell.ack(l.id, { result: "spawned" });
    await cancel(hub, w);
    await cancel(hub, v);
    await sleep(150);
    expect((await stageOf(hub, w)).status).toBe("cancelled");
    expect((await stageOf(hub, v)).status).toBe("cancelled");
    expect(shell.reqs.filter((r) => r.kind === "close")).toHaveLength(2);
    await expectNoFailureTrail(hub, "cc2");
  });

  test("(i) a result for a cancelled stage is refused and the stage stays cancelled", async () => {
    const { hub, shell } = await boot("ci");
    const t = await ticket(hub, "tester", "one");
    await until(() => shell.launches().length >= 1);
    const l = shell.launches()[0];
    expect(await shell.ack(l.id, { result: "spawned" })).toBe(200);
    const reg = await registerAgent(hub, l.session, { room: "ci" });
    cleanup.push(() => reg.close());
    expect(await cancel(hub, t)).toBe(200);
    await sleep(150);
    const s = await stageOf(hub, t);
    expect(s.status).toBe("cancelled");
    const r = await postJson(hub, "/handoffs", { from: l.session, to: "Orchestrator", task: "result", context: { stage_id: s.id, ticket_id: t } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await stageOf(hub, t)).toMatchObject({ status: "cancelled", reason: "ticket cancelled" });
    await expectNoFailureTrail(hub, "ci");
  });

  test("(g) the worker worktree (ticket branch) stays at the releasing ack; the validator worktree goes", async () => {
    const { hub, shell } = await boot("cg");
    const w = await ticket(hub, "worker", "w");
    const v = await ticket(hub, "validator", "v");
    await until(() => shell.launches().length >= 2);
    const [lw, lv] = [shell.launches().find((l) => l.session.startsWith("worker"))!, shell.launches().find((l) => l.session.startsWith("validator"))!];
    for (const l of shell.launches()) await shell.ack(l.id, { result: "spawned" });
    await cancel(hub, w);
    await cancel(hub, v);
    await until(() => shell.reqs.filter((r) => r.kind === "close").length >= 2);
    for (const c of shell.reqs.filter((r) => r.kind === "close")) expect(await shell.ack(c.id, { result: "spawned" })).toBe(200);
    await sleep(200);
    expect(existsSync(lw.cwd!)).toBe(true);
    expect(existsSync(lv.cwd!)).toBe(false);
  });
});

describe("hub start", () => {
  test("(f) each open stage of a cancelled ticket is cancelled, each live one gets one close, nothing is retried", async () => {
    const hub = await spawnHub();
    cleanup.push(() => hub.kill());
    await giveProjectHttp(hub, "cf");
    await authedFetch(hub, "/rooms/cf/settings", { method: "PUT", body: JSON.stringify({ role_limits: { tester: 1, worker: 3, validator: 3 } }) });
    const orch = await registerAgent(hub, "Orchestrator", { room: "cf" });
    const shell = openShell(hub);
    await sleep(100);
    // worker: running; validator: launching (no ack); tester queued behind a tester that is the retrying one
    const running = await ticket(hub, "worker", "running");
    const launching = await ticket(hub, "validator", "launching");
    const retry = await ticket(hub, "tester", "retrying");
    const queued = await ticket(hub, "tester", "queued");
    await until(() => shell.launches().length >= 3);
    const lw = shell.launches().find((l) => l.session.startsWith("worker"))!;
    const lt = shell.launches().find((l) => l.session.startsWith("tester"))!;
    await shell.ack(lw.id, { result: "spawned" });
    // the tester's stage: spawned, then its session leaves: two ends of turn is a stop; simpler, a restart settles it. Use a launch error.
    await shell.ack(lt.id, { result: "error", error: "boom" });
    await sleep(300);
    shell.stop();
    orch.close();
    const before = await stagesOf(hub);
    expect(before.find((s) => s.ticket_id === running)!.status).toBe("running");
    expect(before.find((s) => s.ticket_id === launching)!.status).toBe("launching");
    // after the relaunch of attempt 2 the tester is launching again, so seed retrying and queued by hand below
    await hub.kill();

    const db = new Database(hub.ledgerPath);
    db.run("UPDATE stage SET status = 'retrying' WHERE ticket_id = ?", [retry]);
    db.run("UPDATE stage SET status = 'queued', session = NULL WHERE ticket_id = ?", [queued]);
    db.run("UPDATE tickets SET status = 'cancelled' WHERE id IN (?, ?, ?, ?)", [running, launching, retry, queued]);
    db.close();

    const second = await bootOn(hub.ledgerPath, hub.token);
    cleanup.push(second.kill);
    const shell2 = openShell(second.hub);
    cleanup.push(() => shell2.stop());
    await sleep(500);
    const after = (await getJson(second.hub, "/stages?status=all")).json as Stage[];
    for (const s of after) expect(s).toMatchObject({ status: "cancelled", reason: "ticket cancelled" });
    expect(after.length).toBeGreaterThanOrEqual(3);
    // one close per live stage (running, launching, retrying with a session): no launch at all
    expect(shell2.launches()).toHaveLength(0);
    const liveWithSession = after.filter((s) => s.session);
    expect(shell2.reqs.filter((r) => r.kind === "close").map((r) => r.session).sort()).toEqual(liveWithSession.map((s) => s.session!).sort());
    // the one stage.retrying event is the tester's launch error before the seed
    await expectNoFailureTrail(second.hub, "cf", { retries: 1 });
  });
});

/** Boots the hub again on an existing ledger (the helper always makes a new one). */
async function bootOn(ledgerPath: string, token: string): Promise<{ hub: HubHandle; kill: () => Promise<void> }> {
  const base = mkdtempSync(join(tmpdir(), "cubilot-restart-"));
  mkdirSync(join(base, "att"), { recursive: true });
  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env, PORT: "0", CUBILOT_TOKEN: token, CUBILOT_LEDGER_DB: ledgerPath,
      CUBILOT_ATTACHMENTS_DIR: join(base, "att"), CUBILOT_TRANSCRIPTS_DIR: join(base, "tr"), CUBILOT_DATA_DIR: join(base, "data"),
      CUBILOT_HUMAN_NAME: "human", CUBILOT_DEFAULT_ROOM: "default",
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
  const hub = { url, token, ledgerPath, attachmentsDir: join(base, "att"), transcriptsDir: join(base, "tr"), humanName: "human", kill: async () => { proc.kill(); await proc.exited; } } as HubHandle;
  return { hub, kill: hub.kill };
}
