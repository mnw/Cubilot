// Writing roles: a ticket with role writer, editor or reviewer queues like any other (the gate of t_9d878ebf272a9177 is gone).
// Real hub, HTTP only.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_CHAIN = ["writer", "editor", "reviewer"];
const LEAD = "Orchestrator";

describe("writing roles queue", () => {
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
    launchStream = openLaunchStream(hub);
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
    test(`${role}: create as queued (default and explicit) is 201; draft is 201`, async () => {
      for (const extra of [{}, { status: "queued" }, { status: "draft" }]) {
        const { r, id } = await mk({ role, ...extra });
        expect(r.status).toBe(201);
        expect(await status(id)).toBe((extra as any).status ?? "queued");
      }
    });

    test(`${role}: a move to queued is 200 for the human and the lead; a non-lead agent keeps its 403`, async () => {
      for (const by of [hub.humanName, LEAD]) {
        const id = await draft(`rq-move-${role}-${by}`, role);
        expect((await move(id, by)).status).toBe(200);
        expect(await status(id)).toBe("queued");
      }
      const id = await draft(`rq-move-${role}-bob`, role);
      expect((await move(id, "rc-bob")).status).toBe(403);
    });

    test(`${role}: the lead still gets 403 on a high-radius request, the human queues it`, async () => {
      const id = await draft(`rq-high-${role}`, role, { blast_radius: "high" });
      const r = await move(id, LEAD);
      expect(r.status).toBe(403);
      expect((r.json as any).error).toContain("needs the human's Approve");
      expect((await move(id, hub.humanName)).status).toBe(200);
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

  test("approval queues the writing roles with the others", async () => {
    const request = `rq-appr-${++n}`;
    const ids = [await draft(request, "worker"), await draft(request, null)];
    for (const role of NO_CHAIN) ids.push(await draft(request, role));
    const r = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect(r.status).toBe(200);
    const body = r.json as any;
    expect(body.queued.sort()).toEqual([...ids].sort());
    expect(body.not_queued).toBeUndefined();
    for (const id of ids) expect(await status(id)).toBe("queued");
    const again = await postJson(hub, `/requests/rc/${request}/approve`, { by: hub.humanName });
    expect((again.json as any).idempotent).toBe(true);
  });

  test("spec PASS queues the writing roles with the others", async () => {
    const request = `rq-pass-${++n}`;
    const ok = await draft(request, "worker");
    const none = await draft(request, null);
    const roleIds: string[] = [];
    for (const role of NO_CHAIN) roleIds.push(await draft(request, role));
    const spec = await postJson(hub, "/handoffs", { from: "rc-alice", to_role: "validator", review: "spec", request_id: request, task: "review", context: { request_text: "X" } });
    expect(spec.status).toBe(201);
    const launch = async () => {
      for (let i = 0; i < 80 && !launches.some((l) => l.kind === "launch" && l.role === "validator"); i++) await sleep(50);
      return launches.find((l) => l.kind === "launch" && l.role === "validator");
    };
    const l = await launch();
    expect(l).toBeTruthy();
    expect((await ackLaunch(hub, l.id, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, l.session, { room: "rc" }));
    const pass = await postJson(hub, "/handoffs", {
      from: l.session, to: LEAD, task: "result",
      context: { notes: "n", stage_id: l.stage_id, review: "spec", request_id: request, verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
    expect([await status(ok), await status(none)]).toEqual(["queued", "queued"]);
    for (const id of roleIds) expect(await status(id)).toBe("queued");
  });
});
