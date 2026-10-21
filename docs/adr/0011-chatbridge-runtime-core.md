# One bridge core, two thin runtime adapters; Claude joins through a mod, not an MCP sidecar

Claude agents reached the room through `channel-bin`, an MCP stdio sidecar (`hub/channel.ts` + `tail.ts` + `permission-relay.ts`), spawned with a per-agent `--mcp-config` and the research-preview flag `--dangerously-load-development-channels server:chatbridge`. That path forced three workarounds: a PTY output scan in `ui/terminal.js` to dismiss the flag's confirm prompt, a fixed 10 s cold-start delay before tailing, and one undifferentiated `notifications/claude/channel` event for every message. Pi agents ran the same chatbridge in-process (`pi-extension.ts`) with urgency-aware delivery and its own header format. The two adapters shared `tools.ts` and `hub-client.ts` but had already drifted: the pi briefing renderer was a copy of `tail.ts`'s, and `instructions.json` described a `<channel …>` tag that pi agents never see.

Claude Code 2.1.287 ships mods: in-process function-hook plugins (`register(on)`, hooks `($, e, next)`). They let the Claude path run in-process like pi, so both runtimes can share one bridge.

## Considered Options

- **Keep the MCP sidecar and only share helpers with pi:** rejected — keeps the dev-channels flag, the output scan and the warm-up delay, and the adapters keep drifting.
- **Two independent adapters, each with its own policy:** rejected — the briefing copy and the `<channel>` instructions mismatch already show this drifts.
- **A plugin system for runtimes:** rejected — over-scope. `Host` has exactly two implementations.
- **Keep an MCP fallback after cutover:** rejected by decision. Work stays on the `claude_mods` branch until `test-matrix.md` passes on both runtimes; `main` keeps the MCP path until merge.

## Decision

- **`hub/channel/core.ts` owns policy**: room gate, briefing/nutshell text, one message envelope, delivery mode (`context` / `steer` / `wake`), and the post-delivery check (a chat message addressed directly to the agent, once read, gets one nudge if the run that read it ends without a hub-acknowledged `post` or `post_file`). Adapters implement the `Host` contract in `hub/channel/host.ts` (request, stream, upload, deliver, log) and wire runtime events to `onRunEnd` / `onToolResult`. Nothing else.
- **`tools.ts` and `hub-client.ts` do I/O through the `Host`**, not `node:*` or global `fetch`, because the mod runs with no Node and no network.
- **Claude adapter** is `hub/channel/claude-mod/register.ts`: tools via `$.tool.register` (names stay `mcp__chatbridge__*`), instructions via `prompt.compose`, the hub stream via `curl` under `$.process.spawn` (`$.http.fetch` buffers and takes no timeout), delivery via `$.session.append` / `$.prompt.submit`. Every hub request is a bounded `curl`.
- **Identity by env** (`CHATBRIDGE_AGENT`, `CHATBRIDGE_ROOM`), like pi. `pty.rs` launches `claude --plugin-dir <staged mod>`; the mod is staged to `~/Library/Application Support/A2AChannel/chatbridge-mod/` because Claude Code writes type files into every loaded plugin dir.
- **Permission relay moves to the `classic.PermissionRequest` hook**: POST `/permissions`, wait on the new `GET /permissions/:id/wait`, dismiss on timeout and fall back to the local dialog.
- **Removed**: `hub/channel.ts`, `tail.ts`, `permission-relay.ts`, `A2A_MODE=channel`, per-agent `mcp-configs/<agent>.json` (the `--mcp-config` flag now carries only the user's global servers, chatbridge filtered), the dev-channels flag, the PTY output scan, and the 10 s warm-up.

## Consequences

- **Permission timing depends on the Claude Code build.** The hook asks the hub and waits (default 60 s, hub cap 300 s); a timed-out request is dismissed explicitly so no ghost card remains. On Claude Code 2.1.296 (verified live, M18) the local dialog opens immediately, concurrently with the hook: the room and the terminal race and the first answer wins. A room verdict applies through the hook and closes the dialog; a terminal answer runs the tool at once, and the hook keeps waiting until its timeout, then dismisses the room card (it stays visible for up to 60 s). On 2.1.287 the dialog waited for the hook (observed in M15/M16). No TTL was added to the `permissions` table.
- **Early-access risk.** Mods are early access; a Claude Code release can break the adapter. No MCP fallback exists after cutover. Verified only on Claude Code 2.1.287 and pi 0.87.1. `scripts/check-mod.sh` (`claude plugin validate` + `tsc` against the engine's own declarations) is the drift check; re-run the spike and `test-matrix.md` on each version bump.
- **The hub is unchanged and runtime-blind**, except for the additive `GET /permissions/:id/wait` route and its ledger poll (one 250 ms poll loop per waiting request; an in-process waiter map is the upgrade if many agents wait at once).
- **Delivery is uniform across runtimes.** `context` (briefing, nutshell, resolved permissions — no wake), `steer` (interrupts — into a running turn), `wake` (chat, handoffs — starts a turn when idle). The post-delivery check is hub-verified: a 403 or a claimed-but-unsent post still triggers the nudge.
- **Constraint found by the spike**: in the mod, `$` may only be passed to top-level function declarations (`claude plugin validate` rejects the rest), so the `Host` is built in a top-level `makeHost($)` and the core never sees `$`. Pi's `sendUserMessage` returns `undefined` at runtime despite its `Promise<void>` type, so pi delivery is fire-and-forget and any chaining must be wrapped.
- **`mcp__chatbridge__*` tools are deferred behind ToolSearch**, same as MCP tools were.
- **The mod answers its own tool calls, so it must enforce permissions itself.** Found in review: a user `ask` rule on `mcp__chatbridge__post_file` was silently bypassed. The tool hook now asks `$.tool.check` first; `deny` or a rule-based `ask` refuses the call (no approval dialog exists for mod tools), a mode-only `ask` runs it. `--disallowedTools` hides the tool from the model entirely.
- **Tool surface for external sessions changes**: `get_mcp_template` returns a `claude --plugin-dir …` launch line instead of an `.mcp.json` snippet.
- **The user's `defaultMode: "auto"` suppresses most permission dialogs**, so the relay rarely fires in normal use; the test matrix forces `default` mode in its project.

## Spike evidence (2026-10-13, Claude Code 2.1.287, pi 0.87.1)

Isolated standalone hub on port 8100, data under `/tmp/a2a-spike`. Recorded in `openspec/changes/chatbridge-claude-mod/design.md`, "Spike results".

- Non-interactive load, no warm-up window (a message 20 ms after `session.start` started a turn), run-level signals (`turn.complete` once per run), long-lived `curl` stream from `session.start` (still receiving heartbeats at 3m45s): `/tmp/a2a-spike/events.log`, `/tmp/a2a-spike/debug*.log`, `/tmp/a2a-spike/evidence/run-claude.*`, `/tmp/a2a-spike/evidence/run-longevity.debug.log`.
- `PermissionRequest` hook held 30 s on `$.process.run` with no budget error: `/tmp/a2a-spike/evidence/run-permission-1.debug.log`.
- pi `message_start` carries the envelope; `turn_end` fires per iteration, `agent_end` once per run: `/tmp/a2a-spike/pi-events.log`, `/tmp/a2a-spike/evidence/run-pi.log`.
- One first-ever launch in an untrusted folder logged no `session.start` after the trust answer and did not reproduce; tracked as test-matrix row M30. These files are in `/tmp` and not durable; the findings are copied into `design.md`.

## Recorded by

`chatbridge-claude-mod` (openspec change, branch `claude_mods`); design decisions D1–D9, spike results in `design.md`.
