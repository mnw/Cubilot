# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard rules

- **Never commit unless asked.** Worker/Writer stage sessions commit on own ticket/<id> branch only, never on main, never push. docs/rules/core.md
- **Heavy processes run one at a time.** Lock: /tmp/cubilot-heavy.lock; use ./scripts/test.sh. docs/rules/core.md
- **No framework in ui/index.html.** docs/rules/core.md
- **Hub port is dynamic.** Never hardcode it. docs/rules/core.md
- **Harness is per agent and immutable.** Unknown values rejected. docs/rules/terminal.md
- **Pi gets the chatbridge as an extension.** Rerun build-sidecars.sh after extension changes. docs/rules/bridge.md
- **Pi shares Claude skills and commands only.** No MCP, plugins or hooks. docs/rules/bridge.md
- **Per-agent skill switches live in <app data>/factory/agents/.** Only the app writes .skills-off. docs/rules/bridge.md
- **Skills are added per role, not per agent.** docs/rules/bridge.md
- **After changing hub/hub.ts rebuild sidecars.** Run ./scripts/build-sidecars.sh first. docs/rules/core.md
- **Never mutate knownAgents, agentQueues, agentConnections or staleTimers directly.** Use agents.ensure/remove. docs/rules/core.md
- **Hub endpoints require auth.** Bearer token on mutating routes. docs/rules/core.md
- **Upload allowlist is by extension only.** No MIME check. docs/rules/core.md
- **Attachments persist at CUBILOT_ATTACHMENTS_DIR/<id>.<ext>.** docs/rules/core.md
- **JSON bodies capped at 256 KiB.** docs/rules/core.md
- **One event plus one table update per state change.** Same transaction; never bypass. docs/rules/kinds.md
- **Only three cross-kind transactions.** Add no fourth without updating docs/PROTOCOL.md. docs/rules/kinds.md
- **Broadcasts carry version = events.seq.** docs/rules/kinds.md
- **by/from are self-asserted.** Not cryptographically verified. docs/rules/permissions.md
- **Terminal-state retries.** Same-status retry returns 200 (idempotent); different-status retry returns 409. docs/rules/kinds.md
- **/interrupts: pending to acknowledged only.** docs/rules/kinds.md
- **Briefings re-send on roster or presence change, not once per process.** docs/rules/bridge.md
- **Raw PTY only.** Never tmux -C; no send-keys for interactive input (only for one-shot commands the user starts). docs/rules/terminal.md
- **pty.rs plumbing helper changes need an integration test.** docs/rules/terminal.md
- **tmux needs UTF-8 locale env.** LANG and LC_ALL on new-session and attach. docs/rules/terminal.md
- **tmux uses tmux.sock; new-session -d -x 80 -y 24.** Wrap in $SHELL -ic as ONE argv element. docs/rules/terminal.md
- **tmux sessions survive Cubilot restart.** Never kill on exit; remain-on-exit off. docs/rules/terminal.md
- **Chatbridge is a Claude mod, not MCP.** Never write project .mcp.json. docs/rules/bridge.md
- **Mod is staged, never loaded from the .app.** Pass staged path to --plugin-dir. docs/rules/bridge.md
- **Bridge core owns policy; adapters implement Host only.** Policy goes in core.ts. docs/rules/bridge.md
- **Mod tool hook must ask $.tool.check.** docs/rules/bridge.md
- **Pre/PostToolUse hooks do not run for chatbridge tools.** docs/rules/bridge.md
- **Keep --allowed-tools on the claude command in pty.rs.** docs/rules/bridge.md
- **In the mod, pass $ only to top-level function declarations.** docs/rules/bridge.md
- **After changing `hub/channel/**`.** Rerun build-sidecars.sh AND check-mod.sh. docs/rules/bridge.md
- **Claude Code 2.1.296 is the minimum.** Never force tengu_plugin_hooks_modules. docs/rules/bridge.md
- **Verified on Claude Code 2.1.296 and pi 0.87.1.** Rerun spike evidence on change. `usage.cache_read_input_tokens` checked on 2.1.311. docs/rules/bridge.md
- **Claude hooks pass via --settings <path>.** Never write ~/.claude/settings.json. docs/rules/bridge.md
- **pty_capture_turn is the single TUI capture primitive.** docs/rules/terminal.md
- **Dev rebuilds only via ./scripts/install.sh.** Never pkill + cp. docs/rules/core.md
- **Human is a permanent roster member.** docs/rules/core.md
- **Never skip the ad-hoc re-sign in build-sidecars.sh.** docs/rules/core.md
- **macOS ARM64 only.** No speculative platforms. docs/rules/core.md
- **Roster never persists; transcript only if persist_transcript.** docs/rules/transcripts.md
- **Lazy hydration on first agent reconnect.** Trigger: connection, not startup. docs/rules/transcripts.md
- **Summariser prompt lives only in room-summariser.ts.** Adapters never build prompts; count "- " bullets only. docs/rules/summariser.md
- **Room summary scope is the active JSONL chunk only.** docs/rules/summariser.md
- **<private>...</private> stripped at persistence, never at delivery.** Only on-disk sinks call redactPrivate. docs/rules/transcripts.md
- **Permission relay is a hub-first wait in the PermissionRequest hook.** Bound every hook request. docs/rules/permissions.md
- **Permissions have no TTL.** docs/rules/permissions.md
- **State-machine kinds live in hub/kinds/<kind>.ts (KindModule).** Never add kind branches to hub.ts. docs/rules/kinds.md
- **Broadcast with cap.sse.emit(entry, scope).** Never enumerate agent queues in a kind. docs/rules/kinds.md
- **Tickets need acceptance criteria.** Agent moves a ticket to done only with its Validator PASSes; no human Allow step. docs/rules/kinds.md
- **A draft ticket starts nothing.** An open blocker stops a claim. docs/rules/kinds.md
- **Hub decides launches; Rust shell only executes.** docs/rules/kinds.md
- **Stage state changes only via createStageApi.** docs/rules/kinds.md
- **system is the hub's own actor, never a caller's.** Hub returns 400 if a body names it. docs/rules/kinds.md
- **Validator and Reviewer worktrees are read-only.** Hub refuses a writable one. docs/rules/kinds.md
- **CUBILOT_STAGE_ID marks a hub-launched session.** Never set it by hand. docs/rules/kinds.md
- **The hub builds the context pack with no model.** Stable block: no per-stage field. Metrics failure never changes a stage. docs/rules/kinds.md
- **Nutshell is a document, not a kind.** Lives in hub/nutshell.ts. docs/rules/kinds.md
- **Rooms are immutable per agent.** Never add a route that changes it. docs/rules/kinds.md
- **Cross-room mutations are 403 for non-human senders.** Bulk interrupt is human-only. docs/rules/kinds.md
- **Human target "all" needs a room body field.** Else 400. docs/rules/kinds.md
- **Nutshell is per-room.** docs/rules/kinds.md
- **Bridge core enforces the room gate.** docs/rules/bridge.md
- **Slash commands bypass the hub.** Review BUILTIN/DESTRUCTIVE_SLASH_COMMANDS per release. docs/rules/terminal.md

## Accepted risks (known, not bugs)

- **blast_radius high is advisory.** docs/rules/permissions.md
- **Launch stream has no per-role token.** docs/rules/permissions.md
- **devtools is on in release builds.** docs/rules/core.md
- **post_file follows symlinks.** docs/rules/bridge.md
- **Persisted transcripts may capture secrets.** Opt-in only. docs/rules/transcripts.md
- **Rotated transcript chunks never auto-delete.** Use clear-transcript. docs/rules/transcripts.md

### Key invariants

- **Queues are drop-oldest.** docs/rules/core.md
- **SSE heartbeat 15s plus idleTimeout: 0.** docs/rules/core.md
- **Dedup by server id and session id.** docs/rules/core.md
- **Reserved names: you, all, system.** Max 64 chars. docs/rules/core.md
- **Stale agents removed 15s after last SSE drop.** docs/rules/core.md

## Editing notes

- **Adding a Tauri command.** #[tauri::command] in lib.rs plus generate_handler![]. docs/rules/core.md
- **Icons are generated.** Never hand-edit. docs/rules/core.md

Architecture, data flow, paths: docs/rules/core.md. Caveats: docs/rules/bridge.md. Index: docs/rules/README.md.

## Commands

Install deps:
```
bun install
```

Run the hub standalone (for iterating on hub.ts without rebuilding the app):
```
PORT=8011 bun run hub/hub.ts       # or any free port
```
The `.app` picks a free port at runtime — only set `PORT` when running `hub.ts` directly for dev.

Build + install the full macOS app to `/Applications/Cubilot.app`:
```
./scripts/install.sh
```

Rebuild sidecars only (no Tauri rebuild):
```
./scripts/build-sidecars.sh
```

Validate, type-check and test the Claude mod (after any `hub/channel/**` change):
```
./scripts/check-mod.sh [path/to/claude-code/index.d.ts]
```

Rebuild Tauri shell only (assumes sidecars exist):
```
bun x tauri build
```

Quick test the hub (against the running `.app`):
```
HUB=$(cat ~/Library/Application\ Support/Cubilot/hub.url)
TOK=$(cat ~/Library/Application\ Support/Cubilot/hub.token)
curl -s "$HUB/agents?token=$TOK"                                 # roster (human only)
curl -sN --max-time 1 "$HUB/agent-stream?agent=foo&token=$TOK"   # auto-registers "foo"
curl -s "$HUB/agents?token=$TOK"                                 # includes "foo"
```

Full test run: `./scripts/test.sh [bun test args]` is the default. It takes the heavy lock itself, runs `bun test "$@"`, and stops the run and its process group at a time or memory limit. Settings: `CUBILOT_TEST_TIMEOUT_S` (default 520 s), `CUBILOT_TEST_MAX_RSS_MB` (default 2048 MB), `CUBILOT_HEAVY_LOCK` (default `/tmp/cubilot-heavy.lock`). Memory check: RSS sum of the process group, once per second; not a strict ceiling.

Tests: `bun test` (discovery scoped to `tests/` by `bunfig.toml`), `cargo test --manifest-path src-tauri/Cargo.toml`, and `./scripts/check-mod.sh` for the Claude mod's own `claude plugin test` suite. Type check: `bun x tsc --noEmit`. No linter.

Single test: `bun test tests/unit/briefing-signature.test.ts` or `bun test -t "<name pattern>"`; Rust: `cargo test --manifest-path src-tauri/Cargo.toml <name>`. Integration tests boot a real hub per test via `tests/helpers/hub.ts` (port 0, temp ledger, no mocks) — they don't need the `.app`. `pty-plumbing.test.ts` needs tmux on PATH. `check-mod.sh` needs the Claude Code declarations a live session writes into the staged mod (or pass the `index.d.ts` path).
