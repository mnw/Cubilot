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
function world(linked: string[], version = V2) {
  const dir = mkdtempSync(join(tmpdir(), "relink-"));
  dirs.push(dir);
  mkdirSync(join(dir, V1)); mkdirSync(join(dir, V2)); mkdirSync(join(dir, "agents"));
  for (const n of linked) symlinkSync(join(dir, V1), join(dir, "agents", agentKey(n)));
  const routes = createFactoryFeature({ dir, version }).routes;
  const call = (path: string, body: unknown) =>
    routes.find((r) => r.path === path)!.handler(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }), {} as any, {}) as Promise<Response>;
  return {
    dir,
    pending: (n: string) => { try { return readFileSync(join(dir, "agents", `${agentKey(n)}.pending`), "utf8").trim().split("\n"); } catch { return null; } },
    relink: (body: unknown) => call("/factory/relink", body),
    applied: (body: unknown) => call("/factory/applied", body),
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
    await w.applied({ agent: "bob", version: V1 });
    expect(w.record("bob")).toBe(V1);
    expect(w.record("ghost")).toBeNull();
  });
});
