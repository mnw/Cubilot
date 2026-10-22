import { describe, expect, mock, test, tier } from "claude-code/testing";

tier("user");

const TOKEN = "tok-test";
const HUB = "http://127.0.0.1:9999";

// The mod sends every hub request as `curl -K -` with a config on stdin.
function urlOf(stdin: string): string {
  return /^url = "([^"]*)"/m.exec(stdin)?.[1] ?? "";
}
function curlOk(status: number, body: string) {
  return { value: { exitCode: 0, stdout: `${body}\n${status}`, stderr: "" } };
}

// What hub.url says, and whether CHATBRIDGE_HUB pins it (tests clear the pin to move the hub).
// Extra launch env for the next world() (reset by it).
let extraEnv: Record<string, string> = {};
let urlNow = HUB;
let hubPinned = true;

// What the token file says; tests change it mid-run to model a token rotation.
let tokenNow = TOKEN;

// Every curl child the mod started in the last world(): its argv and the config on stdin.
let curlCalls: Array<{ argv: string[]; stdin: string }> = [];

// Ordered stream: a string is yielded as a chunk, a function is awaited (a step the test controls).
// Overrides world()'s `chunk` for one test; world() clears it.
let streamSteps: Array<string | (() => Promise<void>)> | null = null;

// The exit code the mocked hub-stream curl ends with.
let spawnCode = 0;
let clock: { advance(ms: number): Promise<void> };

// Every host-state write the mod made since the last world(), as [key, value].
let stateSets: Array<[string, unknown]> = [];
// The host-held state of the last world(), so a test can play a second module writing to it.
let stateNow: Record<string, unknown> = {};

// Wires the world beneath the mod: identity env, the token file, a silent clock,
// an idle hub stream, and debug logs. `run` answers each curl request.
function world(on: any, run: (url: string, stdin: string) => unknown, chunk?: string, check: object = { decision: "allow" }, ownLog = false, stateSeed: Record<string, unknown> = {}) {
  urlNow = HUB;
  mock.env(on, { CHATBRIDGE_AGENT: "bob", CHATBRIDGE_ROOM: "r1", CHATBRIDGE_HUB: hubPinned ? HUB : "", HOME: "/Users/t", ...extraEnv });
  clock = mock.clock(on);
  spawnCode = 0;
  streamSteps = null;
  curlCalls = [];
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  tokenNow = TOKEN;
  on("fs.read", (_$: any, e: any) => ({ value: String(e.path ?? "").endsWith("hub.url") ? urlNow : tokenNow }));
  if (!ownLog) on("ui.log", () => ({ value: undefined }));
  on("tool.check", () => check);
  // Host-held $.state, answered from memory.
  const state: Record<string, unknown> = { ...stateSeed };
  stateNow = state;
  stateSets = [];
  on("state.get", ($: any, e: any) => ({ value: { value: state[e.key], version: 1 } }));
  on("state.set", ($: any, e: any) => { stateSets.push([e.key, e.value]); state[e.key] = e.value; return { value: { version: 2 } }; });
  on("tool.register", ($: any, e: any) => ({ value: { tool: `mcp__chatbridge__${e.name}` } }));
  on("process.spawn", async function* ($: any, e: any) {
    curlCalls.push({ argv: [...(e.argv ?? [])], stdin: String(e.input ?? "") });
    if (streamSteps) {
      for (const step of streamSteps) {
        if (typeof step === "string") yield { stream: "stdout", text: step };
        else await step();
      }
    } else if (chunk) yield { stream: "stdout", text: chunk };
    return { value: { code: spawnCode } };
  });
  // Beneath the mod, an unanswered permission request is Claude Code's own dialog: no decision.
  on("classic.PermissionRequest", () => ({}));
  on("process.run", ($: any, e: any) => {
    curlCalls.push({ argv: [...(e.argv ?? [])], stdin: String(e.init?.stdin ?? "") });
    return run(urlOf(e.init?.stdin ?? ""), e.init?.stdin ?? "");
  });
}

async function start($: any) {
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
}

// The hub answers a relink with a move; anything else is a plain 200.
const relinked = (url: string) => (url.endsWith("/factory/applied") ? curlOk(200, "{}") : url.endsWith("/factory/relink") ? curlOk(200, JSON.stringify({ ok: true, reload: true, version: "v-2" })) : curlOk(200, "{}"));

describe("register", () => {
  test("tool call: post goes to the hub and returns its text", async ($, on) => {
    const seen: string[] = [];
    world(on, (url, stdin) => {
      seen.push(url);
      expect(stdin).toContain(`Authorization: Bearer ${TOKEN}`);
      return curlOk(200, '{"ok":true}');
    });
    await start($);
    const r: any = await $.tool.call({ tool: "mcp__chatbridge__post", to: "you", text: "hi" } as any);
    expect(r.deny).toBeUndefined();
    expect(String(r.result ?? r.text)).toContain("posted");
    expect(seen).toContain(`${HUB}/post`);
  });

  test("every curl child starts with -q and its config sets noproxy (request, upload and stream)", async ($, on) => {
    world(on, () => curlOk(200, "{}"), '{"x":1}', { decision: "allow" }, false);
    await start($);
    await $.tool.call({ tool: "mcp__chatbridge__post", to: "you", text: "hi" } as any);
    await $.classic.PermissionRequest({ tool_name: "Bash", tool_input: {}, permission_suggestions: [] } as any);
    expect(curlCalls.length).toBeGreaterThanOrEqual(3);          // the stream, a post, a permission request
    for (const c of curlCalls) {
      expect(c.argv.slice(0, 2)).toEqual(["curl", "-q"]);        // -q FIRST: no ~/.curlrc
      expect(c.stdin).toContain('noproxy = "*"');
      expect(c.stdin).not.toMatch(/^proxy\s*=/m);
    }
    expect(curlCalls.some((c) => c.argv.includes("-N"))).toBe(true);   // the stream call is covered too
  });

  test("tool call: a hub rejection surfaces as an error to the model", async ($, on) => {
    world(on, () => curlOk(403, '{"error":"cross-room"}'));
    await start($);
    const r: any = await $.tool.call({ tool: "mcp__chatbridge__post", to: "x", text: "hi" } as any);
    expect(JSON.stringify(r)).toContain("403");
  });
});

describe("tool permissions", () => {
  const call = { tool: "mcp__chatbridge__post_file", path: "/tmp/x.md", to: "you" };

  test("a user ask rule refuses the call; nothing reaches the hub", async ($, on) => {
    const seen: string[] = [];
    world(on, (url) => { seen.push(url); return curlOk(200, "{}"); }, undefined, { decision: "ask", rule: "mcp__chatbridge__post_file" });
    await start($);
    const r: any = await $.tool.call(call as any);
    expect(JSON.stringify(r)).toContain("blocked by permission rule mcp__chatbridge__post_file");
    expect(seen).toEqual([]);
  });

  test("a deny decision refuses the call; nothing reaches the hub", async ($, on) => {
    const seen: string[] = [];
    world(on, (url) => { seen.push(url); return curlOk(200, "{}"); }, undefined, { decision: "deny", reason: "denied" });
    await start($);
    const r: any = await $.tool.call(call as any);
    expect(JSON.stringify(r)).toContain("blocked");
    expect(seen).toEqual([]);
  });

  test("an ask from the mode alone (no rule) runs the tool", async ($, on) => {
    const seen: string[] = [];
    world(on, (url) => { seen.push(url); return curlOk(200, '{"ok":true}'); }, undefined, { decision: "ask" });
    await start($);
    const r: any = await $.tool.call({ tool: "mcp__chatbridge__post", to: "you", text: "hi" } as any);
    expect(String(r.result ?? r.text)).toContain("posted");
    expect(seen).toContain(`${HUB}/post`);
  });
});

describe("post_file paths", () => {
  test("spaces, ;, comma, quote and backslash are escaped for curl -F, not rejected", async ($, on) => {
    const path = '/tmp/a "b";c\\d, e.md';
    let form = "";
    world(on, (url, stdin) => {
      if (url.endsWith("/upload")) {
        form = /^form = (.*)$/m.exec(stdin)?.[1] ?? "";
        return curlOk(200, '{"url":"/image/x.md","path":"/att/x.md"}');
      }
      return curlOk(200, "{}");
    });
    on("fs.stat", () => ({ value: { kind: "file", size: 10, mtimeMs: 0, isLink: false } }));
    await start($);
    const r: any = await $.tool.call({ tool: "mcp__chatbridge__post_file", path, to: "you" } as any);
    expect(String(r.result ?? r.text)).toContain("posted /att/x.md");
    // config-file layer escapes once more; curl undoes it and then reads file=@"<-F-escaped path>"
    expect(form).toBe('"file=@\\"/tmp/a \\\\\\"b\\\\\\";c\\\\\\\\d, e.md\\""');
  });
});

describe("classic.PermissionRequest", () => {
  const ask = { tool_name: "Bash", tool_input: { command: "touch /tmp/x" }, permission_suggestions: [] };

  function hub(waits: Array<[number, string]>, dismiss: [number, string] | "unreachable" = [200, "{}"]) {
    const calls: string[] = [];
    return {
      calls,
      run: (url: string) => {
        calls.push(url.replace(HUB, ""));
        if (url.endsWith("/permissions")) return curlOk(201, "{}");
        if (url.includes("/wait?")) {
          const [s, b] = waits.shift() ?? [200, '{"status":"pending"}'];
          return curlOk(s, b);
        }
        if (url.endsWith("/dismiss")) {
          return dismiss === "unreachable" ? { value: { exitCode: 7, stdout: "", stderr: "connect failed" } } : curlOk(dismiss[0], dismiss[1]);
        }
        return curlOk(404, "{}");
      },
    };
  }

  test("allowed in the room -> allow, no dialog", async ($, on) => {
    const h = hub([[200, '{"status":"allowed"}']]);
    world(on, h.run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("allow");
    expect(h.calls.some((c) => c.endsWith("/dismiss"))).toBe(false);
  });

  test("denied in the room -> deny", async ($, on) => {
    world(on, hub([[200, '{"status":"denied"}']]).run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("deny");
  });

  test("timeout + dismiss 2xx -> local dialog", async ($, on) => {
    const h = hub([[200, '{"status":"pending"}']], [200, "{}"]);
    world(on, h.run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision).toBeUndefined();
    expect(h.calls.some((c) => c.endsWith("/dismiss"))).toBe(true);
  });

  test("timeout + dismiss 409 + re-read allowed -> allow", async ($, on) => {
    const h = hub([[200, '{"status":"pending"}'], [200, '{"status":"allowed"}']], [409, '{"error":"permission already allowed"}']);
    world(on, h.run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("allow");
    expect(h.calls.filter((c) => c.includes("timeout_ms=0"))).toHaveLength(1);
  });

  test("dismiss transport failure + re-read still pending -> local dialog, after the re-read", async ($, on) => {
    const h = hub([[200, '{"status":"pending"}'], [200, '{"status":"pending"}']], "unreachable");
    world(on, h.run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision).toBeUndefined();
    expect(h.calls.filter((c) => c.includes("timeout_ms=0"))).toHaveLength(1);
  });

  test("dismiss transport failure + re-read denied -> deny", async ($, on) => {
    const h = hub([[200, '{"status":"pending"}'], [200, '{"status":"denied"}']], "unreachable");
    world(on, h.run);
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("deny");
    expect(h.calls.filter((c) => c.includes("timeout_ms=0"))).toHaveLength(1);
  });

  test("first wait transport failure -> dismiss, then honour the re-read", async ($, on) => {
    const calls: string[] = [];
    let waits = 0;
    world(on, (url) => {
      calls.push(url.replace(HUB, ""));
      if (url.endsWith("/permissions")) return curlOk(201, "{}");
      if (url.includes("/wait?")) {
        waits++;
        return waits === 1 ? { value: { exitCode: 28, stdout: "", stderr: "Operation timed out" } } : curlOk(200, '{"status":"allowed"}');
      }
      if (url.endsWith("/dismiss")) return curlOk(409, '{"error":"permission already allowed"}');
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("allow");
    expect(calls.some((c) => c.endsWith("/dismiss"))).toBe(true);
  });

  test("an id collision (idempotent 200) is never adopted; a fresh id is used", async ($, on) => {
    const waited: string[] = [];
    let posts = 0;
    world(on, (url, stdin) => {
      if (url.endsWith("/permissions")) {
        posts++;
        // first id collides with another agent's pending request
        return posts === 1 ? curlOk(200, '{"id":"other","agent":"alice","status":"pending"}') : curlOk(201, "{}");
      }
      if (url.includes("/wait?")) {
        const rid = /\/permissions\/([a-z]+)\/wait/.exec(url)?.[1] ?? "";
        waited.push(rid);
        // the colliding request is allowed; ours is denied
        return curlOk(200, waited.length === 1 && posts === 1 ? '{"status":"allowed"}' : '{"status":"denied"}');
      }
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(posts).toBe(2);
    expect(waited).toHaveLength(1);
    expect(r?.decision?.behavior).toBe("deny");
  });

  test("a finished request's id (409) is retried with a fresh id", async ($, on) => {
    let posts = 0;
    const waited: string[] = [];
    const ids: string[] = [];
    world(on, (url, stdin) => {
      if (url.endsWith("/permissions")) {
        posts++;
        ids.push(/request_id[^a-z]+([a-z]{5})/.exec(stdin)?.[1] ?? "");
        return posts === 1 ? curlOk(409, '{"error":"permission already allowed"}') : curlOk(201, "{}");
      }
      if (url.includes("/wait?")) {
        waited.push(/\/permissions\/([a-z]+)\/wait/.exec(url)?.[1] ?? "");
        return curlOk(200, '{"status":"allowed"}');
      }
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(posts).toBe(2);
    expect(ids[0]).toMatch(/^[a-km-z]{5}$/);
    expect(ids[1]).toMatch(/^[a-km-z]{5}$/);
    expect(ids[1]).not.toBe(ids[0]);              // the retry used a different id
    expect(waited).toEqual([ids[1]]);             // and waited on the new one
    expect(r?.decision?.behavior).toBe("allow");
  });

  test("three 409s in a row stop after 3 tries -> local dialog, no wait", async ($, on) => {
    const ids: string[] = [];
    let waits = 0;
    world(on, (url, stdin) => {
      if (url.endsWith("/permissions")) {
        ids.push(/request_id[^a-z]+([a-z]{5})/.exec(stdin)?.[1] ?? "");
        return curlOk(409, '{"error":"permission already allowed"}');
      }
      if (url.includes("/wait?")) waits++;
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);            // three different ids
    expect(waits).toBe(0);
    expect(r?.decision).toBeUndefined();
  });

  // The JSON body the mod POSTed, decoded from the curl config on stdin.
  const postedBody = (stdin: string) => {
    const raw = /^data-binary = "(.*)"$/m.exec(stdin)?.[1] ?? "{}";
    const json = raw.replace(/\\(["\\nrt])/g, (_m, c) => ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[c]);
    return json;
  };

  for (const [name, input] of [
    ["a large CJK Write input", { file_path: "/tmp/a.md", content: "漢字".repeat(20_000) }],
    ["an escape-heavy ASCII input", { command: '"\\'.repeat(6_000) }],
  ] as const) {
    test(`${name}: the POST body stays under the hub cap and the room card is created`, async ($, on) => {
      const sizes: number[] = [];
      let waited = false;
      world(on, (url, stdin) => {
        if (url.endsWith("/permissions")) {
          const bytes = new TextEncoder().encode(postedBody(stdin)).length;
          sizes.push(bytes);
          return bytes > 16_384 ? curlOk(413, '{"error":"body too large"}') : curlOk(201, "{}");   // the hub's cap, in bytes
        }
        if (url.includes("/wait?")) { waited = true; return curlOk(200, '{"status":"allowed"}'); }
        return curlOk(404, "{}");
      });
      await start($);
      const r: any = await $.classic.PermissionRequest({ tool_name: "Write", tool_input: input, permission_suggestions: [] } as any);
      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toBeLessThanOrEqual(16_384);
      expect(waited).toBe(true);                      // the room card exists: the relay reached the wait
      expect(r?.decision?.behavior).toBe("allow");
    });
  }

  test("a refused create (413) is logged once and falls back to the local dialog", async ($, on) => {
    world(on, (url) => (url.endsWith("/permissions") ? curlOk(413, '{"error":"body too large"}') : curlOk(404, "{}")), undefined, { decision: "allow" }, true);
    const logs: string[] = [];
    on("ui.log", ($: any, e: any) => { logs.push(String(e.text)); return { value: undefined }; });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision).toBeUndefined();
    const refused = logs.filter((l) => l.includes("permission request not created"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("HTTP 413");
  });

  test("another error from POST /permissions (413) is not retried", async ($, on) => {
    let posts = 0;
    world(on, (url) => {
      if (url.endsWith("/permissions")) { posts++; return curlOk(413, '{"error":"too large"}'); }
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(posts).toBe(1);
    expect(r?.decision).toBeUndefined();
  });

  test("a 401 on the relay re-reads the token and retries (token rotated during the wait)", async ($, on) => {
    const auths: string[] = [];
    world(on, (url, stdin) => {
      const bearer = /Bearer ([\w-]+)/.exec(stdin)?.[1] ?? "";
      auths.push(`${url.replace(HUB, "")}|${bearer}`);
      if (bearer === TOKEN) { tokenNow = "tok-rotated"; return curlOk(401, '{"error":"unauthorized"}'); }
      if (url.endsWith("/permissions")) return curlOk(201, "{}");
      if (url.includes("/wait?")) return curlOk(200, '{"status":"allowed"}');
      return curlOk(404, "{}");
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision?.behavior).toBe("allow");
    expect(auths.filter((a) => a.startsWith("/permissions|"))).toEqual([`/permissions|${TOKEN}`, "/permissions|tok-rotated"]);
    expect(auths.some((a) => a.includes("/wait?") && a.endsWith("|tok-rotated"))).toBe(true);
  });

  test("the hub moves during the wait: the dismiss and the final re-read go to the new URL", async ($, on) => {
    hubPinned = false;                      // resolve the hub from hub.url, as the app does
    const HUB2 = "http://127.0.0.1:9998";
    const seen: string[] = [];
    try {
      world(on, (url) => {
        seen.push(url);
        if (url.endsWith("/permissions")) return curlOk(201, "{}");
        if (url.includes("/wait?timeout_ms=0")) return curlOk(200, '{"status":"allowed"}');   // the new hub has the verdict
        if (url.includes("/wait?")) { urlNow = HUB2; return curlOk(200, '{"status":"pending"}'); }   // the app restarts here
        if (url.endsWith("/dismiss")) return curlOk(409, '{"error":"permission already allowed"}');
        return curlOk(404, "{}");
      });
      await start($);
      const r: any = await $.classic.PermissionRequest(ask as any);
      expect(r?.decision?.behavior).toBe("allow");
    } finally {
      hubPinned = true;
    }
    expect(seen.filter((u) => u.startsWith(HUB2))).toHaveLength(2);       // dismiss + wait(0)
    expect(seen.filter((u) => u.startsWith(HUB)).every((u) => u.endsWith("/permissions") || u.includes("timeout_ms=60000") || u.includes("/wait?"))).toBe(true);
    expect(seen.some((u) => u.startsWith(HUB2) && u.endsWith("/dismiss"))).toBe(true);
    expect(seen.some((u) => u.startsWith(HUB2) && u.includes("timeout_ms=0"))).toBe(true);
  });

  test("three collisions in a row -> local dialog, no wait", async ($, on) => {
    const calls: string[] = [];
    world(on, (url) => {
      calls.push(url);
      return url.endsWith("/permissions") ? curlOk(200, '{"status":"pending"}') : curlOk(200, '{"status":"allowed"}');
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision).toBeUndefined();
    expect(calls.filter((c) => c.endsWith("/permissions"))).toHaveLength(3);
    expect(calls.some((c) => c.includes("/wait"))).toBe(false);
  });

  test("POST /permissions times out -> local dialog without waiting", async ($, on) => {
    const calls: string[] = [];
    world(on, (url) => {
      calls.push(url);
      return { value: { exitCode: 28, stdout: "", stderr: "Operation timed out" } };
    });
    await start($);
    const r: any = await $.classic.PermissionRequest(ask as any);
    expect(r?.decision).toBeUndefined();
    expect(calls.some((c) => c.includes("/wait"))).toBe(false);
  });
});

describe("delivery", () => {
  function frames(...events: object[]): string {
    return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  }

  // world() with a hub stream that yields `chunk` once.
  function streaming(on: any, chunk: string) {
    world(on, () => curlOk(200, "{}"), chunk);
  }

  test("a chat addressed to the agent is submitted as a prompt with its envelope", async ($, on) => {
    streaming(on, frames({ id: 3, from: "you", to: "bob", room: "r1", text: "hi" }));
    const submitted = new Promise<string>((resolve) => on("prompt.submit", ($: any, e: any) => { resolve(e.text); return { text: e.text }; }));
    await start($);
    expect(await submitted).toBe('[chatbridge id=3 from="you" to="bob" room="r1"]\nhi');
  });

  // A plugin's $.session.append did not reach this file's session.append hook under
  // `claude plugin test` (cause not established), so the append itself is covered
  // live (spike run-claude.log, mod smoke); this test proves a briefing never wakes.
  test("a briefing is never submitted as a prompt", async ($, on) => {
    streaming(on, frames({ type: "briefing", room: "r1", human_name: "human" }, { id: 4, from: "you", to: "bob", room: "r1", text: "after" }));
    const texts: string[] = [];
    const submitted = new Promise<void>((resolve) => on("prompt.submit", ($: any, e: any) => { texts.push(e.text); resolve(); return { text: e.text }; }));
    await start($);
    await submitted;
    expect(texts).toEqual(['[chatbridge id=4 from="you" to="bob" room="r1"]\nafter']);
  });

  // A refused submit is final, whatever the (free-text) reason says: appending a text a hook blocked would slip
  // it past the block, and no reason can be trusted to mean "only busy". Logged, check removed, no append.
  for (const reason of [
    "queue full", "busy", "host limit reached", "usage limit reached",                      // look like capacity
    "blocked by settings hook: rate limit policy", "Stop hook stands while the engine is busy",   // a block that mentions capacity words
    "Stop hook stands", "blocked by settings hook: no deploys on Friday", "plugin policy: refused", "unrecognised refusal", "",
  ]) {
    test(`a refused submit ("${reason}") is final: no append, logged, check removed`, async ($, on) => {
      world(on, () => curlOk(200, "{}"), frames({ id: 9, from: "you", to: "bob", room: "r1", text: "hi" }), { decision: "allow" }, true);
      const logs: string[] = [];
      let failed!: () => void;
      const reported = new Promise<void>((resolve) => (failed = resolve));
      on("ui.log", ($: any, e: any) => {
        logs.push(String(e.text));
        if (String(e.text).includes("message not delivered")) failed();
        return { value: undefined };
      });
      const submits: string[] = [];
      on("prompt.submit", ($: any, e: any) => { submits.push(e.text); return { drop: reason }; });
      const appends: string[] = [];
      on("session.append", ($: any, e: any) => { appends.push(JSON.stringify(e.message)); return { message: e.message, uuid: "u1" }; });
      on("turn.complete", () => ({ text: "" }));
      await start($);
      await reported;
      expect(appends).toEqual([]);                                              // nothing slipped past a block
      expect(logs.some((l) => l.includes(`submit refused: ${reason}`))).toBe(true);
      // The check was removed: an answered turn sends no nudge (a nudge would be a second submit).
      await $.turn.complete({ text: "", turnId: "t1", reason: "answer" } as any);
      await new Promise((r) => setTimeout(r, 100));
      expect(submits).toHaveLength(1);
    });
  }

  test("a failing hub stream is logged once per failure streak, with the curl exit code", async ($, on) => {
    world(on, () => curlOk(200, "{}"), undefined, { decision: "allow" }, true);
    spawnCode = 22;                       // after world(), which resets it
    const logs: string[] = [];
    on("ui.log", ($: any, e: any) => { logs.push(String(e.text)); return { value: undefined }; });
    await start($);
    await clock.advance(10_000);          // several retries: the stream fails each time
    const failures = logs.filter((l) => l.includes("hub stream ended"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("curl exit 22");
  });

  test("submits that stay pending do not hold back the stream: 5 chats are all handed over at once", async ($, on) => {
    streaming(on, frames(...[1, 2, 3, 4, 5].map((id) => ({ id, from: "you", to: "bob", room: "r1", text: `m${id}` }))));
    const texts: string[] = [];
    let all!: () => void;
    const handed = new Promise<void>((resolve) => (all = resolve));
    on("prompt.submit", ($: any, e: any) => {
      texts.push(e.text);
      if (texts.length === 5) all();
      return new Promise(() => {});   // the turn never starts: submit stays pending
    });
    await start($);
    await handed;                     // the mock clock never advances: no timed wait is involved
    expect(texts).toHaveLength(5);
  });

  test("while busy (host state), an interrupt is not submitted as a new prompt", async ($, on) => {
    world(on, () => curlOk(200, "{}"), frames(
      { id: 7, from: "you", to: "bob", room: "r1", kind: "interrupt.new", interrupt_id: "i_9", text: "stop" },
      { id: 8, from: "you", to: "bob", room: "r1", text: "after" },
    ), { decision: "allow" }, false, { busy: true });
    const texts: string[] = [];
    const chat = new Promise<void>((resolve) => on("prompt.submit", ($: any, e: any) => { texts.push(e.text); if (e.text.endsWith("after")) resolve(); return { text: e.text }; }));
    await start($);
    await chat;
    expect(texts.some((t) => t.includes("interrupt.new"))).toBe(false);
  });

  test("a subagent turn.start does not mark the main loop busy; the main loop's does", async ($, on) => {
    world(on, () => curlOk(200, "{}"));
    on("turn.start", (_$: any, e: any) => ({ turnId: e.turnId }));
    await start($);
    stateSets.length = 0;
    await $.turn.start({ text: "", turnId: "t-sub", agentId: "sub1" } as any);
    expect(stateSets).toEqual([]);
    await $.turn.start({ text: "", turnId: "t-main" } as any);
    expect(stateSets).toEqual([["busy", true]]);
  });

  // A read DM, then the main loop's turn ends: only an answer (no post) earns the nudge.
  async function endTurnAfterRead($: any, on: any, reason: string, extra: object = {}): Promise<string[]> {
    world(on, () => curlOk(200, "{}"), frames({ id: 9, from: "you", to: "bob", room: "r1", text: "hi" }));
    const texts: string[] = [];
    const first = new Promise<void>((resolve) => on("prompt.submit", ($: any, e: any) => { texts.push(e.text); resolve(); return { text: e.text }; }));
    on("turn.complete", () => ({ text: "" }));
    await start($);
    await first;
    await new Promise((r) => setTimeout(r, 30));   // submit settled -> the check is armed
    await $.turn.complete({ text: "", turnId: "t1", reason, ...extra } as any);
    await new Promise((r) => setTimeout(r, 100));
    return texts;
  }

  test("an answered turn without a post is nudged (control)", async ($, on) => {
    const texts = await endTurnAfterRead($, on, "answer");
    expect(texts.some((t) => t.includes("got no reply in the room"))).toBe(true);
  });

  test("an aborted, refused or failed turn is not nudged", async ($, on) => {
    const texts = await endTurnAfterRead($, on, "aborted");
    expect(texts.some((t) => t.includes("got no reply in the room"))).toBe(false);
  });

  test("a refused turn is not nudged", async ($, on) => {
    const texts = await endTurnAfterRead($, on, "refusal", { refusal: { category: null, explanation: null } });
    expect(texts.some((t) => t.includes("got no reply in the room"))).toBe(false);
  });

  test("a failed turn is not nudged", async ($, on) => {
    const texts = await endTurnAfterRead($, on, "error");
    expect(texts.some((t) => t.includes("got no reply in the room"))).toBe(false);
  });

  // The agent posts to alice, then alice's message arrives and the main loop's turn ends without a post.
  async function replyThenEndTurn($: any, on: any, text: string): Promise<string[]> {
    world(on, () => curlOk(200, "{}"));
    let posted!: () => void;
    const postDone = new Promise<void>((resolve) => (posted = resolve));
    streamSteps = [() => postDone, `data: ${JSON.stringify({ id: 9, from: "alice", to: "bob", room: "r1", text })}\n\n`];
    const texts: string[] = [];
    const first = new Promise<void>((resolve) => on("prompt.submit", ($: any, e: any) => { texts.push(e.text); resolve(); return { text: e.text }; }));
    on("turn.complete", () => ({ text: "" }));
    await start($);
    await $.tool.call({ tool: "mcp__chatbridge__post", to: "alice", text: "status" } as any);
    posted();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    await $.turn.complete({ text: "", turnId: "t1", reason: "answer" } as any);
    await new Promise((r) => setTimeout(r, 100));
    return texts;
  }

  test("a question after my own status post still gets one nudge", async ($, on) => {
    const texts = await replyThenEndTurn($, on, "Can you review ticket X now?");
    expect(texts.filter((t) => t.includes("got no reply in the room")).length).toBe(1);
  });

  test("an instruction without a question mark after my own status post gets one nudge", async ($, on) => {
    const texts = await replyThenEndTurn($, on, "Review ticket X now.");
    expect(texts.filter((t) => t.includes("got no reply in the room")).length).toBe(1);
  });

  // The nudge window reads Date.now in the mod bundle (no fake clock reaches it: mock.clock answers $.clock only).
  // First message: nudge, which stamps the peer. Second message from the same peer: Date.now is read again
  // in the bridge and, inside the window, no second nudge comes.
  test("the nudge window runs on the real Date.now: one nudge for two messages from one peer", async ($, on) => {
    world(on, () => curlOk(200, "{}"));
    let secondGo!: () => void;
    const gate = new Promise<void>((resolve) => (secondGo = resolve));
    const frame = (id: number) => `data: ${JSON.stringify({ id, from: "alice", to: "bob", room: "r1", text: "Review ticket X now." })}\n\n`;
    streamSteps = [frame(1), () => gate, frame(2)];
    const texts: string[] = [];
    let seen = 0;
    let got!: () => void;
    let next = new Promise<void>((resolve) => (got = resolve));
    on("prompt.submit", ($: any, e: any) => {
      texts.push(e.text);
      if (!e.text.includes("got no reply in the room")) { seen++; got(); next = new Promise<void>((resolve) => (got = resolve)); }
      return { text: e.text };
    });
    on("turn.complete", () => ({ text: "" }));
    expect(typeof Date.now()).toBe("number");
    await start($);
    await next;
    await new Promise((r) => setTimeout(r, 30));
    await $.turn.complete({ text: "", turnId: "t1", reason: "answer" } as any);
    await new Promise((r) => setTimeout(r, 100));
    secondGo();
    await next;
    await new Promise((r) => setTimeout(r, 30));
    await $.turn.complete({ text: "", turnId: "t2", reason: "answer" } as any);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toBe(2);
    expect(texts.filter((t) => t.includes("got no reply in the room")).length).toBe(1);
  });

  test("when idle, an interrupt is submitted as a prompt", async ($, on) => {
    world(on, () => curlOk(200, "{}"), frames(
      { id: 7, from: "you", to: "bob", room: "r1", kind: "interrupt.new", interrupt_id: "i_9", text: "stop" },
    ), { decision: "allow" }, false, { busy: false });
    const submitted = new Promise<string>((resolve) => on("prompt.submit", ($: any, e: any) => { resolve(e.text); return { text: e.text }; }));
    await start($);
    expect(await submitted).toContain('kind="interrupt.new"');
  });

  test("a queued chat does not hold back the next event", async ($, on) => {
    streaming(on, frames(
      { id: 5, from: "you", to: "bob", room: "r1", text: "chat" },
      { id: 6, from: "you", to: "bob", room: "r1", kind: "interrupt.new", interrupt_id: "i_1", text: "stop" },
    ));
    const texts: string[] = [];
    let sawInterrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => (sawInterrupt = resolve));
    on("prompt.submit", ($: any, e: any) => {
      texts.push(e.text);
      if (e.text.includes("interrupt.new")) { sawInterrupt(); return { text: e.text }; }
      return new Promise(() => {}); // the chat's turn never starts
    });
    await start($);
    await interrupted;
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('kind="interrupt.new"');
  });
  test("a new factory_version in the briefing runs reload-plugins through $.command.run", async ($, on) => {
    const brief = (v: string) => `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: v })}\n\n`;
    world(on, relinked, brief("v-2"));
    on("prompt.submit", ($: any, e: any) => ({ text: e.text }));
    const ran = new Promise<string>((resolve) => on("command.run", (_$: any, e: any) => { resolve(e.command); return { value: undefined }; }));
    await start($);
    expect(await ran).toBe("reload-plugins");
  });
  // Unchanged module (a skill-only reload): reload-plugins runs, the same bridge stays connected, no second one starts.
  test("a reload that leaves the module loaded keeps one bridge connected", async ($, on) => {
    const brief = (v: string) => `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: v })}\n\n`;
    const after = `data: ${JSON.stringify({ id: 5, from: "alice", to: "bob", room: "r1", text: "after reload" })}\n\n`;
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    world(on, relinked);
    streamSteps = [brief("v-2"), () => gate, after];
    const texts: string[] = [];
    on("prompt.submit", ($: any, e: any) => { texts.push(e.text); return { text: e.text }; });
    let ran = 0;
    on("command.run", () => { ran++; return { value: undefined }; });
    await start($);
    for (let i = 0; i < 100 && ran < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(1);
    const streams = () => curlCalls.filter((c) => c.argv.includes("-N")).length;
    expect(streams()).toBe(1);
    go();
    for (let i = 0; i < 100 && !texts.some((t) => t.includes("after reload")); i++) await new Promise((r) => setTimeout(r, 5));
    expect(texts.some((t) => t.includes("after reload"))).toBe(true);
    expect(streams()).toBe(1);
    expect(stateSets.filter(([k]) => k === "generation")).toEqual([["generation", 1]]);
    // Module stayed loaded: it recorded the version itself, after the reload resolved, and cleared the marker.
    const applied = curlCalls.filter((c) => urlOf(c.stdin).endsWith("/factory/applied"));
    expect(applied).toHaveLength(1);
    expect(applied[0].stdin).toContain("v-2");
    expect(stateSets.filter(([k]) => k === "applying")).toEqual([["applying", "v-2"], ["applying", ""]]);
  });

  // Replaced module: the old module left its version in $.state; the new module records it at its start and clears it.
  test("a new module records the version the old module left, once, and clears it", async ($, on) => {
    world(on, relinked, undefined, { decision: "allow" }, false, { applying: "v-2" });
    await start($);
    for (let i = 0; i < 100 && !curlCalls.some((c) => urlOf(c.stdin).endsWith("/factory/applied")); i++) await new Promise((r) => setTimeout(r, 5));
    const applied = curlCalls.filter((c) => urlOf(c.stdin).endsWith("/factory/applied"));
    expect(applied).toHaveLength(1);
    expect(applied[0].stdin).toContain("v-2");
    expect(stateSets.filter(([k]) => k === "applying")).toEqual([["applying", ""]]);
  });

  test("a reload that fails records no version and tells the hub it failed", async ($, on) => {
    const brief = `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: "v-2" })}\n\n`;
    world(on, relinked, brief);
    on("prompt.submit", ($: any, e: any) => ({ text: e.text }));
    let ran = 0;
    on("command.run", () => { ran++; throw new Error("reload failed"); });
    await start($);
    for (let i = 0; i < 100 && ran < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
// A failed reload tells the hub so ({failed:true}, no version) and records no version.
    const posts = curlCalls.filter((c) => urlOf(c.stdin).endsWith("/factory/applied"));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((c) => c.stdin.includes("failed") && !c.stdin.includes("v-2"))).toBe(true);
  });

  // Replaced module: a newer generation appears in $.state; the old bridge ends at its next frame and delivers nothing.
  test("when a newer generation exists, the old bridge ends and delivers nothing", async ($, on) => {
    const frame = (id: number, text: string) => `data: ${JSON.stringify({ id, from: "alice", to: "bob", room: "r1", text })}\n\n`;
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    world(on, () => curlOk(200, "{}"));
    streamSteps = [frame(1, "before"), () => gate, frame(2, "after")];
    const texts: string[] = [];
    on("prompt.submit", ($: any, e: any) => { texts.push(e.text); return { text: e.text }; });
    await start($);
    for (let i = 0; i < 100 && !texts.some((t) => t.includes("before")); i++) await new Promise((r) => setTimeout(r, 5));
    expect(texts.some((t) => t.includes("before"))).toBe(true);
    // A replaced module takes the next generation.
    stateNow.generation = 2;
    go();
    await new Promise((r) => setTimeout(r, 100));
    expect(texts.some((t) => t.includes("after"))).toBe(false);
  });
  // The gate runs through $.process.run (a shell, the hook-shaped event on stdin). Exit 2 blocks and the hub is never asked.
  test("CHATBRIDGE_HANDOFF_GATE: exit 2 blocks send_handoff with the gate's stderr; exit 0 lets it through", async ($, on) => {
    extraEnv = { CHATBRIDGE_HANDOFF_GATE: "/g/ste-gate.py" };
    let gateExit = 2;
    const gateRuns: string[] = [];
    world(on, (url, stdin) => {
      if (url) return url.endsWith("/handoffs") ? curlOk(201, '{"id":"h_0123456789abcdef"}') : curlOk(200, "{}");
      gateRuns.push(stdin);
      return { value: { exitCode: gateExit, stdout: "", stderr: "[ste-gate] blocked" } };
    });
    extraEnv = {};
    await start($);
    const call = { tool: "mcp__chatbridge__send_handoff", to: "reviewer", task: "t", context: { path: "/x.md" } } as any;
    const blocked = await $.tool.call(call);
    expect(JSON.stringify(blocked)).toContain("[ste-gate] blocked");
    expect(curlCalls.some((c) => urlOf(c.stdin).endsWith("/handoffs"))).toBe(false);
    expect(JSON.parse(gateRuns[0]).tool_input.to).toBe("reviewer");
    gateExit = 0;
    const passed = await $.tool.call(call);
    expect(JSON.stringify(passed)).toContain("handoff_id=h_0123456789abcdef");
  });
  // The reload is bounded to 30 s, but success and failure stay attached to the real command promise.
  test("a reload that does not end in 30 s times out: nothing recorded yet, the version stays in $.state", async ($, on) => {
    const brief = `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: "v-2" })}\n\n`;
    world(on, relinked, brief);
    on("prompt.submit", ($: any, e: any) => ({ text: e.text }));
    let ran = 0;
    on("command.run", () => new Promise(() => { ran++; })); // never ends
    await start($);
    for (let i = 0; i < 100 && ran < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await clock.advance(30_001);
    await new Promise((r) => setTimeout(r, 50));
    expect(curlCalls.some((c) => urlOf(c.stdin).endsWith("/factory/applied"))).toBe(false);
    const marks = stateSets.filter(([k]) => k === "applying").map(([, v]) => v);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((v) => v === "v-2")).toBe(true);
  });

  // Validator: the command ends AFTER the 30 s bound, successfully: applied is still recorded (once).
  test("Validator: a late successful unchanged-module reload still records its applied version", async ($, on) => {
    const brief = `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: "v-2" })}\n\n`;
    let ordered = false;
    world(on, (url) => {
      if (url.endsWith("/factory/relink")) {
        const reload = !ordered;
        ordered = true;
        return curlOk(200, JSON.stringify({ reload, pending: !reload, version: "v-2" }));
      }
      return curlOk(200, "{}");
    }, brief);
    on("prompt.submit", (_$: any, e: any) => ({ text: e.text }));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let ran = 0;
    on("command.run", async () => { ran++; await gate; return { text: "Reloaded plugins" }; });
    await start($);
    for (let i = 0; i < 100 && ran < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(1);
    await clock.advance(30_001);
    await new Promise((r) => setTimeout(r, 40));
    finish();
    await new Promise((r) => setTimeout(r, 70));
    const applied = curlCalls.filter((c) => urlOf(c.stdin).endsWith("/factory/applied") && c.stdin.includes("v-2"));
    expect(applied).toHaveLength(1);
    expect(stateSets.filter(([k]) => k === "applying").map(([, v]) => v).at(-1)).toBe("");
  });

  test("a command that fails AFTER the 30 s bound reports failed to the hub and clears the marker", async ($, on) => {
    const brief = `data: ${JSON.stringify({ type: "briefing", room: "r1", factory_version: "v-2" })}\n\n`;
    let ordered = false;
    world(on, (url) => {
      if (url.endsWith("/factory/relink")) {
        const reload = !ordered;
        ordered = true;
        return curlOk(200, JSON.stringify({ reload, pending: !reload, version: "v-2" }));
      }
      return curlOk(200, "{}");
    }, brief);
    on("prompt.submit", (_$: any, e: any) => ({ text: e.text }));
    let fail!: () => void;
    const gate = new Promise<void>((_r, reject) => (fail = () => reject(new Error("reload broke"))));
    let ran = 0;
    on("command.run", async () => { ran++; await gate; });
    await start($);
    for (let i = 0; i < 100 && ran < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await clock.advance(30_001);
    await new Promise((r) => setTimeout(r, 40));
    fail();
    await new Promise((r) => setTimeout(r, 70));
    const posts = curlCalls.filter((c) => urlOf(c.stdin).endsWith("/factory/applied"));
    expect(posts.some((c) => c.stdin.includes("failed"))).toBe(true);
    expect(posts.some((c) => c.stdin.includes("v-2"))).toBe(false);
    expect(stateSets.filter(([k]) => k === "applying").map(([, v]) => v).at(-1)).toBe("");
  });
});
