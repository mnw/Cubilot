// GET /rooms/<room>/flow (Part 18 flow measure): slot use, ready tickets, wait hours, review FAIL rate, done without a merge.
// Real hub, temp git repo. Tickets are made through the route, then their event times and the stage rows are seeded so the hours are exact.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, postJson, registerAgent } from "../helpers/fetch";

const H = 3_600_000;
const T0 = 1_000_000_000_000;
const WINDOW = `since=${T0}&until=${T0 + 10 * H}`;

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A repo whose branch staging holds `base`. `feat` holds `unmerged` on top of it. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "flow-proj-"));
  sh(dir, "git", "init", "-q", "-b", "staging");
  sh(dir, "git", "config", "user.email", "t@t");
  sh(dir, "git", "config", "user.name", "t");
  const commit = (file: string, msg = file) => {
    writeFileSync(join(dir, file), file);
    sh(dir, "git", "add", ".");
    sh(dir, "git", "commit", "-qm", msg);
    return sh(dir, "git", "rev-parse", "HEAD");
  };
  const base = commit("a.txt");
  sh(dir, "git", "checkout", "-q", "-b", "feat");
  const unmerged = commit("b.txt");
  sh(dir, "git", "checkout", "-q", "staging");
  return { dir, base, unmerged, commit };
}

describe("GET /rooms/<room>/flow", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  let n = 0;
  let sid = 0;

  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const db = <T>(fn: (d: Database) => T): T => {
    const d = new Database(hub.ledgerPath);
    try { return fn(d); } finally { d.close(); }
  };
  async function room(project: string | null = null, withSettings = true) {
    const name = `fl${++n}`;
    const body = project ? { project_folder: project } : {};
    if (withSettings) expect((await authedFetch(hub, `/rooms/${name}/settings`, { method: "PUT", body: JSON.stringify(body) })).status).toBe(200);
    const alice = `${name}-alice`;
    open.push(await registerAgent(hub, alice, { room: name }));
    return { name, alice };
  }
  type R = Awaited<ReturnType<typeof room>>;
  const mk = async (r: R, extra: Record<string, unknown> = {}) => {
    const res = await postJson(hub, "/tickets", { by: r.alice, title: "t", acceptance_criteria: "c", blast_radius: "low", ...extra });
    expect(res.status).toBe(201);
    return (res.json as { snapshot: { id: string } }).snapshot.id;
  };
  /** Replaces the events of a ticket by a timeline of [kind, hours after T0, payload], and sets the stored status. */
  const timeline = (id: string, status: string, evs: Array<[string, number, object?]>) =>
    db((d) => {
      d.run("DELETE FROM events WHERE entity_id = ?", [id]);
      for (const [kind, h, payload] of evs) d.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, ?, 'x', ?, ?)", [id, kind, JSON.stringify(payload ?? {}), T0 + h * H]);
      d.run("UPDATE tickets SET status = ? WHERE id = ?", [status, id]);
    });
  type StageSeed = { ticket?: string; request?: string; scope?: string[]; role: string; status?: string; verdict?: string | null; launch?: number; end?: number; endKind?: string };
  const stage = (s: StageSeed) =>
    db((d) => {
      const id = `s_flow${++sid}`;
      d.run(
        "INSERT INTO stage (id, ticket_id, request_id, review, role, status, verdict, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, s.ticket ?? null, s.request ?? null, s.request ? "spec" : null, s.role, s.status ?? "passed", s.verdict ?? null, sid],
      );
      for (const t of s.scope ?? []) d.run("INSERT INTO stage_scope (stage_id, ticket_id) VALUES (?, ?)", [id, t]);
      const ev = (kind: string, h: number) => d.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, ?, 'x', '{}', ?)", [id, kind, T0 + h * H]);
      if (s.launch !== undefined) ev("stage.launching", s.launch);
      if (s.end !== undefined) ev(s.endKind ?? "stage.passed", s.end);
      return id;
    });
  const setRole = (id: string, role: string | null) => db((d) => d.run("UPDATE tickets SET role = ? WHERE id = ?", [role, id]));
  const flow = async (r: R | string, query = WINDOW) => {
    const res = await getJson(hub, `/rooms/${typeof r === "string" ? r : r.name}/flow?${query}`);
    expect(res.status).toBe(200);
    return res.json as any;
  };

  test("slot use per role", async () => {
    const r = await room();
    const other = await room();
    const t = await mk(r);
    const o = await mk(other);
    stage({ ticket: t, role: "worker", verdict: "PASS", launch: 1, end: 3 });
    stage({ ticket: t, role: "tester", verdict: "PASS", launch: 8, end: 12 }); // clipped by the window end: 2 h
    stage({ ticket: o, role: "worker", verdict: "PASS", launch: 1, end: 9 }); // another room
    const f = await flow(r);
    expect(f.limits).toBe("current");
    expect(f.window_hours).toBe(10);
    expect(f.slot_use.worker).toEqual({ run_hours: 2, limit: 2, slot_hours: 20, percent: 10 });
    expect(f.slot_use.tester).toEqual({ run_hours: 2, limit: 2, slot_hours: 20, percent: 10 });
    expect(f.slot_use.validator.run_hours).toBe(0);
  });

  test("room without settings uses the default limits", async () => {
    const r = await room(null, false);
    const t = await mk(r);
    stage({ ticket: t, role: "worker", verdict: "PASS", launch: 1, end: 3 });
    const f = await flow(r);
    expect(f.slot_use.worker).toEqual({ run_hours: 2, limit: 2, slot_hours: 20, percent: 10 });
    expect(f.slot_use.validator.limit).toBe(1);
  });

  test("ready tickets", async () => {
    const r = await room();
    const ready = await mk(r, { status: "queued" });
    const live = await mk(r, { status: "queued" });
    stage({ ticket: live, role: "worker", status: "running", launch: 1 });
    const draft = await mk(r, { status: "draft" });
    const blocked = await mk(r, { status: "queued", blocked_by: [draft] });
    const f = await flow(r);
    expect(f.ready_tickets.map((t: any) => t.id)).toEqual([ready]);
    expect([live, blocked].some((id) => f.ready_tickets.some((t: any) => t.id === id))).toBe(false);
  });

  test("blocker merged but not done is cleared", async () => {
    const repo = makeRepo();
    const r = await room(repo.dir);
    const tester = (blocker: string, commit: string) => {
      const sidT = stage({ ticket: blocker, role: "tester", verdict: "PASS", launch: 1, end: 2 });
      db((d) => {
        d.run("UPDATE stage SET session = 'tester-x' WHERE id = ?", [sidT]);
        d.run(
          "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-x', 'role:validator', 'v', ?, 'accepted', 1, 9999999999999)",
          [`h_flow${sidT}`, JSON.stringify({ stage_id: sidT, ticket_id: blocker, verdict: "PASS", commit })],
        );
        d.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'x', '{}', 1)", [`h_flow${sidT}`]);
      });
    };
    const merged = await mk(r, { status: "queued" });
    const unmerged = await mk(r, { status: "queued" });
    db((d) => d.run("UPDATE tickets SET status = 'in_review' WHERE id IN (?, ?)", [merged, unmerged]));
    tester(merged, repo.base);
    tester(unmerged, repo.unmerged);
    const a = await mk(r, { status: "queued", blocked_by: [merged] });
    const b = await mk(r, { status: "queued", blocked_by: [unmerged] });
    const f = await flow(r);
    const ids = f.ready_tickets.map((t: any) => t.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  test("wait reasons do not overlap", async () => {
    const r = await room();
    const blocker = await mk(r, { status: "queued" });
    setRole(blocker, "worker");
    timeline(blocker, "done", [["ticket.created", 0, { status: "queued" }], ["ticket.done", 5]]);
    // draft 0-2, queued with a blocker until 5, queued with no slot 5-7, then claimed
    const w = await mk(r, { status: "draft", blocked_by: [blocker] });
    setRole(w, "worker");
    timeline(w, "claimed", [["ticket.created", 0, { status: "draft" }], ["ticket.queued", 2], ["ticket.claimed", 7]]);
    // draft 0-1, waiting for approval 1-4 (spec PASS at 1, the request holds a high ticket), queued with no slot 4-5
    const high = await mk(r, { status: "draft", request_id: "rq-wait", blast_radius: "high" });
    const p = await mk(r, { status: "draft", request_id: "rq-wait" });
    timeline(high, "draft", [["ticket.created", 0, { status: "draft" }]]);
    setRole(p, "worker");
    timeline(p, "claimed", [["ticket.created", 0, { status: "draft" }], ["ticket.queued", 4], ["ticket.claimed", 5]]);
    stage({ request: "rq-wait", scope: [p], role: "validator", verdict: "PASS", launch: 0, end: 1 });
    // both worker slots (default limit 2) are in use for the whole window
    stage({ ticket: p, role: "worker", status: "running", launch: 0 });
    stage({ ticket: p, role: "worker", status: "running", launch: 0 });
    const f = await flow(r);
    // `high` is a draft for the whole window (10 h) and is not in the scope of the spec PASS, so it is plain draft.
    // The blocker was queued with no blocker and no slot from 0 to 5 (5 h).
    expect(f.wait_hours).toEqual({ draft: 2 + 1 + 10, waiting_approval: 3, blocked: 3, no_slot: 2 + 1 + 5 });
  });

  test("queued time with a free slot counts for no reason", async () => {
    const r = await room();
    const w = await mk(r, { status: "queued" });
    setRole(w, "worker");
    timeline(w, "claimed", [["ticket.created", 0, { status: "queued" }], ["ticket.claimed", 4]]);
    // one of two worker slots is busy from 0 to 2, both from 1 to 2
    stage({ ticket: w, role: "worker", verdict: "PASS", launch: 0, end: 2 });
    stage({ ticket: w, role: "worker", verdict: "PASS", launch: 1, end: 2 });
    const f = await flow(r);
    expect(f.wait_hours).toEqual({ draft: 0, waiting_approval: 0, blocked: 0, no_slot: 1 });
  });

  test("no slot is judged by the role of the ticket", async () => {
    const r = await room();
    const w = await mk(r, { status: "queued" });
    db((d) => d.run("UPDATE tickets SET role = 'tester' WHERE id = ?", [w]));
    timeline(w, "claimed", [["ticket.created", 0, { status: "queued" }], ["ticket.claimed", 4]]);
    const o = await mk(r);
    // both worker slots are busy from 0 to 4, which does not block a tester ticket
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    // both tester slots (default limit 2) are busy from 1 to 3
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 3 });
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 3 });
    const f = await flow(r);
    expect(f.wait_hours.no_slot).toBe(2);
  });

  test("no slot follows a role edit while queued", async () => {
    const r = await room();
    const w = await mk(r, { status: "queued" });
    db((d) => d.run("UPDATE tickets SET role = 'tester' WHERE id = ?", [w]));
    // worker role 0-2, tester role 2-4
    timeline(w, "claimed", [["ticket.created", 0, { status: "queued" }], ["ticket.edited", 2, { fields: ["role"], role: { from: "worker", to: "tester" } }], ["ticket.claimed", 4]]);
    const o = await mk(r);
    // both worker slots busy 0-4: only 0-2 counts. both tester slots busy 1-4: only 2-4 counts.
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 4 });
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 4 });
    const f = await flow(r);
    expect(f.wait_hours.no_slot).toBe(4);
  });

  test("a ticket with no role has no session and waits for no slot", async () => {
    const r = await room();
    const w = await mk(r, { status: "queued" });
    setRole(w, null);
    timeline(w, "claimed", [["ticket.created", 0, { status: "queued" }], ["ticket.claimed", 4]]);
    const o = await mk(r);
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    stage({ ticket: o, role: "worker", status: "running", launch: 0 });
    expect((await flow(r)).wait_hours.no_slot).toBe(0);
    // null to tester at 2: only the tester span counts (both tester slots busy 1-4)
    timeline(w, "claimed", [["ticket.created", 0, { status: "queued" }], ["ticket.edited", 2, { fields: ["role"], role: { from: null, to: "tester" } }], ["ticket.claimed", 4]]);
    setRole(w, "tester");
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 4 });
    stage({ ticket: o, role: "tester", verdict: "PASS", launch: 1, end: 4 });
    expect((await flow(r)).wait_hours.no_slot).toBe(2);
  });

  test("terminal high ticket does not hold approval", async () => {
    const r = await room();
    const high = await mk(r, { status: "draft", request_id: "rq-term", blast_radius: "high" });
    const p = await mk(r, { status: "draft", request_id: "rq-term" });
    timeline(high, "done", [["ticket.created", 0, { status: "draft" }], ["ticket.done", 1]]);
    timeline(p, "draft", [["ticket.created", 0, { status: "draft" }]]);
    stage({ request: "rq-term", scope: [p], role: "validator", verdict: "PASS", launch: 0, end: 1 });
    const f = await flow(r);
    expect(f.wait_hours.waiting_approval).toBe(0);
    expect(f.wait_hours.draft).toBe(11);
  });

  test("FAIL rate per role", async () => {
    const r = await room();
    const other = await room();
    const t = await mk(r);
    const o = await mk(other);
    const ver = (ticket: string, verdict: string, end: number) => stage({ ticket, role: "validator", verdict, launch: 0, end });
    ver(t, "PASS", 1); ver(t, "PASS", 2); ver(t, "PASS", 3); ver(t, "FAIL", 4);
    ver(t, "FAIL", 11); // after the window
    ver(o, "FAIL", 2); // another room
    stage({ request: "rq-spec", scope: [t], role: "validator", verdict: "PASS", launch: 0, end: 1 });
    stage({ request: "rq-spec", scope: [t], role: "validator", verdict: "FAIL", launch: 0, end: 2 });
    stage({ request: "rq-spec", scope: [t], role: "validator", verdict: "FAIL", launch: 0, end: 3 });
    const f = await flow(r);
    expect(f.reviews.validator).toEqual({ pass: 3, fail: 1, fail_percent: 25 });
    expect(f.reviews.spec).toEqual({ pass: 1, fail: 2, fail_percent: 66.7 });
    expect(f.reviews.reviewer).toEqual({ pass: 0, fail: 0, fail_percent: 0 });
  });

  /** Done tickets: one merged by a merge commit, one named only by a plain commit, one named nowhere. */
  async function doneSetup() {
    const r = await room();
    const merged = await mk(r);
    const plain = await mk(r);
    const none = await mk(r);
    db((d) => d.run("UPDATE tickets SET status = 'done' WHERE id IN (?, ?, ?)", [merged, plain, none]));
    const repo = makeRepo();
    sh(repo.dir, "git", "merge", "--no-ff", "-q", "feat", "-m", `Merge ticket/${merged}: work`);
    repo.commit("c.txt", `fix for ${plain}`);
    expect((await authedFetch(hub, `/rooms/${r.name}/settings`, { method: "PUT", body: JSON.stringify({ project_folder: repo.dir }) })).status).toBe(200);
    return { r, merged, plain, none };
  }

  test("done without merge commit", async () => {
    const { r, merged, none } = await doneSetup();
    const f = await flow(r);
    expect(f.staging).toBe("ok");
    const ids = f.done_without_merge.map((t: any) => t.id);
    expect(ids).not.toContain(merged);
    expect(ids).toContain(none);
    expect(f.done_without_merge.find((t: any) => t.id === none).named_by_non_merge_commit).toBe(false);
  });

  test("non-merge commit only is listed", async () => {
    const { r, plain } = await doneSetup();
    const f = await flow(r);
    const entry = f.done_without_merge.find((t: any) => t.id === plain);
    expect(entry).toBeDefined();
    expect(entry.named_by_non_merge_commit).toBe(true);
  });

  test("other room not counted", async () => {
    const { r } = await doneSetup();
    const other = await room();
    const f = await flow(other);
    expect(f.done_without_merge).toBeNull(); // no project folder: the merge check is unavailable, not a guess
    expect(f.staging).toBe("unavailable");
    expect(f.ready_tickets).toEqual([]);
    expect(f.reviews.validator.pass + f.reviews.validator.fail).toBe(0);
    expect(r.name).not.toBe(other.name);
  });

  test("no token 401", async () => {
    expect((await fetch(`${hub.url}/rooms/fl1/flow`)).status).toBe(401);
    expect((await fetch(`${hub.url}/rooms/fl1/flow?token=wrong`)).status).toBe(401);
    expect((await getJson(hub, "/rooms/fl1/flow?since=5&until=5")).status).toBe(400);
    expect((await getJson(hub, "/rooms/fl1/flow")).status).toBe(200); // default window: the last 24 hours
  });
});
