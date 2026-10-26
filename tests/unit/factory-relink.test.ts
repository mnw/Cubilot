import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKey, createFactoryFeature } from "../../hub/features/factory";

const V1 = "v-1111111111111111";
const V2 = "v-2222222222222222";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A temp factory dir with versions V1 and V2, and an agent link (to V1) per name in `linked`.
function world(linked: string[], version = V2, deps: { online?: (n: string) => boolean } = { online: () => true }) {
  const dir = mkdtempSync(join(tmpdir(), "relink-"));
  dirs.push(dir);
  mkdirSync(join(dir, V1)); mkdirSync(join(dir, V2)); mkdirSync(join(dir, "agents"));
  for (const n of linked) symlinkSync(join(dir, V1), join(dir, "agents", agentKey(n)));
  const routes = createFactoryFeature({ dir, version, ...deps }).routes;
  const call = (path: string, body: unknown) =>
    routes.find((r) => r.path === path)!.handler(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }), {} as any, {}) as Promise<Response>;
  const emitted: Array<{ entry: any; scope: any }> = [];
  const roster: Record<string, { name: string; room: string | null; permanent: boolean }> = {
    human: { name: "human", room: null, permanent: true },
    bob: { name: "bob", room: "r1", permanent: false },
    alice: { name: "alice", room: "r1", permanent: false },
  };
  const paused = new Set<string>();
  const cap = {
    config: { humanName: "human" },
    agents: { get: (n: string) => roster[n] ?? null, isPaused: (n: string) => paused.has(n) },
    sse: { emit: (entry: any, scope: any) => emitted.push({ entry, scope }) },
  } as any;
  const reloadRoute = routes.find((r) => r.method === "POST" && r.path instanceof RegExp)!;
  const statusRoute = routes.find((r) => r.method === "GET" && r.path instanceof RegExp)!;
  return {
    dir,
    emitted,
    paused,
    status: (name: string) =>
      statusRoute.handler(new Request(`http://x/agents/${encodeURIComponent(name)}/reload-status`), cap, { id: encodeURIComponent(name) }) as Promise<Response>,
    last: (n: string) => { try { return JSON.parse(readFileSync(join(dir, "agents", `${agentKey(n)}.last`), "utf8")); } catch { return null; } },
    reload: (name: string, body: unknown) =>
      reloadRoute.handler(new Request(`http://x/agents/${encodeURIComponent(name)}/reload`, { method: "POST", body: JSON.stringify(body) }), cap, { id: encodeURIComponent(name) }) as Promise<Response>,
    pending: (n: string) => { try { return readFileSync(join(dir, "agents", `${agentKey(n)}.pending`), "utf8").trim().split("\n"); } catch { return null; } },
    relink: (body: unknown) => call("/factory/relink", body),
    // The bridge reports the attempt id that relink wrote into .pending: fill it in unless the test sets `attempt` itself.
    applied: (body: any) => {
      const own = "attempt" in body;
      let attempt: string | undefined;
      try { attempt = readFileSync(join(dir, "agents", `${agentKey(body.agent)}.pending`), "utf8").split("\n")[2] || undefined; } catch { /* none */ }
      return call("/factory/applied", own ? body : { ...body, attempt });
    },
    target: (n: string) => readlinkSync(join(dir, "agents", agentKey(n))),
    record: (n: string) => { try { return readFileSync(join(dir, "agents", `${agentKey(n)}.applied`), "utf8").trim(); } catch { return null; } },
  };
}

describe("POST /factory/relink", () => {
  test("moves the agent's own link to the desired version, asks for a reload, touches no other link", async () => {
    const w = world(["alice", "bob"]);
    const r = await w.relink({ agent: "bob" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ reload: true, version: V2 });
    expect(w.target("bob")).toBe(join(w.dir, V2));
    expect(w.target("alice")).toBe(join(w.dir, V1));
  });
  test("the key is the hex of the UTF-8 bytes, so a name with a space works", async () => {
    expect(agentKey("a b")).toBe("612062");
    const w = world(["a b"]);
    expect((await w.relink({ agent: "a b" })).status).toBe(200);
    expect(w.target("a b")).toBe(join(w.dir, V2));
  });
  test("an agent with no link gets 404 and no link is created", async () => {
    const w = world(["alice"]);
    expect((await w.relink({ agent: "bob" })).status).toBe(404);
    expect(() => lstatSync(join(w.dir, "agents", agentKey("bob")))).toThrow();
  });
  test("reload:false only when the link AND the applied record both name the desired version", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    // link moved, reload ordered, nothing recorded: pending holds the next call until a completion clears it
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: false, pending: true });
    await w.applied({ agent: "bob", failed: true });
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: true });
    await w.applied({ agent: "bob", failed: true });
    writeFileSync(join(w.dir, "agents", `${agentKey("bob")}.applied`), `${V1}\n`);
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: true });
    expect((await w.applied({ agent: "bob", version: V2 })).status).toBe(200);
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: false, version: V2 });
  });
  test("pending has no time limit: a later relink orders nothing until a completion clears it", async () => {
    const w = world(["bob"]);
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: true });
    expect(w.pending("bob")?.[0]).toBe(V2);
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: false, pending: true });
    // an old pending file (a day old) still blocks
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    utimesSync(join(w.dir, "agents", `${agentKey("bob")}.pending`), old, old);
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: false, pending: true });
  });
  test("pending blocks a reload for ANY version while it is younger than the window; after the reload ends the newer version reloads", async () => {
    const w = world(["bob"], V1);
    writeFileSync(join(w.dir, "agents", `${agentKey("bob")}.pending`), `${V2}\n`);
    mkdirSync(join(w.dir, "v-3333333333333333"));
      const route = createFactoryFeature({ dir: w.dir, version: "v-3333333333333333", now: () => clock }).routes;
    const call = async (path: string, body: unknown) =>
      (await route.find((r) => r.path === path)!.handler(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), {} as any, {})) as Response;
    expect(await (await call("/factory/relink", { agent: "bob" })).json()).toMatchObject({ reload: false, pending: true });
    expect(w.target("bob")).toBe(join(w.dir, V1)); // nothing moved
    // the first reload ends: applied(V2) is recorded and pending is gone; V3 is wanted, so the next call reloads it
    writeFileSync(join(w.dir, "agents", `${agentKey("bob")}.applied`), `${V2}\n`);
    await call("/factory/applied", { agent: "bob", version: V1 });
    rmSync(join(w.dir, "agents", `${agentKey("bob")}.pending`), { force: true });
    expect(await (await call("/factory/relink", { agent: "bob" })).json()).toMatchObject({ reload: true, version: "v-3333333333333333" });
  });
  test("a failed reload ({failed:true}) deletes .pending and writes nothing else; the next relink reloads again at once", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    expect(w.pending("bob")).not.toBeNull();
    const r = await w.applied({ agent: "bob", failed: true });
    expect(r.status).toBe(200);
    expect(w.pending("bob")).toBeNull();
    expect(w.record("bob")).toBeNull();
    expect(w.target("bob")).toBe(join(w.dir, V2));
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: true });
    expect((await w.applied({ agent: "ghost", failed: true })).status).toBe(404);
  });
  test("/factory/applied deletes .pending", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    expect(w.pending("bob")).not.toBeNull();
    await w.applied({ agent: "bob", version: V2 });
    expect(w.pending("bob")).toBeNull();
  });
  test("no agent is 400; no desired version is 409 and moves nothing", async () => {
    expect((await world(["bob"]).relink({})).status).toBe(400);
    for (const bad of ["", "..", "active", "agents", "v-9", `${V2}/..`, "v-GGGGGGGGGGGGGGGG"]) {
      const w = world(["bob"], bad);
      expect((await w.relink({ agent: "bob" })).status, bad).toBe(409);
      expect(w.target("bob")).toBe(join(w.dir, V1));
    }
  });
  test("a desired version that is missing, a file or a symlink alias is 409", async () => {
    const missing = world(["bob"], "v-3333333333333333");
    expect((await missing.relink({ agent: "bob" })).status).toBe(409);
    const file = world(["bob"], "v-4444444444444444");
    writeFileSync(join(file.dir, "v-4444444444444444"), "x");
    expect((await file.relink({ agent: "bob" })).status).toBe(409);
    const alias = world(["bob"], "v-5555555555555555");
    symlinkSync(join(alias.dir, V1), join(alias.dir, "v-5555555555555555"));
    expect((await alias.relink({ agent: "bob" })).status).toBe(409);
    expect(alias.target("bob")).toBe(join(alias.dir, V1));
  });
  test("a `to` parameter does nothing: there is no rollback", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob", to: ".." });
    expect(w.target("bob")).toBe(join(w.dir, V2));
  });
  test("no factory dir at all is 404", async () => {
    const route = createFactoryFeature({ dir: "", version: "" }).routes[0];
    const r = await route.handler(new Request("http://x", { method: "POST", body: JSON.stringify({ agent: "bob" }) }), {} as any, {});
    expect(r.status).toBe(404);
  });
});

describe("POST /factory/applied", () => {
  test("records the version the link names, by file, and only that one", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    expect((await w.applied({ agent: "bob", version: V1 })).status).toBe(409);
    expect(w.record("bob")).toBeNull();
    expect((await w.applied({ agent: "bob", version: V2 })).status).toBe(200);
    expect(w.record("bob")).toBe(V2);
    expect(Bun.spawnSync(["ls", join(w.dir, "agents")]).stdout.toString().split("\n").some((f) => f.includes(".tmp-"))).toBe(false);
  });
  test("no link is 404; missing fields are 400; another agent's record is untouched", async () => {
    const w = world(["bob"]);
    expect((await w.applied({ agent: "ghost", version: V1 })).status).toBe(404);
    expect((await w.applied({ agent: "bob" })).status).toBe(400);
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", version: V2 });
    expect(w.record("bob")).toBe(V2);
    expect(w.record("ghost")).toBeNull();
  });
});

describe("POST /factory/relink with force", () => {
  test("force orders a reload for the version the agent already has, and writes pending", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", version: V2 });
    expect(await (await w.relink({ agent: "bob" })).json()).toMatchObject({ reload: false });
    const r = await w.relink({ agent: "bob", force: true });
    expect(await r.json()).toMatchObject({ reload: true, version: V2 });
    expect(w.pending("bob")?.[0]).toBe(V2);
  });
  test("force does not break the pending rule: no second reload while one runs", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    expect(await (await w.relink({ agent: "bob", force: true })).json()).toMatchObject({ reload: false, pending: true });
  });
  test("force on an agent with no link is 404", async () => {
    const w = world(["alice"]);
    expect((await w.relink({ agent: "bob", force: true })).status).toBe(404);
  });
});

describe("POST /agents/:name/reload", () => {
  test("only the human may call it: an agent, or no `by`, gets 403 and no request is sent", async () => {
    const w = world(["bob"]);
    expect((await w.reload("bob", { by: "alice" })).status).toBe(403);
    expect((await w.reload("bob", {})).status).toBe(403);
    expect(w.emitted).toHaveLength(0);
  });
  test("an unknown agent is 400", async () => {
    const w = world(["bob"]);
    expect((await w.reload("nobody", { by: "human" })).status).toBe(400);
  });
  test("the request goes to that agent only, outside the chat log and the UI, and carries the room and the force flag", async () => {
    const w = world(["bob", "alice"]);
    const r = await w.reload("bob", { by: "human", force: true });
    expect(r.status).toBe(200);
    expect(w.emitted).toHaveLength(1);
    expect(w.emitted[0].scope).toEqual({ kind: "agents-ambient", agents: ["bob"] });
    expect(w.emitted[0].entry).toMatchObject({ type: "agent.reload", from: "system", to: "bob", room: "r1", force: true });
  });
  test("the answer is the status: presence, pause, room and the factory record", async () => {
    const w = world(["bob"], V2, { online: (n) => n === "bob" });
    w.paused.add("bob");
    await w.relink({ agent: "bob" });
    const j = await (await w.reload("bob", { by: "human" })).json();
    expect(j).toMatchObject({ agent: "bob", online: true, paused: true, room: "r1", requested: true });
    expect(j.factory).toEqual({ desired: V2, linked: V2, applied: null, pending: V2, pending_reload_id: null, last: null });
  });
  test("an offline agent only reads its status: nothing is sent", async () => {
    const w = world(["bob"], V2, { online: () => false });
    const j = await (await w.reload("bob", { by: "human", force: true })).json();
    expect(j).toMatchObject({ agent: "bob", online: false, requested: false });
    expect(w.emitted).toHaveLength(0);
  });
  test("an agent with no factory link only reads its status: nothing is sent", async () => {
    const w = world(["alice"]);
    const j = await (await w.reload("bob", { by: "human", force: true })).json();
    expect(j).toMatchObject({ agent: "bob", requested: false });
    expect(j.factory).toMatchObject({ linked: null });
    expect(w.emitted).toHaveLength(0);
  });
});

describe("GET /agents/:name/reload-status and factory.last", () => {
  test("it answers the status of the POST route without `requested`, and sends nothing to the agent", async () => {
    const w = world(["bob"], V2, { online: (n) => n === "bob" });
    w.paused.add("bob");
    await w.relink({ agent: "bob" });
    const j = await (await w.status("bob")).json();
    expect(j).toMatchObject({ agent: "bob", online: true, paused: true, room: "r1" });
    expect("requested" in j).toBe(false);
    expect(j.factory).toEqual({ desired: V2, linked: V2, applied: null, pending: V2, pending_reload_id: null, last: null });
    expect(w.emitted).toHaveLength(0);
  });
  test("an unknown agent and the human are 400, like the POST route", async () => {
    const w = world(["bob"]);
    expect((await w.status("nobody")).status).toBe(400);
    expect((await w.status("human")).status).toBe(400);
  });
  test("the status of an agent with no link has last null and linked null", async () => {
    const w = world(["alice"]);
    expect((await (await w.status("bob")).json()).factory).toMatchObject({ linked: null, last: null });
  });
  test("/factory/applied writes last on success, atomically beside .applied", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    expect((await w.applied({ agent: "bob", version: V2 })).status).toBe(200);
    expect(w.last("bob")).toMatchObject({ result: "applied", version: V2 });
    expect(typeof w.last("bob").at).toBe("number");
    const j = await (await w.status("bob")).json();
    expect(j.factory.last).toMatchObject({ result: "applied", version: V2 });
  });
  test("a failed force reload of the same version shows result failed while applied equals linked", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", version: V2 });
    expect((await w.relink({ agent: "bob", force: true })).status).toBe(200); // the forced reload is ordered
    expect((await w.applied({ agent: "bob", failed: true })).status).toBe(200);
    const f = (await (await w.status("bob")).json()).factory;
    expect(f).toMatchObject({ linked: V2, applied: V2, pending: null });
    expect(f.last).toMatchObject({ result: "failed", version: V2 });
  });
  test("a later success replaces a failure", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", failed: true });
    expect(w.last("bob").result).toBe("failed");
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", version: V2 });
    expect(w.last("bob").result).toBe("applied");
  });
});

describe("reload ids", () => {
  test("the reload route mints an id, puts it in the entry and the answer; none for an offline agent", async () => {
    const w = world(["bob"]);
    const j = await (await w.reload("bob", { by: "human", force: true })).json();
    expect(j.reload_id).toMatch(/^[0-9a-f]{16}$/);
    expect(w.emitted[0].entry.reload_id).toBe(j.reload_id);
    const off = world(["bob"], V2, { online: () => false });
    expect((await (await off.reload("bob", { by: "human" })).json()).reload_id).toBeNull();
  });
  test("pending and last carry the id of the request; a reload without one carries null", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob", force: true, reload_id: "aaaaaaaaaaaaaaaa" });
    const f = (await (await w.status("bob")).json()).factory;
    expect(f).toMatchObject({ pending: V2, pending_reload_id: "aaaaaaaaaaaaaaaa" });
    await w.applied({ agent: "bob", version: V2, reload_id: "aaaaaaaaaaaaaaaa" });
    const g = (await (await w.status("bob")).json()).factory;
    expect(g).toMatchObject({ pending: null, pending_reload_id: null, last: { result: "applied", reload_id: "aaaaaaaaaaaaaaaa" } });
    await w.relink({ agent: "bob", force: true });
    await w.applied({ agent: "bob", failed: true });
    expect(w.last("bob")).toMatchObject({ result: "failed", reload_id: null });
  });
  test("Validator probe: reload A ends after the click for B and before B starts: A's result never carries B's id", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob" });
    await w.applied({ agent: "bob", version: V2 });
    await w.relink({ agent: "bob", force: true, reload_id: "aaaaaaaaaaaaaaaa" }); // A runs
    const click = await (await w.reload("bob", { by: "human", force: true })).json(); // the click for B
    await w.applied({ agent: "bob", version: V2, reload_id: "aaaaaaaaaaaaaaaa" }); // A ends first
    const f = (await (await w.status("bob")).json()).factory;
    expect(f.last.reload_id).toBe("aaaaaaaaaaaaaaaa");
    expect(f.last.reload_id).not.toBe(click.reload_id);
    await w.relink({ agent: "bob", force: true, reload_id: click.reload_id }); // B starts
    expect((await (await w.status("bob")).json()).factory.pending_reload_id).toBe(click.reload_id);
    await w.applied({ agent: "bob", failed: true, reload_id: click.reload_id });
    expect(w.last("bob")).toMatchObject({ result: "failed", reload_id: click.reload_id });
  });
  test("a malformed id is stored as null", async () => {
    const w = world(["bob"]);
    await w.relink({ agent: "bob", force: true, reload_id: "../x\nv-1" });
    expect((await (await w.status("bob")).json()).factory.pending_reload_id).toBeNull();
  });
});

describe("attempt ids: only the reload in .pending can report", () => {
  const files = (w: ReturnType<typeof world>) => ({ pending: w.pending("bob"), applied: w.record("bob"), last: w.last("bob") });
  test("relink makes an attempt id for each ordered reload and writes it into .pending; a refused relink makes none", async () => {
    const w = world(["bob"]);
    const a = await (await w.relink({ agent: "bob" })).json();
    expect(a.attempt).toMatch(/^[0-9a-f]{16}$/);
    expect(w.pending("bob")?.[2]).toBe(a.attempt);
    expect((await (await w.relink({ agent: "bob" })).json()).attempt).toBeUndefined(); // pending: nothing ordered
  });
  test("a report with another attempt id, none, or no order at all is 409 and changes no file", async () => {
    const w = world(["bob"]);
    expect((await w.applied({ agent: "bob", version: V2, attempt: "x" })).status).toBe(409); // no order
    await w.relink({ agent: "bob" });
    const before = files(w);
    for (const attempt of ["0000000000000000", undefined, ""]) {
      expect((await w.applied({ agent: "bob", version: V2, attempt })).status).toBe(409);
      expect((await w.applied({ agent: "bob", failed: true, attempt })).status).toBe(409);
    }
    expect(files(w)).toEqual(before);
    expect(w.target("bob")).toBe(join(w.dir, V2));
  });
  test("two bridge-started reloads (both reload_id null): the late report of the first changes nothing of the second", async () => {
    const w = world(["bob"]);
    const first = (await (await w.relink({ agent: "bob" })).json()).attempt;
    expect((await w.applied({ agent: "bob", version: V2, attempt: first })).status).toBe(200);
    const second = (await (await w.relink({ agent: "bob", force: true })).json()).attempt;
    expect(second).not.toBe(first);
    const before = files(w);
    expect((await w.applied({ agent: "bob", version: V2, attempt: first })).status).toBe(409); // the duplicate
    expect((await w.applied({ agent: "bob", failed: true, attempt: first })).status).toBe(409);
    expect(files(w)).toEqual(before);
    expect(files(w).pending?.[2]).toBe(second);
  });
  test("a late duplicate of A cannot overwrite the finished B in .last", async () => {
    const w = world(["bob"]);
    const a = (await (await w.relink({ agent: "bob", force: true, reload_id: "aaaaaaaaaaaaaaaa" })).json()).attempt;
    await w.applied({ agent: "bob", version: V2, attempt: a });
    const b = (await (await w.relink({ agent: "bob", force: true, reload_id: "bbbbbbbbbbbbbbbb" })).json()).attempt;
    await w.applied({ agent: "bob", version: V2, attempt: b });
    expect((await w.applied({ agent: "bob", version: V2, attempt: a, reload_id: "aaaaaaaaaaaaaaaa" })).status).toBe(409);
    expect(w.last("bob")).toMatchObject({ result: "applied", reload_id: "bbbbbbbbbbbbbbbb" });
  });
  test("the id in .last comes from the order, not from the report", async () => {
    const w = world(["bob"]);
    const a = (await (await w.relink({ agent: "bob", force: true, reload_id: "aaaaaaaaaaaaaaaa" })).json()).attempt;
    await w.applied({ agent: "bob", failed: true, attempt: a, reload_id: "bbbbbbbbbbbbbbbb" });
    expect(w.last("bob")).toMatchObject({ result: "failed", reload_id: "aaaaaaaaaaaaaaaa" });
  });
});
