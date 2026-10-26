// Claude Code adapter for the chatbridge: a mod (function-hooks plugin) that
// joins this session to a Cubilot room through the shared bridge core.
//
// Bundled by scripts/build-sidecars.sh into resources/chatbridge-mod/hooks/register.js
// (a mod may only import files inside its own folder) and loaded with
// `claude --plugin-dir`. Identity arrives as CHATBRIDGE_AGENT / CHATBRIDGE_ROOM env.
//
// Mod rules this file follows: `$` is passed only to top-level function
// declarations (`claude plugin validate` enforces it), there is no setTimeout
// or fetch, and every hub request goes through `curl` with a time bound and the
// bearer token on stdin, never in argv.

import type { On } from "claude-code";
import type { DeliveryMode, Host, HttpResult } from "../host";
import { startBridge, ReloadTimeout, RELOAD_MS, type Bridge } from "../core";
import { CHATBRIDGE_TOOLS, findTool } from "../tools";
import { buildInstructions } from "../instructions";
import { authedGet, authedPost, expandPath, resolveHub } from "../hub-client";

const TOOL_PREFIX = "mcp__chatbridge__";
const REQUEST_MS = 15_000;
const UPLOAD_MS = 60_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const PERMISSION_WAIT_MS = 60_000;

// Module state. A reload is a fresh module, so this resets with it.
let identity: { agent: string; room: string; hubEnv: string } | null = null;
let host: Host | null = null;
let bridge: Bridge | null = null;

// Host-held, so it survives a mod reload mid-turn (types/index.d.ts is its contract).
const BUSY = { plugin: "chatbridge", key: "busy" } as const;
// Counts module generations. A replaced module takes the next number; the older bridge sees it is old and ends.
const GEN = { plugin: "chatbridge", key: "generation" } as const;
// The version a reload is loading, set before the reload runs. If the reload replaces this module, the new module
// records it as applied at its start; if not, this module records it when the reload resolves. "" = none.
const APPLYING = { plugin: "chatbridge", key: "applying" } as const;

// Every hub request is a curl child with its options on stdin. `-q` must be the FIRST argument: it
// stops curl reading the user's ~/.curlrc (a `proxy`, `output` or `fail` there would change or leak
// our requests). `noproxy = "*"` stops the proxy environment variables (http_proxy, ALL_PROXY, ...):
// the bearer token goes to the loopback hub and nowhere else.
export const CURL_ARGV = ["curl", "-q", "-K", "-"] as const;
export const CURL_STREAM_ARGV = ["curl", "-q", "-N", "-K", "-"] as const;
export function curlConfig(lines: string[]): string {
  return [...lines, 'noproxy = "*"'].join("\n") + "\n";
}

// curl config-file string: backslash escapes per curl's config syntax.
function cfg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

// `-w "\n%{http_code}"` appends the status on its own last line.
function parseCurl(stdout: string): HttpResult {
  const i = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(i + 1).trim());
  if (!Number.isInteger(status) || status === 0) throw new Error("hub unreachable");
  return { status, text: stdout.slice(0, i) };
}

// `$.prompt.submit` resolves `{ drop: reason }` and `$.session.append` `{ deny: reason }`
// when nothing was delivered. Returns that reason, or null for a real delivery.
export function refusalOf(result: unknown): string | null {
  if (result && typeof result === "object") {
    const r = result as { drop?: unknown; deny?: unknown };
    if (r.drop !== undefined) return String(r.drop);
    if (r.deny !== undefined) return String(r.deny);
  }
  return null;
}

// Reads `source` until it ends or `signal` fires. A plain `for await` checks the signal only
// when a chunk arrives, so a quiet stream outlives stop() by up to a heartbeat; here the
// reader is released at once and the source is closed (for a spawned curl, leaving the
// loop is what kills it). Closing is not awaited: return() may queue behind a pending read.
// `onEnd` gets the source's return value when it ends on its own (not when aborted).
export async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  onEnd?: (result: unknown) => void,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
  try {
    for (;;) {
      const next = it.next();
      next.catch(() => {}); // a read abandoned at abort may still reject later
      const r = await Promise.race([next, aborted]);
      if (r === ABORTED) return;
      if (r.done) {
        onEnd?.(r.value);
        return;
      }
      yield r.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}
const ABORTED = Symbol("aborted");

// The hub caps POST /permissions at 16 384 BYTES (Content-Length) and input_preview at 8 000
// UTF-16 units. A tool input of CJK text is 3 bytes a character, and a JSON string of JSON
// doubles every quote and backslash, so a character cut alone is not enough: shrink the preview
// until the whole serialized body fits, measured in UTF-8 bytes, never splitting a surrogate pair.
const PERMISSION_BODY_BUDGET = 16_384 - 512; // margin for the encoder's own differences
const PERMISSION_PREVIEW_CHARS = 8_000;
const TRUNCATED = "…[truncated]";

export function fitPreview(
  text: string,
  bodyOf: (preview: string) => string,
  maxChars = PERMISSION_PREVIEW_CHARS,
  maxBytes = PERMISSION_BODY_BUDGET,
): string {
  const enc = new TextEncoder();
  const cut = (n: number): string => {
    let head = text.slice(0, n);
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // half of a surrogate pair
    return head;
  };
  let n = text.length > maxChars ? maxChars - TRUNCATED.length : text.length;
  for (;;) {
    const preview = n < text.length ? cut(n) + TRUNCATED : text;
    const bytes = enc.encode(bodyOf(preview)).length;
    if (bytes <= maxBytes || n <= 0) return preview;
    n = Math.max(0, Math.min(n - 1, Math.floor((n * maxBytes) / bytes * 0.95)));
  }
}

// Records a good reload for this agent. Throws when the hub refuses.
async function recordApplied(version: string, reloadId: string | null, attempt: string | null): Promise<void> {
  if (!identity || !host) throw new Error("chatbridge not started");
  const r = await authedPost(host, identity.hubEnv, "/factory/applied", { agent: identity.agent, version, ...(reloadId ? { reload_id: reloadId } : {}), ...(attempt ? { attempt } : {}) });
  if (r.status < 200 || r.status >= 300) throw new Error(`factory applied not recorded: HTTP ${r.status}`);
}

// Tells the hub a reload failed, so it forgets the order and the next relink asks again.
async function reportFailed(reloadId: string | null, attempt: string | null): Promise<void> {
  if (!identity || !host) throw new Error("chatbridge not started");
  const r = await authedPost(host, identity.hubEnv, "/factory/applied", { agent: identity.agent, failed: true, ...(reloadId ? { reload_id: reloadId } : {}), ...(attempt ? { attempt } : {}) });
  if (r.status < 200 || r.status >= 300) throw new Error(`factory failure not reported: HTTP ${r.status}`);
}

// The one place `$` becomes a Host. Everything else sees only `host`.
function makeHost($: any, home: string, dataDir: string): Host {
  let streamFailing = false; // a failure was logged and no data has arrived since
  async function curl(lines: string[], timeoutMs: number): Promise<HttpResult> {
    const config = curlConfig([...lines, `max-time = ${Math.ceil(timeoutMs / 1000)}`, 'write-out = "\\n%{http_code}"', "silent", "show-error"]);
    const r = await $.process.run([...CURL_ARGV], { stdin: config, timeoutMs: timeoutMs + 5_000 });
    if (r.exitCode !== 0 && !r.stdout) throw new Error(`curl exit ${r.exitCode}: ${r.stderr.trim()}`);
    return parseCurl(r.stdout);
  }

  // A fulfilled promise is not a delivery: submit can resolve `{ drop }` and append
  // `{ deny }`. Only a real delivery may fire onRead (it arms the post check).
  // Resolves null when the text landed, else why it did not.
  async function land(call: () => Promise<unknown>, kind: string, onRead: () => void): Promise<string | null> {
    try {
      const why = refusalOf(await call());
      if (why === null) {
        onRead();
        return null;
      }
      $.ui.log(`[chatbridge] ${kind} refused: ${why}`, { to: "debug" });
      return why;
    } catch (e) {
      $.ui.log(`[chatbridge] ${kind} failed: ${String(e)}`, { to: "debug" });
      return String(e);
    }
  }
  const submit = (text: string, onRead: () => void) => land(() => $.prompt.submit({ text }), "submit", onRead);
  const append = (text: string, onRead: () => void) =>
    land(() => $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }), "append", onRead);

  // A refused submit is FINAL: no fallback to append. `drop` is free text (a hook's refusal, a settings hook's
  // block, a Stop that stands, a host limit), so no reason can be trusted to mean "only busy", and appending a
  // text a hook blocked would slip it past that block. The refusal is logged by land(), and the caller drops the
  // delivery's post check (onFail). A context delivery is an append by design, not a fallback.
  const landText = (text: string, asContext: boolean, onRead: () => void): Promise<string | null> =>
    asContext ? append(text, onRead) : submit(text, onRead);

  return {
    async readText(path) {
      try {
        return await $.fs.read(expandPath(path, home, dataDir));
      } catch {
        return null;
      }
    },
    request(url, init) {
      const lines = [`url = ${cfg(url)}`, `request = ${cfg(init.method)}`];
      for (const [k, v] of Object.entries(init.headers)) lines.push(`header = ${cfg(`${k}: ${v}`)}`);
      if (init.body !== undefined) lines.push(`data-binary = ${cfg(init.body)}`);
      return curl(lines, init.timeoutMs ?? REQUEST_MS);
    },
    async upload(url, token, filePath) {
      let st: { kind: string; size: number };
      try {
        st = await $.fs.stat(filePath);
      } catch (e) {
        throw new Error(`could not read ${filePath}: ${String(e)}`);
      }
      if (st.kind !== "file") throw new Error(`could not read ${filePath}: not a regular file`);
      if (st.size > MAX_UPLOAD_BYTES) throw new Error(`file too large: ${st.size} bytes (max ${MAX_UPLOAD_BYTES})`);
      // curl -F: a double-quoted filename takes `;` and `,` literally and escapes `"` and `\` with `\`.
      const quoted = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return curl([`url = ${cfg(url)}`, `header = ${cfg(`Authorization: Bearer ${token}`)}`, `form = ${cfg(`file=@"${quoted}"`)}`], UPLOAD_MS);
    },
    async *stream(url, token, signal) {
      const config = curlConfig([`url = ${cfg(url)}`, `header = ${cfg(`Authorization: Bearer ${token}`)}`, "no-buffer", "fail", "silent"]);
      const end: { code?: number | null; signal?: string | null } = {};
      for await (const piece of untilAborted<{ stream: string; text: string }>(
        $.process.spawn({ argv: [...CURL_STREAM_ARGV], input: config }),
        signal,
        (result) => Object.assign(end, result ?? {}),
      )) {
        if (piece.stream === "stdout") {
          streamFailing = false;
          yield piece.text;
        }
      }
      // curl --fail exits 22 on an HTTP error (a stale token, a refused room). The core only sees the
      // stream end and retries, so say why once per failure streak, not on every retry.
      const code = end.code;
      if (!signal.aborted && code !== 0 && !streamFailing) {
        streamFailing = true;
        $.ui.log(`[chatbridge] hub stream ended: curl exit ${code ?? end.signal ?? "unknown"}${code === 22 ? " (HTTP error: token or room rejected?)" : ""}; retrying`, { to: "debug" });
      }
    },
    async deliver({ text, mode, onRead, onFail }: { text: string; mode: DeliveryMode; onRead: () => void; onFail?: () => void }) {
      // Never awaited past the state read: a submit queued behind a long turn must not hold
      // back the next event. A refusal is reported through onFail (and logged by land()).
      const busy = mode === "steer" && ((await $.state.get(BUSY)).value ?? false);
      void landText(text, mode === "context" || busy, onRead).then((why) => {
        if (why !== null) onFail?.();
      });
    },
    async handoffGate() {
      return ((await $.env.get("CHATBRIDGE_HANDOFF_GATE")) ?? "").trim() || null;
    },
    async stageId() {
      return ((await $.env.get("CUBILOT_STAGE_ID")) ?? "").trim() || null;
    },
    // $.process.run rejects when the command cannot start or still runs at the timeout: the core logs it and goes on.
    async exec(command, stdin, timeoutMs) {
      const r = await $.process.run(["/bin/sh", "-c", command], { stdin, timeoutMs });
      return { code: r.exitCode, stderr: r.stderr ?? "", timedOut: false };
    },
    // The bridge keeps running: the engine reloads only changed modules, so a skill-only change leaves this
    // module loaded. If the module is replaced, the new one takes the next generation and this bridge ends.
    // Bounded to RELOAD_MS, but success and failure stay attached to the REAL command promise: a command that
    // ends after the bound still records applied (or reports failed). APPLYING stays set until then, so a replaced
    // module also records the version. The hub's pending window blocks a second reload meanwhile.
    async reload(version, reloadId, attempt) {
      await $.state.set(APPLYING, reloadId || attempt ? `${version}\n${reloadId ?? ""}\n${attempt ?? ""}` : version); // a replaced module reads both back
      let timedOut = false;
      const finished: Promise<void> = Promise.resolve($.command.run({ command: "reload-plugins" })).then(
        async () => {
          await recordApplied(version, reloadId, attempt);
          await $.state.set(APPLYING, "");
        },
        async (e) => {
          await $.state.set(APPLYING, "");
          // Before the bound the core sees the rejection and reports failed; after it, nobody else would.
          if (timedOut) await reportFailed(reloadId, attempt).catch(() => {});
          throw e;
        },
      );
      finished.catch(() => {}); // a late failure is reported above, not unhandled
      const timeout = new Promise<never>((_, reject) => { $.clock.after(RELOAD_MS, () => { timedOut = true; reject(new ReloadTimeout()); }); });
      timeout.catch(() => {}); // the timer outlives a reload that ended in time
      await Promise.race([finished, timeout]);
    },
    log(msg) {
      $.ui.log(msg, { to: "debug" });
    },
  };
}

function makeSleep($: any): (ms: number) => Promise<void> {
  return (ms) => new Promise<void>((resolve) => { $.clock.after(ms, resolve); });
}

function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _t, tool_use_id: _id, consent: _c, agentId: _a, ...args } = e;
  return args;
}

function permissionId(): string {
  // Hub PERMISSION_ID_RE: five letters from [a-km-z] (no `l`).
  const alphabet = "abcdefghijkmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 5; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

type Verdict = "allow" | "deny" | null;

function verdictOf(r: { status: number; body: string }): Verdict {
  if (r.status !== 200) return null;
  try {
    // GET /permissions/:id/wait answers the bare snapshot.
    const status = (JSON.parse(r.body) as { status?: string }).status;
    return status === "allowed" ? "allow" : status === "denied" ? "deny" : null;
  } catch {
    return null;
  }
}

// D8: ask the room; null means "the local dialog decides". On 2.1.296 the local dialog
// is already open while this waits; after a local answer the card stays until the wait
// times out and is dismissed (≤ PERMISSION_WAIT_MS).
async function relayPermission(h: Host, id: { agent: string; hubEnv: string }, toolName: string, toolInput: unknown): Promise<Verdict> {
  // Every call goes through hub-client, which re-resolves the hub URL and token each time and
  // re-reads the token once on a 401 (the app can restart, or rotate its token, during a wait).
  if (!(await resolveHub(h, id.hubEnv))) return null;
  // Only a fresh 201 is ours: the hub answers an existing pending id with an idempotent
  // 200, and attaching to that would consume another request's verdict. Retry on a
  // collision (200 or 409) with a new id; anything else falls back to the local dialog.
  const bodyOf = (request_id: string, input_preview: string) =>
    ({ agent: id.agent, request_id, tool_name: toolName, description: `${toolName} wants to run`, input_preview });
  const preview = fitPreview(JSON.stringify(toolInput ?? {}), (p) => JSON.stringify(bodyOf("aaaaa", p)));
  let rid = "";
  for (let attempt = 0; attempt < 3 && !rid; attempt++) {
    const candidate = permissionId();
    const created = await authedPost(h, id.hubEnv, "/permissions", bodyOf(candidate, preview));
    if (created.status === 201) rid = candidate;
    // 200: the id is another agent's pending request. 409: it is a finished request's id.
    // Either way it is not ours: try a fresh id.
    else if (created.status !== 200 && created.status !== 409) {
      // The room never sees this request and the local dialog decides: say why, once.
      h.log(`[chatbridge] permission request not created: HTTP ${created.status} ${created.body.slice(0, 200)}`);
      return null;
    }
  }
  if (!rid) return null;

  const wait = (ms: number) => authedGet(h, id.hubEnv, `/permissions/${rid}/wait?timeout_ms=${ms}`, ms + 5_000);

  // A transport failure on the wait or the dismiss is treated like a timeout or a
  // failed dismiss: the request may still have been decided, so re-read it.
  let first: Verdict = null;
  try {
    first = verdictOf(await wait(PERMISSION_WAIT_MS));
  } catch (e) {
    h.log(`[chatbridge] permission wait failed: ${(e as Error).message ?? e}`);
  }
  if (first) return first;

  try {
    const dismissed = await authedPost(h, id.hubEnv, `/permissions/${rid}/dismiss`, { by: id.agent });
    if (dismissed.status >= 200 && dismissed.status < 300) return null;
  } catch (e) {
    h.log(`[chatbridge] permission dismiss failed: ${(e as Error).message ?? e}`);
  }
  // 409 (a verdict won the race) or any other failure: honour a terminal verdict if there is one.
  return verdictOf(await wait(0));
}

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    const agent = ((await $.env.get("CHATBRIDGE_AGENT")) ?? "").trim();
    if (!agent) {
      $.ui.log("[chatbridge] CHATBRIDGE_AGENT not set — chatbridge inactive", { to: "debug" });
      return started;
    }
    const room = ((await $.env.get("CHATBRIDGE_ROOM")) ?? "").trim() || "default";
    const hubEnv = ((await $.env.get("CHATBRIDGE_HUB")) ?? "").trim();
    const home = (await $.env.get("HOME")) ?? "";
    const dataDir = ((await $.env.get("CUBILOT_DATA_DIR")) ?? "").trim();
    identity = { agent, room, hubEnv };
    host = makeHost($, home, dataDir);
    for (const t of CHATBRIDGE_TOOLS) {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
    }
    bridge?.stop();
    const gen = (((await $.state.get(GEN)).value as number | undefined) ?? 0) + 1;
    await $.state.set(GEN, gen);
    const alive = async () => ((await $.state.get(GEN)).value ?? gen) === gen;
    bridge = startBridge(host, { agent, room, hubEnv, sleep: makeSleep($), alive });
    // A reload that replaced the old module: its version was stored before the reload, and this module records it.
    const applying = (((await $.state.get(APPLYING)).value as string | undefined) ?? "");
    if (applying) {
      await $.state.set(APPLYING, "");
      const [version, reloadId, attempt] = applying.split("\n");
      await recordApplied(version, reloadId || null, attempt || null).catch((e) => host?.log(`[chatbridge] ${(e as Error).message ?? e}`));
    }
    return started;
  });

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    if (!identity) return composed;
    const text = buildInstructions({ agent: identity.agent, room: identity.room });
    return { ...composed, sections: [...composed.sections, { id: "chatbridge:instructions", text, scope: "session" as const }] };
  });

  // turn.start also fires for a subagent's or teammate's run (`agentId` set): only the main loop is busy.
  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      await $.state.set(BUSY, true);
      bridge?.onRunStart();
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) {
      await $.state.set(BUSY, false);
      bridge?.onRunEnd(e.reason === "answer");
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const name = String(e.tool);
    if (!name.startsWith(TOOL_PREFIX)) return next(e);
    const tool = findTool(name.slice(TOOL_PREFIX.length));
    if (!tool || !identity || !host) return next(e);
    const args = toolArgs(e as Record<string, unknown>);
    // This hook answers the call itself, so the engine's permission step beneath it
    // never runs: ask it here. A user rule that says deny, or ask (a mod tool has no
    // approval dialog), refuses the call; an ask from the mode alone does not.
    const check = await $.tool.check({ tool: name, input: args });
    if (check.decision === "deny" || (check.decision === "ask" && check.rule)) {
      const why = check.rule ? `permission rule ${check.rule}` : "permission settings";
      return { deny: `${name} is blocked by ${why}${check.reason ? `: ${check.reason}` : ""}. Chatbridge tools cannot show an approval dialog; change the rule to allow to use it.` };
    }
    try {
      const r = await tool.handler({ agent: identity.agent, hubEnv: identity.hubEnv, host, room: identity.room }, args);
      bridge?.onToolResult(tool.name, true);
      return { result: r.content.map((c) => c.text).join("\n") };
    } catch (err) {
      bridge?.onToolResult(tool.name, false);
      return { deny: (err as Error).message ?? String(err) };
    }
  });

  on("classic.PermissionRequest", async ($, e, next) => {
    if (!identity || !host) return next(e);
    let verdict: Verdict = null;
    try {
      verdict = await relayPermission(host, identity, e.tool_name, e.tool_input);
    } catch (err) {
      host.log(`[chatbridge] permission relay failed: ${(err as Error).message ?? err}`);
    }
    return verdict ? { decision: { behavior: verdict } } : next(e);
  });
}
