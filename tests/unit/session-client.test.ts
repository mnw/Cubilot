// The UI creates, lists and kills sessions through the hub routes and calls no Tauri command for it (hub-first-browser 8.2).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

type Call = { path: string; init?: RequestInit };

function load(answer: (c: Call) => { ok: boolean; status?: number; body?: unknown } = () => ({ ok: true, body: {} })) {
  const fetched: Call[] = [];
  const invoked: Array<[string, unknown]> = [];
  const win: any = {
    __TAURI__: { core: { invoke: async (cmd: string, args: unknown) => { invoked.push([cmd, args]); } } },
    authedFetch: async (path: string, init?: RequestInit) => {
      const c = { path, init };
      fetched.push(c);
      const a = answer(c);
      return { ok: a.ok, status: a.status ?? (a.ok ? 200 : 400), json: async () => a.body, text: async () => JSON.stringify(a.body) };
    },
  };
  const parseErrorBody = async (r: any) => (await r.json()).error;
  new Function("window", "TextEncoder", "parseErrorBody", readFileSync("ui/terminal/pty.js", "utf8"))(win, TextEncoder, parseErrorBody);
  return { pty: win.__CUBILOT_TERM__.pty, fetched, invoked };
}
const sent = (c: Call) => JSON.parse(String(c.init?.body));

describe("session routes", () => {
  test("ptySpawn posts the launch form to /sessions, then attaches with pty_attach", async () => {
    const { pty, fetched, invoked } = load();
    await pty.ptySpawn("w1", "/work", "resume", "cubilot", "pi", "worker", "m1", "high", "prov");
    expect(fetched.map((c) => `${c.init?.method} ${c.path}`)).toEqual(["POST /sessions"]);
    expect(sent(fetched[0])).toEqual({ name: "w1", cwd: "/work", resume: "resume", room: "cubilot", harness: "pi", role: "worker", model: "m1", effort: "high", provider: "prov" });
    expect(invoked).toEqual([["pty_attach", { agent: "w1" }]]);
  });

  test("ptySpawn sends only what is set", async () => {
    const { pty, fetched } = load();
    await pty.ptySpawn("w1", "/work", null, null, null, "worker");
    expect(sent(fetched[0])).toEqual({ name: "w1", cwd: "/work", role: "worker" });
  });

  test("attachOnly calls the hub for nothing and only attaches", async () => {
    const { pty, fetched, invoked } = load();
    await pty.ptySpawn("w1", "/work", null, null, null, null, null, null, null, true);
    expect(fetched).toEqual([]);
    expect(invoked).toEqual([["pty_attach", { agent: "w1" }]]);
  });

  test("a hub refusal rejects with the hub's text and nothing is attached", async () => {
    const { pty, invoked } = load(() => ({ ok: false, body: { error: "a role is required" } }));
    await expect(pty.ptySpawn("w1", "/work")).rejects.toThrow("a role is required");
    expect(invoked).toEqual([]);
  });

  test("ptyKill posts to the kill route of the encoded name", async () => {
    const { pty, fetched, invoked } = load();
    await pty.ptyKill("my agent");
    expect(fetched.map((c) => `${c.init?.method} ${c.path}`)).toEqual(["POST /sessions/my%20agent/kill"]);
    expect(invoked).toEqual([]);
  });

  test("ptyKill rejects when the hub refuses", async () => {
    const { pty } = load(() => ({ ok: false, status: 404, body: { error: "no session: w1" } }));
    await expect(pty.ptyKill("w1")).rejects.toThrow("no session: w1");
  });

  test("ptyList gives the session names, and an empty list when the hub fails", async () => {
    expect(await load(() => ({ ok: true, body: { sessions: ["a", "b"] } })).pty.ptyList()).toEqual(["a", "b"]);
    expect(await load(() => ({ ok: false, body: { error: "x" } })).pty.ptyList()).toEqual([]);
  });

  test("ptyShellExists reads GET /sessions/shell; ptySpawnShell posts it, then attaches the shell", async () => {
    expect(await load(() => ({ ok: true, body: { exists: true } })).pty.ptyShellExists()).toBe(true);
    expect(await load(() => ({ ok: true, body: { exists: false } })).pty.ptyShellExists()).toBe(false);
    expect(await load(() => ({ ok: false, body: { error: "x" } })).pty.ptyShellExists()).toBe(false);
    const { pty, fetched, invoked } = load();
    await pty.ptySpawnShell();
    expect(fetched.map((c) => `${c.init?.method} ${c.path}`)).toEqual(["POST /sessions/shell"]);
    expect(invoked).toEqual([["pty_attach", { agent: "shell" }]]);
  });
});

describe("no Tauri command for sessions", () => {
  const files = [...new Glob("ui/**/*.{js,html}").scanSync(".")].filter((f) => !f.startsWith("ui/vendor/"));
  test.each(["pty_spawn", "pty_spawn_shell", "pty_list", "pty_shell_exists", "pty_kill"])("no UI file names %s", (cmd) => {
    for (const f of files) expect(readFileSync(f, "utf8"), `${f} names ${cmd}`).not.toMatch(new RegExp(`['"\`]${cmd}['"\`]`));
  });
});
