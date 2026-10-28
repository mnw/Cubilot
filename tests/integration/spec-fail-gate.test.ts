// spec-fail-gate 1-7 through the real hub: after two spec FAILs since the last PASS only the human sends a spec review.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Req = { id: string; kind: string; stage_id?: string; session: string; prompt?: string; room?: string };
type Stage = { id: string; status: string; verdict: string | null; request_id: string | null };
const REASON = "spec FAIL limit: the human must send this review";

describe("spec FAIL gate", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const reqs: Req[] = [];
  const leadEntries: Array<{ from?: string; to?: string; text?: string; room?: string }> = [];
  const uiEntries: Array<{ from?: string; to?: string; text?: string; room?: string }> = [];
  const streams: Array<{ close: () => void }> = [];
  let seq = 0;

  const until = async (fn: () => boolean, ms = 4000) => {
    for (let i = 0; i < ms / 50 && !fn(); i++) await sleep(50);
    expect(fn()).toBe(true);
  };
  const launchCount = () => reqs.filter((r) => r.kind === "launch").length;
  const draft = (room: string, request_id: string) =>
    postJson(hub, "/tickets", { by: room === "gh" ? "obs-gh" : "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", request_id, status: "draft" }).then(
      (r) => (r.json as { snapshot: { id: string } }).snapshot.id,
    );
  const spec = (from: string, request_id: string, ticket_ids?: unknown) =>
    postJson(hub, "/handoffs", {
      from, to_role: "validator", review: "spec", request_id, task: "review",
      context: { request_text: "Build X", ...(ticket_ids !== undefined ? { ticket_ids } : {}) },
    });
  const handoffRoom = (id: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db.query<{ room: string }, [string]>("SELECT room FROM handoffs WHERE id = ?").get(id)!.room;
    } finally {
      db.close();
    }
  };
  const stages = async () => (await getJson(hub, "/stages?status=all")).json as Stage[];
  const counts = () => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return {
        handoffs: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()!.n,
        stages: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stage").get()!.n,
        events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
      };
    } finally {
      db.close();
    }
  };
  /** The stored fail_count of every spec result of the request, oldest first. */
  const storedCounts = (request: string) => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db
        .query<{ c: string }, [string]>(
          `SELECT context_json AS c FROM handoffs WHERE json_extract(context_json, '$.review') = 'spec' AND json_extract(context_json, '$.request_id') = ?1
            AND json_extract(context_json, '$.verdict') = 'FAIL' ORDER BY rowid`,
        )
        .all(request)
        .map((r) => (JSON.parse(r.c) as { fail_count?: number }).fail_count);
    } finally {
      db.close();
    }
  };

  /** The launch the hub made last: acked, and its session connected (so it is running). */
  const startLaunch = async (room: string) => {
    const l = reqs.filter((r) => r.kind === "launch").at(-1)!;
    expect((await postJson(hub, `/launches/${l.id}/ack`, { result: "spawned" })).status).toBe(200);
    open.push(await registerAgent(hub, l.session, { room }));
    return l;
  };
  const result = (l: Req, request: string, verdict: "PASS" | "FAIL", ticket: string, extra: Record<string, unknown> = {}) =>
    postJson(hub, "/handoffs", {
      from: l.session, to: l.room === "gh" ? hub.humanName : "Orchestrator", task: "spec verdict",
      context: {
        notes: "n", stage_id: l.stage_id, review: "spec", request_id: request, verdict,
        findings: verdict === "FAIL" ? [{ ticket_id: ticket, severity: "blocking", text: `finding ${++seq}` }] : [],
        suggestions: [], questions_for_human: [], ...extra,
      },
    });
  /** The session ends its turn: the close is queued and acked, so the slot is free. */
  const endSession = async (l: Req) => {
    const n = reqs.filter((r) => r.kind === "close").length;
    expect((await postJson(hub, `/stages/${l.stage_id}/turn-end`, { agent: l.session })).json).toEqual({ action: "close" });
    await until(() => reqs.filter((r) => r.kind === "close").length > n);
    const close = reqs.filter((r) => r.kind === "close").at(-1)!;
    expect((await postJson(hub, `/launches/${close.id}/ack`, { result: "spawned" })).status).toBe(200);
  };
  /** One whole review of the request, sent by `from`: a new draft ticket, the launch, the verdict, the close. */
  const review = async (room: string, from: string, request: string, verdict: "PASS" | "FAIL", extra: Record<string, unknown> = {}) => {
    const ticket = await draft(room, request);
    const n = launchCount();
    expect((await spec(from, request)).status).toBe(201);
    await until(() => launchCount() === n + 1);
    const l = await startLaunch(room);
    const r = await result(l, request, verdict, ticket, extra);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await endSession(l);
    return { l, ticket };
  };

  beforeAll(async () => {
    hub = await spawnHub({ defaultRoom: "gf" }); // the human lives in the default room
    await giveProjectHttp(hub, "gf", "gh");
    const lead = openSSE(hub, "/agent-stream?agent=Orchestrator&room=gf");
    streams.push(lead);
    void (async () => { try { for await (const e of lead.events) leadEntries.push(e); } catch { /* closed */ } })();
    const ui = openSSE(hub, "/stream");
    streams.push(ui);
    void (async () => { try { for await (const e of ui.events) uiEntries.push(e); } catch { /* closed */ } })();
    const launches = openSSE(hub, "/launches/stream");
    streams.push(launches);
    void (async () => { try { for await (const e of launches.events) reqs.push(e as Req); } catch { /* closed */ } })();
    open.push(await registerAgent(hub, "obs-gh", { room: "gh" }));
    // The human is the lead of room gh. The lead route refuses the human as a name, so the row is written directly.
    const db = new Database(hub.ledgerPath);
    db.run("INSERT INTO ticket_room_lead (room, agent, updated_at_ms) VALUES ('gh', ?, 1)", [hub.humanName]);
    db.close();
    await sleep(300);
  });
  afterAll(async () => {
    for (const s of streams) s.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  test("(h, e) the first message says N = 1 for the first review; the stored fail_count is 1 even when the Validator sends 9", async () => {
    await review("gf", "Orchestrator", "req-a", "FAIL", { fail_count: 9 });
    expect(reqs.filter((r) => r.kind === "launch").at(-1)!.prompt).toContain("This is spec review 1 of this request since its last PASS.");
    expect(storedCounts("req-a")).toEqual([1]);
  });

  test("(h, e, f, i) after one FAIL the next first message says N = 2; the second FAIL (no escalate) is stored as 2 and tells the lead and the human the same text", async () => {
    await review("gf", "Orchestrator", "req-a", "FAIL", { fail_count: 0 });
    expect(reqs.filter((r) => r.kind === "launch").at(-1)!.prompt).toContain("This is spec review 2 of this request since its last PASS.");
    expect(storedCounts("req-a")).toEqual([1, 2]);
    await until(() => leadEntries.some((e) => e.from === "system" && e.text?.includes("req-a failed 2 times")));
    const toLead = leadEntries.filter((e) => e.from === "system" && e.text?.includes("req-a failed 2 times"));
    const toHuman = uiEntries.filter((e) => e.from === "system" && e.text?.includes("req-a failed 2 times"));
    expect(toLead).toHaveLength(1);
    expect(toHuman).toHaveLength(1);
    expect(toLead[0].to).toBe("Orchestrator");
    expect(toHuman[0].to).toBe(hub.humanName);
    expect(toLead[0].text).toBe(toHuman[0].text);
  });

  test("(a, i) a third review from the Orchestrator gets 409 with the count; no handoff, stage or event is written", async () => {
    await draft("gf", "req-a");
    const before = counts();
    const r = await spec("Orchestrator", "req-a");
    expect(r.status).toBe(409);
    const err = (r.json as { error: string }).error;
    expect(err).toContain("2 spec FAILs");
    expect(err).toContain("the human must send this review");
    expect(counts()).toEqual(before);
  });

  test("(g, c) Needs-you lists the request while the human's newer review is open; the human's review starts a stage", async () => {
    const n = launchCount();
    const named = await draft("gf", "req-a");
    expect((await spec(hub.humanName, "req-a", [named])).status).toBe(201);
    await until(() => launchCount() === n + 1);
    const l = await startLaunch("gf");
    expect((await stages()).find((s) => s.id === l.stage_id)!.status).toBe("running");
    const rows = ((await getJson(hub, "/requests/gf/needs-you")).json as { requests: Array<{ request_id: string; fail_count: number }> }).requests;
    expect(rows).toEqual([expect.objectContaining({ request_id: "req-a", fail_count: 2 })]);
    // The human's review ends with a PASS: the row goes and the Orchestrator may send again (d).
    expect((await result(l, "req-a", "PASS", "")).status).toBe(201);
    await endSession(l);
    expect(((await getJson(hub, "/requests/gf/needs-you")).json as { requests: unknown[] }).requests).toEqual([]);
  });

  test("(d, h) a PASS lets the Orchestrator send again; its first message says N = 1", async () => {
    await draft("gf", "req-a");
    const n = launchCount();
    expect((await spec("Orchestrator", "req-a")).status).toBe(201);
    await until(() => launchCount() === n + 1);
    const l = await startLaunch("gf");
    expect(reqs.filter((r) => r.kind === "launch").at(-1)!.prompt).toContain("This is spec review 1 of this request since its last PASS.");
    await result(l, "req-a", "PASS", "");
    await endSession(l);
  });

  test("(b, i) two queued stages from the Orchestrator fail with the reason when the second FAIL is recorded; neither launches", async () => {
    await review("gf", "Orchestrator", "req-b", "FAIL");
    const ticket = await draft("gf", "req-b");
    const n = launchCount();
    expect((await spec("Orchestrator", "req-b")).status).toBe(201);
    await until(() => launchCount() === n + 1);
    const running = await startLaunch("gf");
    expect((await spec("Orchestrator", "req-b")).status).toBe(201); // queued: one live spec stage per request
    expect((await spec("Orchestrator", "req-b")).status).toBe(201); // queued
    const queued = (await stages()).filter((s) => s.request_id === "req-b" && s.status === "queued");
    expect(queued).toHaveLength(2);
    expect((await result(running, "req-b", "FAIL", ticket)).status).toBe(201);
    const after = await stages();
    for (const q of queued) expect(after.find((s) => s.id === q.id)!.status).toBe("failed");
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      for (const q of queued) {
        const ev = db.query<{ p: string }, [string]>("SELECT payload_json AS p FROM events WHERE entity_id = ? AND kind = 'stage.failed'").get(q.id);
        expect(ev?.p, q.id).toContain(REASON);
      }
    } finally {
      db.close();
    }
    await endSession(running);
    await sleep(300);
    expect(launchCount()).toBe(n + 1); // nothing launched after the running stage closed
  });

  test("(c) a queued stage from the human stays queued when the second FAIL is recorded, and starts when the slot is free", async () => {
    await review("gf", "Orchestrator", "req-c", "FAIL");
    const ticket = await draft("gf", "req-c");
    const n = launchCount();
    expect((await spec("Orchestrator", "req-c")).status).toBe(201);
    await until(() => launchCount() === n + 1);
    const running = await startLaunch("gf");
    expect((await spec(hub.humanName, "req-c", [ticket])).status).toBe(201); // queued
    const queued = (await stages()).find((s) => s.request_id === "req-c" && s.status === "queued")!;
    expect((await result(running, "req-c", "FAIL", ticket)).status).toBe(201);
    expect((await stages()).find((s) => s.id === queued.id)!.status).toBe("queued");
    await endSession(running);
    await until(() => launchCount() === n + 2);
  });

  test("(f) the lead is the human: exactly one notice, to the human", async () => {
    await review("gh", "obs-gh", "req-h", "FAIL");
    await review("gh", "obs-gh", "req-h", "FAIL");
    await sleep(200);
    const ui = uiEntries.filter((e) => e.from === "system" && e.text?.includes("req-h failed 2 times"));
    expect(ui).toHaveLength(1);
    expect(ui[0].to).toBe(hub.humanName);
    // The agent of that room got no copy.
    expect(leadEntries.filter((e) => e.text?.includes("req-h failed"))).toHaveLength(0);
  });

  test("the count is per room: the same request id in another room is not gated", async () => {
    await draft("gf", "req-h");
    expect((await spec("Orchestrator", "req-h")).status).toBe(201);
  });

  test("human-review-room (a) the human's review after two FAILs takes the room of its ticket (not the human's default room); N = 3", async () => {
    await review("gh", "obs-gh", "req-hr", "FAIL");
    await review("gh", "obs-gh", "req-hr", "FAIL");
    const ticket = await draft("gh", "req-hr");
    const n = launchCount();
    const stagesBefore = (await stages()).filter((s) => s.request_id === "req-hr").length;
    const r = await spec(hub.humanName, "req-hr", [ticket]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(handoffRoom((r.json as { id: string }).id)).toBe("gh");
    await until(() => launchCount() === n + 1);
    expect((await stages()).filter((s) => s.request_id === "req-hr")).toHaveLength(stagesBefore + 1);
    const l = await startLaunch("gh");
    expect(l.room).toBe("gh");
    expect(l.prompt).toContain("This is spec review 3 of this request since its last PASS.");
    expect((await result(l, "req-hr", "PASS", "")).status).toBe(201);
    await endSession(l);
  });

  test("human-review-room (b) the human names tickets of two rooms: 400, nothing recorded", async () => {
    const a = await draft("gf", "req-two");
    const b = await draft("gh", "req-two");
    const before = counts();
    const r = await spec(hub.humanName, "req-two", [a, b]);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("one room");
    expect(counts()).toEqual(before);
  });

  test("human-review-room (c, c2) the human names no tickets, or an empty list: 400 naming ticket_ids, nothing recorded", async () => {
    await draft("gf", "req-none");
    const before = counts();
    for (const ids of [undefined, []]) {
      const r = await spec(hub.humanName, "req-none", ids);
      expect(r.status).toBe(400);
      expect((r.json as { error: string }).error).toContain("ticket_ids");
      expect(counts()).toEqual(before);
    }
  });

  test("human-review-room: an unknown ticket from the human is 400, nothing recorded", async () => {
    const before = counts();
    const r = await spec(hub.humanName, "req-none", ["t_0000000000000000"]);
    expect(r.status).toBe(400);
    expect(counts()).toEqual(before);
  });

  test("human-review-room (e) an agent with fewer than two FAILs and no ticket_ids: its own room, default scope", async () => {
    await draft("gh", "req-e");
    const r = await spec("obs-gh", "req-e");
    expect(r.status).toBe(201);
    expect(handoffRoom((r.json as { id: string }).id)).toBe("gh");
  });
});
