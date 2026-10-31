// hub/core/factory-cleanup.ts: the cleanup cases that src-tauri/src/factory.rs had (moved in Part 12 group 10).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupVersions, readLiveState } from "../../hub/core/factory-cleanup";
import { agentKey } from "../../hub/core/skills";

const ver = (c: string) => `v-${c.repeat(16)}`;
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "factory-cleanup-"));
  roots.push(root);
  for (const c of "abcdef12") mkdirSync(join(root, ver(c)));
  writeFileSync(join(root, "current"), ver("a"));
  symlinkSync(ver("b"), join(root, "active"));
  mkdirSync(join(root, "agents"));
  return root;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const later = () => Date.now() + 11 * 60_000;

describe("cleanupVersions", () => {
  test("keeps what is in use, deletes old unused versions and the link of a dead session", () => {
    const d = setup();
    const agents = join(d, "agents");
    symlinkSync(join(d, ver("c")), join(agents, agentKey("live one")));
    symlinkSync(join(d, ver("f")), join(agents, agentKey("dead one")));
    writeFileSync(join(agents, `${agentKey("dead one")}.applied`), ver("f"));
    writeFileSync(join(agents, `${agentKey("live one")}.applied`), ver("c"));
    const live = { sessions: ["live one"], panes: `sh -c "claude --plugin-dir /x/factory/${ver("d")}/worker"` };
    expect(cleanupVersions(d, live, Date.now())).toEqual([]); // too young
    expect(cleanupVersions(d, new Error("boom"), later())).toHaveLength(1); // failed read deletes nothing
    expect(existsSync(join(d, ver("e")))).toBe(true);
    const log = cleanupVersions(d, live, later());
    expect(log).toHaveLength(5);
    expect(() => lstatSync(join(agents, agentKey("dead one")))).toThrow();
    expect(existsSync(join(agents, `${agentKey("dead one")}.applied`))).toBe(false);
    expect(existsSync(join(agents, `${agentKey("live one")}.applied`))).toBe(true);
    for (const c of "abcd") expect(existsSync(join(d, ver(c)))).toBe(true);
    for (const c of "ef12") expect(existsSync(join(d, ver(c)))).toBe(false);
  });

  test("records, views and locks are not links; an unreadable link deletes nothing", () => {
    const d = setup();
    const agents = join(d, "agents");
    const key = agentKey("bob");
    symlinkSync(join(d, ver("c")), join(agents, key));
    for (const x of [".pending", ".skills-off", ".skills-applied"]) writeFileSync(join(agents, `${key}${x}`), "{}");
    mkdirSync(join(agents, `${key}.skills-lock`));
    mkdirSync(join(agents, `${key}.view-1`));
    symlinkSync(`${key}.view-1`, join(agents, `${key}.view`));
    const live = { sessions: ["bob"], panes: "" };
    cleanupVersions(d, live, later());
    expect(existsSync(join(d, ver("e")))).toBe(false);
    expect(existsSync(join(d, ver("c")))).toBe(true);
    expect(existsSync(join(agents, `${key}.pending`))).toBe(true);
    // a dead session: link and records go together
    cleanupVersions(d, { sessions: [], panes: "" }, later());
    expect(() => lstatSync(join(agents, key))).toThrow();
    expect(existsSync(join(agents, `${key}.pending`))).toBe(false);
    mkdirSync(join(d, ver("9")));
    writeFileSync(join(agents, "notalink"), "x");
    expect(cleanupVersions(d, live, later())).toHaveLength(1);
    expect(existsSync(join(d, ver("9")))).toBe(true);
  });
});

describe("readLiveState", () => {
  test("is an Error without CUBILOT_TMUX", () => {
    expect(readLiveState({ CUBILOT_DATA_DIR: "/tmp" })).toBeInstanceOf(Error);
  });
});
