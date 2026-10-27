# Rules: terminal

tmux, PTY, harness spawn, slash commands and TUI capture rules.

## Agent harness is chosen per agent at spawn and is immutable for the session

- **Agent harness is chosen per agent at spawn and is immutable for the session.** `claude` (default) or `pi` (pi.dev), picked in the spawn modal, threaded `ptySpawn` → `pty_spawn` → `agent_command()` in `pty.rs` (the `Harness` enum). Unknown values are rejected, never defaulted — a UI typo must surface, not silently launch the wrong binary. Changing an agent's harness means killing and respawning, same as room. Both harnesses speak the same hub protocol, so mixed-harness rooms work and nothing hub-side is harness-aware.

## Terminal pane uses a raw PTY, not `tmux -C` control mode

- **Terminal pane uses a raw PTY, not `tmux -C` control mode.** xterm.js consumes tmux's ANSI directly; keystrokes go to the PTY master as raw bytes. Never re-introduce `tmux -C` or `send-keys` for interactive input forwarding — that's what v0.6 broke on. `send-keys` is only allowed for one-shot commands the user invoked explicitly (none in v0.7). The v0.9.8 regression guard at `tests/integration/pty-plumbing.test.ts` asserts raw-PTY mode (no `%output` / `%begin` / `%end` control-mode framing on the attach stream).

## Any change to `pty.rs`'s `resolve_utf8_locale`, `configure_existing_session`, or `attach_and_stream` helpers SHALL have an integration test scenario covering the affected plumbing before the change ships

- **Any change to `pty.rs`'s `resolve_utf8_locale`, `configure_existing_session`, or `attach_and_stream` helpers SHALL have an integration test scenario covering the affected plumbing before the change ships.** The baseline is `tests/integration/pty-plumbing.test.ts` (7 scenarios across session lifecycle, locale env, remain-on-exit toggle, raw-PTY mode). Per-helper coverage closed the pre-v0.9.5 deferral cycle — without it, pty.rs refactors keep getting pushed to "some future change with tests first". Don't repeat that.

## tmux sessions need UTF-8 locale env

- **tmux sessions need UTF-8 locale env.** Pass `LANG` and `LC_ALL` to both `new-session -e` and `builder.env()` on the attach client. macOS GUI apps inherit a blank / `C` locale from launchd; without UTF-8 in the locale, claude's capability probe downgrades to ASCII output and its logo renders as `____` instead of Braille/box-drawing. Use the user's `LANG` if it already contains `utf`; otherwise default to `en_US.UTF-8` (ships with every macOS install).

## Terminal sessions use tmux on `~/Library/Application Support/Cubilot/tmux.sock`

- **Terminal sessions use tmux on `~/Library/Application Support/Cubilot/tmux.sock`.** `new-session -d -x 80 -y 24` (dimensions are load-bearing — tmux probes the invoking TTY otherwise, and our Rust shell has no controlling terminal). Wrap every session command in `$SHELL -ic "..."` so `.zshrc` aliases resolve (Anthropic's installer creates `claude` as a `.zshrc` alias, not a PATH binary). The inner command must be passed as a SINGLE tmux argv element so /bin/sh's argv-join doesn't split the quoted `--mcp-config '/path with spaces'` into multiple tokens.

## tmux sessions survive Cubilot restart

- **tmux sessions survive Cubilot restart.** The Rust shell MUST NOT kill tmux sessions on app exit. Drop the PTY handles (which detaches our `attach-session` client) and let tmux keep running. The pane auto-attaches on next launch via `pty_list()` + `pty_spawn` idempotent re-attach. Also: on every auto-attach, force `remain-on-exit off` on the session — legacy sessions from earlier builds had it ON, which silently holds panes after claude exits and blocks the clean tab-close flow.

## `pty_capture_turn(agent, input, timeout_ms)` is the single primitive for deterministic single-turn TUI capture

- **`pty_capture_turn(agent, input, timeout_ms)` is the single primitive for deterministic single-turn TUI capture.** Three layers coordinated atomically: geometry (`tmux set-option window-size manual` + `resize-window 240×100`), capture (`tmux pipe-pane -o`), completion (Stop-hook sentinel poll). All cleanup happens regardless of success/failure (pipe-pane disable, window-size restore). Output lands at `/tmp/cubilot/<agent>/captures/turn-<epoch>.log` (success) or `turn-<epoch>.partial.log` (timeout/error — retained for forensics). 10 most recent successful captures retained per agent; older success files pruned, partials never auto-pruned. Caller reads via `pty_read_capture(log_path)` (size-capped, /tmp/cubilot/ path-prefix-guarded).

## Chat slash commands bypass the hub

- **Chat slash commands bypass the hub.** A `/`-prefixed message in the composer routes through `pty_write` (Tauri IPC) to the per-agent tmux PTY — NOT through `POST /post`. Bytes go direct to the agent's terminal. The chat log gets one synthetic `system` audit entry per send (in-memory; lost on hub restart). Slash sends require a concrete room (not `All rooms`) and explicit `@agent`/`@all` targeting. The two constants `BUILTIN_SLASH_COMMANDS` and `DESTRUCTIVE_SLASH_COMMANDS` live in `ui/features/slash-discovery.js` — review on each Claude Code release because built-ins drift between versions and the destructive list gates the multi-agent confirm modal.
