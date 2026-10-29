// Role gate: a ticket whose role has no hub stage chain (writer, editor, reviewer) never enters queued.
// Temporary: the writing chain (t_922581db0beb6fe4) removes the gate. Real hub, HTTP only.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_CHAIN = ["writer", "editor", "reviewer"];
const LEAD = "Orchestrator";

describe("role chain gate", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const held: any[] = [];
  const launches: any[] = [];
  let launchStream: ReturnType<typeof openSSE>;
  let n = 0;

  // The board observer: every ticket.* entry the hub broadcasts. A refused call must add none.
  const seen: any[] = [];
  let ui: ReturnType<typeof openSSE>;
  const list = async () => (await getJson(hub, "/tickets?room=rc&status=all&archived=1")).json as any[];
  const find = async (id: string) => (await list()).find((t) => t.id === id);
  const status = async (id: string) => (await find(id)).status as string;
  const version = async (id: string) => (await find(id)).version as number;
  const tickets = async () => (await list()).length;
  const marker = async () => { await sleep(300); return seen.length; };
  const quiet = async (mark: number) => { await sleep(300); expect(seen.slice(mark).map((e) => e.kind)).toEqual([]); };
  const mk = async (over: Record<string, unknown> = {}, by = "rc-alice") => {
    const r = await postJson(hub, "/tickets", { by, title: "T", acceptance_criteria: "c", blast_radius: "low", ...over });
    return { r, id: (r.json as any)?.snapshot?.id as string };
  };
  const draft = async (request_id: string, role: string | null, over: Record<string, unknown> = {}) => {
    const { r, id } = await mk({ status: "draft", request_id, ...(role ? { role } : {}), ...over });
    expect(r.status).toBe(201);
    return id;
  };
  const move = (id: string, by: string, to = "queued") => postJson(hub, `/tickets/${id}/transition`, { by, to });
  const heldMessages = () => held.filter((e) => e.kind === "ticket.held");

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), "rolegate-"));
    const git = (...a: string[]) => {
      const x = Bun.spawnSync(["git", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (x.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${x.stderr}`);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1");
    git("add", ".");
    git("commit", "-qm", "1");
    hub = await spawnHub();
    expect((await authedFetch(hub, "/rooms/rc/settings", { method: "PUT", body: JSON.stringify({ project_folder: repo, role_limits: { validator: 1 } }) })).status).toBe(200);
    open.push(await registerAgent(hub, "rc-alice", { room: "rc" }));
    open.push(await registerAgent(hub, "rc-bob", { room: "rc" }));
    // The lead's stream: collect what the hub sends it.
    const lead = openSSE(hub, `/agent-stream?agent=${LEAD}&room=rc`);
    open.push(lead);
    void (async () => { try { for await (const e of lead.events) held.push(e); } catch { /* closed */ } })();
    ui = openSSE(hub, "/stream");
    open.push(ui);
    void (async () => { try { for await (const e of ui.events) if (typeof e.kind === "string" && e.kind.startsWith("ticket.")) seen.push(e); } catch { /* closed */ } })();
    launchStream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of launchStream.events) launches.push(e); } catch { /* closed */ } })();
    expect((await postJson(hub, "/rooms/rc/lead", { by: hub.humanName, agent: LEAD })).status).toBe(200);
    await sleep(300);
  });
  afterAll(async () => {
    launchStream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  for (const role of NO_CHAIN) {
    test(`${role}: create as queued (default and explicit) is 409, no row; draft is 201`, async () => {
      const before = await tickets();
      const mark = await marker();
      for (const extra of [{}, { status: "queued" }]) {
        const { r } = await mk({ role, ...extra });
        expect(r.status).toBe(409);
        expect((r.json as any).error).toBe(`role ${role} has no hub stage chain: create the ticket as draft`);
      }
      expect(await tickets()).toBe(before);
      await quiet(mark);
      expect((await mk({ role, status: "draft" })).r.status).toBe(201);
    });

    test(`${role}: a move to queued is 409 for the human and the lead; the row and the events do not change`, async () => {
      const id = await draft(`rq-move-${role}`, role);
      const v0 = await version(id);
      const mark = await marker();
      for (const by of [hub.humanName, LEAD]) {
        const r = await move(id, by);
        expect(r.status).toBe(409);
        expect((r.json as any).error).toBe(`role ${role} has no hub stage chain: ticket ${id} cannot enter queued`);
      }
      expect(await status(id)).toBe("draft");
      expect(await version(id)).toBe(v0);
      await quiet(mark);
      // A non-lead agent keeps its 403.
      expect((await move(id, "rc-bob")).status).toBe(403);
    });

    test(`${role}: the lead still gets 403 on a high-radius request before the role check`, async () => {
      const id = await draft(`rq-high-${role}`, role, { blast_radius: "high" });
      const r = await move(id, LEAD);
      expect(r.status).toBe(403);
      expect((r.json as any).error).toContain("needs the human's Approve");
      expect((await move(id, hub.humanName)).status).toBe(409);
    });
  }

  test("worker and role null still queue: create, move", async () => {
    for (const role of ["worker", null]) {
      const extra = role ? { role } : {};
      expect((await mk(extra)).r.status).toBe(201);
      const id = await draft(`rq-ok-${role}`, role);
      expect((await move(id, LEAD)).status).toBe(200);
      expect(await status(id)).toBe("queued");
    }
  });

  test("approval: no-chain drafts stay draft, the others queue, not_queued lists them, one lead message", async () => {
    const request = `rq-appr-${++n}`;
    const ok = await draft(request, "worker");
    const none = await draft(request, null);
    const stuck = new Map<string, string>();
    for (const role of NO_CHAIN) stuck.set(await draft(request, role), role);
    const before = heldMessages().length;
    const r = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect(r.status).toBe(200);
    const body = r.json as any;
    expect(body.queued.sort()).toEqual([ok, none].sort());
    expect(body.idempotent).toBeUndefined();
    expect([...body.not_queued].sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(
      [...stuck].map(([id, role]) => ({ id, role, reason: `role ${role} has no hub stage chain` })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect([await status(ok), await status(none)]).toEqual(["queued", "queued"]);
    for (const id of stuck.keys()) expect(await status(id)).toBe("draft");
    await sleep(300);
    const msgs = heldMessages().slice(before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("system");
    for (const [id, role] of stuck) {
      expect(msgs[0].text).toContain(id);
      expect(msgs[0].text).toContain(`role ${role}`);
    }
    // A second approval still has held drafts: not idempotent, one more message.
    const again = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect((again.json as any).queued).toEqual([]);
    expect((again.json as any).not_queued).toHaveLength(3);
    expect((again.json as any).idempotent).toBeUndefined();
  });

  test("approval with only chain roles keeps today's shape: not_queued empty, repeat is idempotent", async () => {
    const request = `rq-appr-${++n}`;
    await draft(request, "worker");
    const before = heldMessages().length;
    const r = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect((r.json as any).not_queued).toEqual([]);
    const again = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect((again.json as any).idempotent).toBe(true);
    await sleep(200);
    expect(heldMessages()).toHaveLength(before);
  });

  test("spec PASS: no-chain drafts stay draft, the others queue without rollback, the lead gets one message", async () => {
    const request = `rq-pass-${++n}`;
    const ok = await draft(request, "worker");
    const none = await draft(request, null);
    const stuck = new Map<string, string>();
    for (const role of NO_CHAIN) stuck.set(await draft(request, role), role);
    const before = heldMessages().length;
    const spec = await postJson(hub, "/handoffs", { from: "rc-alice", to_role: "validator", review: "spec", request_id: request, task: "review", context: { request_text: "X" } });
    expect(spec.status).toBe(201);
    const launch = async () => {
      for (let i = 0; i < 80 && !launches.some((l) => l.kind === "launch" && l.role === "validator"); i++) await sleep(50);
      return launches.find((l) => l.kind === "launch" && l.role === "validator");
    };
    const l = await launch();
    expect(l).toBeTruthy();
    expect((await postJson(hub, `/launches/${l.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, l.session, { room: "rc" }));
    const pass = await postJson(hub, "/handoffs", {
      from: l.session, to: LEAD, task: "result",
      context: { notes: "n", stage_id: l.stage_id, review: "spec", request_id: request, verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
    expect([await status(ok), await status(none)]).toEqual(["queued", "queued"]);
    for (const id of stuck.keys()) expect(await status(id)).toBe("draft");
    await sleep(300);
    const msgs = heldMessages().slice(before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("system");
    for (const [id, role] of stuck) {
      expect(msgs[0].text).toContain(id);
      expect(msgs[0].text).toContain(`role ${role}`);
    }
  });
});
