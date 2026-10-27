// G10: a ticket that moves to draft or done cancels its queued stages (stage-draft-done-cancel). Real hub, fake shell.

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


const ST = "ticket moved to";
const human = (hub: HubHandle) => hub.humanName;
const move = async (hub: HubHandle, id: string, to: string, by = "Orchestrator") => (await postJson(hub, `/tickets/${id}/transition`, { by, to })).status;
const editCriteria = async (hub: HubHandle, id: string) => (await postJson(hub, `/tickets/${id}/edit`, { by: "Orchestrator", acceptance_criteria: `new ${Math.random()}` })).status;
const ticketStatus = async (hub: HubHandle, id: string) => ((await getJson(hub, `/tickets/${id}`)).json as { snapshot?: { status: string }; status?: string });
const rows = (hub: HubHandle, id: string) => {
  const db = new Database(hub.ledgerPath, { readonly: true });
  try { return db.query("SELECT * FROM stage WHERE ticket_id = ? ORDER BY created_seq, rowid").all(id) as Array<Stage & { created_seq: number; updated_seq: number; version: number }>; } finally { db.close(); }
};
const api = async (hub: HubHandle, id: string) => (await getJson(hub, `/stages/${id}`)).json as Stage;
const tstatus = (hub: HubHandle, id: string) => {
  const db = new Database(hub.ledgerPath, { readonly: true });
  try { return (db.query("SELECT status FROM tickets WHERE id = ?").get(id) as { status: string }).status; } finally { db.close(); }
};
const setTicket = (hub: HubHandle, id: string, status: string) => {
  const db = new Database(hub.ledgerPath);
  try { db.run("UPDATE tickets SET status = ? WHERE id = ?", [status, id]); } finally { db.close(); }
};

/** Two validator tickets with the only validator slot held by the first: the second one has a queued stage. */
async function held(room: string, shell = true) {
  const b = await boot(room, { shell });
  const t1 = await ticket(b.hub, "validator", "holder");
  const t2 = await ticket(b.hub, "validator", "held");
  if (b.shell) await until(() => b.shell.launches().length >= 1);
  expect((await stageOf(b.hub, t2)).status).toBe("queued");
  return { ...b, t1, t2 };
}

describe("a move to draft or done cancels the queued stages", () => {
  test("(a) criteria edit: ticket draft, stage cancelled with the draft reason, no launch, no failure trail; (e) draft -> queued gives one new queued stage", async () => {
    const { hub, shell, t2 } = await held("da");
    const old = await stageOf(hub, t2);
    expect(await editCriteria(hub, t2)).toBe(200);
    await sleep(150);
    expect(tstatus(hub, t2)).toBe("draft");
    expect(await stageOf(hub, t2)).toMatchObject({ id: old.id, status: "cancelled", reason: `${ST} draft` });
    expect(shell.launches()).toHaveLength(1);
    expect(shell.reqs.filter((r) => r.kind === "close")).toHaveLength(0);
    await expectNoFailureTrail(hub, "da");
    // (e)
    expect(await move(hub, t2, "queued", human(hub))).toBe(200);
    await sleep(150);
    const all = rows(hub, t2);
    expect(all.map((s) => [s.role, s.status])).toEqual([["validator", "cancelled"], ["validator", "queued"]]);
    expect(all[0].id).toBe(old.id);
    expect(shell.launches()).toHaveLength(1);
  });

  test("(b) transition queued -> draft: stage cancelled with the draft reason, no launch", async () => {
    const { hub, shell, t2 } = await held("db");
    expect(await move(hub, t2, "draft", human(hub))).toBe(200);
    await sleep(150);
    expect(await stageOf(hub, t2)).toMatchObject({ status: "cancelled", reason: `${ST} draft` });
    expect(shell.launches()).toHaveLength(1);
  });

  test("(c) transition to done: stage cancelled with the done reason, no launch; (j) a later evaluation adds no stage", async () => {
    const { hub, shell, t2 } = await held("dc");
    expect(await move(hub, t2, "done", human(hub))).toBe(200);
    await sleep(150);
    expect(await stageOf(hub, t2)).toMatchObject({ status: "cancelled", reason: `${ST} done` });
    expect(shell.launches()).toHaveLength(1);
    await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", task: "again", context: { ticket_id: t2 } });
    await sleep(200);
    expect(rows(hub, t2)).toHaveLength(1);
    expect(shell.launches()).toHaveLength(1);
  });

  test("(j) a cancelled stage of a cancelled ticket: no new stage after an evaluation", async () => {
    const { hub, shell, t2 } = await held("dj");
    expect(await move(hub, t2, "cancelled")).toBe(200);
    await sleep(150);
    expect(await stageOf(hub, t2)).toMatchObject({ status: "cancelled", reason: "ticket cancelled" });
    await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", task: "again", context: { ticket_id: t2 } });
    await sleep(200);
    expect(rows(hub, t2)).toHaveLength(1);
    expect(shell.launches()).toHaveLength(1);
  });

  test("(d) pickup guard: a seeded queued stage of a draft, done or cancelled ticket is not launched when the slot frees, the row stays", async () => {
    const b = await boot("dd");
    const { hub, shell } = b;
    const holder = await ticket(hub, "validator", "holder");
    const ids = [await ticket(hub, "validator", "a"), await ticket(hub, "validator", "b"), await ticket(hub, "validator", "c")];
    await until(() => shell.launches().length >= 1);
    const before = ids.map((id) => rows(hub, id));
    ["draft", "done", "cancelled"].forEach((s, i) => setTicket(hub, ids[i], s));
    // free the slot: cancel the holder, ack its close
    const l = shell.launches()[0];
    expect(await shell.ack(l.id, { result: "spawned" })).toBe(200);
    expect(await move(hub, holder, "cancelled")).toBe(200);
    await until(() => shell.closes(l.session).length >= 1);
    expect(await shell.ack(shell.closes(l.session)[0].id, { result: "spawned" })).toBe(200);
    await sleep(300);
    expect(shell.launches()).toHaveLength(1);
    ids.forEach((id, i) => expect(rows(hub, id)).toEqual(before[i]));
  });

  test("(f) a running stage of a ticket moved to draft or done does not change", async () => {
    const { hub, shell } = await boot("df", { limits: { validator: 3 } });
    const a = await ticket(hub, "validator", "a");
    const c = await ticket(hub, "validator", "c");
    await until(() => shell.launches().length >= 2);
    for (const l of shell.launches()) expect(await shell.ack(l.id, { result: "spawned" })).toBe(200);
    await sleep(100);
    const before = [rows(hub, a), rows(hub, c)];
    expect(before.map((r) => r[0].status)).toEqual(["running", "running"]);
    expect(await move(hub, a, "draft", human(hub))).toBe(200);
    expect(await move(hub, c, "done", human(hub))).toBe(200);
    await sleep(200);
    expect([rows(hub, a), rows(hub, c)]).toEqual(before);
    expect(shell.reqs.filter((r) => r.kind === "close")).toHaveLength(0);
  });

  test("(i) a Validator PASS moves a low ticket to done and cancels its queued stage of another role, after stage.passed commits", async () => {
    const { hub, shell } = await boot("di", { limits: { validator: 3, tester: 3 } });
    const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "r", acceptance_criteria: "c", blast_radius: "low", role: null, status: "in_review" });
    const id = (t.json as { snapshot: { id: string } }).snapshot.id;
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", task: "validate", context: { ticket_id: id } })).status).toBe(201);
    await until(() => shell.launches().length >= 1);
    const l = shell.launches()[0];
    expect(await shell.ack(l.id, { result: "spawned" })).toBe(200);
    const reg = await registerAgent(hub, l.session, { room: "di" });
    cleanup.push(() => reg.close());
    const v = rows(hub, id)[0];
    const seed = new Database(hub.ledgerPath);
    try {
      const seq = (seed.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
      seed.run("INSERT INTO stage (id, ticket_id, role, attempt, status, created_seq, updated_seq, version) VALUES ('s_00000000000000aa', ?, 'tester', 1, 'queued', ?, ?, ?)", [id, seq, seq, seq]);
    } finally { seed.close(); }
    const r = await postJson(hub, "/handoffs", { from: l.session, to: "Orchestrator", task: "result", context: { stage_id: v.id, ticket_id: id, verdict: "PASS", findings: [], suggestions: [] } });
    expect(r.status).toBe(201);
    await sleep(300);
    const all = rows(hub, id);
    expect(all.find((s) => s.id === v.id)!.status).toBe("passed");
    expect(await api(hub, "s_00000000000000aa")).toMatchObject({ status: "cancelled", reason: `${ST} done` });
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      const ev = db.query("SELECT seq, kind FROM events WHERE kind IN ('stage.passed', 'ticket.done', 'stage.cancelled') ORDER BY seq").all() as Array<{ seq: number; kind: string }>;
      expect(ev.map((e) => e.kind)).toEqual(["stage.passed", "ticket.done", "stage.cancelled"].sort((a, b) => ev.findIndex((e) => e.kind === a) - ev.findIndex((e) => e.kind === b)));
      expect(ev[ev.length - 1].kind).toBe("stage.cancelled");
      expect((db.query("SELECT status FROM tickets WHERE id = ?").get(id) as { status: string }).status).toBe("done");
    } finally { db.close(); }
    expect(shell.launches()).toHaveLength(1);
  });
});

describe("hub start", () => {
  test("(h) queued stages of a draft and a done ticket are cancelled at start, no launch", async () => {
    const b = await held("dh");
    const t3 = await ticket(b.hub, "validator", "third");
    b.shell.stop();
    await b.hub.kill();
    expect(rows(b.hub, t3)[0].status).toBe("queued");
    setTicket(b.hub, b.t2, "draft");
    setTicket(b.hub, t3, "done");
    const second = await bootOn(b.hub.ledgerPath, b.hub.token);
    cleanup.push(second.kill);
    const shell2 = openShell(second.hub);
    cleanup.push(() => shell2.stop());
    await sleep(500);
    expect(await api(second.hub, rows(second.hub, b.t2)[0].id)).toMatchObject({ status: "cancelled", reason: `${ST} draft` });
    expect(await api(second.hub, rows(second.hub, t3)[0].id)).toMatchObject({ status: "cancelled", reason: `${ST} done` });
    expect(shell2.launches().filter((l) => [rows(second.hub, b.t2)[0].id, rows(second.hub, t3)[0].id].includes(l.stage_id!))).toHaveLength(0);
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
