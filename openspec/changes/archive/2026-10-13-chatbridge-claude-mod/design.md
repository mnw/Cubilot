## Context

Two runtimes join a room today, through two unrelated adapters:

- **Claude** — `hub/channel.ts` (MCP stdio server, `CUBILOT_MODE=channel` of `cubilot-bin`) + `tail.ts` + `permission-relay.ts`. Spawned via a per-agent `--mcp-config` and `--dangerously-load-development-channels server:chatbridge`. Every hub event becomes one `notifications/claude/channel`, which Claude Code renders as a `<channel …>` tag and always treats the same way. The flag forces a confirm prompt (`ui/terminal.js` scans PTY output to dismiss it) and fresh sessions swallow notifications for ~10 s (`channel.ts` delays the tail).
- **Pi** — `hub/channel/pi-extension.ts`, in-process, loaded with `pi -e`. Already delivers by urgency (`steer` / `followUp` / no-wake context) and renders its own `[kind · from …]` header. Its briefing renderer is a copy of `tail.ts`'s.

Both share `tools.ts` (tool schemas + handlers) and `hub-client.ts` (discovery, auth, 401 retry), which import `node:fs`, `node:os`, `node:path` and global `fetch`.

Claude Code 2.1.287 ships mods: an in-process hooks module (`register(on)`, hooks `($, e, next)`), early access. The module runs with no Node and no global network; everything goes through `$` (`$.fs`, `$.http.fetch` — buffered, no streaming — `$.process.run` / `$.process.spawn`, `$.env`, `$.tool.register`, `$.session.append`, `$.prompt.submit`, `prompt.compose`, `turn.start` / `turn.complete`, `classic.PermissionRequest`). A hook's own code has a 10 s budget per dispatch; `$` calls in flight do not count against it.

Pi 0.87.1's extension API covers the same surface (`registerTool`, `before_agent_start`, `session_start` / `session_shutdown`, `sendMessage` / `sendUserMessage`, `turn_start` / `turn_end`, `tool_result`, `ui.setStatus`).

## Goals / Non-Goals

**Goals:**
- One bridge core shared by both runtimes: room gate, briefing text, message envelope, delivery policy, post-delivery check. Adapters carry no policy.
- Claude joins the room with no research-preview flag, no output scanning, no fixed warm-up delay.
- Same delivery semantics on both runtimes: `context`, `steer`, `wake`.
- Hub-verified posting: a turn that should have answered and did not gets one nudge.
- Remove the MCP path entirely at cutover.

**Non-Goals:**
- Permission relay for pi (pi has no permission dialog; nothing asks for one).
- In-terminal panes or bands for handoffs/interrupts (the webview already shows them).
- Any hub-side runtime awareness: the hub protocol stays harness-blind.
- Changing tool schemas, kinds, or room semantics.
- Windows/Linux, or Claude Code builds without function hooks.

## Decisions

### D1. Host contract, core owns policy

```ts
// hub/channel/host.ts
export type DeliveryMode = "context" | "steer" | "wake";
export type HttpResult = { status: number; text: string };
export type Host = {
  readText(path: string): Promise<string | null>;
  // Every request is bounded: timeoutMs defaults to 15 000; the permission wait passes timeout_ms + 5 000.
  request(url: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<HttpResult>;
  upload(url: string, token: string, filePath: string): Promise<HttpResult>;   // multipart, field "file"; 60 s bound
  stream(url: string, token: string, signal: AbortSignal): AsyncIterable<string>; // raw SSE text
  // Resolves once the runtime has ACCEPTED the delivery (queued or appended), never later.
  // onRead fires when the message enters the model's context, possibly much later.
  deliver(d: { id: number | null; text: string; mode: DeliveryMode; onRead: () => void }): Promise<void>;
  log(msg: string): void;
};
```

`core.ts` exports `startBridge(host, { agent, room, hubEnv })`, returning `{ stop, onRunEnd, onToolResult }`. It runs the tail loop, parses SSE frames, applies the room gate, renders, picks the mode and calls `host.deliver`. The read signal is the per-delivery `onRead` callback, not a bridge method, so the adapter never has to map ids back to checks except where the runtime forces it (pi, D7).

**`deliver` must not block the tail.** If it awaited the queued run's start, a chat queued while the agent is busy would stall the SSE loop and hold back a following `interrupt.new`. Acceptance and read are therefore separate: the mod calls `$.prompt.submit` / `$.session.append` without awaiting them inside `deliver` and chains `onRead` on their promise; pi's `sendUserMessage` / `sendMessage` return on enqueue and `onRead` fires from `message_start`. Spike task 1.2 verifies that un-awaited `$.prompt.submit` calls keep their call order. `hub-client.ts` and `tools.ts` take the `Host` (through `ToolContext`) in place of `node:*` and `fetch`.

*Alternatives:* keep two adapters and only share helpers. Rejected: the briefing copy and the `<channel>` instructions mismatch show the adapters already drift. *Ceiling:* `Host` has exactly two implementations; it is not a plugin system.

### D2. Delivery policy (core)

| Event | Mode |
|---|---|
| `briefing`, `nutshell.updated`, `permission.resolved`, `permission.dismissed`, `interrupt.ack`, and `permission.new` whose `from` is this agent | `context` |
| `interrupt.new` | `steer` |
| everything else (chat, `handoff.*`, another agent's `permission.new`) | `wake` |

Kinds, not `from`, decide the informational cases: `handoff.update` carries the creator in `from` even when the other party acted, so a `from === agent` rule would silence accept/decline news the creator needs. Found in the mod smoke test: the requesting agent was woken three times by its own permission and ack traffic.

Adapter mapping:

| Mode | pi | Claude mod |
|---|---|---|
| `context` | `sendMessage({customType, content}, {triggerTurn:false, deliverAs:"nextTurn"})` | `$.session.append({ message: { type: "user", content } })` |
| `steer` | `sendUserMessage(text, {deliverAs:"steer"})` | busy → `$.session.append`; idle → `$.prompt.submit` |
| `wake` | `sendUserMessage(text, {deliverAs:"followUp"})` (may continue the running agent run) | `$.prompt.submit({ text })` (queued if busy; queued submits run as one batched turn once idle) |

The mod tracks busy/idle itself from `turn.start` / `turn.complete`.

### D3. One message envelope

Both runtimes receive the same first line, then the body:

```
[chatbridge id=42 from="alice" to="bob" room="EU Space" kind="handoff.new" handoff_id="h_x" version=3 catchup]
<text>
```

Keys are emitted only when present, in a fixed order: `id from to room kind <id-key> version status expires_at_ms catchup` (`id` is the hub entry id, used by D7). String values are always written as JSON string literals (`JSON.stringify`), so spaces, quotes, `]` and newlines in agent names or room labels cannot break or forge the line; numbers are bare; `catchup` is a bare flag. A value is never emitted unquoted. `instructions.json` describes this line and no longer mentions `<channel …>`. Briefing and nutshell text keep their current prose, rendered once in `core.ts`.

*Alternative:* keep `<channel>`-shaped XML for Claude. Rejected: pi never sees it, and the tag's trusted-attribute semantics belonged to Claude Code's channel renderer, which is gone.

### D4. Hub stream in the mod: `curl` under `$.process.spawn`

`$.http.fetch` buffers the whole body, so it cannot hold SSE open, and it takes no timeout or abort signal, so a hung request would hang the hook that awaits it. The mod therefore does all hub HTTP through `curl`. The mod's `host.stream` runs `curl -sN --no-buffer -H @- <url>/agent-stream?agent=…&room=…`, the bearer header supplied on stdin (`input`), so the token never appears in `ps`. The loop starts from `session.start` as a detached `void (async () => …)()`, the pattern the API documents for a child that lives for the session. On exit, the core waits 2 s, re-resolves `hub.url` + `hub.token` and respawns, exactly as today.

`host.request` in the mod: `$.process.run(["curl","-sS","--max-time",<s>,"-H","@-","-X",method,"--data-binary","@<tmp>"|…,"-w","\n%{http_code}",url], { timeoutMs })`, headers (bearer included) on stdin, so every call is bounded (default 15 s; the permission wait passes its own `timeout_ms` + 5 s). `host.upload`: `$.fs.stat` (regular file, ≤ 8 MiB) then the same `curl` shape with `-F file=@<path>`. Pi keeps `fetch` + `FormData`, with an `AbortSignal.timeout` of the same bound.

*Alternative:* a new hub long-poll route polled with `$.clock.every`. Kept as the fallback if the spike shows the spawned child does not survive `session.start`.

### D5. Identity by env, like pi

`pty.rs` builds `CHATBRIDGE_AGENT='…' CHATBRIDGE_ROOM='…' '<claude>' [--continue|--resume] --plugin-dir '<mod>' --allowed-tools 'mcp__chatbridge__ack_permission,mcp__chatbridge__post,mcp__chatbridge__post_file'`. The mod reads identity with `$.env.get`. The plugin is named `chatbridge`, so its tools are listed as `mcp__chatbridge__<name>` and the allow-list is unchanged. `write_mcp_config_for` and the per-agent chatbridge MCP configs go away. The user's global MCP servers (the Cubilot `mcp.json`) are unrelated to the chatbridge and keep reaching Claude agents: each spawn writes them, `chatbridge` filtered out, to one generated `mcp-configs/global.json` passed with `--mcp-config` (omitted when there are none).

### D6. Instructions

Pi: `before_agent_start` (unchanged). Mod: `prompt.compose` appends `{ id: "chatbridge:instructions", scope: "session", text }`. Same `buildInstructions()` output.

### D7. Post-delivery check (core)

The check is bound to the **run that reads the message**, not to its arrival. Three moments, each reported by the adapter:

1. **Delivered** — the core hands a qualifying message (a chat message whose `to` is this agent; not `all`, not a structured kind, not a nudge) to `host.deliver` and records it as *pending*, keyed by the hub entry `id`. Nothing is armed yet.
2. **Read** — the adapter calls the delivery's `onRead` callback when that message enters the model's context. Only then is the check *armed*, and only posts that complete **after** this point can disarm it.
3. **Run end** — the adapter reports `onRunEnd()` when the whole run that consumed the message is over (not one model/tool iteration). Armed and not disarmed → one `wake` nudge: "A message addressed to you got no reply in the room. Your terminal output is visible to nobody — call post." The nudge itself never qualifies, so it never re-arms.

Each qualifying delivery owns its own check object, armed only by that delivery's `onRead` closure; checks are never keyed by the hub entry id, because ids restart with the hub. `onToolResult("post" | "post_file", ok)` disarms every armed check when the hub answered 2xx. A post during run A cannot clear a message queued for run B, because B's message is still *pending*, not armed.

Adapter signals:

| Signal | Claude mod | pi |
|---|---|---|
| `onRead` | the un-awaited `$.prompt.submit` promise resolves (it resolves as that message's turn starts); for `steer` via `session.append`, the append resolving | `message_start` for a user message whose envelope carries that `id` (adapter keeps `id → onRead`) |
| `onRunEnd()` | `turn.complete` | `agent_end` (not `turn_end`, which fires per model/tool iteration) |
| `onToolResult` | `tool.call` hook on the chatbridge tools, after `next(e)` | the tool's `execute` |

The envelope's `id` lets pi match `message_start` to the delivery. Both read the outcome from the hub response, so a post the model only claims to have made never disarms the check.

Required tests (core, fake host): a `wake` chat whose `onRead` has not fired does not delay delivery of a following `interrupt.new` (chat-then-interrupt during a run); message queued during run A + post in A + run A ends → no nudge, check still pending; run B reads it, ends without post → one nudge; multi-iteration run (several tool calls, post in the last iteration) → no nudge; rejected post (403) → nudge.

### D8. Permission relay via `classic.PermissionRequest`

The hook mints a request id matching the hub's `PERMISSION_ID_RE` (5 letters, `[a-km-z]`), `POST /permissions` with `{ agent, request_id, tool_name, description, input_preview }` (preview from `tool_input`, truncated to 8 000 chars), then awaits `GET /permissions/<id>/wait?timeout_ms=<n>` through `host.request` with `timeoutMs: n + 5000` (bounded `curl` under `$.process.run`, D4). The wait is a `$` call, so it does not consume the 10 s hook budget.

- `allowed` / `denied` → answer `{ decision: { behavior } }`.
- timeout → `POST /permissions/<id>/dismiss` as the agent. A 2xx means the dismiss won → `next(e)`, so the decision stays with Claude's local dialog. A 409 means a verdict won the race → re-read the snapshot (`GET /permissions/<id>/wait?timeout_ms=0`) and honour its `allowed`/`denied`. Any other dismiss failure → re-read once; terminal verdict → honour it; otherwise `next(e)`.
- hub unreachable, POST rejected, or any call exceeding its `curl` bound → `next(e)`. Every request in this hook is bounded (D4), so the hook can never hang indefinitely.

Required tests (mod, `claude plugin test` with stubbed `process.run`): allow; deny; timeout + dismiss 2xx → `next`; timeout + dismiss 409 + re-read `allowed` → allow; dismiss fails + re-read pending → `next`; POST /permissions times out → `next`. Manual: a lone agent with nobody watching the webview is answered from its local dialog (already open on 2.1.296), and the card is gone from the room once the 60 s wait ends.

New hub route `GET /permissions/:id/wait` (read auth, in `hub/kinds/permission.ts`): returns the snapshot once its status is terminal or `timeout_ms` (capped at 300 000) elapses. Polls the ledger every 250 ms. *Ceiling:* one poll loop per waiting request; switch to an in-process waiter map if many agents wait at once.

*Alternative:* answer `next(e)` at once and race the hub in the background, as the MCP relay does. Not possible from the hook. **Observed on 2.1.296 (M18):** the engine itself opens the local dialog concurrently with the hook, so the race exists anyway: a room verdict answers through the hook and closes the dialog; a terminal No dismisses the card at once; a terminal Yes runs the tool and the hook dismisses the card at its timeout. On 2.1.287 the dialog waited for the hook.

No TTL is added to the `permissions` table: the wait timeout ends the *hook*, not the request, and a timed-out request is dismissed explicitly.

### D8b. Chatbridge tool permissions (found in review)

The mod's `tool.call` hook answers the call, so Claude Code's permission step beneath it never runs. The hook therefore calls `$.tool.check` first:

| Decision | Result |
|---|---|
| `allow` | runs |
| `deny` (rule, mode or `--disallowedTools`) | refused / not offered |
| `ask` from a user rule | **refused** with an explanation — no approval dialog exists for mod tools; failing closed honours the rule |
| `ask` from the mode alone | runs |

Not equivalent to the old allow-list: `--allowed-tools` pre-approved only `post`, `post_file`, `ack_permission`. The other six chatbridge tools (handoff send/accept/decline/cancel, interrupt send/ack) prompted in `default` mode and now run without a prompt. Accepted because they only change hub state; a user who wants them gated can add a `deny` rule. Listed as BREAKING in the proposal.

**Local-answer cleanup (considered, withdrawn 2026-10-13):** code that dismisses the room card as soon as the person answers the local dialog. A tool.call-entry heuristic was wrong (the permission prompt runs beneath `tool.call`'s `next(e)`), and the hook's `next.signal` aborts only on a local No (any dispatch abandonment, in fact), never on a local Yes. Withdrawn. Observed without it on install 9 (crossed cases, 2026-10-13): after a local No the card is dismissed by the agent within ~50 ms and a room verdict gets 409 (mechanism not traced: most likely the engine abandons the hook's in-flight wait, and the relay's failure path dismisses); after a local Yes the card stays pending until the wait ends (≤ 60 s), and a room verdict in that window is recorded but does not change the outcome.

### D9. Build and packaging

`scripts/build-sidecars.sh` bundles twice from the same sources:
- `hub/channel/pi-extension.ts` → `src-tauri/resources/pi-extension.js` (unchanged).
- `hub/channel/claude-mod/register.ts` → `src-tauri/resources/chatbridge-mod.js`, one file like `pi-extension.js`. The plugin's two JSON files are compiled into the Rust shell with `include_str!` from `hub/channel/claude-mod/` (single source; avoids bundling a dot-directory as a Tauri resource).

A mod can only import files inside its own folder, so bundling is required. `lib.rs` resolves the bundled mod with the same candidate paths it uses for `pi-extension.js`, then **copies it to `~/Library/Application Support/Cubilot/chatbridge-mod/` at startup** (replacing the previous copy) and passes that path to `--plugin-dir`. Claude Code writes `.claude-plugin/types/`, `.gitignore` and `tsconfig.json` into every `--plugin-dir` folder it loads (observed in the mod smoke test), so pointing it inside the signed `.app` would modify the bundle. `get_mcp_template` returns the `--plugin-dir` launch line for external sessions.

### D10. Tests

- `tests/unit/bridge-core.test.ts` (bun): room gate, envelope rendering, mode table, post-check arming/disarming/nudge-once, with a fake `Host`.
- `hub/channel/claude-mod/tests/register.test.ts` (`claude plugin test`): a `wake` delivery calls `prompt.submit`; `steer` while busy calls `session.append`; a `PermissionRequest` timeout calls `next`.
- `tests/integration/pty-plumbing.test.ts`: spawn-command assertion updated to `--plugin-dir`.
- `test-matrix.md` in this change: the cross-runtime acceptance matrix (scenario, steps, expected, evidence to capture), derived from the specs. The historical T1–T11 rounds are not in the repo (their report files are gone), so they are not used as a gate; the matrix replaces them. Run by two tester agents (one Claude, one pi) before merge.

## Risks / Trade-offs

- [Early-access API changes between Claude Code releases] → Pin the verified Claude Code version in CLAUDE.md; the mod tests fail loudly on API drift; the adapter is small (~80 lines) to re-port.
- [Function hooks may need an opt-in that a tmux-spawned agent cannot answer] → Spike task 1 settles this before any refactor lands; if there is no non-interactive opt-in, stop and report.
- [Detached `curl` may die with the `session.start` dispatch] → Spike verifies; fallback is the long-poll route (D4).
- [Permission dialog now waits on the hub first] → Bounded wait (default 60 s), then the local dialog; the hub card is dismissed so no ghost card remains.
- [`$.prompt.submit` text is framed as "the chatbridge plugin sent a message"] → Acceptable and truthful; the envelope still carries `from`.
- [Post-check nudges on messages that need no reply] → Armed only for chat addressed directly to the agent, only once the run has read it; one nudge, never repeated.
- [Envelope spoofing via names/labels] → All string values JSON-quoted (D3); tests cover spaces, quotes and `]`.
- [No MCP fallback after cutover] → Accepted by decision; work stays on `claude_mods` until `test-matrix.md` passes on both runtimes.
- [Uncommitted WIP in `ui/terminal.js` carried onto the branch] → The dev-channels scan removal is the last task and touches only that helper.

## Migration Plan

1. Spike on the branch (throwaway mod under the dev-mods folder); record answers in Open Questions.
2. Core + Host extraction; pi ported; pi passes the pi rows of `test-matrix.md` with no behaviour change except the unified envelope.
3. Hub `GET /permissions/:id/wait`.
4. Claude mod; mod tests; mixed-runtime room passes `test-matrix.md`.
5. Cutover in `pty.rs` / `lib.rs` / build script; delete the MCP path; CLAUDE.md rules rewritten.
6. Existing tmux sessions from MCP-spawned builds keep running their old command until killed and respawned; there is no in-place migration (agent runtime is immutable per session).

Rollback: the work lives on `claude_mods`; `main` keeps the MCP path until merge.

## Spike results (2026-10-13, Claude Code 2.1.287, pi 0.87.1)

Run against an isolated standalone hub (port 8100, data under `/tmp/cubilot-spike`), bundled tmux on its own socket. Evidence: `/tmp/cubilot-spike/events.log`, `pi-events.log`, `debug*.log`.

1. **Non-interactive load — answered.** `claude --plugin-dir <mod>` loads the hooks module with no question (`hooks module spike@inline loaded (worker …)`). In a never-trusted folder, hooks modules wait for the workspace-trust answer and load as soon as it is given; that prompt exists today on the MCP path too. One first-ever launch in an untrusted folder logged no `session.start` after trust; not reproduced on a second untrusted folder → matrix row M30.
2. **Delivery timing — answered.** `session.start` → stream connected in 10 ms; a message sent 20 ms later started a turn. No warm-up window: the fixed 10 s delay goes.
3. **Permission hub-wait default** — still 60 s; unchanged.
4. **Run-level signals — answered.** `turn.complete` fires once per run (a run with two Bash calls → one `turn.complete`). The `$.prompt.submit` promise resolves at that turn's `turn.start`. A `tool.call` hook sees the tool outcome after `next(e)`.
5. **pi `message_start` — answered.** It carries the user text including the envelope, so `id → onRead` matching works. `turn_end` fires per model/tool iteration (4 in one run); `agent_end` once per run.

Further findings that change the implementation:

- **`$` may only be passed to top-level function declarations** (static check in `claude plugin validate`). A top-level `makeHost($)` returning an object of closures over `$` passes; so the mod adapter builds its `Host` there and the core never sees `$`.
- **`$.prompt.submit` calls made while busy are queued and batched**: three submits issued mid-run all resolved at the next `turn.start` and ran as one turn, in call order. `onRead` therefore fires for all of them at once; D7 is unaffected.
- **`$.session.append` while busy is a working steer**: appended mid-run, the same run's next model request saw it.
- **pi `sendUserMessage` returns `undefined` at runtime** (typed `Promise<void>`): fire-and-forget, so pi delivery cannot block the tail. Any `.then` on it must be wrapped (`Promise.resolve(...)`). pi folds `followUp` messages into the running agent run rather than starting a new one; `steer` lands after the current tool execution.
- **Registered mod tools are deferred behind ToolSearch**, the same as MCP tools today.
- **The user's settings use `defaultMode: "auto"`**, so most tool calls never raise a permission dialog and the relay rarely fires in practice. Matrix P0 forces `default` mode in the test project.
- **`classic.PermissionRequest` holding for 30 s on `$.process.run`** produced no budget error and answered without a dialog ("Allowed by PermissionRequest hook").

## Rollout gate (found during acceptance, 2026-10-13)

Installed plugins' hooks modules are gated by Claude Code's GrowthBook flag `tengu_plugin_hooks_modules` (default on). On 2.1.287 a stale "off" from the disk cache of an earlier session disabled the mod in every new process (0/5 launches at 12:24; the two failed `c1` app spawns). 2.1.296 overrides a disk-cached "off" under its credential checks (from the bundle's code; not documented) and loaded the mod 3/3. Mitigations: minimum Claude Code 2.1.296 probed on every new spawn, never cached, skipped on re-attach (task 6.7), and a 20 s join warning in the UI driven by connected presence (task 6.8) so a genuine server-side "off" is visible instead of silent. Forcing the flag on (`DISABLE_GROWTHBOOK`) was rejected: it overrides Anthropic's rollout/kill-switch control and disables every other server flag.

**Update channel (decided by the human, 2026-10-13):** the `stable` auto-update channel was at 2.1.287 and its auto-updater reinstalled it at 13:54 over a manual 2.1.296 upgrade. The human chose to move to the `latest` channel (option A) over restoring MCP as the default harness (option B). Requirement until stable reaches 2.1.296: `autoUpdatesChannel: "latest"`.

## Mod reload during a turn (M37, 2026-10-13)

The engine defers a plugin-dir reload while a tool call runs (observed: touch at 13:53:36, reload at the tool's end, 45 s later). A reload resets module state, so `busy` reads false until the next `turn.start`; a steer delivered between the reload and the end of that same turn is queued as a prompt instead of appended — it arrives one turn later, never lost. The reconnecting bridge also gets the hub's `catchup` replay of anything still pending. Fixed after review: `busy` now lives in host state (`$.state`, contract `hub/channel/claude-mod/types/index.d.ts`), which survives a reload; verified on the installed build (matrix M37b: the post-reload replay was appended into the running turn). Every app restart restages the folder and so triggers this reload in each running Claude agent.

## Open Questions

1. Permission hub-wait default: 60 s; make it a `config.yml` key only if the default proves wrong.
2. Cause of the single untrusted-folder miss (spike result 1) — watched by matrix row M30.
