// role_models in config.yml: the hub reads it at each stage launch and puts model, provider and effort in the launch
// request. Real ledger, real files in a temp CUBILOT_DATA_DIR, no mocks.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveProject } from "../helpers/repo";
import { migrateLedger } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime, type LaunchInput } from "../../hub/kinds/stage";
import { roleModelFor } from "../../hub/core/role-models";
import type { LaunchRequest } from "../../hub/core/launch-queue";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

type Launch = Extract<LaunchRequest, { kind: "launch" }>;
const ROLES = ["worker", "tester", "validator"];

let dir: string;
let before: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "role-models-"));
  before = process.env.CUBILOT_DATA_DIR;
  process.env.CUBILOT_DATA_DIR = dir;
});
afterEach(() => {
  if (before === undefined) delete process.env.CUBILOT_DATA_DIR;
  else process.env.CUBILOT_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});
const config = (text: string) => writeFileSync(join(dir, "config.yml"), text);

function makeEnv(o: { ackMs?: number } = {}) {
  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  const rt = createStageRuntime(db, { ackMs: o.ackMs ?? 60_000 });
  rt.module.migrate(db);
  const cap = { db, sse: { emit: (_e: Entry, _s: Scope) => {} }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  const sent: LaunchRequest[] = [];
  const ac = new AbortController();
  rt.queue.attach((r) => sent.push(r), ac.signal, cap);
  let n = 0;
  const launch = (role: string, session = `${role}-1`) => {
    giveProject(db, "r1");
    const id = `t_${(++n).toString(16).padStart(16, "0")}`;
    db.run(
      `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, created_at_ms, updated_at_ms, version)
       VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'queued', 1, 1, 1)`,
      [id],
    );
    const s = rt.api.create({ ticket_id: id, role }, "system", cap);
    const input: LaunchInput = { stage_id: s.id, session, room: "r1", harness: "claude", cwd: "/tmp/p", prompt: "first" };
    const r = rt.enqueueLaunch(input, cap);
    return { s, r, req: sent.filter((x): x is Launch => x.kind === "launch").at(-1) };
  };
  return { db, rt, cap, sent, launch, stop: () => { ac.abort(); rt.queue.dispose(); } };
}

describe("role_models in a launch request", () => {
  test("an entry sets harness, model, provider and effort", () => {
    config("role_models:\n  worker:\n    harness: pi\n    model: m1\n    provider: p1\n    effort: high\n");
    const e = makeEnv();
    const { req } = e.launch("worker");
    expect(req).toMatchObject({ harness: "pi", model: "m1", provider: "p1", effort: "high" });
    e.stop();
  });

  test("a partial entry adds only the fields it sets", () => {
    config("role_models:\n  worker:\n    model: m1\n");
    const e = makeEnv();
    const { req } = e.launch("worker");
    expect(req!.harness).toBe("claude");
    expect(req!.model).toBe("m1");
    expect("provider" in req!).toBe(false);
    expect("effort" in req!).toBe(false);
    e.stop();
  });

  test("no key and no entry give the request of today", () => {
    const e = makeEnv();
    const none = e.launch("worker").req!; // no config.yml at all
    config("other: 1\n");
    const noKey = e.launch("tester").req!;
    config("role_models:\n  validator:\n    model: m\n");
    const noEntry = e.launch("worker", "worker-2").req!;
    for (const [r, role, session] of [[none, "worker", "worker-1"], [noKey, "tester", "tester-1"], [noEntry, "worker", "worker-2"]] as const) {
      expect(Object.keys(r).sort()).toEqual(["cwd", "env", "harness", "id", "kind", "prompt", "role", "room", "session", "stage_id"]);
      expect(r).toMatchObject({ role, session, harness: "claude" });
    }
    e.stop();
  });

  test("an edit between two launches changes the second request", () => {
    config("role_models:\n  worker:\n    model: one\n");
    const e = makeEnv();
    expect(e.launch("worker").req!.model).toBe("one");
    config("role_models:\n  worker:\n    model: two\n");
    expect(e.launch("worker", "worker-2").req!.model).toBe("two");
    e.stop();
  });

  test.each([
    ["not a map", "role_models:\n  worker: sonnet\n", "role_models.worker: the entry is not a map"],
    ["a null entry", "role_models:\n  worker:\n", "role_models.worker: the entry is not a map"],
    ["a number field", "role_models:\n  worker:\n    model: 5\n", "role_models.worker: model is not a string"],
    ["an unknown field", "role_models:\n  worker:\n    modle: x\n", "role_models.worker: unknown field modle"],
    ["a bad harness", "role_models:\n  worker:\n    harness: codex\n", 'role_models.worker: harness must be claude or pi, not "codex"'],
  ])("shape error (%s) fails only that role", (_n, yml, reason) => {
    config(`${yml}  tester:\n    model: ok\n`);
    const e = makeEnv();
    const bad = e.launch("worker");
    expect(bad.r.ok).toBe(false);
    expect(bad.req).toBeUndefined(); // nothing queued
    expect(e.rt.api.load(bad.s.id)).toMatchObject({ status: "failed", attempt: 2 }); // retry, then final
    const why = e.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'stage.retrying'").get(bad.s.id)!;
    expect(JSON.parse(why.payload_json).reason).toContain(reason);
    const other = e.launch("tester");
    expect(other.req).toMatchObject({ role: "tester", model: "ok" });
    e.stop();
  });

  test("a key that is not a role has no effect", () => {
    config("role_models:\n  cook:\n    model: x\n  worker:\n    model: m\n");
    const e = makeEnv();
    expect(e.launch("worker").req!.model).toBe("m");
    expect(e.launch("tester").req!.model).toBeUndefined();
    e.stop();
  });

  test.each([
    ["invalid YAML", "role_models: [unclosed\n  - : :\n"],
    ["a scalar", "role_models: 5\n"],
    ["a list", "role_models:\n  - worker\n"],
    ["null", "role_models:\n"],
  ])("role_models as %s: every role launches as today", (_n, yml) => {
    config(yml);
    const e = makeEnv();
    const { req } = e.launch("worker");
    expect(req).toMatchObject({ harness: "claude" });
    expect("model" in req!).toBe(false);
    e.stop();
  });

  test("a missing file: every role launches as today", () => {
    const e = makeEnv();
    expect(e.launch("worker").req!.harness).toBe("claude");
    e.stop();
  });

  test("a value error ack gets the role_models prefix; a launch without an entry keeps its text", () => {
    config("role_models:\n  worker:\n    model: nope\n");
    const e = makeEnv();
    const a = e.launch("worker");
    e.rt.queue.ack(a.req!.id, { result: "error", error: 'invalid model: "nope"' }, e.cap);
    const why = (id: string) => e.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'stage.retrying'").get(id)!;
    expect(JSON.parse(why(a.s.id).payload_json).reason).toBe("the launch did not start: role_models.worker: invalid model: \"nope\"");
    const t = e.launch("tester");
    e.rt.queue.ack(t.req!.id, { result: "error", error: "tmux failed" }, e.cap);
    expect(JSON.parse(why(t.s.id).payload_json).reason).toBe("the launch did not start: tmux failed");
    e.stop();
  });

  test("a launch id leaves the role_models set when its launch ends: ack spawned, ack error or time-out", () => {
    config("role_models:\n  worker:\n    model: m\n  tester:\n    model: m\n");
    const e = makeEnv();
    const a = e.launch("worker");
    const b = e.launch("tester");
    const c = e.launch("worker", "worker-2");
    expect(e.rt.pendingRoleModelLaunches()).toBe(3);
    e.rt.queue.ack(a.req!.id, { result: "spawned" }, e.cap);
    expect(e.rt.pendingRoleModelLaunches()).toBe(2);
    // An error ack ends the first attempt of b; its retry is a new request with its own id.
    e.rt.queue.ack(b.req!.id, { result: "error", error: "tmux failed" }, e.cap);
    const retry = e.sent.filter((x): x is Launch => x.kind === "launch" && x.stage_id === b.s.id).at(-1)!;
    expect(retry.id).not.toBe(b.req!.id);
    expect(e.rt.pendingRoleModelLaunches()).toBe(2); // c and the retry of b
    e.rt.queue.ack(retry.id, { result: "spawned" }, e.cap);
    e.rt.queue.ack(c.req!.id, { result: "spawned" }, e.cap);
    expect(e.rt.pendingRoleModelLaunches()).toBe(0);
    e.stop();
  });

  test("a launch that times out leaves the set", async () => {
    config("role_models:\n  worker:\n    model: m\n");
    const e = makeEnv({ ackMs: 20 });
    e.launch("worker");
    expect(e.rt.pendingRoleModelLaunches()).toBe(1);
    for (let i = 0; i < 600 && e.rt.pendingRoleModelLaunches() !== 0; i++) await new Promise((r) => setTimeout(r, 50)); // deadline 30 s
    expect(e.rt.pendingRoleModelLaunches()).toBe(0);
    e.stop();
  }, 60000);
});

describe("roleModelFor", () => {
  test("blank strings count as not set", () => {
    config("role_models:\n  worker:\n    model: ''\n    effort: ' '\n");
    expect(roleModelFor("worker", ROLES)).toEqual({ entry: null });
  });
});
