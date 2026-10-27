// Stage metrics writer (context-pack 5.1, 5.3, brief test 16). Fixture transcripts use the field names recorded in
// openspec/changes/context-pack/tasks.md 5.4 (Claude Code 2.1.311).

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import { HANDOFF_SECTION_MAX, NOTES_SECTION_MAX, PACK_SECTION_MAX, renderFirstMessage } from "../../hub/core/first-message";
import { renderStable } from "../../hub/core/primer";
import { HEAD_CAP_BYTES, MAX_FIRST_MESSAGE_BYTES, claudeProjectFolder, metricsByRole, recordStageMetrics, selectTranscript, stagesMissingMetrics } from "../../hub/core/stage-metrics";
import type { Entry, HubCapabilities, RouteDef, Scope } from "../../hub/core/types";
import type { LaunchRequest } from "../../hub/core/launch-queue";

type U = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
const usage = (input_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number, output_tokens: number): U => ({
  input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
});
const line = (o: unknown) => JSON.stringify(o);
const user = (ts: number, text: string) => line({ type: "user", timestamp: new Date(ts).toISOString(), message: { role: "user", content: text } });
const asst = (id: string, u: U, tool?: string) =>
  line({ type: "assistant", message: { id, usage: u, content: tool ? [{ type: "tool_use", name: tool, input: {} }] : [{ type: "text", text: "x" }] } });

/** A transcript file: `mode` and `permission-mode` lines first (no timestamp), then the first user message. */
function transcript(folder: string, name: string, ts: number, firstText: string, ...rest: string[]): string {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${name}.jsonl`);
  writeFileSync(file, [line({ type: "mode", mode: "x" }), user(ts, firstText), ...rest].join("\n") + "\n");
  return file;
}

function makeEnv(extra: { recordMetrics?: typeof recordStageMetrics } = {}) {
  const projects = mkdtempSync(join(tmpdir(), "sm-projects-"));
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: 60_000, bootGraceMs: 1000, claudeProjectsDir: projects, ...extra });
  rt.module.migrate(db);
  giveProject(db, "r1");
  const cap = {
    db,
    sse: { emit: (_e: Entry, _s: Scope) => {} },
    briefing: { refresh: () => {} },
    agents: { get: (_n: string) => null },
  } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  rt.queue.attach((r) => sent.push(r), new AbortController().signal, cap);
  const tid = "t_0000000000000001";
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 'worker', 1, 1, 1)`,
    [tid],
  );
  rt.evaluateStages(tid, cap, [], { launch: true });
  const stageId = db.query<{ id: string }, []>("SELECT id FROM stage").get()!.id;
  const launches = () => sent.filter((r) => r.kind === "launch") as Array<Extract<LaunchRequest, { kind: "launch" }>>;
  const spawn = () => {
    const l = launches().at(-1)!;
    rt.queue.ack(l.id, { result: "spawned" }, cap);
    return l;
  };
  const route = rt.module.routes.find((r: RouteDef) => r.method === "POST" && String(r.path).includes("turn-end"))!;
  const turnEnd = (session: string) => route.handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ agent: session }) }), cap, { id: stageId });
  /** Attempt 2: two stops, the close ack, the relaunch. */
  const retry = async () => {
    await turnEnd("worker-1");
    await turnEnd("worker-1");
    for (const r of sent) if (r.kind === "close") rt.queue.ack(r.id, { result: "spawned" }, cap);
  };
  /** The window of attempt N starts at its stage.launching event: pin the times so the fixtures need no clock. */
  const pinLaunchTimes = (...ms: number[]) => {
    const seqs = db.query<{ seq: number }, [string]>("SELECT seq FROM events WHERE entity_id = ? AND kind = 'stage.launching' ORDER BY seq").all(stageId);
    seqs.forEach((s, i) => db.run("UPDATE events SET at_ms = ? WHERE seq = ?", [ms[i], s.seq]));
  };
  const pass = async () => {
    const r = rt.api.move(stageId, { to: "passed" }, "system", cap);
    await rt.metricsIdle();
    return r;
  };
  const rows = () => db.query<Record<string, unknown>, []>("SELECT * FROM stage_metrics ORDER BY attempt").all();
  const folder = (l: LaunchRequest & { kind: "launch" }) => claudeProjectFolder(l.cwd!, projects);
  return { db, rt, cap, projects, stageId, spawn, launches, retry, pinLaunchTimes, pass, rows, folder, turnEnd };
}

// The hub logs through console.error; collect only the metrics lines.
const realError = console.error;
let logged: string[] = [];
function capture() {
  logged = [];
  console.error = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.startsWith("[stage-metrics]")) logged.push(s);
  };
}
afterEach(() => {
  console.error = realError;
});

describe("stage metrics writer", () => {
  test("a transcript gives the first-message numbers, the first request's cache read and the tokens before the first Edit", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(
      e.folder(l), "s1", 1500, `You are the worker. Stage: ${e.stageId}`,
      asst("m1", usage(1, 0, 0, 1)), // a partial line of request m1: the last line of an id wins
      asst("m1", usage(10, 200, 3000, 50)),
      asst("m2", usage(5, 0, 3200, 40), "Edit"),
      asst("m3", usage(1, 0, 3300, 10)), // after the Edit: not counted
    );
    await e.pass();
    const [r] = e.rows();
    expect(r).toMatchObject({
      stage_id: e.stageId, attempt: 1, role: "worker", source: "claude",
      first_message_bytes: Buffer.byteLength(l.prompt),
      first_message_tokens_est: Math.ceil(Buffer.byteLength(l.prompt) / 4),
      prompt_tokens_first: 10 + 200 + 3000,
      cache_read_tokens: 3000,
      tokens_before_action: 10 + 200 + 3000 + 50 + (5 + 0 + 3200 + 40),
    });
    expect(logged).toEqual([]);
  });

  test("a failed stage gets one normal metrics row", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(
      e.folder(l), "s1", 1500, `You are the worker. Stage: ${e.stageId}`,
      asst("m1", usage(10, 200, 3000, 50)),
      asst("m2", usage(5, 0, 3200, 40), "Edit"),
    );
    const r = e.rt.api.move(e.stageId, { to: "failed", reason: "test" }, "system", e.cap);
    await e.rt.metricsIdle();
    expect(r.status).toBe("failed");
    const rows = e.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage_id: e.stageId, attempt: 1, role: "worker", source: "claude",
      first_message_bytes: Buffer.byteLength(l.prompt),
      first_message_tokens_est: Math.ceil(Buffer.byteLength(l.prompt) / 4),
      prompt_tokens_first: 10 + 200 + 3000,
      cache_read_tokens: 3000,
      tokens_before_action: 10 + 200 + 3000 + 50 + (5 + 0 + 3200 + 40),
    });
    expect(logged).toEqual([]);
  });

  test("the result handoff is an action: a Tester that never edits counts up to its verdict", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(e.folder(l), "s1", 1500, e.stageId, asst("m1", usage(1, 0, 100, 5)), asst("m2", usage(1, 0, 100, 7), "mcp__chatbridge__send_handoff"), asst("m3", usage(9, 9, 9, 9)));
    await e.pass();
    expect(e.rows()[0]).toMatchObject({ source: "claude", tokens_before_action: 106 + 108 });
  });

  test("a retry has two rows, and each attempt uses its own file, not an older one (selection window)", async () => {
    capture();
    const e = makeEnv();
    const l1 = e.spawn();
    await e.retry();
    const l2 = e.spawn();
    expect(l2.cwd).toBe(l1.cwd); // the reused worktree: one project folder
    e.pinLaunchTimes(1000, 5000);
    const f = e.folder(l1);
    transcript(f, "old-stage", 100, "You are the worker. Stage: s_ffffffffffffffff", asst("o", usage(1, 0, 999, 1)));
    transcript(f, "old-same-id", 200, `Stage: ${e.stageId}`, asst("o", usage(1, 0, 888, 1))); // before the window of attempt 1
    transcript(f, "a1", 1200, `Stage: ${e.stageId}`, asst("a", usage(1, 0, 111, 1)));
    transcript(f, "a2", 5200, `Stage: ${e.stageId}`, asst("b", usage(1, 0, 222, 1)));
    await e.pass();
    const rows = e.rows();
    expect(rows.map((r) => [r.attempt, r.source, r.cache_read_tokens])).toEqual([[1, "claude", 111], [2, "claude", 222]]);
    expect(logged).toEqual([]);
  });

  test("attempt 1 has no transcript and attempt 2 has one: NULLs and source none for attempt 1, the file for attempt 2", async () => {
    capture();
    const e = makeEnv();
    const l1 = e.spawn();
    await e.retry();
    e.spawn();
    e.pinLaunchTimes(1000, 5000);
    transcript(e.folder(l1), "a2", 5100, `Stage: ${e.stageId}`, asst("b", usage(2, 0, 70, 3)));
    await e.pass();
    const [a1, a2] = e.rows();
    expect(a1).toMatchObject({ attempt: 1, source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null });
    expect(a1!.first_message_bytes).toBe(Buffer.byteLength(l1.prompt));
    expect(a2).toMatchObject({ attempt: 2, source: "claude", cache_read_tokens: 70 });
    expect(logged).toHaveLength(1);
  });

  test("a missing transcript stores NULL and source none, keeps the first-message size, leaves the stage passed, logs one line", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    await e.pass();
    expect(e.rt.api.load(e.stageId)!.status).toBe("passed");
    expect(e.rows()[0]).toMatchObject({
      source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null,
      first_message_bytes: Buffer.byteLength(l.prompt),
    });
    expect(logged).toHaveLength(1);
  });

  test("a transcript without usage stores source none and logs one line", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(e.folder(l), "s1", 1500, e.stageId);
    await e.pass();
    expect(e.rows()[0]).toMatchObject({ source: "none", cache_read_tokens: null });
    expect(logged).toHaveLength(1);
  });

  test("a forced write failure leaves the stage passed and writes exactly one log line", async () => {
    capture();
    const e = makeEnv();
    e.spawn();
    e.db.exec("DROP TABLE stage_metrics");
    expect((await e.pass()).status).toBe("passed");
    expect(e.rt.api.load(e.stageId)!.status).toBe("passed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("writing the row failed");
  });

  test("a forced read failure writes exactly one log line; the row is stored as none and the stage is passed", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    const file = transcript(e.folder(l), "s1", 1500, e.stageId, asst("a", usage(1, 0, 5, 1)));
    chmodSync(file, 0o000);
    try {
      await e.pass();
    } finally {
      chmodSync(file, 0o644);
    }
    expect(e.rt.api.load(e.stageId)!.status).toBe("passed");
    expect(e.rows()[0]).toMatchObject({ source: "none", cache_read_tokens: null });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("reading the transcript failed");
  });
});

describe("restart, old events and unreadable usage", () => {
  /** A new runtime on the same ledger: the hub restarted between the launch and the end of the stage. */
  const restarted = (e: ReturnType<typeof makeEnv>) => {
    const rt2 = createStageRuntime(e.db, { ackMs: 60_000, bootGraceMs: 1000, claudeProjectsDir: e.projects });
    return async () => {
      rt2.api.move(e.stageId, { to: "passed" }, "system", e.cap);
      await rt2.metricsIdle();
    };
  };

  test("a hub restart keeps the row: one row, first_message_bytes set, transcript values read", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(e.folder(l), "s1", 1500, e.stageId, asst("m1", usage(1, 2, 30, 4)));
    await restarted(e)();
    expect(e.rows()).toHaveLength(1);
    expect(e.rows()[0]).toMatchObject({ source: "claude", first_message_bytes: Buffer.byteLength(l.prompt), cache_read_tokens: 30, prompt_tokens_first: 33 });
    expect(logged).toEqual([]);
  });

  test("a hub restart with no transcript: one row, source none, NULL token fields", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    await restarted(e)();
    expect(e.rows()).toHaveLength(1);
    expect(e.rows()[0]).toMatchObject({ source: "none", first_message_bytes: Buffer.byteLength(l.prompt), prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null });
    expect(logged).toHaveLength(1);
  });

  test("an old stage.launching event without launch metadata: no row, one log line", async () => {
    capture();
    const e = makeEnv();
    e.spawn();
    e.db.run("UPDATE events SET payload_json = json_remove(payload_json, '$.launch') WHERE entity_id = ? AND kind = 'stage.launching'", [e.stageId]);
    await e.pass();
    expect(e.rows()).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(e.stageId);
    expect(logged[0]).toContain("attempt 1");
    expect(logged[0]).toContain("launched before stage metrics");
  });

  const unreadable: Array<[string, unknown]> = [
    ["an empty usage object", {}],
    ["a string token field", { input_tokens: "5", cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }],
    ["a negative token field", { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: -4, output_tokens: 1 }],
    ["a non-integer token field", { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 2.5, output_tokens: 1 }],
  ];
  test("valid usage plus one cut-off JSON line: source none, NULL token fields, one log line, stage passed", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    transcript(e.folder(l), "s1", 1500, e.stageId, asst("a", usage(1, 0, 5, 1)), '{"type":"assistant","message":{"id":"b","usa');
    expect((await e.pass()).status).toBe("passed");
    expect(e.rows()[0]).toMatchObject({ source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null });
    expect(logged).toHaveLength(1);
  });

  for (const [name, u] of unreadable) {
    test(`${name}: source none, NULL token fields, one log line`, async () => {
      capture();
      const e = makeEnv();
      const l = e.spawn();
      e.pinLaunchTimes(1000);
      transcript(e.folder(l), "s1", 1500, e.stageId, line({ type: "assistant", message: { id: "m1", usage: u, content: [] } }));
      await e.pass();
      expect(e.rows()[0]).toMatchObject({ source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null });
      expect(logged).toHaveLength(1);
    });
  }
});

describe("pi usage source (5.3)", () => {
  test("a pi stage row has source none and three NULLs, even when a matching Claude transcript exists", async () => {
    capture();
    const db = new Database(":memory:");
    migrateLedger(db);
    const projects = mkdtempSync(join(tmpdir(), "sm-pi-"));
    const cwd = "/tmp/wt/pi-case";
    const payload = JSON.stringify({ launch: { role: "worker", harness: "pi", cwd, bytes: 400 } });
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES ('s_1', 'stage.launching', 'system', ?, 1000)", [payload]);
    transcript(claudeProjectFolder(cwd, projects), "s1", 1500, "Stage: s_1", asst("a", usage(1, 0, 5, 1)));
    await recordStageMetrics(db, "s_1", 7, console.error, projects);
    const r = db.query<Record<string, unknown>, []>("SELECT * FROM stage_metrics").get()!;
    expect(r).toMatchObject({
      source: "none", prompt_tokens_first: null, cache_read_tokens: null, tokens_before_action: null,
      first_message_bytes: 400, first_message_tokens_est: 100, created_seq: 7,
    });
    expect(logged).toEqual([]);
  });
});

describe("deferred writer", () => {
  test("a reader that does not resolve does not delay the stage: it is passed with no row, then the row appears", async () => {
    capture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const e = makeEnv({
      recordMetrics: async (...a) => {
        calls++;
        await gate;
        return recordStageMetrics(...a);
      },
    });
    e.spawn();
    const moved = e.rt.api.move(e.stageId, { to: "passed" }, "system", e.cap); // returns while the reader is still open
    expect(moved.status).toBe("passed");
    expect(e.rt.api.load(e.stageId)!.status).toBe("passed");
    expect(calls).toBe(0); // not inline: it starts after this call returns
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(e.rows()).toHaveLength(0);
    release();
    await e.rt.metricsIdle();
    expect(e.rows()).toHaveLength(1);
  });
});

describe("bounded candidate read", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sm-cap-"));

  test("a first user message on line 3 matches", async () => {
    const f = dir();
    const file = join(f, "a.jsonl");
    writeFileSync(file, [line({ type: "mode" }), line({ type: "permission-mode" }), user(1500, "Stage: s_x")].join("\n") + "\n");
    expect(await selectTranscript(f, "s_x", 1000, null)).toBe(file);
  });

  test("the largest renderable first message, JSONL-encoded, matches and gives source 'claude' with token values", async () => {
    capture();
    const e = makeEnv();
    const l = e.spawn();
    e.pinLaunchTimes(1000);
    const primerProject = mkdtempSync(join(tmpdir(), "primer-max-"));
    mkdirSync(join(primerProject, "docs"));
    writeFileSync(join(primerProject, "docs", "PRIMER.md"), "x".repeat(100_000));
    const max = renderFirstMessage({
      stageId: e.stageId, role: "worker",
      ticket: { id: "t_0000000000000001", title: "T".repeat(200), acceptance_criteria: "c".repeat(4000), blast_radius: "medium", request_id: "r".repeat(64) },
      branch: "ticket/t_0000000000000001", worktree: "/" + "w".repeat(1023), reason: "r".repeat(1500), recipient: "Orchestrator",
      handoff: { id: "h_0000000000000001", from: "Orchestrator", task: "x".repeat(500), context: { notes: "n".repeat(HANDOFF_SECTION_MAX * 2) } },
      stable: renderStable({ projectFolder: primerProject, nutshell: "N".repeat(256 * 1024) }),
      notes: [{ source: "planning", role: null, notes: "p".repeat(NOTES_SECTION_MAX * 2) }],
      pack: { graph: "g".repeat(PACK_SECTION_MAX * 2), signatures: "s".repeat(PACK_SECTION_MAX * 2) },
    });
    const line1 = user(1500, max);
    expect(Buffer.byteLength(max)).toBeGreaterThan(HANDOFF_SECTION_MAX);
    expect(Buffer.byteLength(max)).toBeLessThanOrEqual(MAX_FIRST_MESSAGE_BYTES);
    expect(Buffer.byteLength(line1)).toBeLessThanOrEqual(HEAD_CAP_BYTES);
    transcript(e.folder(l), "s1", 1500, max, asst("m1", usage(10, 200, 3000, 50)));
    await e.pass();
    expect(e.rows()[0]).toMatchObject({ source: "claude", prompt_tokens_first: 3210, cache_read_tokens: 3000 });
    expect(logged).toEqual([]);
  });

  test("a first user message over the cap does not match and logs nothing", async () => {
    capture();
    const f = dir();
    writeFileSync(join(f, "big.jsonl"), user(1500, "Stage: s_x " + "y".repeat(HEAD_CAP_BYTES)) + "\n");
    const stats = { bytes: 0 };
    expect(await selectTranscript(f, "s_x", 1000, null, stats)).toBeNull();
    expect(stats.bytes).toBeLessThanOrEqual(HEAD_CAP_BYTES);
    expect(logged).toEqual([]);
  });

  test("every shipped first-message template fits the template allowance of the cap", () => {
    for (const d of readdirSync("factory")) {
      const t = join("factory", d, "first-message.md");
      if (existsSync(t)) expect(readFileSync(t).length).toBeLessThanOrEqual(4 * 1024);
    }
  });

  test("58 candidate files read under 58 x 64 KiB, in chunks of at most 4 KiB", async () => {
    const f = dir();
    for (let i = 0; i < 57; i++) writeFileSync(join(f, `c${i}.jsonl`), user(1500, "Stage: s_other " + "z".repeat(HEAD_CAP_BYTES + 200 * 1024)) + "\n");
    const hit = join(f, "hit.jsonl");
    writeFileSync(hit, user(1600, "Stage: s_x") + "\n");
    const stats = { bytes: 0 };
    expect(await selectTranscript(f, "s_x", 1000, null, stats)).toBe(hit);
    expect(stats.bytes).toBeLessThan(58 * HEAD_CAP_BYTES);
    expect(stats.bytes).toBeLessThan(57 * (HEAD_CAP_BYTES + 200 * 1024)); // each candidate over the cap stops at the cap, not at its end
    console.log(`bytes read for 58 files: ${stats.bytes}`);
  });
});

describe("start repair of missing rows (t_8c328391ae299304)", () => {
  /** The first runtime stops before the deferred write (a no-op writer); the second one starts on the same ledger. */
  const noWrite = async () => {};
  const startAgain = async (e: ReturnType<typeof makeEnv>, extra: { recordMetrics?: typeof recordStageMetrics } = {}) => {
    const rt2 = createStageRuntime(e.db, { ackMs: 60_000, bootGraceMs: 1000, claudeProjectsDir: e.projects, ...extra });
    rt2.module.start!(e.cap);
    await rt2.metricsIdle();
    rt2.module.dispose?.();
  };

  for (const to of ["passed", "failed"] as const) {
    test(`stage.${to} commits, the runtime stops before the write, a new start writes exactly one row with the transcript values`, async () => {
      capture();
      const e = makeEnv({ recordMetrics: noWrite });
      const l = e.spawn();
      e.pinLaunchTimes(1000);
      transcript(e.folder(l), "s1", 1500, e.stageId, asst("m1", usage(1, 2, 30, 4)));
      e.rt.api.move(e.stageId, { to, ...(to === "failed" ? { reason: "x" } : {}) } as any, "system", e.cap);
      await e.rt.metricsIdle();
      expect(e.rows()).toHaveLength(0);
      await startAgain(e);
      expect(e.rows()).toHaveLength(1);
      expect(e.rows()[0]).toMatchObject({ stage_id: e.stageId, attempt: 1, source: "claude", cache_read_tokens: 30, prompt_tokens_first: 33 });
      expect(logged).toEqual([]);
      // (c) a second start: the row count and the row are unchanged
      const before = e.rows();
      await startAgain(e);
      expect(e.rows()).toEqual(before);
      expect(logged).toEqual([]);
    });
  }

  /** Stage A attempt 1 ends by retry, stage B passes, stage A attempt 2 passes: the order of the terminal events is A1, B, A2. */
  async function interleave(e: ReturnType<typeof makeEnv>) {
    const tidB = "t_0000000000000002";
    e.db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, role, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 'worker', 1, 1, 1)`,
      [tidB],
    );
    e.spawn(); // A attempt 1
    e.rt.evaluateStages(tidB, e.cap, [], { launch: true });
    const stageB = e.db.query<{ id: string }, [string]>("SELECT id FROM stage WHERE ticket_id = ?").get(tidB)!.id;
    expect(stageB).not.toBe(e.stageId);
    e.spawn(); // B
    await e.retry(); // A attempt 1 ends by retry
    e.spawn(); // A attempt 2
    e.rt.api.move(stageB, { to: "passed" }, "system", e.cap);
    e.rt.api.move(e.stageId, { to: "passed" }, "system", e.cap);
    await e.rt.metricsIdle();
    return stageB;
  }
  /** The route's source, unsorted here: all stages are role worker, so the order is the ORDER BY of metricsByRole. */
  const route = (e: ReturnType<typeof makeEnv>) =>
    metricsByRole(e.db, "r1", "(SELECT room FROM tickets WHERE id = s.ticket_id)")
      .worker!.map((r) => `${r.stage_id}:${r.attempt}`);

  for (const mode of ["deferred write", "repair"] as const) {
    test(`created_seq is the seq of each attempt's own terminal event (${mode}); the route order is A1, B, A2`, async () => {
      capture();
      // deferred write: hold the writes and run them in reverse, so the insert order differs from the terminal-event order
      const held: Array<() => Promise<unknown>> = [];
      const hold: typeof recordStageMetrics = (...a) => {
        held.push(() => recordStageMetrics(...a));
        return Promise.resolve() as any;
      };
      const e = makeEnv({ recordMetrics: mode === "repair" ? noWrite : hold });
      const stageB = await interleave(e);
      if (mode === "repair") {
        expect(e.rows()).toHaveLength(0);
        await startAgain(e);
      } else {
        for (const w of held.reverse()) await w();
      }
      const inserted = e.db.query<{ stage_id: string; attempt: number }, []>("SELECT stage_id, attempt FROM stage_metrics ORDER BY rowid").all().map((r) => `${r.stage_id}:${r.attempt}`);
      expect(inserted).not.toEqual([`${e.stageId}:1`, `${stageB}:1`, `${e.stageId}:2`]);
      const ends = e.db
        .query<{ entity_id: string; kind: string; seq: number }, []>("SELECT entity_id, kind, seq FROM events WHERE kind IN ('stage.passed','stage.failed','stage.retrying') ORDER BY seq")
        .all();
      const [a1, b, a2] = ends;
      expect([a1!.entity_id, a1!.kind, b!.entity_id, a2!.entity_id]).toEqual([e.stageId, "stage.retrying", stageB, e.stageId]);
      const seqOf = (stage: string, attempt: number) => e.db.query<{ created_seq: number }, [string, number]>("SELECT created_seq FROM stage_metrics WHERE stage_id = ? AND attempt = ?").get(stage, attempt)?.created_seq;
      expect([seqOf(e.stageId, 1), seqOf(stageB, 1), seqOf(e.stageId, 2)]).toEqual([a1!.seq, b!.seq, a2!.seq]);
      const order = e.db
        .query<{ stage_id: string; attempt: number }, []>("SELECT stage_id, attempt FROM stage_metrics ORDER BY created_seq, stage_id, attempt")
        .all()
        .map((r) => `${r.stage_id}:${r.attempt}`);
      expect(order).toEqual([`${e.stageId}:1`, `${stageB}:1`, `${e.stageId}:2`]);
      expect(route(e)).toEqual(order);
    });
  }

  test("the selection query runs after start() returns, in the deferred step", async () => {
    capture();
    const e = makeEnv({ recordMetrics: noWrite });
    e.spawn();
    await e.pass();
    const steps: string[] = [];
    const rt2 = createStageRuntime(e.db, {
      ackMs: 60_000,
      bootGraceMs: 1000,
      claudeProjectsDir: e.projects,
      findMissingMetrics: (db) => {
        steps.push("select");
        return stagesMissingMetrics(db);
      },
    });
    rt2.module.start!(e.cap);
    steps.push("start returned");
    expect(steps).toEqual(["start returned"]);
    await rt2.metricsIdle();
    rt2.module.dispose?.();
    expect(steps).toEqual(["start returned", "select"]);
    expect(e.rows()).toHaveLength(1);
  });

  test("an attempt without launch metadata: no row, no log line at start", async () => {
    capture();
    const e = makeEnv({ recordMetrics: noWrite });
    e.spawn();
    e.db.run("UPDATE events SET payload_json = json_remove(payload_json, '$.launch') WHERE entity_id = ? AND kind = 'stage.launching'", [e.stageId]);
    await e.pass();
    await startAgain(e);
    expect(e.rows()).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  test("the writer throws: one log line, the start returns, the stage row is unchanged", async () => {
    capture();
    const e = makeEnv({ recordMetrics: noWrite });
    e.spawn();
    await e.pass();
    const stageBefore = e.db.query("SELECT * FROM stage WHERE id = ?").get(e.stageId);
    await startAgain(e, { recordMetrics: async () => { throw new Error("boom"); } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(e.stageId);
    expect(e.rows()).toHaveLength(0);
    expect(e.db.query("SELECT * FROM stage WHERE id = ?").get(e.stageId)).toEqual(stageBefore);
  });

  test("two attempts, attempt 1 has a row, attempt 2 has none: the repair inserts only attempt 2", async () => {
    capture();
    const e = makeEnv({ recordMetrics: noWrite });
    const l1 = e.spawn();
    await e.retry();
    const l2 = e.spawn();
    e.pinLaunchTimes(1000, 2000);
    transcript(e.folder(l1), "a1", 1500, e.stageId, asst("m1", usage(1, 0, 5, 1)));
    transcript(e.folder(l2), "a2", 2500, e.stageId, asst("m2", usage(7, 0, 9, 1)));
    e.db.run(
      "INSERT INTO stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, source, created_seq) VALUES (?, 1, 'worker', 11, 3, 'none', 5)",
      [e.stageId],
    );
    const row1 = e.rows()[0];
    await e.pass();
    await startAgain(e);
    expect(e.rows()).toHaveLength(2);
    expect(e.rows()[0]).toEqual(row1!);
    expect(e.rows()[1]).toMatchObject({ attempt: 2, source: "claude", cache_read_tokens: 9 });
    expect(logged).toEqual([]);
  });
});
