// Every mutating route of the real hub queues no launch unless the stage evaluator finds a ready stage (4.1).
// The route list is derived from the source of the feature and kind modules (hub/kinds/*.ts, hub/features/*.ts: each
// `method:` plus `path:` pair of a RouteDef) and from the chatbridge tool paths (authedPost in hub/channel/tools.ts).
// A route that is added later is walked too. One that has no URL here fails the test.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";
import { openLaunchStream } from "../helpers/fake-executor";

const ROOT = join(import.meta.dir, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Found = { method: string; file: string; path: string };

/** The mutating routes of the feature and kind modules, with the path as a pattern source (`:id` for a capture). */
function routerRoutes(): Found[] {
  const out: Found[] = [];
  for (const dir of ["hub/kinds", "hub/features"]) {
    for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(ROOT, dir, f), "utf8");
      const named = (n: string) => src.match(new RegExp(`const ${n} = (/\\^.*\\$/);`))?.[1];
      for (const m of src.matchAll(/method: "(POST|PUT|PATCH|DELETE)",\s*path: ([^,\n]+),/g)) {
        let expr = m[2].trim();
        if (/^[A-Z_]+$/.test(expr)) expr = named(expr) ?? expr;
        let path: string;
        if (expr.startsWith('"')) path = expr.slice(1, -1);
        else if (expr.startsWith("/^")) path = expr.slice(2, -2).replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)|\(\\d\+\)/g, ":id");
        else throw new Error(`${dir}/${f}: cannot read the path ${expr}`);
        out.push({ method: m[1], file: `${dir}/${f}`, path });
      }
    }
  }
  return out;
}

/** The hub paths the chatbridge tools post to (`:id` for a template part). */
function toolPaths(): string[] {
  const src = readFileSync(join(ROOT, "hub/channel/tools.ts"), "utf8");
  const paths = new Set<string>();
  for (const m of src.matchAll(/authedPost\(\s*ctx\.host,\s*ctx\.hubEnv,\s*([`"])([^`"]+)\1/g)) paths.add(m[2].replace(/\$\{[^}]*\}/g, ":id"));
  if (/authedUpload\(/.test(src)) paths.add("/upload");
  return [...paths];
}

describe("every mutating route queues no launch for a ticket with no ready stage", () => {
  let hub: HubHandle;
  const open: Array<{ close: () => void }> = [];
  const ids = { ticket: "", handoff: "", interrupt: "" };

  beforeAll(async () => {
    hub = await spawnHub();
    await giveProjectHttp(hub, "r1");
    open.push(await registerAgent(hub, "alice", { room: "r1" }));
    open.push(await registerAgent(hub, "bob", { room: "r1" }));
    // A queued ticket with no role, a pending handoff and a pending interrupt: the routes below act on real ids.
    const t = await postJson(hub, "/tickets", { by: "alice", title: "T", acceptance_criteria: "c", blast_radius: "low", role: null });
    ids.ticket = (t.json as any).snapshot.id;
    ids.handoff = ((await postJson(hub, "/handoffs", { from: "alice", to: "bob", task: "t" })).json as any).id;
    ids.interrupt = ((await postJson(hub, "/interrupts", { from: "alice", to: "bob", text: "x" })).json as any).id;
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await hub.kill();
  });

  const urlOf = (path: string): string => {
    const seg = path.split("/");
    let n = 0;
    return seg.map((s, i) => {
      if (s !== ":id") return s;
      const kind = seg[i - 1] ?? "";
      n++;
      if (kind === "tickets") return ids.ticket;
      if (kind === "handoffs") return ids.handoff;
      if (kind === "interrupts") return ids.interrupt;
      if (kind === "permissions") return "abcde";
      if (kind === "rooms") return "r1";
      if (kind === "agents") return "bob";
      if (kind === "requests") return "req1";
      return n === 2 ? "1" : "x";
    }).join("/");
  };

  test("the derivation finds the known route families", () => {
    const found = routerRoutes();
    const paths = found.map((r) => `${r.method} ${r.path}`);
    for (const p of ["POST /tickets", "POST /handoffs", "POST /interrupts", "POST /post", "PUT /rooms/:id/settings", "POST /rooms/:id/lead"]) {
      expect(paths).toContain(p);
    }
    // The hub runs its own launch queue: no route takes a launch ack any more.
    expect(paths).not.toContain("POST /launches/:id/ack");
    expect(paths).not.toContain(`GET ${["/launches", "stream"].join("/")}`);
    expect(found.length).toBeGreaterThanOrEqual(25);
  });

  test("every chatbridge tool path is a mutating route of the router", () => {
    const routes = routerRoutes().filter((r) => r.method === "POST").map((r) => r.path);
    const tools = toolPaths();
    expect(tools.length).toBeGreaterThanOrEqual(15);
    for (const p of tools) expect(routes).toContain(p);
  });

  test("a POST or PUT to every route, with launch fields in the body, queues no launch and creates no stage", async () => {
    const sse = openLaunchStream(hub);
    const got: unknown[] = [];
    void (async () => { try { for await (const e of sse.events) got.push(e); } catch { /* closed */ } })();
    await sleep(150);

    const launchy = { launch: true, launch_session: "worker-1", stage: "queue", enqueue_launch: true, stage_id: "s_0123456789abcdef" };
    const body = {
      by: "alice", from: "alice", to: "bob", agent: "ghost", assignee: "bob", title: "T2", text: "launch worker-1", task: "t",
      reason: "r", behavior: "allow", result: "spawned", acceptance_criteria: "c", blast_radius: "low", ...launchy,
    };
    const walked = new Set<string>();
    for (const r of [...routerRoutes(), ...toolPaths().map((p) => ({ method: "POST", file: "hub/channel/tools.ts", path: p }))]) {
      const key = `${r.method} ${r.path}`;
      if (walked.has(key)) continue;
      walked.add(key);
      const res = await authedFetch(hub, urlOf(r.path), { method: r.method, body: JSON.stringify(body) });
      // 404 is a hub answer for an unknown id, not a missing route: the router answers a missing route with { error: "not found", path }.
      const j = (await res.json().catch(() => null)) as any;
      expect(res.status === 404 && j?.error === "not found" && j?.path !== undefined, `${key} is not routed`).toBe(false);
      expect(res.status, key).toBeLessThan(600);
    }
    expect(walked.size).toBeGreaterThanOrEqual(25);

    await sleep(500);
    sse.close();
    expect(got).toEqual([]);
    expect((await getJson(hub, "/stages?status=all")).json).toEqual([]);
  });

  test("no route module reads a launch parameter from a body; enqueueLaunch has only evaluateStages and drainQueue (retry path) as callers", () => {
    // The caller rule is checked in tests/unit/launch-queue.test.ts ("only the stage logic queues launches").
    const files = [...["hub/kinds", "hub/features"].flatMap((d) => readdirSync(join(ROOT, d)).filter((n) => n.endsWith(".ts")).map((n) => `${d}/${n}`)), "hub/hub.ts"];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/\b(b|body|payload|input)\.(launch\w*|enqueue\w*|launch_session)\b/);
      expect(src, f).not.toMatch(/\[\s*["'](launch\w*|enqueue\w*)["']\s*\]/);
    }
  });

  test("control: a route that makes a ready stage queues exactly one launch (the evaluator, not the route, decides)", async () => {
    const sse = openLaunchStream(hub);
    const got: any[] = [];
    void (async () => { try { for await (const e of sse.events) got.push(e); } catch { /* closed */ } })();
    await sleep(150);
    const t = await postJson(hub, "/tickets", { by: "alice", title: "ready", acceptance_criteria: "c", blast_radius: "low", role: "worker" });
    expect(t.status).toBe(201);
    await sleep(500);
    sse.close();
    expect(got.filter((e) => e.kind === "launch")).toHaveLength(1);
  });
});
