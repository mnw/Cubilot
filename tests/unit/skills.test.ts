// hub/core/skills.ts: the skills.rs test cases (list, store, mode, prepare) on a temp factory folder, never the real app data.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../../hub/features/factory-skills";
import { agentKey, applyIn, buildView, inventory, listIn, modeFromCommand, setOffIn, shellWords, SkillsError, writeAtomic } from "../../hub/core/skills";

const V = "v-0000000000000001";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// A staged version: worker with skills a, b and shared with skill s; a plugin manifest in both.
function staged() {
  const root = mkdtempSync(join(tmpdir(), "cubilot-skills-"));
  roots.push(root);
  const dest = join(root, "factory");
  const v = join(dest, V);
  for (const [g, skills] of [["worker", ["a", "b"]], ["shared", ["s"]]] as const) {
    mkdirSync(join(v, g, ".claude-plugin"), { recursive: true });
    writeFileSync(join(v, g, ".claude-plugin/plugin.json"), `{"name":"factory-${g}"}`);
    for (const s of skills) {
      mkdirSync(join(v, g, "skills", s), { recursive: true });
      writeFileSync(join(v, g, "skills", s, "SKILL.md"), s);
    }
  }
  writeFileSync(join(v, "worker/role.md"), "role");
  mkdirSync(join(v, "worker/hooks"), { recursive: true });
  writeFileSync(join(v, "worker/hooks/hooks.json"), "{}");
  mkdirSync(join(dest, "agents"), { recursive: true });
  symlinkSync(v, join(dest, "agents", agentKey("ag"))); // the agent link; view links go through it
  return { root, dest, v };
}

const rec = (dest: string, agent: string, suffix: string) => join(dest, "agents", `${agentKey(agent)}${suffix}`);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ids = (s: ReturnType<typeof listIn>) => s.groups.flatMap((g) => g.skills.map((k) => [k.id, k.on, k.state]));
const viewCmd = (dest: string, agent: string, withView: boolean) => {
  const base = join(dest, "agents", `${agentKey(agent)}${withView ? ".view" : ""}`);
  return `CHATBRIDGE_ROLE='worker' '/bin/pi' --no-skills --skill '${base}/worker/skills' --skill '${base}/shared/skills' -e '/e.js'`;
};
const views = (dest: string, agent: string) => [1, 2, 3, 4].filter((g) => existsSync(join(dest, "agents", `${agentKey(agent)}.view-${g}`)));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("list", () => {
  test("a role-less agent has no groups and a legacy agent with a role is not role-less", () => {
    const { dest, v } = staged();
    const none = listIn(dest, v, "ag", null, null);
    expect([none.role, none.mode, none.relaunch_needed, none.groups.length]).toEqual([null, "none", false, 0]);
    const legacy = listIn(dest, v, "ag", "worker", "'/bin/claude' --plugin-dir '/m'");
    expect([legacy.role, legacy.mode]).toEqual(["worker", "legacy"]);
    expect(legacy.groups.map((g) => g.name)).toEqual(["Role · worker", "Shared"]);
    expect(ids(legacy).every(([, on, st]) => on === true && st === "new")).toBe(true);
    expect(listIn(dest, v, "ag", "worker", null).mode).toBe("legacy");
  });

  test("states come only from the applied record", () => {
    const { dest, v } = staged();
    writeAtomic(rec(dest, "ag", ".skills-applied"), '{"version":"x","gen":1,"off":["worker/b"],"skills":["worker/a","worker/b"]}');
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    const l = listIn(dest, v, "ag", "worker", viewCmd(dest, "ag", true));
    expect(ids(l)).toEqual([
      ["worker/a", false, "loaded"],
      ["worker/b", true, "not_loaded"],
      ["shared/s", true, "new"],
    ]);
    expect(l.relaunch_needed).toBe(false);
  });

  test("relaunch is needed for the first uncheck of a plain or legacy agent only", async () => {
    const { dest, v } = staged();
    const plain = viewCmd(dest, "ag", false);
    expect(listIn(dest, v, "ag", "worker", plain).relaunch_needed).toBe(false);
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    const l = listIn(dest, v, "ag", "worker", plain);
    expect([l.mode, l.relaunch_needed]).toEqual(["plain", true]);
    expect(listIn(dest, v, "ag", "worker", "'/bin/claude'").relaunch_needed).toBe(true);
    expect(listIn(dest, v, "ag", "worker", viewCmd(dest, "ag", true)).relaunch_needed).toBe(false);
    await expect(applyIn(dest, v, "ag", "worker", plain)).rejects.toThrow("Relaunch ag to apply");
    expect(views(dest, "ag")).toEqual([]);
    expect(existsSync(rec(dest, "ag", ".skills-prepared"))).toBe(false);
  });

  test("an obsolete role id in the store does not set relaunch_needed", () => {
    const { dest, v } = staged();
    writeAtomic(rec(dest, "ag", ".skills-off"), '["old-role/x"]');
    expect(listIn(dest, v, "ag", "worker", viewCmd(dest, "ag", false)).relaunch_needed).toBe(false);
    writeAtomic(rec(dest, "ag", ".skills-off"), '["old-role/x","worker/a"]');
    expect(listIn(dest, v, "ag", "worker", viewCmd(dest, "ag", false)).relaunch_needed).toBe(true);
  });
});

describe("mode", () => {
  test("is read from the real flag values only", () => {
    const { dest } = staged();
    const key = agentKey("ag");
    const d = dest;
    const view = `${d}/agents/${key}.view`;
    const link = `${d}/agents/${key}`;
    const m = (c: string) => modeFromCommand(c, dest, "ag");
    expect(m(`pi --skill '${view}/worker/skills' --skill '${view}/shared/skills'`)).toBe("view");
    expect(m(`claude --plugin-dir '/m' --plugin-dir '${view}/worker' --plugin-dir '${view}/shared'`)).toBe("view");
    expect(m(`pi --skill '${link}/worker/skills' --skill '${link}/shared/skills'`)).toBe("plain");
    expect(m(`pi --append-system-prompt '${view}/x' --skill '${link}/worker/skills'`)).toBe("plain");
    expect(m(`CHATBRIDGE_ROOM='${view}/worker' pi --skill '${link}/worker/skills'`)).toBe("plain");
    expect(m(`pi --append-system-prompt-file '${view}/role.md' --model x`)).toBe("legacy");
    expect(m(`pi --append-system-prompt --skill '${view}/worker/skills'`)).toBe("legacy");
    expect(m(`pi 'a --skill ${view}/worker/skills'`)).toBe("legacy");
    expect(m(`pi --skill '${d}/agents/${agentKey("other")}.view/worker/skills'`)).toBe("legacy");
    expect(m(`pi --skill "${view}/worker/skills"`)).toBe("view");
    expect(m(`pi --skill ${(view + "/worker/skills").replace(/ /g, "\\ ")}`)).toBe("view");
    expect(m("pi --no-skills -e '/e.js'")).toBe("legacy");
    expect(m("")).toBe("legacy");
    expect(shellWords(String.raw`a 'b c' "d \" e" f\ g`)).toEqual(["a", "b c", 'd " e', "f g"]);
  });

  test("reads the one-argument double-quoted form tmux prints for the pane start command", () => {
    const { dest } = staged();
    const view = `${dest}/agents/${agentKey("ag")}.view`;
    const tmux = `"CHATBRIDGE_AGENT='ag' pi --skill '${view}/worker/skills' -e '/x.js'"`;
    expect(modeFromCommand(tmux, dest, "ag")).toBe("view");
    expect(modeFromCommand(tmux, dest, "someone-else")).toBe("legacy");
  });
});

describe("store", () => {
  test("set refuses an unknown id, deletes the file for an empty list and writes mode 0600", () => {
    const { dest, v } = staged();
    const path = rec(dest, "ag", ".skills-off");
    expect(() => setOffIn(dest, v, "ag", "worker", ["worker/a", "worker/zzz"])).toThrow("unknown skill: worker/zzz");
    expect(existsSync(path)).toBe(false);
    try {
      setOffIn(dest, v, "ag", "worker", ["worker/zzz"]);
    } catch (e) {
      expect((e as SkillsError).status).toBe(400);
    }
    setOffIn(dest, v, "ag", "worker", ["shared/s", "worker/a", "worker/a"]);
    expect(json(path)).toEqual(["shared/s", "worker/a"]);
    expect(mode(path)).toBe(0o600);
    expect(() => setOffIn(dest, v, "ag", "worker", ["worker/zzz"])).toThrow();
    expect(json(path)).toEqual(["shared/s", "worker/a"]);
    setOffIn(dest, v, "ag", "worker", []);
    expect(existsSync(path)).toBe(false);
    setOffIn(dest, v, "ag", "worker", []);
  });

  test("the write is atomic: no temp file stays and a failed write changes nothing", () => {
    const { dest, v } = staged();
    const path = rec(dest, "ag", ".skills-off");
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    const key = agentKey("ag");
    expect(require("node:fs").readdirSync(join(dest, "agents")).filter((n: string) => n.startsWith(`${key}.`))).toEqual([`${key}.skills-off`]);
    // the target path is a folder: rename fails, the temp file goes, the folder stays
    rmSync(path);
    mkdirSync(path);
    expect(() => setOffIn(dest, v, "ag", "worker", ["worker/b"])).toThrow();
    expect(require("node:fs").readdirSync(join(dest, "agents")).filter((n: string) => n.startsWith(`${key}.`))).toEqual([`${key}.skills-off`]);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  test("a choice survives a kill and the x button", () => {
    const { dest, v } = staged();
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    expect(listIn(dest, v, "ag", "worker", viewCmd(dest, "ag", true)).groups[0].skills[0].on).toBe(false);
    expect(listIn(dest, v, "ag", "worker", null).groups[0].skills[0].on).toBe(false);
  });
});

describe("prepare", () => {
  // A launch as the shell does it: the choice in the store, an applied record of the inventory.
  const launched = (dest: string, v: string, off: string[]) => {
    const body = JSON.stringify({ version: V, gen: 0, off, skills: inventory(v, "worker") });
    writeAtomic(rec(dest, "ag", ".skills-published"), body);
    writeAtomic(rec(dest, "ag", ".skills-applied"), body);
  };

  test("a plain agent with every skill on prepares an inventory record and no build", async () => {
    const { dest, v } = staged();
    launched(dest, v, []);
    mkdirSync(join(v, "worker/skills/c"));
    await applyIn(dest, v, "ag", "worker", viewCmd(dest, "ag", false));
    const p = json(rec(dest, "ag", ".skills-prepared"));
    expect([p.kind, p.gen, p.off]).toEqual(["inventory", 1, []]);
    expect(p.skills).toContain("worker/c");
    expect(views(dest, "ag")).toEqual([]);
  });

  test("a plain agent reload makes a new skill loaded with no view and the same flags", async () => {
    const { dest, v } = staged();
    launched(dest, v, []);
    const flags = viewCmd(dest, "ag", false);
    mkdirSync(join(v, "worker/skills/c"));
    expect(ids(listIn(dest, v, "ag", "worker", flags)).find(([i]) => i === "worker/c")![2]).toBe("new");
    await applyIn(dest, v, "ag", "worker", flags);
    const p = json(rec(dest, "ag", ".skills-prepared"));
    // the hub publishes the prepared record, copies it to pending and to applied on the success report
    writeAtomic(rec(dest, "ag", ".skills-applied"), JSON.stringify({ version: V, gen: p.gen, off: p.off, skills: p.skills }));
    const after = listIn(dest, v, "ag", "worker", flags);
    expect(after.groups.flatMap((g) => g.skills).every((s) => s.on && s.state === "loaded")).toBe(true);
    expect([after.mode, after.relaunch_needed]).toEqual(["plain", false]);
    expect(views(dest, "ag")).toEqual([]);
    expect(existsSync(rec(dest, "ag", ".view"))).toBe(false);
  });

  test("a preparation builds without publishing and a newer one replaces the older unpublished build", async () => {
    const { dest, v } = staged();
    const key = agentKey("ag");
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    buildView(dest, v, "ag", "worker", 1, ["worker/a"]); // gen 1 published
    const publishedLink = rec(dest, "ag", ".view");
    symlinkSync(`${key}.view-1`, publishedLink);
    writeAtomic(rec(dest, "ag", ".skills-published"), JSON.stringify({ gen: 1, off: ["worker/a"], skills: inventory(v, "worker"), version: V }));
    const before = readlinkSync(publishedLink);
    const publishedRec = readFileSync(rec(dest, "ag", ".skills-published"), "utf8");
    const cmd = viewCmd(dest, "ag", true);
    setOffIn(dest, v, "ag", "worker", ["worker/a", "worker/b"]);
    await applyIn(dest, v, "ag", "worker", cmd);
    expect(readlinkSync(publishedLink)).toBe(before);
    expect(readFileSync(rec(dest, "ag", ".skills-published"), "utf8")).toBe(publishedRec);
    expect(json(rec(dest, "ag", ".skills-prepared")).gen).toBe(2);
    expect(existsSync(join(dest, "agents", `${key}.view-2/worker/skills/b`))).toBe(false);
    // all on again: a full view, prepared as gen 3; the unpublished gen 2 goes
    setOffIn(dest, v, "ag", "worker", []);
    await applyIn(dest, v, "ag", "worker", cmd);
    expect(json(rec(dest, "ag", ".skills-prepared")).gen).toBe(3);
    const full = join(dest, "agents", `${key}.view-3`);
    for (const p of ["worker/skills/a", "worker/skills/b", "shared/skills/s"]) expect(existsSync(join(full, p))).toBe(true);
    expect(existsSync(join(dest, "agents", `${key}.view-2`))).toBe(false);
    expect(existsSync(join(dest, "agents", `${key}.view-1`))).toBe(true);
    // a failing build (the shared folder is missing) leaves .skills-prepared as it was
    const prepared = readFileSync(rec(dest, "ag", ".skills-prepared"), "utf8");
    renameSync(join(v, "shared"), join(v, "shared-away"));
    await expect(applyIn(dest, v, "ag", "worker", cmd)).rejects.toThrow();
    renameSync(join(v, "shared-away"), join(v, "shared"));
    expect(readFileSync(rec(dest, "ag", ".skills-prepared"), "utf8")).toBe(prepared);
    expect(views(dest, "ag")).toEqual([1, 3]);
    // plain agent, everything on: apply is a no-op
    setOffIn(dest, v, "ag", "worker", []);
    await applyIn(dest, v, "ag", "worker", viewCmd(dest, "ag", false));
  });

  test("a view of the real staged tree leaves every staged file unchanged when the view is written", () => {
    const { dest, v } = staged();
    const snap = () => Object.fromEntries(["worker/.claude-plugin/plugin.json", "shared/.claude-plugin/plugin.json", "worker/role.md", "worker/skills/a/SKILL.md"].map((f) => [f, readFileSync(join(v, f), "utf8")]));
    const before = snap();
    const view = buildView(dest, v, "ag", "worker", 1, ["worker/b"]);
    writeFileSync(join(view, "worker/.claude-plugin/plugin.json"), "changed");
    writeFileSync(join(view, "worker/.gitignore"), "x");
    expect(snap()).toEqual(before);
    expect(lstatSync(join(view, "worker/role.md")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(view, "worker/.claude-plugin")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(view, "worker/skills/b"))).toBe(false);
    expect(readlinkSync(join(view, "worker/skills/a"))).toBe(join(dest, "agents", agentKey("ag"), "worker/skills/a"));
  });

  test("a preparation waits for the lock and errors after the wait", async () => {
    const { dest, v } = staged();
    setOffIn(dest, v, "ag", "worker", ["worker/a"]);
    buildView(dest, v, "ag", "worker", 1, ["worker/a"]);
    writeAtomic(rec(dest, "ag", ".skills-published"), JSON.stringify({ gen: 1, off: ["worker/a"], skills: [] }));
    const release = await takeLock(dest, agentKey("ag"), 1000, "hub");
    try {
      const t0 = Date.now();
      await expect(applyIn(dest, v, "ag", "worker", viewCmd(dest, "ag", true), 300)).rejects.toThrow("busy");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
      expect(views(dest, "ag")).toEqual([1]);
    } finally {
      release();
    }
  });

  test("an agent without a role cannot be prepared", async () => {
    const { dest, v } = staged();
    await expect(applyIn(dest, v, "ag", null, null)).rejects.toThrow("no role");
  });
});

describe("role from a tmux pill is not trusted", () => {
  test("a role that is a path is refused before any read or write, and nothing outside the factory is touched", async () => {
    const { root, dest, v } = staged();
    const outside = join(root, "owned");
    mkdirSync(join(outside, "skills", "x"), { recursive: true });
    writeFileSync(join(outside, "skills", "x", "SKILL.md"), "x");
    mkdirSync(join(root, "factory-sibling"), { recursive: true });
    const before = readdirSyncSorted(join(dest, "agents"));
    for (const role of ["../../owned", `../${"owned"}`, "/tmp/owned", "shared", "Worker", "a/b", "missing"]) {
      expect(() => listIn(dest, v, "ag", role, null), role).toThrow(SkillsError);
      expect(() => setOffIn(dest, v, "ag", role, []), role).toThrow(SkillsError);
      await expect(applyIn(dest, v, "ag", role, null), role).rejects.toBeInstanceOf(SkillsError);
    }
    expect(readdirSyncSorted(join(dest, "agents"))).toEqual(before);
    expect(existsSync(rec(dest, "ag", ".skills-off"))).toBe(false);
    expect(readdirSyncSorted(outside)).toEqual(["skills"]);
  });
});
const readdirSyncSorted = (p: string) => readdirSync(p).sort();
