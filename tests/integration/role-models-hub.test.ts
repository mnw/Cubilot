// role_models in config.yml through a real hub: the launch request on the fake executor stream, the stage in the ledger.
// The hub reads $CUBILOT_DATA_DIR/config.yml at each launch, so each test rewrites the file of the one hub.

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream, ackLaunch } from "../helpers/fake-executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` every 10 ms until it returns a value; throws when `ms` pass without one. */
const until = async <T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

describe("role_models through the hub", () => {
  let hub: HubHandle;
  let configFile: string;
  const open: Array<{ close: () => void }> = [];
  const launches: any[] = [];
  let stream: ReturnType<typeof openSSE>;

  beforeAll(async () => {
    hub = await spawnHub();
    const data = join(dirname(hub.ledgerPath), "data");
    mkdirSync(data, { recursive: true });
    configFile = join(data, "config.yml");
    stream = openLaunchStream(hub);
    void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
    await sleep(200);
  });
  // A room of its own for each test: unacked launches keep their role slots (limit 10 at most).
  let room = "";
  let n = 0;
  beforeEach(async () => {
    room = `rm${++n}`;
    await giveProjectHttp(hub, room);
    open.push(await registerAgent(hub, `rm-alice${n}`, { room }));
    const put = await authedFetch(hub, `/rooms/${room}/settings`, { method: "PUT", body: JSON.stringify({ role_limits: { worker: 10, tester: 10 } }) });
    expect(put.status).toBe(200);
  });
  afterAll(async () => {
    stream.close();
    for (const c of open) c.close();
    await hub.kill();
  });

  const config = (text: string) => writeFileSync(configFile, text);
  const noConfig = () => rmSync(configFile, { force: true });

  /** Queues a ticket of `role`; returns its stage and the launch requests it caused (waits for them to settle). */
  const start = async (role: string) => {
    const seen = launches.length;
    const r = await postJson(hub, "/tickets", { by: `rm-alice${n}`, title: "t", acceptance_criteria: "c", blast_radius: "low", role });
    expect(r.status).toBe(201);
    const ticket = (r.json as { snapshot: { id: string } }).snapshot.id;
    // Settled: the stage exists and either its launch request arrived or the hub failed it before any request.
    const stage = await until("the stage to launch or fail", async () => {
      const st = ((await getJson(hub, "/stages?status=all")).json as any[]).find((s) => s.ticket_id === ticket);
      const got = launches.slice(seen).some((x) => x.kind === "launch" && x.stage_id === st?.id);
      return st && (got || st.status === "failed") ? st : undefined;
    });
    return { ticket, stage, reqs: launches.slice(seen).filter((x) => x.kind === "launch" && x.stage_id === stage?.id) };
  };
  const reasons = (stageId: string): string[] => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      return db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM events WHERE entity_id = ? AND kind = 'stage.retrying'").all(stageId).map((r) => JSON.parse(r.payload_json).reason);
    } finally { db.close(); }
  };
  const ack = (id: string, body: Record<string, unknown>) => ackLaunch(hub, id, body);

  test("an entry sets harness, model, provider and effort", async () => {
    config("role_models:\n  worker:\n    harness: pi\n    model: m1\n    provider: p1\n    effort: high\n");
    const { reqs } = await start("worker");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ role: "worker", harness: "pi", model: "m1", provider: "p1", effort: "high" });
  });

  test("a partial entry adds only the fields it sets", async () => {
    config("role_models:\n  worker:\n    model: m1\n");
    const { reqs } = await start("worker");
    expect(reqs[0].model).toBe("m1");
    expect(reqs[0].harness).toBe("claude");
    expect("provider" in reqs[0]).toBe(false);
    expect("effort" in reqs[0]).toBe(false);
  });

  test("no file, no key and no entry give the request of today", async () => {
    const keys = ["cwd", "env", "harness", "id", "kind", "prompt", "role", "room", "session", "stage_id"];
    noConfig();
    expect(Object.keys((await start("worker")).reqs[0]).sort()).toEqual(keys);
    config("other: 1\n");
    expect(Object.keys((await start("worker")).reqs[0]).sort()).toEqual(keys);
    config("role_models:\n  tester:\n    model: m\n");
    const w = (await start("worker")).reqs[0];
    expect(Object.keys(w).sort()).toEqual(keys);
    expect(w.harness).toBe("claude");
  });

  test.each([
    ["not a map", "role_models:\n  worker: sonnet\n", "role_models.worker: the entry is not a map"],
    ["a number field", "role_models:\n  worker:\n    model: 5\n", "role_models.worker: model is not a string"],
    ["an unknown field", "role_models:\n  worker:\n    modle: x\n", "role_models.worker: unknown field modle"],
    ["a bad harness", "role_models:\n  worker:\n    harness: codex\n", "role_models.worker: harness must be claude or pi"],
  ])("shape error (%s) fails only that role", async (_n, yml, reason) => {
    config(`${yml}  tester:\n    model: ok\n`);
    const bad = await start("worker");
    expect(bad.reqs).toEqual([]);
    expect(bad.stage).toMatchObject({ status: "failed" });
    expect(reasons(bad.stage.id).join("\n")).toContain(reason);
    const other = await start("tester");
    expect(other.reqs).toHaveLength(1);
    expect(other.reqs[0]).toMatchObject({ role: "tester", model: "ok" });
  });

  test("a key that is not a role has no effect", async () => {
    config("role_models:\n  cook:\n    model: x\n  worker:\n    model: m\n");
    expect((await start("worker")).reqs[0].model).toBe("m");
    expect("model" in (await start("tester")).reqs[0]).toBe(false);
  });

  test.each([
    ["invalid YAML", "role_models: [unclosed\n  - : :\n"],
    ["a scalar", "role_models: 5\n"],
    ["a list", "role_models:\n  - worker\n"],
    ["null", "role_models:\n"],
  ])("role_models as %s: every role launches as today", async (_n, yml) => {
    config(yml);
    const { reqs } = await start("worker");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].harness).toBe("claude");
    expect("model" in reqs[0]).toBe(false);
  });

  test("an edit between two launches changes the second request", async () => {
    config("role_models:\n  worker:\n    model: one\n");
    expect((await start("worker")).reqs[0].model).toBe("one");
    config("role_models:\n  worker:\n    model: two\n");
    expect((await start("worker")).reqs[0].model).toBe("two");
  });

  test("a value-refusal ack gets the prefix; a later tmux error and a launch without an entry do not", async () => {
    config("role_models:\n  worker:\n    model: nope\n");
    const a = await start("worker");
    expect((await ack(a.reqs[0].id, { result: "error", error: 'invalid model: "nope"' })).status).toBe(200);
    await until("the retry reason", () => reasons(a.stage.id).length > 0);
    expect(reasons(a.stage.id)[0]).toBe('the launch did not start: role_models.worker: invalid model: "nope"');

    const b = await start("worker");
    expect((await ack(b.reqs[0].id, { result: "error", error: "tmux new-session failed" })).status).toBe(200);
    await until("the retry reason", () => reasons(b.stage.id).length > 0);
    expect(reasons(b.stage.id)[0]).toBe("the launch did not start: tmux new-session failed");

    const c = await start("tester"); // no entry for tester
    expect((await ack(c.reqs[0].id, { result: "error", error: 'invalid model: "x"' })).status).toBe(200);
    await until("the retry reason", () => reasons(c.stage.id).length > 0);
    expect(reasons(c.stage.id)[0]).toBe('the launch did not start: invalid model: "x"');
  });
});
