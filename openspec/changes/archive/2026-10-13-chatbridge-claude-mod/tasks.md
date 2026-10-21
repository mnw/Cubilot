## 1. Spike (go/no-go; throwaway mod under the session's dev-mods folder)

- [x] 1.1 Minimal mod: `session.start` spawns `curl -sN -H @-` against a running hub's `/agent-stream`, logs each piece with `$.ui.log` → verify: pieces keep arriving 2+ minutes after `session.start` returned
- [x] 1.2 Same mod: on first stream piece, `$.prompt.submit({ text })` and `$.session.append` of a user row → verify: an idle session starts a turn from the submit; the appended row is visible to the model next turn; nothing is lost in the first 10 s after spawn; three un-awaited submits issued while busy run in call order
- [x] 1.3 Launch it as A2AChannel would: tmux, `CHATBRIDGE_AGENT=… claude --plugin-dir <spike>` → verify: the mod loads with no interactive question; record what (if anything) enables function hooks non-interactively
- [x] 1.4 Register one tool + `tool.call` hook + `turn.complete` hook → verify: model sees `mcp__<plugin>__<name>`; `turn.complete` fires once per run (not per model request) for submit-started turns, including a run with several tool calls; the `$.prompt.submit` promise resolves as that turn starts; the `tool.call` hook sees the handler's outcome
- [x] 1.5 `classic.PermissionRequest` hook that awaits a 30 s `curl` via `$.process.run` then answers `{ decision: { behavior: "allow" } }` → verify: no budget error; tool proceeds without a dialog
- [x] 1.5b pi side: a throwaway extension logs `message_start` and `agent_end` for a `sendUserMessage` delivery during a multi-tool run → verify: `message_start` carries the user text; `agent_end` fires once per run
- [x] 1.6 Record answers in design.md Open Questions; if 1.3 has no non-interactive path, STOP and report before task 2

## 2. Bridge core and Host contract

- [x] 2.0 Write `test-matrix.md` in this change from the specs: one row per scenario that needs a live room (id, runtime, steps, expected, evidence to capture) → verify: Reviewer signs off before 3.5

- [x] 2.1 Add `hub/channel/host.ts` (`Host`, `DeliveryMode`, `HttpResult`) per design D1
- [x] 2.2 Refactor `hub/channel/hub-client.ts` to take a `Host`: `resolveHub` reads via `host.readText`, `authedPost`/`authedUpload` go through `host.request`/`host.upload`; keep the 401 re-read-and-retry
- [x] 2.3 Thread the `Host` through `ToolContext` in `hub/channel/tools.ts`; `post_file` size/regular-file check moves into each `Host.upload`
- [x] 2.4 Add `hub/channel/core.ts`: SSE frame parsing, room gate, briefing/nutshell render (moved from `tail.ts`), envelope render with JSON-quoted values and `id` (D3), mode table (D2), tail loop with 2 s backoff and per-retry re-resolve, `startBridge()` returning `{ stop, onRunEnd, onToolResult }`; `host.deliver({ id, text, mode, onRead })` resolves on acceptance and the tail loop never waits on `onRead`
- [x] 2.5 Post check in `core.ts` per design D7: pending on delivery, armed when the delivery's `onRead` fires, evaluated on `onRunEnd()`, disarmed only by a hub-2xx `post`/`post_file` after arming, one nudge, nudge never qualifies
- [x] 2.6 Update `hub/channel/instructions.json`: describe the `[chatbridge …]` envelope; drop `<channel>` and `channel-bin` wording
- [x] 2.7 `tests/unit/bridge-core.test.ts` with a fake `Host`: cross-room drop; envelope key order, `catchup`, and values with spaces, `]`, quotes and newlines round-tripping through `JSON.parse`; mode per kind; post check: direct/broadcast/rejected post/nudge once, message queued during run A not cleared or nudged by A, multi-iteration run posting last; chat-then-interrupt during a run: the interrupt is delivered while the chat's `onRead` is still outstanding → verify: `bun test tests/unit` passes
- [x] 2.8 `tsc --noEmit` shows no errors beyond the recorded baseline (4 pre-existing errors in unmodified `hub/main.ts`: TS1375 ×2 and TS5097 ×2 at lines 15 and 17); `grep -n "node:\|fetch(" hub/channel/{core,tools,hub-client}.ts` returns nothing

## 3. Port pi onto the core (no behaviour change except the envelope)

- [x] 3.1 Rewrite `hub/channel/pi-extension.ts` as an adapter (`sendUserMessage` returns `undefined` at runtime: never chain on it unwrapped): pi `Host` (`node:fs` read, `fetch`, `FormData` upload, streaming `fetch` body reader, `deliver` mapped per D2), `startBridge` on `session_start`, `stop` on `session_shutdown`
- [x] 3.2 Wire `message_start` (envelope `id`, via an `id → onRead` map) → `onRead`, `agent_end` → `onRunEnd` (not `turn_end`), and tool outcomes from `execute` → `onToolResult`; bound `fetch` with `AbortSignal.timeout`
- [x] 3.3 Remove the duplicated `renderBriefing`/`renderMeta`/`deliveryFor` and its `ponytail:` comment
- [x] 3.4 Rebuild with `./scripts/build-sidecars.sh`, install with `./scripts/install.sh` → verify: pi agent joins, gets briefing without waking, receives/answers chat, interrupt steers mid-turn, `post_file` works, terminal-only reply gets one nudge
- [x] 3.5 Testers run the S3 rows of `test-matrix.md` with pi subjects → verify: all pass, evidence posted

## 4. Hub permission wait route

- [x] 4.1 Add `GET /permissions/:id/wait?timeout_ms=` to `hub/kinds/permission.ts` (read auth, default 60 000, cap 300 000, `0` returns immediately, 400 on bad id, 404 on unknown, 250 ms ledger poll, `ponytail:` comment naming the per-request poll ceiling)
- [x] 4.2 Integration check against a standalone hub (`PORT=… bun run hub/hub.ts`): wait returns early on verdict, returns `pending` on timeout, `timeout_ms=0` immediate, 400/404 cases, dismiss after verdict returns 409 → verify with curl
- [x] 4.3 Add the route to PROTOCOL.md
- [x] 4.4 In-repo regression for the wait route in `tests/integration/permission-lifecycle.test.ts`: immediate, early verdict, timeout, 400/404/invalid timeout, two concurrent waiters, client abort mid-wait

## 5. Claude Code mod adapter

- [x] 5.1 `hub/channel/claude-mod/.claude-plugin/plugin.json` (name `chatbridge`) and `hooks/hooks.json`
- [x] 5.2 `hub/channel/claude-mod/register.ts` (build the `Host` in a top-level `function makeHost($)`; `$` is never passed to any other function — `claude plugin validate` rejects it): identity from `$.env.get`; inactive with one log line when `CHATBRIDGE_AGENT` is unset; mod `Host` (`$.fs.read`; every request and upload via `curl` under `$.process.run` with `--max-time` and headers on stdin; `curl -sN` stream via `$.process.spawn` with headers on stdin; `deliver` per D2 with busy/idle from `turn.start`/`turn.complete`; `deliver` calls `$.prompt.submit`/`$.session.append` without awaiting and chains `onRead` on the promise; `onRunEnd` on `turn.complete`)
- [x] 5.3 Tools: `$.tool.register` for each `CHATBRIDGE_TOOLS` entry in `session.start`; one `tool.call` hook per tool calling the shared handler and reporting the outcome to the core
- [x] 5.4 `prompt.compose` hook appending `chatbridge:instructions` (scope `session`) from `buildInstructions()`
- [x] 5.5 `classic.PermissionRequest` hook per design D8 (mint id, POST, wait route, allow/deny; on timeout dismiss: 2xx → `next(e)`, 409/other → re-read and honour a terminal verdict, else `next(e)`; any bounded-request failure → `next(e)`)
- [x] 5.6 `hub/channel/claude-mod/tests/register.test.ts`: wake → `prompt.submit` and `deliver` resolves before the submitted turn starts; steer while busy → `session.append`; permission: allow, deny, timeout + dismiss 2xx → `next`, timeout + dismiss 409 + re-read allowed → allow, dismiss fails + still pending → `next`, POST times out → `next` → verify: `claude plugin test` passes
- [x] 5.7 `scripts/check-mod.sh`: bundle the mod to a temp folder, `claude plugin validate` it, and `tsc` `hub/channel/claude-mod/register.ts` against the Claude Code declarations the engine wrote for the last loaded copy (root `tsconfig.json` excludes `hub/channel/claude-mod/**`) → verify: validate passes, tsc clean

## 6. Build, spawn and packaging cutover

- [x] 6.1 `scripts/build-sidecars.sh`: bundle `hub/channel/claude-mod/register.ts` (`bun build --format=esm --target=browser`) to `src-tauri/resources/chatbridge-mod.js`; gitignore it
- [x] 6.2 Tauri resources gain `resources/chatbridge-mod.js`. `lib.rs` resolves it with the same candidate paths as `pi-extension.js`, then at startup materializes the plugin folder atomically at `~/Library/Application Support/A2AChannel/chatbridge-mod/`: build it in a sibling temp dir (`.claude-plugin/plugin.json` and `hooks/hooks.json` written from `include_str!` of the repo files under `hub/channel/claude-mod/`, `hooks/register.js` copied from the resource), then rename over the old one. Never point `--plugin-dir` into the `.app` (Claude Code writes type files into the loaded folder) → verify: after a spawn, `codesign --verify --deep /Applications/A2AChannel.app` passes and the staged folder has the three files
- [x] 6.3 `pty.rs::claude_command`: env identity + `--plugin-dir`, keep `--allowed-tools`, drop the chatbridge MCP config and the dev-channels flag, keep the user's global MCP servers via one generated `mcp-configs/global.json` (`--mcp-config`, chatbridge filtered); delete `write_mcp_config_for` and the `mcp-configs` dir helper; update the unit tests near `pty.rs:1451`
- [x] 6.4 `tests/integration/pty-plumbing.test.ts`: spawn-command assertion expects `--plugin-dir`, no dev-channels flag, and `--mcp-config` only for the global-servers file → verify: suite passes
- [x] 6.5 `lib.rs::get_mcp_template` returns the launch line per the hub-discovery spec; update `ui/features/mcp-modal.js` copy and the header button's title/aria-label
- [x] 6.6 `./scripts/install.sh` → verify: Claude agent joins with no confirm prompt and no keystrokes sent; briefing arrives without waking; chat/interrupt/handoff/permission flows work

- [x] 6.7 Version floor: refuse Claude spawns when `claude --version` < 2.1.296 (probed on every new spawn, no success cache; re-attach skips it) → verify: unit tests for parse/compare; live: spawn works on 2.1.296
- [x] 6.8 Join warning: a freshly spawned agent not connected (presence) after 20 s gets a visible warning on its tab; regression `tests/unit/join-warning.test.ts` → verify: `node --check`; live: normal spawn shows none

## 7. Remove the MCP path

- [x] 7.1 Delete `hub/channel.ts`, `hub/channel/tail.ts`, `hub/channel/permission-relay.ts`; drop `A2A_MODE=channel` from `hub/main.ts`
- [x] 7.2 Remove the dev-channels output scan and its resize-cycle from `ui/terminal.js` (touch only that helper; the branch carries unrelated uncommitted WIP in this file)
- [x] 7.3 Remove `@modelcontextprotocol/sdk` (and `zod` if now unused) from `package.json` → verify: `bun install`, `tsc --noEmit`, `./scripts/build-sidecars.sh` all clean
- [x] 7.4 `grep -rn "dangerously-load-development-channels\|notifications/claude/channel\|A2A_MODE=channel\|modelcontextprotocol" hub src-tauri ui scripts tests` returns nothing

## 8. Verification and docs

- [x] 8.1 Testers run every row of `test-matrix.md` in one room with a Claude tester and a pi tester, including the lone-agent permission row with nobody on the webview → verify: all pass, evidence posted to the room and reviewed — CLOSED 2026-10-13: Reviewer final verdict PASS (install 10). Limits retained: M6-P NOT RUN as written (unit + M6-alt cover the nudge branch); pi agent names with spaces NOT RUN live (pre-existing pane defect; spaced rooms PASS on both runtimes); M1(d) code-audit exception, live input trace NOT RUN; M25-P PASS functionally with a partial command record. Known limits: local-Yes permission asymmetry; pi/Claude `--continue` picks the newest session in a shared folder.
- [x] 8.2 Rewrite CLAUDE.md: replace the `--mcp-config`, `--dangerously-load-development-channels`, dev-channels auto-dismiss, `claude/channel/permission` and "channel-bin enforces the room" rules with the bridge-core / mod / Host / PermissionRequest rules; pin the verified Claude Code version; update the Architecture section and research-preview caveats
- [x] 8.3 Add `docs/adr/0011-chatbridge-runtime-core.md` (why mods, why one core, why the permission behaviour change; use the next free number if 0011 is taken by then)
- [x] 8.4 Mark the unarchived `permission-relay` change's MCP-capability requirements as superseded by `chatbridge-runtime`
- [x] 8.5 Strip any spike/debug instrumentation; delete the spike mod folder — DONE 2026-10-13: TEMP-DEBUG removed; spike mod folders trashed; test sessions abx, asktest2, c3, p2, p3 stopped (t1–t3, c1, p1 closed by the human).
- [x] 8.6 Baseline exceptions (pre-existing at c55e3f7, recorded at group 2 acceptance): `tests/unit/slash-parse.test.ts` fails because `ui/features/slash-mode.js` is not tracked; `tsc --noEmit` errors in `hub/main.ts` — CLOSED (`export {}` + `allowImportingTsExtensions`/`noEmit` in the root tsconfig; tsc now 0 errors); `tests/integration/persist-and-restart.test.ts` "entries replay through /stream after hub restart" fails (verified failing at clean c55e3f7 in a detached worktree). Close the remaining two, or obtain the human's explicit acceptance, before merge — CLOSED 2026-10-13: both were stale tests. slash-parse now loads `ui/features/slash-command.js` (merged in e73eb39); persist-and-restart registers an agent after the respawn, because hydration is lazy (ADR 0001). No product code changed. Reviewer PASS; bun test 165 pass, 0 fail.
- [x] 8.7 Add the ASD-STE100 `language` section to `hub/channel/instructions.json` (human request 2026-10-13) → verify: both bundles contain it, check-mod and tsc clean
