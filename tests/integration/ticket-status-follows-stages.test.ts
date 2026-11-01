// The ticket status follows its stages (t_1bcbbc00281ed9a9): a worker that never claims leaves the ticket "queued".
// A worker result moves the ticket to in_review (actor system), so the Tester and Validator stages run on an in_review
// ticket and the lead's move to done is legal after the final PASS (real hub).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "tsf";
const LEAD = "tsf-lead";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ticket status follows its stages", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    const put = await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10, validator: 10 } }) });
    expect(put.status).toBe(200);
    open.push(await registerAgent(hub, LEAD, { room: ROOM }));
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: LEAD })).status).toBe(200);
    // The shell stand-in acks every launch.
    const sse = openLaunchStream(hub);
    open.push(sse);
    void (async () => {
      try { for await (const req of sse.events) await ackLaunch(hub, req.id, { result: "spawned" }); } catch { /* closed */ }
    })();
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const rows = (sql: string, ...p: any[]) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query(sql).all(...p) as any[]; } finally { db.close(); }
  };
  const ticketRow = (id: string) => rows("SELECT status, assignee FROM tickets WHERE id = ?", id)[0] as { status: string; assignee: string | null };
  const eventKinds = (id: string) => rows("SELECT kind, actor FROM events WHERE entity_id = ? ORDER BY seq", id) as Array<{ kind: string; actor: string }>;

  /** The running stage of the role on the ticket, with its agent registered. */
  const running = async (ticketId: string, role: string) => {
    type S = { id: string; ticket_id: string; role: string; session: string };
    let stage: S | undefined;
    for (let i = 0; i < 100 && !stage; i++) {
      stage = ((await getJson(hub, "/stages?status=running")).json as S[]).find((x) => x.ticket_id === ticketId && x.role === role);
      if (!stage) await sleep(50);
    }
    expect(stage).toBeTruthy();
    open.push(await registerAgent(hub, stage!.session, { room: ROOM }));
    return stage!;
  };
  const newCommit = (ticketId: string) => {
    const tip = git("rev-parse", `refs/heads/ticket/${ticketId}`);
    const sha = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "work");
    git("update-ref", `refs/heads/ticket/${ticketId}`, sha);
    return sha;
  };

  /** The t_1bcb sequence: a ticket the worker never claims, then the worker, tester and validator results. */
  async function runChain(claimFirst: boolean) {
    git("update-ref", "refs/heads/staging", git("rev-parse", "main")); // each ticket branch starts at the same base
    const t = await postJson(hub, "/tickets", { by: LEAD, title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: "worker" });
    expect(t.status).toBe(201);
    const ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
    const w = await running(ticketId, "worker");
    expect(ticketRow(ticketId).status).toBe("queued"); // the launch assigns the session but does not claim
    if (claimFirst) expect((await postJson(hub, `/tickets/${ticketId}/claim`, { by: w.session })).status).toBe(200);
    const commit = newCommit(ticketId);
    const wr = await postJson(hub, "/handoffs", { from: w.session, to_role: "tester", task: "test", context: { notes: "n", stage_id: w.id, ticket_id: ticketId, commit } });
    expect({ status: wr.status, body: wr.json }).toMatchObject({ status: 201 });
    // After the worker result the ticket is in review, before any tester stage runs.
    expect(ticketRow(ticketId).status).toBe("in_review");
    const tester = await running(ticketId, "tester");
    expect(ticketRow(ticketId).status).toBe("in_review");
    const tr = await postJson(hub, "/handoffs", {
      from: tester.session, to_role: "validator", task: "validate",
      context: { notes: "n", stage_id: tester.id, ticket_id: ticketId, verdict: "PASS", report: "r", commit, findings: [], full_suite: false, tests_run: ["tests/integration/x.test.ts"] },
    });
    expect(tr.status).toBe(201);
    const validator = await running(ticketId, "validator");
    const vr = await postJson(hub, "/handoffs", {
      from: validator.session, to: LEAD, task: "result",
      context: { notes: "n", stage_id: validator.id, ticket_id: ticketId, verdict: "PASS", report: "r", findings: [], suggestions: [] },
    });
    expect(vr.status).toBe(201);
    return { ticketId, commit };
  }

  test("a queued ticket with no claim: the worker result moves it to in_review and the lead closes it after the PASS", async () => {
    const { ticketId, commit } = await runChain(false);
    const kinds = eventKinds(ticketId);
    expect(kinds.map((e) => e.kind)).not.toContain("ticket.claimed");
    const review = kinds.filter((e) => e.kind === "ticket.in_review");
    expect(review).toEqual([{ kind: "ticket.in_review", actor: "system" }]);
    const payload = rows("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'ticket.in_review'", ticketId)[0].payload_json;
    expect(JSON.parse(payload)).toMatchObject({ from: "queued", to: "in_review" });
    expect(ticketRow(ticketId)).toEqual({ status: "in_review", assignee: LEAD });
    // The PASS commit is not on staging yet: done is refused. After the merge the lead's move succeeds.
    const early = await postJson(hub, `/tickets/${ticketId}/transition`, { by: LEAD, to: "done" });
    expect(early.status).toBe(409);
    git("update-ref", "refs/heads/staging", commit);
    const done = await postJson(hub, `/tickets/${ticketId}/transition`, { by: LEAD, to: "done" });
    expect(done.status).toBe(200);
    expect(ticketRow(ticketId).status).toBe("done");
  });

  test("a claimed ticket: the worker result moves it to in_review", async () => {
    const { ticketId } = await runChain(true);
    const kinds = eventKinds(ticketId);
    expect(kinds.filter((e) => e.kind === "ticket.in_review")).toEqual([{ kind: "ticket.in_review", actor: "system" }]);
    expect(ticketRow(ticketId)).toEqual({ status: "in_review", assignee: LEAD });
  });
});
