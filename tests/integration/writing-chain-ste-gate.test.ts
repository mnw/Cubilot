// STE gate (request r-2026-10-29-writing-chain-2): the Reviewer lints the Editor's doc with the real ste-lint.py before the review
// and sends a lint FAIL (gate "ste-lint") to_role editor. The hub does not lint: the gate helper below does what reviewer.md step 1 says.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const ROOM = "wsg";
const LEAD = "Orchestrator";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

describe("writing chain ste gate", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, ROOM);
    expect((await authedFetch(hub, `/rooms/${ROOM}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { writer: 10, editor: 10, reviewer: 10, validator: 10 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, LEAD, { room: ROOM }));
    open.push(await registerAgent(hub, "wsg-alice", { room: ROOM }));
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
    const r = await postJson(hub, "/tickets", { by: "wsg-alice", title: "doc", acceptance_criteria: "c", blast_radius: "low", role, ...over });
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
  const editorStage = async (ticket: string, docText: string, summary: string) => {
    const e = await newest(ticket, "editor");
    await spawn(e);
    writeFileSync(join(e.cwd, "doc.md"), docText);
    const sha = commit(e.cwd, `${ticket}-e.txt`);
    const r = await handoff(e.session, { to_role: "reviewer", context: ctx(e, ticket, { commit: sha, path: "doc.md", change_summary: summary }) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await endTurn(e);
    return sha;
  };
  // A running Reviewer stage at the Editor's commit.
  const reviewerStage = async (ticket: string, docText: string, summary = "s") => {
    await writerStage(ticket);
    const sha = await editorStage(ticket, docText, summary);
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

  const LINT = resolve(import.meta.dir, "../../factory/shared/skills/asd-ste100/scripts/ste-lint.py");
  const CLEAN = "Open the file.\n\nRun the test.\n";
  const LONG = "This sentence has far too many words because it keeps going on and on without any stop so that the linter must count more than twenty five words here.";
  const lint = (...a: string[]) => Bun.spawnSync(["python3", "-I", LINT, ...a], { stdout: "pipe", stderr: "pipe" });
  // Step 1 of reviewer.md: run 1 (--disable, exit 0), run 2 (--json, listed hits at listed lines), reason judgement.
  const gate = (path: string, summary: string, accept: (reason: string) => boolean = () => true) => {
    const listed = [...summary.matchAll(/^ste_disable: (\S+) at (\d+): (.+)$/gm)].map((m) => ({ rule: m[1], line: Number(m[2]), reason: m[3] }));
    const findings: Array<{ severity: "blocking"; text: string }> = [];
    const rules = [...new Set(listed.map((l) => l.rule))];
    const r1 = lint(...(rules.length ? ["--disable", rules.join(",")] : []), path);
    if (r1.exitCode !== 0) {
      for (const m of r1.stdout.toString().matchAll(/^\S+?:(\d+):\d+ (\S+):(.*)$/gm)) findings.push({ severity: "blocking", text: `${m[2]} at ${path}:${m[1]}:${m[3]}` });
      if (!findings.length) findings.push({ severity: "blocking", text: `ste-lint exit ${r1.exitCode}: ${r1.stderr}` });
    }
    const hits = (JSON.parse(lint("--json", path).stdout.toString()).violations as Array<{ rule: string; line: number; message: string }>).filter((v) => rules.includes(v.rule));
    for (const h of hits) if (!listed.some((l) => l.rule === h.rule && l.line === h.line)) findings.push({ severity: "blocking", text: `${h.rule} at ${path}:${h.line}: ${h.message}` });
    for (const l of listed) if (!accept(l.reason)) findings.push({ severity: "blocking", text: `ste_disable ${l.rule} at ${path}:${l.line}: reason rejected` });
    return findings;
  };
  const lintFail = (r: any, t: string, sha: string, findings: unknown[], over: Record<string, unknown> = {}) =>
    handoff(r.session, { to_role: "editor", context: ctx(r, t, { verdict: "FAIL", gate: "ste-lint", commit: sha, findings, ...over }) });
  // The lint FAIL ends the Reviewer and starts one Editor stage; returns the Editor launch request.
  const sendBack = async (r: any, t: string, sha: string, findings: Array<{ text: string }>) => {
    expect(findings.length).toBeGreaterThan(0);
    const res = await lintFail(r, t, sha, findings);
    expect(res.status, errorsOf(res)).toBe(201);
    expect(stagesOf(t, "reviewer").map((s) => [s.status, s.verdict])).toEqual([["passed", "FAIL"]]);
    await endTurn(r);
    for (let i = 0; i < 80 && stagesOf(t, "editor").length < 2; i++) await sleep(50);
    await sleep(300);
    expect(stagesOf(t, "editor")).toHaveLength(2);
    expect(stagesOf(t, "writer")).toHaveLength(1);
    return launchOf(stagesOf(t, "editor")[1].id);
  };

  test("lint fail goes to the editor", async () => {
    const t = await mk("writer");
    const { r, sha } = await reviewerStage(t, `${CLEAN}\n${LONG}\n`);
    const findings = gate(join(r.cwd, "doc.md"), "s");
    expect(findings.map((f) => f.text).join("\n")).toMatch(/long-sentence at .*doc\.md:5:/);
    const e2 = await sendBack(r, t, sha, findings);
    expect(e2.prompt).toContain("long-sentence at");
    expect((await ticketRow(t)).status).toBe("in_review");
  });

  test("listed break passes, unlisted line fails", async () => {
    const t = await mk("writer");
    const doc = `${CLEAN}\n${LONG}\n\n${LONG}\n`;
    const { r, sha } = await reviewerStage(t, doc, "ste_disable: long-sentence at 5: a quoted command line");
    const path = join(r.cwd, "doc.md");
    const findings = gate(path, "ste_disable: long-sentence at 5: a quoted command line");
    // Run 1 passes with the rule disabled; run 2 finds the second hit at line 7, which is not listed.
    expect(lint("--disable", "long-sentence", path).exitCode).toBe(0);
    expect(findings.map((f) => f.text)).toHaveLength(1);
    expect(findings[0].text).toMatch(/long-sentence at .*doc\.md:7:/);
    // Both lines listed: no finding, so the review continues and a PASS follows the reviewer rule.
    expect(gate(path, "ste_disable: long-sentence at 5: r1\nste_disable: long-sentence at 7: r2")).toEqual([]);
    await sendBack(r, t, sha, findings);
  });

  test("disabled run fails goes to the editor", async () => {
    const t = await mk("writer");
    // The listed rule is disabled, but another hard rule still fails in run 1.
    const doc = `${CLEAN}\n${LONG}\n`;
    const { r, sha } = await reviewerStage(t, doc, "ste_disable: passive-voice at 1: reason");
    const findings = gate(join(r.cwd, "doc.md"), "ste_disable: passive-voice at 1: reason");
    expect(lint("--disable", "passive-voice", join(r.cwd, "doc.md")).exitCode).toBe(1);
    expect(findings.some((f) => /long-sentence at/.test(f.text))).toBe(true);
    await sendBack(r, t, sha, findings);
  });

  test("rejected reason goes to the editor", async () => {
    const t = await mk("writer");
    const summary = "ste_disable: long-sentence at 5: because I like it";
    const { r, sha } = await reviewerStage(t, `${CLEAN}\n${LONG}\n`, summary);
    const findings = gate(join(r.cwd, "doc.md"), summary, () => false);
    expect(findings.map((f) => f.text)).toEqual([expect.stringMatching(/ste_disable long-sentence at .*doc\.md:5: reason rejected/)]);
    await sendBack(r, t, sha, findings);
  });

  test("lint fail starts one editor stage", async () => {
    const t = await mk("writer");
    const { r, sha } = await reviewerStage(t, `${CLEAN}\n${LONG}\n`);
    const findings = gate(join(r.cwd, "doc.md"), "s");
    await sendBack(r, t, sha, findings);
    expect(stagesOf(t, "writer")).toHaveLength(1);
    expect(stagesOf(t, "editor").map((s) => s.status)).toEqual(["passed", "launching"]);
    // A ste-lint FAIL to the Writer, and a plain FAIL to the Editor, are refused.
    const t2 = await mk("writer");
    const b = await reviewerStage(t2, CLEAN);
    const toWriter = await handoff(b.r.session, { to_role: "writer", context: ctx(b.r, t2, { verdict: "FAIL", gate: "ste-lint", commit: b.sha, findings: [{ severity: "blocking", text: "x" }] }) });
    expect(toWriter.status).toBe(400);
    expect(errorsOf(toWriter)).toContain('gate "ste-lint" must be sent with to_role "editor"');
    const plain = await handoff(b.r.session, { to_role: "editor", context: ctx(b.r, t2, { verdict: "FAIL", commit: b.sha, findings: [{ severity: "blocking", text: "x" }] }) });
    expect(plain.status).toBe(400);
    expect(errorsOf(plain)).toContain('a Reviewer FAIL must be sent with to_role "writer"');
    await release(b.r, t2, b.sha);
  });

  test("clean doc follows the reviewer result rule", async () => {
    const t = await mk("writer");
    const { r, sha } = await reviewerStage(t, CLEAN);
    expect(gate(join(r.cwd, "doc.md"), "s")).toEqual([]);
    const res = await pass(r, t, sha);
    expect(res.status, errorsOf(res)).toBe(201);
    expect(stagesOf(t, "editor")).toHaveLength(1);
    expect((await ticketRow(t)).assignee).toBe(LEAD);
    await endTurn(r);
    const t2 = await mk("writer");
    const b = await reviewerStage(t2, CLEAN);
    const res2 = await fail(b.r, t2, b.sha);
    expect(res2.status, errorsOf(res2)).toBe(201);
    await endTurn(b.r);
    for (let i = 0; i < 80 && stagesOf(t2, "writer").length < 2; i++) await sleep(50);
    expect(stagesOf(t2, "writer")).toHaveLength(2);
    expect(stagesOf(t2, "editor")).toHaveLength(1);
  });
});
