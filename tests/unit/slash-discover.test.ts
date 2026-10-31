// Slash discovery (Part 12 group 3): the same entries for the same folders as slash_discover_for_agent, and the route.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSlashCommands, readFrontmatterDescription, readGlobalMcpServers } from "../../hub/core/slash-discover";
import { spawnHub, type HubHandle } from "../helpers/hub";

const fx = mkdtempSync(join(tmpdir(), "cubilot-slash-"));
const home = join(fx, "home");
const cwd = join(fx, "proj");
const w = (p: string, body: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const cmd = (root: string, name: string, desc?: string) => w(join(root, ".claude/commands", `${name}.md`), desc === undefined ? "body\n" : `---\ndescription: ${desc}\n---\nbody\n`);
const skill = (root: string, base: string, name: string, desc: string) => w(join(root, base, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${desc}"\n---\n`);

beforeAll(() => {
  cmd(cwd, "deploy", "Deploy it");
  cmd(cwd, "shared", "from project");
  cmd(home, "shared", "from home"); // the first definition wins: the project
  cmd(home, "plain");
  w(join(home, ".claude/commands/notes.txt"), "not a command");
  skill(home, ".claude/skills", "grill", "Ask hard questions");
  mkdirSync(join(home, ".claude/skills/empty"), { recursive: true }); // no SKILL.md: not a skill
  skill(cwd, ".pi/skills", "pionly", "Pi only");
  skill(join(home, ".pi/agent/npm/node_modules/pkg"), "skills", "pkgskill", "From a package");
});
afterAll(() => rmSync(fx, { recursive: true, force: true }));

const mcp = { context7: { description: "Docs", prompts: ["lookup", 5] }, serena: { prompts: ["x"] }, none: {} };

describe("discoverSlashCommands", () => {
  test("claude: commands, skills and MCP prompts of the folder and the home, sorted, first definition wins", () => {
    const got = discoverSlashCommands({ cwd, home, harness: "claude", mcpServers: mcp });
    expect(got).toEqual([
      { name: "deploy", description: "Deploy it" },
      { name: "grill", description: "Ask hard questions" },
      { name: "mcp__context7__lookup", description: "Docs" },
      { name: "mcp__serena__x", description: "" },
      { name: "plain", description: "" },
      { name: "shared", description: "from project" },
    ]);
  });

  test("pi: skills as skill:<name>, commands from .claude/commands, no MCP prompts", () => {
    const got = discoverSlashCommands({ cwd, home, harness: "pi", mcpServers: mcp });
    expect(got.map((e) => e.name)).toEqual(["deploy", "plain", "shared", "skill:grill", "skill:pionly", "skill:pkgskill"]);
    expect(got.find((e) => e.name === "skill:pkgskill")!.description).toBe("From a package");
  });

  test("no pane folder: the home folder only", () => {
    const got = discoverSlashCommands({ cwd: null, home, harness: "claude", mcpServers: {} });
    expect(got.map((e) => e.name)).toEqual(["grill", "plain", "shared"]);
  });

  test("an empty home gives no entries", () => {
    expect(discoverSlashCommands({ cwd: join(fx, "nothing"), home: join(fx, "nohome"), harness: "claude", mcpServers: {} })).toEqual([]);
  });
});

describe("helpers", () => {
  test("frontmatter description: quotes stripped, 120 characters, none without frontmatter", () => {
    const f = join(fx, "fm.md");
    w(f, `---\ndescription: '${"x".repeat(200)}'\n---\n`);
    expect(readFrontmatterDescription(f)).toBe("x".repeat(120));
    w(f, "no frontmatter\ndescription: nope\n");
    expect(readFrontmatterDescription(f)).toBeNull();
    w(f, "---\nname: a\n---\ndescription: after\n");
    expect(readFrontmatterDescription(f)).toBeNull();
    expect(readFrontmatterDescription(join(fx, "missing.md"))).toBeNull();
  });

  test("global MCP file: only mcpServers, without chatbridge; bad JSON or no file gives none", () => {
    const f = join(fx, "mcp.json");
    w(f, JSON.stringify({ _comment: "x", mcpServers: { chatbridge: { command: "evil" }, context7: { prompts: ["p"] } } }));
    expect(Object.keys(readGlobalMcpServers(f))).toEqual(["context7"]);
    w(f, "{nope");
    expect(readGlobalMcpServers(f)).toEqual({});
    expect(readGlobalMcpServers(join(fx, "absent.json"))).toEqual({});
  });
});

describe("GET /agents/<name>/slash-commands", () => {
  let hub: HubHandle;
  const get = (path: string) => fetch(`${hub.url}${path}`, { headers: { Authorization: `Bearer ${hub.token}` } });
  beforeAll(async () => {
    const tmux = join(fx, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh
case "$*" in
  *has-session*"=c1"*|*has-session*"=p1"*) exit 0 ;;
  *has-session*) exit 1 ;;
  *show-options*"=p1:"*) echo pi ;;
  *show-options*"=c1:"*) echo claude ;;
  *display-message*) echo ${cwd} ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(tmux, 0o755);
    hub = await spawnHub({ env: { CUBILOT_TMUX: tmux, HOME: home } });
    mkdirSync(hub.dataDir, { recursive: true });
    writeFileSync(join(hub.dataDir, "mcp.json"), JSON.stringify({ mcpServers: mcp }));
  });
  afterAll(() => hub.kill());

  test("a claude agent: the entries of its folder", async () => {
    const body = await (await get("/agents/c1/slash-commands")).json();
    expect(body.commands.map((e: { name: string }) => e.name)).toEqual(["deploy", "grill", "mcp__context7__lookup", "mcp__serena__x", "plain", "shared"]);
  });

  test("a pi agent: skill:<name> entries", async () => {
    const body = await (await get("/agents/p1/slash-commands")).json();
    expect(body.commands.map((e: { name: string }) => e.name)).toContain("skill:grill");
  });

  test("an unknown agent is 404", async () => {
    expect((await get("/agents/nobody/slash-commands")).status).toBe(404);
  });

  test("a read route needs the bearer token", async () => {
    expect((await fetch(`${hub.url}/agents/c1/slash-commands`)).status).toBe(401);
  });
});
