// Skill switch routes (Part 12 group 4): GET/PUT /agents/<name>/skills and POST /agents/<name>/skills/apply on a real
// hub. The factory tree and tmux are fixtures in a temp folder, never the real app data.
// The two write routes are human-only (group 11): the agent token gets 403 and nothing is written.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { agentKey } from "../../hub/core/skills";

const fx = mkdtempSync(join(tmpdir(), "cubilot-skills-routes-"));
const factory = join(fx, "factory");
const v = join(factory, "v1");
const fakeTmux = join(fx, "tmux");
let hub: HubHandle;

const call = (method: string, path: string, body?: unknown, token = hub.humanToken) =>
  fetch(`${hub.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const offFile = (agent: string) => join(factory, "agents", `${agentKey(agent)}.skills-off`);

beforeAll(async () => {
  for (const [g, skills] of [["worker", ["a", "b"]], ["shared", ["s"]]] as const) {
    mkdirSync(join(v, g, ".claude-plugin"), { recursive: true });
    writeFileSync(join(v, g, ".claude-plugin/plugin.json"), "{}");
    writeFileSync(join(v, g, "role.md"), "r");
    for (const s of skills) {
      mkdirSync(join(v, g, "skills", s), { recursive: true });
      writeFileSync(join(v, g, "skills", s, "SKILL.md"), s);
    }
  }
  writeFileSync(join(factory, "current"), "v1\n");
  mkdirSync(join(factory, "agents"), { recursive: true });
  for (const a of ["w1", "w2"]) symlinkSync(v, join(factory, "agents", agentKey(a)));
  const base = (a: string, view: boolean) => `${factory}/agents/${agentKey(a)}${view ? ".view" : ""}`;
  // w1: a role and a launch with a skill view. w2: a role and a plain launch. n1: no role.
  writeFileSync(
    fakeTmux,
    `#!/bin/sh
case "$*" in
  *list-sessions*) printf 'w1\\tworker\\tm\\t\\t\\tpi\\nw2\\tworker\\tm\\t\\t\\tpi\\nn1\\t\\t\\t\\t\\tclaude\\n' ;;
  *has-session*"=w1"*|*has-session*"=w2"*|*has-session*"=n1"*) exit 0 ;;
  *list-panes*"=w1:"*) echo "pi --skill '${base("w1", true)}/worker/skills' --skill '${base("w1", true)}/shared/skills'" ;;
  *list-panes*"=w2:"*) echo "pi --skill '${base("w2", false)}/worker/skills' --skill '${base("w2", false)}/shared/skills'" ;;
  *list-panes*"=n1:"*) echo "claude" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(fakeTmux, 0o755);
  hub = await spawnHub({ env: { CUBILOT_FACTORY_DIR: factory, CUBILOT_TMUX: fakeTmux } });
});

afterAll(async () => {
  await hub.kill();
});

describe("skill switch routes", () => {
  test("Skill switch set: PUT saves, GET reads it back, and the choice is in .skills-off", async () => {
    const before = await (await call("GET", "/agents/w1/skills")).json();
    expect(before.role).toBe("worker");
    expect(before.mode).toBe("view");
    expect(before.groups.map((g: any) => g.name)).toEqual(["Role · worker", "Shared"]);
    expect(before.groups.flatMap((g: any) => g.skills).every((s: any) => s.on)).toBe(true);

    const put = await call("PUT", "/agents/w1/skills", { off: ["worker/b", "worker/a", "worker/b"] });
    expect(put.status).toBe(200);
    expect(JSON.parse(readFileSync(offFile("w1"), "utf8"))).toEqual(["worker/a", "worker/b"]);
    const after = await (await call("GET", "/agents/w1/skills")).json();
    expect(after.groups[0].skills.map((s: any) => [s.id, s.on])).toEqual([["worker/a", false], ["worker/b", false]]);
    expect(after.relaunch_needed).toBe(false);

    expect((await call("PUT", "/agents/w1/skills", { off: [] })).status).toBe(200);
    expect(existsSync(offFile("w1"))).toBe(false);
  });

  test("PUT refuses an unknown skill, a bad body and an agent with no role, and writes nothing", async () => {
    expect((await call("PUT", "/agents/w1/skills", { off: ["worker/zzz"] })).status).toBe(400);
    expect((await call("PUT", "/agents/w1/skills", { off: "worker/a" })).status).toBe(400);
    expect((await call("PUT", "/agents/w1/skills", { off: [1] })).status).toBe(400);
    expect((await call("PUT", "/agents/n1/skills", { off: [] })).status).toBe(409);
    expect(existsSync(offFile("w1")) || existsSync(offFile("n1"))).toBe(false);
    const none = await (await call("GET", "/agents/n1/skills")).json();
    expect([none.role, none.mode, none.groups]).toEqual([null, "none", []]);
  });

  test("an unknown agent gets 404 on all three routes", async () => {
    expect((await call("GET", "/agents/ghost/skills")).status).toBe(404);
    expect((await call("PUT", "/agents/ghost/skills", { off: [] })).status).toBe(404);
    expect((await call("POST", "/agents/ghost/skills/apply")).status).toBe(404);
  });

  test("apply prepares a build for a view agent and answers 409 'Relaunch' for a plain agent", async () => {
    await call("PUT", "/agents/w1/skills", { off: ["worker/a"] });
    const ok = await call("POST", "/agents/w1/skills/apply");
    expect(ok.status).toBe(200);
    const prepared = JSON.parse(readFileSync(join(factory, "agents", `${agentKey("w1")}.skills-prepared`), "utf8"));
    expect([prepared.kind, prepared.off]).toEqual(["view", ["worker/a"]]);
    expect(existsSync(join(factory, "agents", `${agentKey("w1")}.view-${prepared.gen}`, "worker/skills/b"))).toBe(true);
    expect(existsSync(join(factory, "agents", `${agentKey("w1")}.view-${prepared.gen}`, "worker/skills/a"))).toBe(false);

    await call("PUT", "/agents/w2/skills", { off: ["worker/a"] });
    const plain = await call("POST", "/agents/w2/skills/apply");
    expect(plain.status).toBe(409);
    expect((await plain.json()).error).toMatch(/^Relaunch w2 to apply/);
  });

  test("the agent token gets 403 on PUT and apply and writes nothing; the human token works", async () => {
    const offBefore = existsSync(offFile("w1")) ? readFileSync(offFile("w1"), "utf8") : null;
    const put = await call("PUT", "/agents/w1/skills", { off: ["worker/a", "worker/b"] }, hub.token);
    expect(put.status).toBe(403);
    expect(existsSync(offFile("w1")) ? readFileSync(offFile("w1"), "utf8") : null).toBe(offBefore);
    const before = existsSync(join(factory, "agents", `${agentKey("w1")}.skills-prepared`));
    expect((await call("POST", "/agents/w1/skills/apply", undefined, hub.token)).status).toBe(403);
    expect(existsSync(join(factory, "agents", `${agentKey("w1")}.skills-prepared`))).toBe(before);
    expect((await call("GET", "/agents/w1/skills", undefined, hub.token)).status).toBe(200);
    expect((await call("PUT", "/agents/w1/skills", { off: [] }, hub.humanToken)).status).toBe(200);
  });

  test("a request without a token gets 401 on each route", async () => {
    for (const [m, p] of [["GET", "/agents/w1/skills"], ["PUT", "/agents/w1/skills"], ["POST", "/agents/w1/skills/apply"]] as const) {
      const r = await fetch(`${hub.url}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" });
      expect(r.status).toBe(401);
    }
  });
});
