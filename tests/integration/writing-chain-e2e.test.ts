// Writing chain end to end (request r-2026-10-29-writing-chain-2, story 3): a [doc] ticket runs writer, editor and
// reviewer in turn on the hub, and the Reviewer result follows the Validator rules. Real hub, fake shell acks, temp git repo.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "wce";
const LEAD = "Orchestrator";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

describe("writing chain end to end", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    expect((await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { writer: 10, editor: 10, reviewer: 10, validator: 10 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, LEAD, { room: ROOM }));
    open.push(await registerAgent(hub, "wce-alice", { room: ROOM }));
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: LEAD })).status).toBe(200);
    stream = openLaunchStream(hub);
    void (async () => { try { for await (const e of stream.events) reqs.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const mk = async (role: string, over: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/tickets", { by: "wce-alice", title: "doc", acceptance_criteria: "c", blast_radius: "low", role, ...over });
    expect(r.status).toBe(201);
    return (r.json as { snapshot: { id: string } }).snapshot.id;
  };
  const ticketRow = async (id: string) => ((await getJson(hub, `/tickets?room=${ROOM}&status=all&archived=1`)).json as any[]).find((t) => t.id === id);
  const stagesOf = (ticket: string, role: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try { return db.query("SELECT id, status, session, verdict FROM stage WHERE ticket_id = ? AND role = ? ORDER BY created_seq").all(ticket, role) as Array<{ id: string; status: string; session: string; verdict: string | null }>; } finally { db.close(); }
  };
  const launchOf = async (stageId: string) => {
    for (let i = 0; i < 80 && !reqs.some((r) => r.kind === "launch" && r.stage_id === stageId); i++) await sleep(50);
    return reqs.find((r) => r.kind === "launch" && r.stage_id === stageId);
  };
  const newest = async (ticket: string, role: string) => {
    for (let i = 0; i < 80 && stagesOf(ticket, role).length === 0; i++) await sleep(50);
    return launchOf(stagesOf(ticket, role).at(-1)!.id);
  };
  // The turn end queues the close; a session name is reused, so only a close after the mark counts.
  const closeAfter = (session: string, mark: number) => reqs.slice(mark).find((r) => r.kind === "close" && r.session === session);
  const spawn = async (req: any) => {
    expect((await ackLaunch(hub, req.id, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, req.session, { room: ROOM }));
  };
  const endTurn = async (req: any) => {
    const mark = reqs.length;
    expect((await postJson(hub, `/stages/${req.stage_id}/turn-end`, { agent: req.session })).status).toBe(200);
    for (let i = 0; i < 80 && !closeAfter(req.session, mark); i++) await sleep(50);
    expect((await ackLaunch(hub, closeAfter(req.session, mark).id, { result: "spawned" })).status).toBe(200);
  };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", ".");
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  const handoff = (from: string, over: Record<string, unknown>) => postJson(hub, "/handoffs", { from, task: "result", ...over });
  const ctx = (req: any, ticket: string, over: Record<string, unknown> = {}) => ({ stage_id: req.stage_id, ticket_id: ticket, notes: "n", ...over });

  // The Writer takes the ticket to in_review, commits and hands over to the Editor.
  const writerStage = async (ticket: string) => {
    const w = await newest(ticket, "writer");
    await spawn(w);
    expect((await postJson(hub, `/tickets/${ticket}/claim`, { by: w.session })).status).toBe(200);
    for (const to of ["in_progress", "in_review"]) expect((await postJson(hub, `/tickets/${ticket}/transition`, { by: w.session, to, note: "n" })).status).toBe(200);
    const sha = commit(w.cwd, `${ticket}-w.txt`);
    const r = await handoff(w.session, { to_role: "editor", context: ctx(w, ticket, { commit: sha, path: "doc.md" }) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await endTurn(w);
    return sha;
  };
  const editorStage = async (ticket: string) => {
    const e = await newest(ticket, "editor");
    await spawn(e);
    const sha = commit(e.cwd, `${ticket}-e.txt`);
    const r = await handoff(e.session, { to_role: "reviewer", context: ctx(e, ticket, { commit: sha, path: "doc.md", change_summary: "s" }) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await endTurn(e);
    return sha;
  };
  // A running Reviewer stage at the Editor's commit.
  const reviewerStage = async (ticket: string) => {
    await writerStage(ticket);
    const sha = await editorStage(ticket);
    const r = await newest(ticket, "reviewer");
    await spawn(r);
    return { r, sha };
  };
  const pass = (r: any, ticket: string, sha: string, over: Record<string, unknown> = {}) =>
    handoff(r.session, { to: LEAD, context: ctx(r, ticket, { verdict: "PASS", commit: sha, findings: [], ...over }) });
  const fail = (r: any, ticket: string, sha: string, over: Record<string, unknown> = {}, to: Record<string, unknown> = { to_role: "writer" }) =>
    handoff(r.session, { ...to, context: ctx(r, ticket, { verdict: "FAIL", commit: sha, findings: [{ severity: "blocking", text: "wrong default" }], ...over }) });
  // Ends a running Reviewer with a valid PASS and frees its session name, so the next test starts clean.
  const release = async (r: any, t: string, sha: string) => {
    expect((await pass(r, t, sha)).status).toBe(201);
    await endTurn(r);
  };
  const errorsOf = (r: { json: unknown }) => ((r.json as any)?.errors ?? [(r.json as any)?.error]).join("\n");

  test("doc ticket queues", async () => {
    const t = await mk("writer");
    expect((await ticketRow(t)).status).toBe("queued");
    const w = await newest(t, "writer");
    expect(w.role).toBe("writer");
    expect(git(w.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ticket/${t}`);
  });

  test("writer, editor and reviewer run in turn and the PASS reaches the lead", async () => {
    const t = await mk("writer");
    const { r, sha } = await reviewerStage(t);
    expect(stagesOf(t, "writer").map((s) => s.status)).toEqual(["passed"]);
    expect(stagesOf(t, "editor").map((s) => s.status)).toEqual(["passed"]);
    expect((await ticketRow(t)).status).toBe("in_review");
    // No stage session accepted or declined a hand-over: the role hand-overs stay pending.
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      const rows = db.query("SELECT to_agent, status FROM handoffs WHERE to_agent LIKE 'role:%' AND json_extract(context_json, '$.ticket_id') = ?").all(t) as Array<{ to_agent: string; status: string }>;
      expect(rows.map((x) => x.to_agent)).toEqual(["role:editor", "role:reviewer"]);
      expect(rows.every((x) => x.status === "pending")).toBe(true);
    } finally { db.close(); }
    const res = await pass(r, t, sha, { findings: [{ severity: "suggestion", text: "a better word" }] });
    expect(res.status, errorsOf(res)).toBe(201);
    // The same close rule as a Validator PASS (L4): the ticket stays in_review and goes to the lead.
    expect(stagesOf(t, "reviewer").map((s) => [s.status, s.verdict])).toEqual([["passed", "PASS"]]);
    const row = await ticketRow(t);
    expect([row.status, row.assignee]).toEqual(["in_review", LEAD]);
    await endTurn(r);
  });

  test("reviewer FAIL starts one writer stage", async () => {
    const t = await mk("writer");
    const { r, sha } = await reviewerStage(t);
    const res = await fail(r, t, sha);
    expect(res.status, errorsOf(res)).toBe(201);
    expect(stagesOf(t, "reviewer").map((s) => [s.status, s.verdict])).toEqual([["passed", "FAIL"]]);
    await endTurn(r);
    for (let i = 0; i < 80 && stagesOf(t, "writer").length < 2; i++) await sleep(50);
    await sleep(300);
    const writers = stagesOf(t, "writer");
    expect(writers).toHaveLength(2);
    expect(writers[1].status).toBe("launching");
    expect(stagesOf(t, "editor")).toHaveLength(1);
    const w2 = await launchOf(writers[1].id);
    expect(w2.prompt).toContain("wrong default");
    expect((await ticketRow(t)).status).toBe("in_review");
  });

  describe("reviewer result checks", () => {
    // Each refusal leaves the stage running: a valid PASS afterwards ends it and frees the session name.
    const refused = async (send: (r: any, t: string, sha: string) => Promise<{ status: number; json: unknown }>, field: string) => {
      const t = await mk("writer");
      const { r, sha } = await reviewerStage(t);
      const res = await send(r, t, sha);
      expect(res.status).toBe(400);
      expect(errorsOf(res)).toContain(field);
      expect(stagesOf(t, "reviewer")[0].status).toBe("running");
      expect(stagesOf(t, "writer")).toHaveLength(1);
      await release(r, t, sha);
    };

    test("missing ticket_id 400", () =>
      refused((r, _t, sha) => handoff(r.session, { to: LEAD, context: { stage_id: r.stage_id, notes: "n", verdict: "PASS", commit: sha, findings: [] } }), "context.ticket_id"));

    test("finding without severity 400", () => refused((r, t, sha) => pass(r, t, sha, { findings: [{ text: "no severity" }] }), "context.findings[0].severity"));

    test("finding with severity major 400", () => refused((r, t, sha) => fail(r, t, sha, { findings: [{ severity: "major", text: "x" }] }), "context.findings[0].severity"));

    test("PASS to another agent 400", () =>
      refused((r, t, sha) => handoff(r.session, { to: "wce-alice", context: ctx(r, t, { verdict: "PASS", commit: sha, findings: [] }) }), "to: a Reviewer PASS must be sent to"));

    test("PASS with a blocking finding 400", () => refused((r, t, sha) => pass(r, t, sha, { findings: [{ severity: "blocking", text: "x" }] }), "a PASS must not have a blocking finding"));

    test("FAIL to another role 400", () => refused((r, t, sha) => fail(r, t, sha, {}, { to_role: "editor" }), 'to: a Reviewer FAIL must be sent with to_role "writer"'));
  });

  test("validator result without severity accepted", async () => {
    const t = await mk(null as unknown as string);
    expect((await handoff("wce-alice", { to_role: "validator", task: "validate", context: { ticket_id: t } })).status).toBe(201);
    const v = await newest(t, "validator");
    await spawn(v);
    const res = await handoff(v.session, { to: LEAD, context: ctx(v, t, { verdict: "FAIL", findings: [{ ticket_id: t, text: "no severity here" }] }) });
    expect(res.status, errorsOf(res)).toBe(201);
    expect(stagesOf(t, "validator").map((s) => s.verdict)).toEqual(["FAIL"]);
  });
});
