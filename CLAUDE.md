# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Each rule is one line; details are in docs/rules/ (rules/<topic>.md).

## Hard rules

- **Never commit unless asked.** Stage sessions: own ticket branch only; never push. rules/core.md
- **Heavy processes run one at a time.** Lock: /tmp/cubilot-heavy.lock; use ./scripts/test.sh. rules/core.md
- **No framework in ui/index.html.** rules/core.md
- **Hub port is dynamic.** Never hardcode it. rules/core.md
- **Harness is per agent and immutable.** claude or pi at spawn; unknown values rejected. rules/terminal.md
- **Pi gets the chatbridge as an extension.** Rerun build-sidecars.sh after changing pi-extension.ts, tools.ts, hub-client.ts. rules/bridge.md
- **Pi shares Claude skills and commands only.** No MCP, plugins or hooks. rules/bridge.md
- **Per-agent skill switches live in <app data>/factory/agents/.** Only the app writes .skills-off. rules/bridge.md
- **Skills are added per role, not per agent.** rules/bridge.md
- **After changing hub/hub.ts rebuild sidecars.** Run ./scripts/build-sidecars.sh first. rules/core.md
- **Never mutate knownAgents, agentQueues, agentConnections or staleTimers directly.** Use agents.ensure/remove. rules/core.md
- **Hub endpoints require auth.** Bearer token on mutating routes; reads also accept ?token=. rules/core.md
- **Upload allowlist is by extension only.** attachment_extensions in config.yml; no MIME check. rules/core.md
- **Attachments persist at CUBILOT_ATTACHMENTS_DIR/<id>.<ext>.** No cache. rules/core.md
- **JSON bodies capped at 256 KiB.** rules/core.md
- **One event plus one table update per state change.** Same transaction; never bypass. rules/kinds.md
- **Only three cross-kind transactions.** Add no fourth without updating docs/PROTOCOL.md. rules/kinds.md
- **Broadcasts carry version = events.seq.** rules/kinds.md
- **by/from are self-asserted.** Not cryptographically verified. rules/permissions.md
- **Terminal-state retries.** rules/kinds.md
- **/interrupts: pending to acknowledged only.** rules/kinds.md
- **Briefings re-send on roster change.** Context mode only. rules/bridge.md
- **Raw PTY only.** Never tmux -C or send-keys. rules/terminal.md
- **pty.rs plumbing helper changes need an integration test.** Cover resolve_utf8_locale, configure_existing_session, attach_and_stream. rules/terminal.md
- **tmux needs UTF-8 locale env.** LANG and LC_ALL on new-session and attach. rules/terminal.md
- **tmux uses tmux.sock; new-session -d -x 80 -y 24.** Wrap in $SHELL -ic as ONE argv element. rules/terminal.md
- **tmux sessions survive Cubilot restart.** Never kill on exit; remain-on-exit off. rules/terminal.md
- **Chatbridge is a Claude mod, not MCP.** Never write project .mcp.json. rules/bridge.md
- **Mod is staged, never loaded from the .app.** Pass staged path to --plugin-dir. rules/bridge.md
- **Bridge core owns policy; adapters implement Host only.** Policy goes in core.ts. rules/bridge.md
- **Mod tool hook must ask $.tool.check.** rules/bridge.md
- **Pre/PostToolUse hooks do not run for chatbridge tools.** rules/bridge.md
- **Keep --allowed-tools on the claude command in pty.rs.** Not proven redundant. rules/bridge.md
- **In the mod, pass $ only to top-level function declarations.** rules/bridge.md
- **After hub/channel/** changes.** Rerun build-sidecars.sh AND check-mod.sh. rules/bridge.md
- **Claude Code 2.1.296 is the minimum.** Never force tengu_plugin_hooks_modules. rules/bridge.md
- **Verified on Claude Code 2.1.296 and pi 0.87.1.** Rerun spike evidence on change. rules/bridge.md
- **Claude hooks pass via --settings <path>.** Never write ~/.claude/settings.json. rules/bridge.md
- **pty_capture_turn is the single TUI capture primitive.** Output under /tmp/cubilot/<agent>/captures/. rules/terminal.md
- **Dev rebuilds only via ./scripts/install.sh.** Never pkill + cp. rules/core.md
- **Human is a permanent roster member.** rules/core.md
- **Never skip the ad-hoc re-sign in build-sidecars.sh.** Sidecar dies with 137 else. rules/core.md
- **macOS ARM64 only.** No speculative platforms. rules/core.md
- **Roster never persists; transcript only if persist_transcript.** JSONL rotates at 10,000 lines. rules/transcripts.md
- **Lazy hydration on first agent reconnect.** Adapters never build prompts. rules/transcripts.md
- **Summariser prompt lives only in room-summariser.ts.** Adapters never build prompts; count "- " bullets only. rules/summariser.md
- **Room summary scope is the active JSONL chunk only.** rules/summariser.md
- **<private>...</private> stripped at persistence, never at delivery.** Every request bounded. rules/transcripts.md
- **Permission relay is a hub-first wait in the PermissionRequest hook.** No kind branches in hub.ts. rules/permissions.md
- **Permissions have no TTL.** rules/permissions.md
- **State-machine kinds live in hub/kinds/<kind>.ts (KindModule).** Never add kind branches to hub.ts. rules/kinds.md
- **Broadcast with cap.sse.emit(entry, scope).** Never enumerate agent queues in a kind. rules/kinds.md
- **Tickets need acceptance criteria.** An agent moves a high blast_radius ticket to done only after the human's Allow. rules/kinds.md
- **A draft ticket starts nothing.** An open blocker stops a claim. rules/kinds.md
- **Hub decides launches; Rust shell only executes.** Hub refuses a writable one. rules/kinds.md
- **Stage state changes only via createStageApi.** No endpoint takes a stage-create command. rules/kinds.md
- **system is the hub's own actor, never a caller's.** Hub returns 400 when a body names system. rules/kinds.md
- **Validator and Reviewer worktrees are read-only.** Detached; hub refuses a writable one. rules/kinds.md
- **CUBILOT_STAGE_ID marks a hub-launched session.** Bulk interrupt human-only. rules/kinds.md
- **Nutshell is a document, not a kind.** Lives in hub/nutshell.ts. rules/kinds.md
- **Rooms are immutable per agent.** Never add a route that changes an agent's room. rules/kinds.md
- **Cross-room mutations are 403 for non-human senders.** Review BUILTIN/DESTRUCTIVE_SLASH_COMMANDS each release. rules/kinds.md
- **Human target "all" needs a room body field.** Else 400. rules/kinds.md
- **Nutshell is per-room.** rules/kinds.md
- **Bridge core enforces the room gate.** rules/bridge.md
- **Slash commands bypass the hub.** rules/terminal.md

## Accepted risks (known, not bugs)

- **blast_radius high is advisory.** Advisory against a token holder. rules/permissions.md
- **Launch stream has no per-role token.** rules/permissions.md
- **devtools is on in release builds.** Accepted. rules/core.md
- **post_file follows symlinks.** rules/bridge.md
- **Persisted transcripts may capture secrets.** Opt-in only. rules/transcripts.md
- **Rotated transcript chunks never auto-delete.** Use clear-transcript. rules/transcripts.md

## Key invariants

- **Queues are drop-oldest.** rules/core.md
- **SSE heartbeat 15s plus idleTimeout: 0.** rules/core.md
- **Dedup by server id and session id.** rules/core.md
- **Reserved names: you, all, system.** Validator enforces [A-Za-z0-9_.-], max 64. rules/core.md
- **Stale agents removed 15s after last SSE drop.** rules/core.md

## Editing notes

- **Adding a Tauri command.** #[tauri::command] in lib.rs plus generate_handler![]. rules/core.md
- **Icons are generated.** Do not hand-edit generated icon files. rules/core.md

Architecture, data flow, resource paths: rules/core.md. Research-preview caveat: rules/bridge.md. Index: rules/README.md.

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

Full test run: `./scripts/test.sh [bun test args]` is the default. It takes the heavy lock itself. It runs `bun test "$@"`, so arguments pass through. It applies a time limit and a memory limit. When either is reached, it stops the run and its process group. Settings: `CUBILOT_TEST_TIMEOUT_S` (default 300 s), `CUBILOT_TEST_MAX_RSS_MB` (default 2048 MB) and `CUBILOT_HEAVY_LOCK` (default `/tmp/cubilot-heavy.lock`). The memory check sums the RSS of the test process group once per second. It is not a strict ceiling. A process that leaves the group is not counted.

Tests: `bun test` (discovery scoped to `tests/` by `bunfig.toml`), `cargo test --manifest-path src-tauri/Cargo.toml`, and `./scripts/check-mod.sh` for the Claude mod's own `claude plugin test` suite. Type check: `bun x tsc --noEmit`. No linter.

Single test: `bun test tests/unit/briefing-signature.test.ts` or `bun test -t "<name pattern>"`; Rust: `cargo test --manifest-path src-tauri/Cargo.toml <name>`. Integration tests boot a real hub per test via `tests/helpers/hub.ts` (`bun run hub/hub.ts` on port 0, temp ledger/attachments dir, no mocks) — they don't need the `.app`. `pty-plumbing.test.ts` needs tmux on PATH (`tests/helpers/tmux.ts`). `check-mod.sh` needs the Claude Code declarations a live session writes into the staged mod (or pass the `index.d.ts` path).
