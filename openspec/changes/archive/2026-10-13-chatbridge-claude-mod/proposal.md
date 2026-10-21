## Why

Claude agents reach the room through an MCP sidecar (`channel-bin`) that depends on the research-preview `--dangerously-load-development-channels` flag, which drags in three workarounds: an output-scanning auto-dismiss of the dev-channels confirm prompt, a fixed 10 s cold-start delay before tailing, and a single undifferentiated notification for every message. Pi agents already run the chatbridge in-process (`pi-extension.ts`) with urgency-aware delivery. Claude Code now ships mods — in-process function-hook plugins — which let the Claude path run the same way, so both runtimes can share one bridge core and behave identically inside the room.

## What Changes

- Extract a runtime-neutral **bridge core** (room gate, briefing render, one message envelope, delivery policy, post-delivery check) and a small **Host** contract that each runtime implements. `tools.ts` and `hub-client.ts` stop importing `node:*` and global `fetch`; their I/O goes through the Host.
- Port the **pi** adapter onto the core first, with no behaviour change, as the regression baseline.
- Add a **Claude Code mod** (`chatbridge`) as the second adapter: tools via `$.tool.register` (names stay `mcp__chatbridge__*`), instructions via `prompt.compose`, hub stream via `curl` under `$.process.spawn`, delivery via `$.session.append` / `$.prompt.submit`.
- **Three delivery modes, both runtimes**: `context` (briefing, nutshell — no wake), `steer` (interrupts — into a running turn), `wake` (chat, handoffs, permissions — starts a turn when idle).
- **Post-delivery check, both runtimes**: a turn started by a room delivery that ends without a successful `post` gets one nudge. "Successful" means the hub answered 2xx, not that the model said so.
- **Permission relay moves to `classic.PermissionRequest`**: the hook asks the hub and waits for a verdict; on timeout the hook dismisses the room card and falls through. On Claude Code 2.1.296 (verified live, M18) the local dialog opens immediately, concurrently with the hook: the room and the terminal race and the first answer wins. A room verdict applies through the hook and closes the dialog; a terminal answer runs the tool at once, and the hook keeps waiting until its timeout, then dismisses the room card (it stays visible for up to 60 s). On 2.1.287 the dialog waited for the hook (observed in M15/M16). (Designed on 2.1.287 as a hub-first wait that held the dialog; that BREAKING change does not occur on the 2.1.296 minimum.)
- **BREAKING (behaviour): chatbridge tool permissions.** The mod answers its own tool calls and asks `$.tool.check` first. (a) A user settings rule that says `ask` for a chatbridge tool now **refuses** the call with an explanation instead of opening a dialog — a mod tool has no approval dialog. (b) Under a mode-only `ask` (e.g. `default` mode, no rule), all nine chatbridge tools now run without a prompt. Previously only `post`, `post_file` and `ack_permission` were pre-approved via `--allowed-tools`; `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff`, `send_interrupt` and `ack_interrupt` followed the mode and prompted in `default` mode. These six only change hub state (no local side effects). `deny` rules and `--disallowedTools` still block.
- **One message envelope** for both runtimes; `instructions.json` describes it instead of the `<channel …>` tag pi agents never see.
- `pty.rs` spawns Claude as `CHATBRIDGE_AGENT=… CHATBRIDGE_ROOM=… claude --plugin-dir <mod>` (identity by env, like pi).
- **BREAKING**: remove the MCP path — `hub/channel.ts`, `hub/channel/tail.ts`, `hub/channel/permission-relay.ts`, `A2A_MODE=channel` in `hub/main.ts`, per-agent `mcp-configs/`, the `--dangerously-load-development-channels` flag, the dev-channels output scan in `ui/terminal.js`, and the 10 s warm-up.
- **BREAKING**: the "MCP configs" header modal (`get_mcp_template`) returns a `claude --plugin-dir …` launch line for external sessions instead of an `.mcp.json` snippet.

## Capabilities

### New Capabilities
- `chatbridge-runtime`: the shared bridge core, the Host contract, the three delivery modes, the message envelope, the post-delivery check, the Claude mod and pi adapters, and permission relay via `classic.PermissionRequest`. Supersedes the requirements of the unarchived `permission-relay` change that bind the relay to the MCP channel capability.

### Modified Capabilities
- `agent-onboarding`: briefing is delivered by the bridge in `context` mode, not as an MCP `notifications/claude/channel` event.
- `hub-discovery`: URL/token discovery and auth requirements move from `channel-bin` to the bridge core; the MCP config template requirement becomes a mod launch-line requirement.
- `terminal-projection`: Claude sessions start with `--plugin-dir` and env identity, not `--dangerously-load-development-channels`.
- `interrupt-messages`: interrupts are delivered in `steer` mode by the bridge, not as MCP notifications.
- `attachment-upload-by-agent`: `post_file` is a bridge tool served by either runtime, not an MCP tool of the channel sidecar.

## Impact

- **Code**: `hub/channel/*` (new `core.ts`, `host.ts`; `tools.ts`, `hub-client.ts`, `instructions.*`, `pi-extension.ts` refactored), new `hub/channel/claude-mod/` plugin folder, `hub/channel.ts` + `hub/main.ts` channel mode removed, `src-tauri/src/pty.rs` (`claude_command`, `write_mcp_config_for`), `src-tauri/src/lib.rs` (`get_mcp_template`, mod path resolution), `ui/terminal.js`, `ui/features/mcp-modal.js`, `scripts/build-sidecars.sh` (bundles the core twice), `tests/integration/pty-plumbing.test.ts`.
- **Dependencies**: Claude Code with function hooks (early access; API may change between releases); `curl` (ships with macOS). `@modelcontextprotocol/sdk` can be dropped once `channel.ts` is gone.
- **Docs**: CLAUDE.md hard rules on `--mcp-config`, `--dangerously-load-development-channels`, the dev-channels auto-dismiss, and the `claude/channel/permission` capability are rewritten in the same change.
- **Risk**: mods are early access; a Claude Code release can break the adapter. No MCP fallback remains after cutover, by decision.
