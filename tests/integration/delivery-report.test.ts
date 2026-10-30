// Delivery report (P6-08): GET /requests/<room>/<id>/delivery is built from the ledger and git. The Needs-you list
// carries one `deliveries` line for each delivered request with a merge commit that is not on main yet.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

const ROOM = "dr";
const logDir = mkdtempSync(join(tmpdir(), "dr-staging-log-"));
process.env.CUBILOT_STAGING_LOG_DIR = logDir;

describe("delivery report", () => {
  let hub: HubHandle;
  let repo: string;
  const open: Array<{ close: () => void }> = [];

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  let fileN = 0;
  /** A merge commit on staging with this message, like the Orchestrator's merge of a ticket branch. */
  const mergeToStaging = (message: string) => {
    const b = `b${++fileN}`;
    git("checkout", "-q", "-b", b, "staging");
    writeFileSync(join(repo, `f${fileN}.txt`), String(fileN));
    git("add", ".");
    git("commit", "-qm", `work ${fileN}`);
    git("checkout", "-q", "staging");
    git("merge", "--no-ff", "-q", "-m", message, b);
    return git("rev-parse", "HEAD");
  };
  const sql = (fn: (db: Database) => void) => {
    const db = new Database(hub.ledgerPath);
    try { fn(db); } finally { db.close(); }
  };
  const mkRequest = async (request_id: string, extra: Record<string, unknown> = {}) => {
    const r = await postJson(hub, "/requests", { by: "dr-lead", request_id, ...extra });
    expect(r.status).toBe(201);
  };
  const mkTicket = async (request_id: string, over: Record<string, unknown> = {}) => {
    const t = await postJson(hub, "/tickets", { by: "dr-lead", title: "T", acceptance_criteria: "c1", blast_radius: "low", request_id, status: "draft", ...over });
    expect(t.status).toBe(201);
    return (t.json as { snapshot: { id: string } }).snapshot.id;
  };
  const setStatus = (id: string, status: string) => sql((db) => void db.run("UPDATE tickets SET status = ? WHERE id = ?", [status, id]));
  const report = async (request: string) => getJson(hub, `/requests/${ROOM}/${request}/delivery`);
  let sn = 0;
  /** A passed Validator stage of a ticket, with its result handoff. Returns the handoff id. */
  const validatorPass = (ticketId: string): string => {
    sn++;
    const sid = `s_${sn.toString(16).padStart(16, "0")}`;
    const hid = `h_${sn.toString(16).padStart(16, "0")}`;
    sql((db) => {
      db.run(
        `INSERT INTO stage (id, ticket_id, request_id, review, verdict, role, attempt, status, session, slot_seq, created_seq, updated_seq, version)
         VALUES (?, ?, NULL, NULL, 'PASS', 'validator', 1, 'passed', ?, NULL, ?, ?, ?)`,
        [sid, ticketId, `validator-${sn}`, 1000 + sn, 1000 + sn, 1000 + sn],
      );
      db.run(
        "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, ?, 'x', 'r', ?, 'accepted', ?, ?)",
        [hid, `validator-${sn}`, JSON.stringify({ stage_id: sid, verdict: "PASS", suggestions: [`suggest ${hid}`] }), 1, 2],
      );
    });
    return hid;
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "dr-repo-"));
    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1");
    git("add", ".");
    git("commit", "-qm", "one");
    git("branch", "staging");
    git("checkout", "-q", "staging");
    hub = await spawnHub();
    open.push(await registerAgent(hub, "dr-lead", { room: ROOM }));
    expect((await postJson(hub, `/rooms/${ROOM}/lead`, { by: hub.humanName, agent: "dr-lead" })).status).toBe(200);
    const put = await fetch(`${hub.url}/rooms/${ROOM}/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project_folder: repo }),
    });
    expect(put.ok).toBe(true);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  test("Open ticket: a request with an in_review ticket returns 409", async () => {
    await mkRequest("dr-open");
    const a = await mkTicket("dr-open");
    const b = await mkTicket("dr-open");
    setStatus(a, "done");
    setStatus(b, "in_review");
    expect((await report("dr-open")).status).toBe(409);
    setStatus(b, "cancelled");
    expect((await report("dr-open")).status).toBe(200);
  });

  test("a request with only cancelled tickets, an unknown request and a bad id are refused", async () => {
    await mkRequest("dr-allcancel");
    setStatus(await mkTicket("dr-allcancel"), "cancelled");
    expect((await report("dr-allcancel")).status).toBe(409);
    expect((await report("dr-nope")).status).toBe(404);
    expect((await authedFetch(hub, `/requests/${ROOM}/bad%20id/delivery`)).status).toBe(400);
  });

  test("Ticket status and merge commit: origin and features first, the newest merge commit for each ticket", async () => {
    await mkRequest("dr-t", { features: ["Export", "Import"] });
    const a = await mkTicket("dr-t", { title: "Alpha" });
    const b = await mkTicket("dr-t", { title: "Beta" });
    const c = await mkTicket("dr-t", { title: "Gamma" });
    mergeToStaging(`Merge ticket/${a}: Alpha (old)`);
    const newest = mergeToStaging(`Merge ticket/${a}: Alpha (validator PASS h_1)`);
    // The merge of another ticket branch into a ticket branch is not a merge into staging.
    mergeToStaging(`Merge ticket/${b} (P6) into P6-08`);
    setStatus(a, "done");
    setStatus(b, "done");
    setStatus(c, "cancelled");
    const r = await report("dr-t");
    expect(r.status).toBe(200);
    const j = r.json as any;
    expect(Object.keys(j).slice(0, 4)).toEqual(["request_id", "origin", "features", "tickets"]);
    expect(j.origin).toBe("human");
    expect(j.features).toEqual(["Export", "Import"]);
    const by = Object.fromEntries(j.tickets.map((t: any) => [t.id, t]));
    expect(by[a]).toMatchObject({ title: "Alpha", status: "done", merge_commit: newest });
    expect(by[b]).toMatchObject({ status: "done", merge_commit: "no merge commit" });
    expect(by[c]).toMatchObject({ status: "cancelled", merge_commit: "no merge commit" });
  });

  test("Criteria edit: the text before and after, only edits after the Approve", async () => {
    await mkRequest("dr-edit");
    const t = await mkTicket("dr-edit", { acceptance_criteria: "first" });
    expect((await postJson(hub, `/tickets/${t}/edit`, { by: hub.humanName, acceptance_criteria: "before approve" })).status).toBe(200);
    expect((await postJson(hub, `/requests/${ROOM}/dr-edit/approve`, { by: hub.humanName })).status).toBe(200);
    expect((await postJson(hub, `/tickets/${t}/edit`, { by: hub.humanName, acceptance_criteria: "after approve" })).status).toBe(200);
    setStatus(t, "done");
    const j = (await report("dr-edit")).json as any;
    expect(j.criteria_edits).toHaveLength(1);
    expect(j.criteria_edits[0]).toMatchObject({ ticket_id: t, from: "before approve", to: "after approve" });
  });

  test("Factory follow-up: a child request with its tickets and statuses", async () => {
    await mkRequest("dr-fu");
    const t = await mkTicket("dr-fu");
    await mkRequest("dr-fu-fu-1", { origin: "factory", parent_request_id: "dr-fu", source: t });
    const f = await mkTicket("dr-fu-fu-1", { title: "Fix it" });
    setStatus(t, "done");
    const j = (await report("dr-fu")).json as any;
    expect(j.factory_requests).toEqual([{ request_id: "dr-fu-fu-1", tickets: [{ id: f, title: "Fix it", status: "draft" }] }]);
    expect(j.known_limits.follow_up_tickets).toEqual([{ id: f, title: "Fix it", status: "draft", request_id: "dr-fu-fu-1" }]);
  });

  test("Known limits: open suggestions of the Validator PASS results", async () => {
    await mkRequest("dr-kl");
    const t = await mkTicket("dr-kl");
    const h = validatorPass(t);
    setStatus(t, "done");
    const j = (await report("dr-kl")).json as any;
    expect(j.known_limits.open_suggestions).toEqual([{ ticket_id: t, handoff_id: h, text: `suggest ${h}` }]);
    expect(j.known_limits.follow_up_tickets).toEqual([]);
  });

  test("High-radius change: both PASS ids, and the mark when the merge message names only one", async () => {
    await mkRequest("dr-hi");
    const t = await mkTicket("dr-hi", { blast_radius: "high", title: "Risky" });
    const h1 = validatorPass(t);
    const h2 = validatorPass(t);
    mergeToStaging(`Merge ticket/${t}: Risky (validator PASS ${h1})`);
    setStatus(t, "done");
    let j = (await report("dr-hi")).json as any;
    expect(j.checks.high_radius).toEqual([{ ticket_id: t, pass_handoffs: [h1, h2], merge_message_incomplete: true }]);
    expect(j.checks.high_radius[0]).toBeDefined();
    // A complete message has no mark.
    await mkRequest("dr-hi2");
    const u = await mkTicket("dr-hi2", { blast_radius: "high" });
    const g1 = validatorPass(u);
    const g2 = validatorPass(u);
    mergeToStaging(`Merge ticket/${u}: Risky (validator PASS ${g1}, second review PASS ${g2})`);
    setStatus(u, "done");
    j = (await report("dr-hi2")).json as any;
    expect(j.checks.high_radius).toEqual([{ ticket_id: u, pass_handoffs: [g1, g2], merge_message_incomplete: false }]);
    // A low ticket is not listed.
    await mkRequest("dr-lo");
    const l = await mkTicket("dr-lo");
    setStatus(l, "done");
    expect(((await report("dr-lo")).json as any).checks.high_radius).toEqual([]);
  });

  test("Test counts: pass and fail of the log at the newest merge commit, with the hash", async () => {
    await mkRequest("dr-tc");
    const a = await mkTicket("dr-tc");
    const b = await mkTicket("dr-tc");
    const first = mergeToStaging(`Merge ticket/${a}: A (validator PASS h_a)`);
    const newest = mergeToStaging(`Merge ticket/${b}: B (validator PASS h_b)`);
    writeFileSync(join(logDir, `${first}.log`), " 1 pass\n 9 fail\n");
    writeFileSync(join(logDir, `${newest}.log`), "bun test v1\n\n 412 pass\n 0 fail\nRan 412 tests across 30 files.\n");
    setStatus(a, "done");
    setStatus(b, "done");
    expect(((await report("dr-tc")).json as any).checks.test_counts).toEqual({ commit: newest, pass: 412, fail: 0 });
  });

  test("No merge commit: a request without any merge commit says no staging log", async () => {
    await mkRequest("dr-nm");
    setStatus(await mkTicket("dr-nm"), "done");
    const j = (await report("dr-nm")).json as any;
    expect(j.tickets[0].merge_commit).toBe("no merge commit");
    expect(j.checks.test_counts).toBe("no staging log");
  });

  test("No staging log: the newest merge commit has no log file", async () => {
    await mkRequest("dr-nl");
    const t = await mkTicket("dr-nl");
    mergeToStaging(`Merge ticket/${t}: T (validator PASS h_x)`);
    setStatus(t, "done");
    expect(((await report("dr-nl")).json as any).checks.test_counts).toBe("no staging log");
  });

  test("Live-check steps: the criteria of the [human] ticket of the request", async () => {
    await mkRequest("dr-lc");
    const a = await mkTicket("dr-lc");
    const l = await mkTicket("dr-lc", { title: "[human] Live check", acceptance_criteria: "1. Open the board.\n2. Press the button." });
    setStatus(a, "done");
    setStatus(l, "done");
    const j = (await report("dr-lc")).json as any;
    expect(j.checks.live_check).toEqual({ ticket_id: l, steps: "1. Open the board.\n2. Press the button." });
    await mkRequest("dr-lc2");
    setStatus(await mkTicket("dr-lc2"), "done");
    expect(((await report("dr-lc2")).json as any).checks.live_check).toBeNull();
  });

  test("Merged into main: the Needs-you line shows until each merge commit is on main", async () => {
    await mkRequest("dr-mm");
    const a = await mkTicket("dr-mm");
    const sha = mergeToStaging(`Merge ticket/${a}: A (validator PASS h_a)`);
    setStatus(a, "done");
    const lines = async () => ((await getJson(hub, `/requests/${ROOM}/needs-you`)).json as { deliveries: any[] }).deliveries;
    expect(await lines()).toContainEqual({ request_id: "dr-mm", unmerged_commits: [sha] });
    // An open request has no line.
    await mkRequest("dr-mm-open");
    const o = await mkTicket("dr-mm-open");
    mergeToStaging(`Merge ticket/${o}: O (validator PASS h_o)`);
    expect((await lines()).map((l) => l.request_id)).not.toContain("dr-mm-open");
    // The human merges staging into main: the line goes.
    git("checkout", "-q", "main");
    git("merge", "--ff-only", "-q", "staging");
    git("checkout", "-q", "staging");
    expect((await lines()).map((l) => l.request_id)).not.toContain("dr-mm");
  });
});
