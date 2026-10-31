// G9 through the real hub (HTTP only): one live stage per ticket of any role. A handoff that arrives during a live stage
// waits, and a role handoff recorded during a live stage of its own role is spent by that stage.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "ols";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Stage = { id: string; ticket_id: string | null; role: string; status: string; review: string | null; attempt: number; session: string | null };

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Boots the hub again on an existing ledger (the helper always makes a new one). */
async function bootOn(ledgerPath: string, token: string): Promise<HubHandle> {
  const base = mkdtempSync(join(tmpdir(), "cubilot-ols-restart-"));
  mkdirSync(join(base, "att"), { recursive: true });
  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env, PORT: "0", CUBILOT_TOKEN: token, CUBILOT_LEDGER_DB: ledgerPath,
      CUBILOT_ATTACHMENTS_DIR: join(base, "att"), CUBILOT_HUMAN_NAME: "human", CUBILOT_DEFAULT_ROOM: "default",
      CUBILOT_DATA_DIR: join(base, "data"),
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write("hum-restart-token-0123456789\n");
  proc.stdin.end();
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
  return { url, token, humanToken: "hum-restart-token-0123456789", pid: proc.pid, ledgerPath, attachmentsDir: join(base, "att"), humanName: "human", kill: async () => { proc.kill(); await proc.exited; } } as HubHandle;
}

describe("one live stage per ticket", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;
  const extraHubs: HubHandle[] = [];

  const watch = (h: HubHandle, into: any[]) => {
    const s = openSSE(h, "/launches/stream");
    void (async () => { try { for await (const e of s.events) into.push(e); } catch { /* closed */ } })();
    return s;
  };

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    open.push(await registerAgent(hub, "Orchestrator", { room: ROOM }));
    open.push(await registerAgent(hub, "ols-alice", { room: ROOM }));
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10, validator: 10, writer: 10 } }) });
    expect(put.status).toBe(200);
    stream = watch(hub, launches);
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    for (const h of extraHubs) await h.kill();
    await hub.kill();
  });

  const mk = async (extra: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/tickets", { by: "ols-alice", title: "t", acceptance_criteria: "c", blast_radius: "low", role: null, ...extra });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  /** The stages of a ticket in creation order (read-only ledger query; the route has no stable order). */
  const stagesOf = async (ticket: string, h: HubHandle = hub) => {
    const db = new Database(h.ledgerPath, { readonly: true });
    try {
      return db.query("SELECT id, ticket_id, role, status, review, attempt, session FROM stage WHERE ticket_id = ? ORDER BY created_seq").all(ticket) as Stage[];
    } finally { db.close(); }
  };
  const roles = async (ticket: string) => (await stagesOf(ticket)).map((s) => s.role);
  const roleHandoff = (ticket: string, role: string, extra: Record<string, unknown> = {}, h: HubHandle = hub) =>
    postJson(h, "/handoffs", { from: "ols-alice", to_role: role, task: "do it", context: { ticket_id: ticket }, ...extra });
  const touch = async (ticket: string, h: HubHandle = hub) => expect((await postJson(h, `/tickets/${ticket}/edit`, { by: h === hub ? "ols-alice" : h.humanName, title: `t${Math.random()}` })).status).toBe(200);
  /** Waits until the check holds; fails the test when it does not hold in time. */
  const until = async <T>(what: string, f: () => Promise<T | false | undefined> | T | false | undefined, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
      await sleep(10);
    }
  };
  /** A hub round trip: the hub has handled every request sent before it (the hooks run inside the request). */
  const settle = (h: HubHandle = hub) => getJson(h, "/stages?status=all");

  /** Acks the launch of a stage as spawned and connects its session: the stage is running. */
  const run = async (stageId: string, h: HubHandle = hub, reqs: any[] = launches) => {
    const req = await until(`launch of ${stageId}`, () => reqs.find((r) => r.stage_id === stageId));
    expect(req).toBeDefined();
    expect((await postJson(h, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(h, req.session, { room: ROOM }));
    return req.session as string;
  };
  /** Ends a tester or writer stage with a result to a named agent (not to_role). */
  const finish = async (stage: Stage, session: string, h: HubHandle = hub, to = "ols-alice") => {
    const r = await postJson(h, "/handoffs", { from: session, to, task: "result", context: { notes: "n", stage_id: stage.id, ticket_id: stage.ticket_id, commit: "0123456789abcdef0123456789abcdef01234567" } });
    expect(r.status).toBe(201);
  };
  const finishReview = async (stage: Stage, session: string, verdict: "PASS" | "FAIL") => {
    const r = await postJson(hub, "/handoffs", {
      from: session, to: "ols-alice", task: "result",
      context: { notes: "n", stage_id: stage.id, ticket_id: stage.ticket_id, verdict, findings: [], suggestions: [] },
    });
    expect(r.status).toBe(201);
  };
  const newCommit = (ticketId: string) => {
    const ref = `refs/heads/ticket/${ticketId}`;
    const tip = Bun.spawnSync(["git", "-C", projectRepo(), "rev-parse", "--verify", "--quiet", ref]).exitCode === 0 ? git("rev-parse", ref) : git("rev-parse", "staging");
    const sha = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "work");
    git("update-ref", ref, sha);
    return sha;
  };

  test("(a) a worker handoff during a running tester stage starts nothing; when the tester stage ends, exactly one worker stage starts", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    const [tester] = await stagesOf(t);
    const session = await run(tester.id);
    const n = launches.length;
    expect((await roleHandoff(t, "worker")).status).toBe(201);
    await touch(t);
    await settle();
    expect(await roles(t)).toEqual(["tester"]);
    expect(launches).toHaveLength(n);
    await finish(tester, session);
    await settle();
    const after = await stagesOf(t);
    expect(after.map((s) => [s.role, s.status])).toEqual([["tester", "passed"], ["worker", "launching"]]);
    expect(launches).toHaveLength(n + 1);
    await touch(t); // no other handoff or ticket event adds a stage
    await settle();
    expect(await roles(t)).toEqual(["tester", "worker"]);
  });

  for (const end of ["passed", "failed"] as const) {
    test(`(${end === "passed" ? "b" : "c"}) G9 order with a ${end} worker stage: one tester stage, no worker stage, also after later events`, async () => {
      const t = await mk({ role: "worker" });
      await settle();
      const [worker] = await stagesOf(t);
      expect(worker).toMatchObject({ role: "worker", status: "launching" });
      let session = "";
      if (end === "passed") session = await run(worker.id);
      expect((await roleHandoff(t, "worker")).status).toBe(201); // recorded while the worker stage is live: spent by it
      if (end === "passed") {
        // the worker result is the tester handoff
        const r = await postJson(hub, "/handoffs", { from: session, to_role: "tester", task: "result", context: { notes: "n", stage_id: worker.id, ticket_id: t, commit: newCommit(t) } });
        expect(r.status).toBe(201);
      } else {
        expect((await roleHandoff(t, "tester")).status).toBe(201); // recorded while the worker stage is live
        // two launch errors fail the stage
        for (let i = 1; i <= 2; i++) {
          const req = await until(`launch ${i} of ${worker.id}`, () => launches.filter((r) => r.stage_id === worker.id)[i - 1]);
          expect(req).toBeDefined();
          await postJson(hub, `/launches/${req.id}/ack`, { result: "error", error: "tmux failed" });
        }
      }
      await settle();
      expect((await stagesOf(t)).map((s) => [s.role, s.status === "failed" || s.status === "passed" ? "ended" : "live"])).toEqual([["worker", "ended"], ["tester", "live"]]);
      await touch(t);
      await settle();
      expect(await roles(t)).toEqual(["worker", "tester"]);
      // the tester stage ends and another ticket event comes: still no worker stage
      const tester = (await stagesOf(t))[1];
      await finish(tester, await run(tester.id));
      await touch(t);
      await settle();
      expect(await roles(t)).toEqual(["worker", "tester"]);
    });
  }

  test("(e) two waiting handoffs of two roles start in creation order, one stage at a time", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    const [tester] = await stagesOf(t);
    const sTester = await run(tester.id);
    expect((await roleHandoff(t, "validator")).status).toBe(201);
    expect((await roleHandoff(t, "writer")).status).toBe(201);
    await settle();
    expect(await roles(t)).toEqual(["tester"]);
    await finish(tester, sTester);
    await settle();
    expect((await stagesOf(t)).map((s) => [s.role, s.status])).toEqual([["tester", "passed"], ["validator", "launching"]]);
    const validator = (await stagesOf(t))[1];
    await finishReview(validator, await run(validator.id), "FAIL");
    await settle();
    expect((await stagesOf(t)).map((s) => [s.role, s.status])).toEqual([["tester", "passed"], ["validator", "passed"], ["writer", "launching"]]);
  });

  test("(f) two same-role handoffs during one live same-role stage are both spent by it", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    const [tester] = await stagesOf(t);
    const session = await run(tester.id);
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    expect(await roles(t)).toEqual(["tester"]);
    await finish(tester, session);
    await touch(t);
    await settle();
    expect((await stagesOf(t)).map((s) => [s.role, s.status])).toEqual([["tester", "passed"]]);
  });

  test("(g) a spec review runs while a ticket stage is live", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    const [tester] = await stagesOf(t);
    await run(tester.id);
    const draft = await mk({ status: "draft", request_id: "req-ols" });
    expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-ols", task: "review", context: { request_text: "X" } })).status).toBe(201);
    await settle();
    const all = (await getJson(hub, "/stages?status=all")).json as Stage[];
    const spec = all.find((s) => s.review === "spec" && s.request_id === "req-ols") as any;
    expect(spec).toBeDefined();
    expect(spec.status).toBe("launching");
    expect((await stagesOf(t)).map((s) => [s.role, s.status])).toEqual([["tester", "running"]]);
    expect(await stagesOf(draft)).toEqual([]);
  });

  test("(h) fix loop: a validator FAIL, then a new worker handoff, starts one worker stage", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "validator")).status).toBe(201);
    await settle();
    const [validator] = await stagesOf(t);
    await finishReview(validator, await run(validator.id), "FAIL");
    await settle();
    expect(await roles(t)).toEqual(["validator"]);
    expect((await roleHandoff(t, "worker")).status).toBe(201);
    await settle();
    expect((await stagesOf(t)).map((s) => [s.role, s.status])).toEqual([["validator", "passed"], ["worker", "launching"]]);
    await touch(t);
    await settle();
    expect(await roles(t)).toEqual(["validator", "worker"]);
  });

  test("a ticket stage that fails for no project folder lets the waiting handoff of its ticket start a stage", async () => {
    const R2 = "ols2";
    // its own hub: the session names tester-1 etc. would clash with the other tests
    const h2 = await spawnHub();
    extraHubs.push(h2);
    const l2: any[] = [];
    const w2 = watch(h2, l2);
    await sleep(200);
    await giveProjectHttp(h2, R2);
    open.push(await registerAgent(h2, "ols2-bob", { room: R2 }));
    const put = (body: Record<string, unknown>) => authedFetch(h2, `/rooms/${R2}/settings`, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ role_limits: { worker: 10, tester: 1, validator: 10, writer: 10 } })).status).toBe(200);
    const mk2 = async () => {
      const r = await postJson(h2, "/tickets", { by: "ols2-bob", title: "t", acceptance_criteria: "c", blast_radius: "low", role: null });
      expect(r.status).toBe(201);
      return (r.json as { snapshot: { id: string } }).snapshot.id;
    };
    const a = await mk2();
    const t = await mk2();
    expect((await roleHandoff(a, "tester", { from: "ols2-bob" }, h2)).status).toBe(201);
    await settle(h2);
    const [aStage] = await stagesOf(a, h2);
    expect(aStage.status).toBe("launching"); // holds the one tester slot
    expect((await roleHandoff(t, "tester", { from: "ols2-bob" }, h2)).status).toBe(201);
    expect((await roleHandoff(t, "worker", { from: "ols2-bob" }, h2)).status).toBe(201);
    await settle(h2);
    expect((await stagesOf(t, h2)).map((s) => [s.role, s.status])).toEqual([["tester", "queued"]]);
    expect((await put({ project_folder: null })).status).toBe(200);
    // the slot frees: the queued tester stage of t fails (no project folder); the evaluator then starts the worker stage
    const req = await until(`launch of ${aStage.id}`, () => l2.find((r) => r.stage_id === aStage.id));
    expect(req).toBeDefined();
    expect((await postJson(h2, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
    const sess = await registerAgent(h2, req.session, { room: R2 });
    await finish(aStage, req.session, h2, "ols2-bob");
    await settle(h2);
    // the passed stage holds its slot until its session close is acked; then the queued tester stage tries to launch
    expect((await postJson(h2, `/stages/${aStage.id}/turn-end`, { agent: req.session })).json).toEqual({ action: "close" });
    const close = await until("close launch of the passed stage", () => l2.find((r) => r.kind === "close" && r.session === req.session));
    expect(close).toBeDefined();
    expect((await postJson(h2, `/launches/${close.id}/ack`, { result: "spawned" })).status).toBe(200);
    await settle(h2);
    expect((await stagesOf(t, h2)).map((s) => [s.role, s.status])).toEqual([["tester", "failed"], ["worker", "failed"]]);
    sess.close();
    w2.close();
  });

  test("(d) a role handoff older than a later terminal stage of its role stays spent after a restart; an unspent expired handoff still starts one stage", async () => {
    const t = await mk();
    expect((await roleHandoff(t, "tester")).status).toBe(201);
    await settle();
    const [tester] = await stagesOf(t);
    await finish(tester, await run(tester.id));
    await settle();
    // an unspent expired handoff: recorded on a draft ticket, expired before the ticket is queued
    const d = await mk({ status: "draft" });
    expect((await roleHandoff(d, "tester", { ttl_seconds: 1 })).status).toBe(201);
    // the sweep runs every 5 s: wait for the real expiry, then prove it
    const status = await until("the handoff expires", async () => {
      const all = (await getJson(hub, `/handoffs?status=expired`)).json as Array<{ status: string; context: { ticket_id: string } }>;
      return all.find((x) => x.context?.ticket_id === d)?.status;
    }, 8000);
    expect(status).toBe("expired");

    stream.close();
    for (const c of open.splice(0)) c.close(); // an open agent stream would reconnect to the dead hub
    await hub.kill();
    const second = await bootOn(hub.ledgerPath, hub.token);
    extraHubs.push(second);
    const reqs2: any[] = [];
    const s2 = watch(second, reqs2);
    await settle(second);
    await touch(t, second);
    await settle(second);
    expect(await stagesOf(t, second)).toHaveLength(1); // the old pending handoff is spent
    expect((await postJson(second, `/tickets/${d}/transition`, { by: second.humanName, to: "queued" })).status).toBe(200);
    await settle(second);
    expect((await stagesOf(d, second)).map((s) => s.role)).toEqual(["tester"]);
    s2.close();
  }, 30_000);

});
