// One request id in two rooms (spec-review-stage 2.5b): a spec stage reads only its own room's handoff, commit and findings.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: string; stage_id: string; session: string; room: string; cwd: string | null; prompt: string };

describe("the same request id in two rooms", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: Req[] = [];
  let stream: ReturnType<typeof openSSE>;
  let c1 = "";
  let c2 = "";
  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  const launches = (room: string) => reqs.filter((r) => r.kind === "launch" && r.room === room);
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 80 && !fn(); i++) await sleep(50);
    expect(fn()).toBe(true);
  };

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), "tworooms-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    for (const n of ["1", "2"]) {
      writeFileSync(join(repo, "a.txt"), n);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", n);
    }
    c2 = git(repo, "rev-parse", "HEAD");
    c1 = git(repo, "rev-parse", "HEAD~1");
    hub = await spawnHub();
    for (const room of ["ta", "tb"]) {
      expect((await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify({ project_folder: repo }) })).status).toBe(200);
      open.push(await registerAgent(hub, `${room}-lead`, { room }));
      expect((await authedFetch(hub, `/rooms/${room}/lead`, { method: "POST", body: JSON.stringify({ by: hub.humanName, agent: `${room}-lead` }) })).status).toBe(200);
    }
    stream = openSSE(hub, "/launches/stream");
    void (async () => { try { for await (const e of stream.events) reqs.push(e as Req); } catch { /* closed */ } })();
    await sleep(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const draft = (room: string) => postJson(hub, "/tickets", { by: `${room}-lead`, title: `T-${room}`, acceptance_criteria: `criteria of ${room}`, blast_radius: "low", request_id: "req-1", status: "draft" });
  const spec = (room: string, text: string, commit: string) =>
    postJson(hub, "/handoffs", { from: `${room}-lead`, to_role: "validator", review: "spec", request_id: "req-1", task: "review", context: { request_text: text, commit } });

  test("both rooms review req-1 at once (one live spec stage per request is per room); each launch has its own text and commit", async () => {
    const ta = ((await draft("ta")).json as { snapshot: { id: string } }).snapshot.id;
    const tb = ((await draft("tb")).json as { snapshot: { id: string } }).snapshot.id;
    expect((await spec("ta", "TEXT-OF-A", c1)).status).toBe(201);
    expect((await spec("tb", "TEXT-OF-B", c2)).status).toBe(201);
    await until(() => launches("ta").length === 1 && launches("tb").length === 1);
    const a = launches("ta")[0];
    const b = launches("tb")[0];
    expect(a.prompt).toContain("TEXT-OF-A");
    expect(a.prompt).not.toContain("TEXT-OF-B");
    expect(b.prompt).toContain("TEXT-OF-B");
    expect(b.prompt).not.toContain("TEXT-OF-A");
    expect(git(a.cwd!, "rev-parse", "HEAD")).toBe(c1);
    expect(git(b.cwd!, "rev-parse", "HEAD")).toBe(c2);
    expect(a.prompt).toContain(ta);
    expect(a.prompt).not.toContain(tb);

    // Room B's review FAILs with a finding; room A's second review must not see it.
    expect((await postJson(hub, `/launches/${b.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, b.session, { room: "tb" }));
    const fail = await postJson(hub, "/handoffs", {
      from: b.session, to: "tb-lead", task: "verdict",
      context: { stage_id: b.stage_id, review: "spec", request_id: "req-1", verdict: "FAIL", findings: [{ ticket_id: tb, severity: "blocking", text: "FINDING-OF-B" }], questions_for_human: [] },
    });
    expect(fail.status, JSON.stringify(fail.json)).toBe(201);
    expect((await postJson(hub, `/launches/${a.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, a.session, { room: "ta" }));
    const pass = await postJson(hub, "/handoffs", {
      from: a.session, to: "ta-lead", task: "verdict",
      context: { stage_id: a.stage_id, review: "spec", request_id: "req-1", verdict: "PASS", findings: [], suggestions: [], questions_for_human: [] },
    });
    expect(pass.status, JSON.stringify(pass.json)).toBe(201);
  });

  test("a second review in room A has room A's request text only, and no finding of room B; one in room B has B's finding", async () => {
    // Close both finished sessions so their slots are free, then start a second review in each room.
    for (const room of ["ta", "tb"]) {
      const first = launches(room)[0];
      expect((await postJson(hub, `/stages/${first.stage_id}/turn-end`, { agent: first.session })).json).toEqual({ action: "close" });
    }
    await until(() => reqs.filter((r) => r.kind === "close").length === 2);
    for (const c of reqs.filter((r) => r.kind === "close")) expect((await postJson(hub, `/launches/${c.id}/ack`, { result: "spawned" })).status).toBe(200);
    await draft("ta"); // the PASS queued room A's first ticket; a new draft is what the second review covers
    expect((await spec("ta", "SECOND-A", c2)).status).toBe(201);
    expect((await spec("tb", "SECOND-B", c2)).status).toBe(201);
    await until(() => launches("ta").length === 2 && launches("tb").length === 2);
    const a2 = launches("ta")[1];
    const b2 = launches("tb")[1];
    expect(a2.prompt).toContain("SECOND-A");
    expect(a2.prompt).not.toContain("SECOND-B");
    expect(a2.prompt).not.toContain("FINDING-OF-B");
    expect(a2.prompt).not.toContain("earlier reviews"); // room A had a PASS and no FAIL
    expect(b2.prompt).toContain("FINDING-OF-B");
    expect(b2.prompt).toContain("SECOND-B");
    const stages = (await getJson(hub, "/stages?status=all")).json as Array<{ id: string }>;
    expect(stages.length).toBe(4);
  });
});
