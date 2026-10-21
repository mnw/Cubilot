// The Claude mod must not treat a dropped submit or a denied append as a delivery:
// onRead arms the post check, so a phantom read means a phantom nudge.
import { afterAll, describe, expect, test } from "bun:test";
import { refusalOf } from "../../hub/channel/claude-mod/register";

describe("refusalOf", () => {
  test("a dropped prompt.submit is a refusal", () => {
    expect(refusalOf({ drop: "queue full" })).toBe("queue full");
  });
  test("a denied session.append is a refusal", () => {
    expect(refusalOf({ deny: "blocked by plugin" })).toBe("blocked by plugin");
  });
  test("a stored prompt or row is a delivery", () => {
    expect(refusalOf({ text: "hi", origin: { kind: "plugin" } })).toBeNull();
    expect(refusalOf({ message: { type: "user" }, uuid: "u1" })).toBeNull();
    expect(refusalOf(undefined)).toBeNull();
  });
});

// stop() must release the stream reader at once, not at the next heartbeat chunk.
import { untilAborted } from "../../hub/channel/claude-mod/register";

describe("untilAborted", () => {
  // A source whose read never completes by itself, like a quiet curl between heartbeats.
  function quiet() {
    const state = { closed: 0 };
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: async () => { state.closed++; return { done: true, value: undefined }; },
      }),
    };
    return { source, state };
  }

  test("an abort ends the loop at once and closes the source", async () => {
    const { source, state } = quiet();
    const ac = new AbortController();
    const seen: string[] = [];
    const loop = (async () => { for await (const x of untilAborted(source, ac.signal)) seen.push(x); return "ended"; })();
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await Promise.race([loop, new Promise((r) => setTimeout(() => r("still waiting"), 200))])).toBe("ended");
    expect(state.closed).toBe(1);
    expect(seen).toEqual([]);
  });

  test("an already aborted signal reads nothing", async () => {
    const { source, state } = quiet();
    const ac = new AbortController();
    ac.abort();
    const out: string[] = [];
    for await (const x of untilAborted(source, ac.signal)) out.push(x);
    expect(out).toEqual([]);
    expect(state.closed).toBe(1);
  });

  test("chunks pass through until the source ends", async () => {
    async function* three() { yield "a"; yield "b"; yield "c"; }
    const out: string[] = [];
    for await (const x of untilAborted(three(), new AbortController().signal)) out.push(x);
    expect(out).toEqual(["a", "b", "c"]);
  });

  test("a read that rejects after the abort is not an unhandled rejection", async () => {
    let reject!: (e: Error) => void;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>((_, rej) => (reject = rej)),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    const ac = new AbortController();
    const loop = (async () => { for await (const _ of untilAborted(source, ac.signal)) { /* none */ } })();
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await loop;
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 10)); // would crash the test run if unhandled
  });
});

// The hub caps POST /permissions at 16 384 bytes; the relay must fit its preview into that.
import { fitPreview } from "../../hub/channel/claude-mod/register";

describe("fitPreview", () => {
  const bodyOf = (p: string) => JSON.stringify({ agent: "bob", request_id: "abcde", tool_name: "Write", description: "Write wants to run", input_preview: p });
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const BUDGET = 16_384 - 512;
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  test("a small input is returned unchanged", () => {
    const text = JSON.stringify({ command: "ls" });
    expect(fitPreview(text, bodyOf)).toBe(text);
  });

  test("a large CJK Write input fits in bytes (3 bytes a character)", () => {
    const text = JSON.stringify({ file_path: "/tmp/a.md", content: "漢字".repeat(20_000) });
    const p = fitPreview(text, bodyOf);
    expect(bytes(bodyOf(p))).toBeLessThanOrEqual(BUDGET);
    expect(p.endsWith("…[truncated]")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(8_000);
    expect(p.length).toBeGreaterThan(1_000);          // it keeps as much as fits, not a token amount
  });

  test("an escape-heavy ASCII input fits (every quote and backslash doubles)", () => {
    const text = JSON.stringify({ command: '"\\'.repeat(6_000) });
    const p = fitPreview(text, bodyOf);
    expect(bytes(bodyOf(p))).toBeLessThanOrEqual(BUDGET);
    // Guard only: escapes at most double ASCII, so the old 8 000-char slice already fit (about 16 100 bytes).
    // Only multi-byte text (3 bytes a CJK character) overflowed the cap; that case is the one above.
    expect(bytes(bodyOf(text))).toBeGreaterThan(16_384);   // the uncut input does exceed the cap
  });

  test("a cut never splits a surrogate pair", () => {
    for (const filler of ["😀", "a😀", "ab😀"]) {
      const text = JSON.stringify({ content: filler.repeat(9_000) });
      const p = fitPreview(text, bodyOf);
      expect(loneSurrogate.test(p)).toBe(false);
      expect(bytes(bodyOf(p))).toBeLessThanOrEqual(BUDGET);
    }
  });

  test("an input just under the char cap but over the byte cap is shrunk further", () => {
    const text = "漢".repeat(7_900);
    const p = fitPreview(text, bodyOf);
    expect(bytes(bodyOf(p))).toBeLessThanOrEqual(BUDGET);
  });
});

// The mod's curl children must ignore ~/.curlrc and every proxy variable: the bearer token goes to
// the loopback hub and nowhere else. Run real curl with the mod's own argv and config builders.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURL_ARGV, CURL_STREAM_ARGV, curlConfig } from "../../hub/channel/claude-mod/register";

describe("curl isolation (real curl)", () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("hello") });
  afterAll(() => server.stop(true));
  const deadProxy = "http://127.0.0.1:1";                        // nothing listens: any use of it fails
  const home = mkdtempSync(join(tmpdir(), "cubilot-curlrc-"));
  writeFileSync(join(home, ".curlrc"), `proxy = "${deadProxy}"\noutput = "/dev/null"\n`);   // a hostile user config
  const env = { PATH: process.env.PATH ?? "", HOME: home, http_proxy: deadProxy, HTTP_PROXY: deadProxy, all_proxy: deadProxy, ALL_PROXY: deadProxy };

  async function curl(argv: readonly string[], config: string): Promise<{ out: string; code: number }> {
    const p = Bun.spawn([...argv], { stdin: new Blob([config]), stdout: "pipe", stderr: "pipe", env });
    const out = await new Response(p.stdout).text();
    return { out, code: await p.exited };
  }
  const lines = [`url = "http://127.0.0.1:${server.port}/"`, "silent", "show-error", "max-time = 5"];

  test("the built argv starts with -q and the built config ends with noproxy", () => {
    expect(CURL_ARGV.slice(0, 2)).toEqual(["curl", "-q"]);
    expect(CURL_STREAM_ARGV.slice(0, 2)).toEqual(["curl", "-q"]);
    const cfg = curlConfig(lines);
    expect(cfg.trimEnd().split("\n").at(-1)).toBe('noproxy = "*"');
    expect(cfg.endsWith("\n")).toBe(true);
  });

  test("with the mod's argv and config, a hostile ~/.curlrc and proxy variables change nothing", async () => {
    const r = await curl(CURL_ARGV, curlConfig(lines));
    expect([r.code, r.out]).toEqual([0, "hello"]);
  });

  test("the same holds for the stream argv", async () => {
    const r = await curl(CURL_STREAM_ARGV, curlConfig([...lines, "no-buffer", "fail"]));
    expect([r.code, r.out]).toEqual([0, "hello"]);
  });

  test("control: without -q and noproxy the same environment breaks the request", async () => {
    const r = await curl(["curl", "-K", "-"], lines.join("\n") + "\n");
    expect(r.out === "hello").toBe(false);                         // the proxy or the output setting won
    // -q alone is not enough: the proxy variables still apply
    const q = await curl(["curl", "-q", "-K", "-"], lines.join("\n") + "\n");
    expect(q.out === "hello" && q.code === 0).toBe(false);
  });
});
