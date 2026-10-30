import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import vm from "node:vm";

// ui/features/native-actions.js, whole file, in a vm with a fake DOM. No __TAURI_INTERNALS__ unless a test adds one.
const SRC = readFileSync("ui/features/native-actions.js", "utf8");

class El {
  value = "";
  textContent = "";
  focused = false;
  selected = false;
  classes = new Set<string>();
  handlers: Record<string, Array<(e: any) => void>> = {};
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  addEventListener(t: string, fn: (e: any) => void) { (this.handlers[t] ??= []).push(fn); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

let els: Record<string, El>;
let tauriCalls: string[];
let fetched: string[];
let clipboard: string[];
let ctx: any;

function boot(tauri: boolean, paths: Record<string, string> = { config: "/data/config.yml", skills: "/data/factory-user", mcp: "/data/mcp.json" }) {
  els = {};
  for (const id of ["path-modal", "path-title", "path-note", "path-value", "path-copy-btn", "path-close-btn", "path-copied-status"]) els[id] = new El();
  tauriCalls = [];
  fetched = [];
  clipboard = [];
  const window: any = {};
  if (tauri) window.__TAURI_INTERNALS__ = { invoke: async () => undefined };
  ctx = vm.createContext({
    window,
    document: { getElementById: (id: string) => els[id] ?? null, addEventListener() {} },
    navigator: { clipboard: { writeText: async (t: string) => { clipboard.push(t); } } },
    setTimeout: () => 0,
    tauriInvoke: async (cmd: string) => { tauriCalls.push(cmd); },
    authedFetch: async (path: string) => { fetched.push(path); return { ok: true, json: async () => paths }; },
    parseErrorBody: async () => "err",
  });
  vm.runInContext(SRC, ctx);
}

describe("native actions without the Tauri shell", () => {
  beforeEach(() => boot(false));

  test("Open config in a browser: the path with Copy, no Tauri command, no error", async () => {
    await vm.runInContext("openNative('config')", ctx);
    expect(tauriCalls).toEqual([]);
    expect(fetched).toEqual(["/settings/paths"]);
    expect(els["path-modal"].classes.has("open")).toBe(true);
    expect(els["path-value"].value).toBe("/data/config.yml");
    await els["path-copy-btn"].handlers.click[0]({});
    expect(clipboard).toEqual(["/data/config.yml"]);
  });

  test("the skills folder and the MCP config show their own paths", async () => {
    await vm.runInContext("openNative('skills')", ctx);
    expect(els["path-value"].value).toBe("/data/factory-user");
    await vm.runInContext("openNative('mcp')", ctx);
    expect(els["path-value"].value).toBe("/data/mcp.json");
    expect(tauriCalls).toEqual([]);
  });

  test("Reload in a browser: the restart text, and no hub request", () => {
    expect(vm.runInContext("reloadInBrowser()", ctx)).toBe(true);
    expect(els["path-title"].textContent).toBe("Restart the hub to apply these settings");
    expect(els["path-value"].value.length).toBeGreaterThan(0);
    expect(els["path-modal"].classes.has("open")).toBe(true);
    expect(fetched).toEqual([]);
    expect(tauriCalls).toEqual([]);
  });

  test("a hub error rejects, so the caller shows it", async () => {
    ctx.authedFetch = async () => ({ ok: false, status: 500, text: async () => "" });
    await expect(vm.runInContext("openNative('config')", ctx)).rejects.toThrow();
  });
});

describe("native actions in the desktop window", () => {
  beforeEach(() => boot(true));

  test("Open config calls the shell command and shows nothing", async () => {
    await vm.runInContext("openNative('config')", ctx);
    expect(tauriCalls).toEqual(["open_config_file"]);
    expect(fetched).toEqual([]);
    expect(els["path-modal"].classes.has("open")).toBe(false);
  });

  test("Reload is left to the shell", () => {
    expect(vm.runInContext("reloadInBrowser()", ctx)).toBe(false);
    expect(els["path-modal"].classes.has("open")).toBe(false);
  });
});

describe("the UI reads its settings from the hub", () => {
  test("no UI file invokes one of the eight moved commands", () => {
    const re = /invoke\(\s*'(get_ui_settings|get_human_name|get_app_version|get_mcp_template|resolve_default_room|list_roles|pty_roles|pty_harness)'/;
    for (const f of new Glob("ui/**/*.js").scanSync(".")) {
      if (f.startsWith("ui/vendor/")) continue;
      expect(re.test(readFileSync(f, "utf8")), f).toBe(false);
    }
  });
});
