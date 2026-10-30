// A Tester PASS says which tests ran: a full_suite object, or full_suite false with tests_run (real hub).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const FULL = "a".repeat(40);
const SUITE = { command: "./scripts/test.sh", exit_code: 0, pass: 10, fail: 0, log_path: "/tmp/l.log" };

describe("tester PASS evidence", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    const put = await authedFetch(hub, "/rooms/r1/settings", { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10, validator: 10, writer: 10 } }) });
    expect(put.status).toBe(200);
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    const sse = openSSE(hub, "/launches/stream");
    open.push(sse);
    void (async () => {
      try { for await (const req of sse.events) await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" }); } catch { /* closed */ }
    })();
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  /** A ticket of the radius with a running Tester stage. The shell stand-in in beforeAll acks every launch. */
  const running = async (radius: "low" | "high") => {
    const t = await postJson(hub, "/tickets", { by: "alice", title: "T", acceptance_criteria: "c", blast_radius: radius, priority: "medium", role: "tester" });
    const ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
    type S = { id: string; ticket_id: string; role: string; session: string };
    let stage: S | undefined;
    for (let i = 0; i < 100 && !stage; i++) {
      stage = ((await getJson(hub, "/stages?status=running")).json as S[]).find((x) => x.ticket_id === ticketId && x.role === "tester");
      if (!stage) await new Promise((r) => setTimeout(r, 50));
    }
    expect(stage).toBeTruthy();
    open.push(await registerAgent(hub, stage!.session, { room: "r1" }));
    return { ticketId, stageId: stage!.id, session: stage!.session };
  };
  const send = (s: { ticketId: string; stageId: string; session: string }, extra: Record<string, unknown>, verdict = "PASS") =>
    postJson(hub, "/handoffs", {
      from: s.session, to_role: "validator", task: "validate",
      context: { notes: "n", stage_id: s.stageId, ticket_id: s.ticketId, verdict, report: "r", commit: FULL, findings: [], ...extra },
    });
  const errors = (r: { json: unknown }) => (r.json as { errors: string[] }).errors;

  // A refused result keeps the stage running: the two refusal tests share one stage (the role limit allows few live stages).
  let refused: Awaited<ReturnType<typeof running>>;

  test("low PASS with no field: 400, one error line naming both forms", async () => {
    const s = (refused = await running("low"));
    const r = await send(s, {});
    expect(r.status).toBe(400);
    expect(errors(r)).toHaveLength(1);
    expect(errors(r)[0]).toContain("full_suite {command, exit_code, pass, fail, log_path}");
    expect(errors(r)[0]).toContain("tests_run");
  });

  test("low PASS with full_suite false and an empty, missing or malformed tests_run: 400", async () => {
    const s = refused;
    for (const extra of [
      { full_suite: false, tests_run: [] },
      { full_suite: false },
      { full_suite: false, tests_run: [""] },
      { full_suite: false, tests_run: [1] },
      { tests_run: ["tests/a.test.ts"] },
      { full_suite: { command: "x" } },
    ]) expect((await send(s, extra)).status).toBe(400);
  });

  test("low PASS with full_suite false and tests_run: accepted", async () => {
    const s = await running("low");
    const r = await send(s, { full_suite: false, tests_run: ["tests/integration/tester-pass-evidence.test.ts"] });
    expect(r.status).toBe(201);
  });

  test("low PASS with the full_suite object: accepted", async () => {
    const s = await running("low");
    expect((await send(s, { full_suite: SUITE })).status).toBe(201);
  });

  test("low FAIL with no field: accepted", async () => {
    const s = await running("low");
    const r = await send(s, { findings: [{ ticket_id: s.ticketId, severity: "blocking", text: "x" }] }, "FAIL");
    expect(r.status).not.toBe(400);
  });

  test("high PASS: the full_suite object stays required; tests_run does not replace it", async () => {
    const s = await running("high");
    const r = await send(s, { full_suite: false, tests_run: ["tests/a.test.ts"] });
    expect(r.status).toBe(400);
    expect(errors(r).join("\n")).toContain("context.full_suite is required for a high-radius ticket");
  });
});
