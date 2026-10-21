# Part 12: hub-first architecture, browser access and Linux hosting

Status: idea, saved for later. Not ready to build.

## Idea

Keep the desktop app. Move the logic that the UI gets from the Tauri shell into the hub. Then the UI talks only to the hub, and any browser can open the same UI. For example, the human can answer "Waiting for you" (Part 11) from a phone.

## Goal: one hub for macOS and Linux

The hub must run on macOS and on Linux, also on a Linux server without a screen.
- On a Mac, the desktop app launches the hub and adds the window.
- On a Linux server, a systemd user service launches the hub. The human opens the UI in a browser, through a private network such as Tailscale.

A Linux server has no desktop window, so the terminal layer must be in the hub (this part). This makes Part 12 a requirement for Linux, not an option.

## Why

- The factory runs without a human watching it. The human must see the board and approve tickets from other devices.
- The UI is already a web page. It reaches the hub with HTTP and the event stream. Only a small set of calls goes through the Tauri shell.
- A browser alone cannot launch processes (`claude`, `pi`, tmux, `git worktree`). A browser version still needs a local service with those powers. The hub is that service.

## The current Tauri commands

The shell (`src-tauri/src/lib.rs`, `src-tauri/src/pty.rs`) exposes these commands to the UI:

| Group | Commands | Proposal |
|---|---|---|
| Terminal | `pty_spawn`, `pty_spawn_shell`, `pty_write`, `pty_resize`, `pty_kill`, `pty_list`, `pty_shell_exists`, `pty_heal_geometry`, `pty_harness`, `pty_capture_turn`, `pty_read_capture`, `pty_tap_read` | Move to the hub |
| Settings and config | `get_ui_settings`, `reload_settings`, `get_human_name`, `resolve_default_room`, `get_mcp_template`, `slash_discover_for_agent`, `get_app_version` | Move to the hub |
| Hub discovery | `get_hub_url` | Not needed when the hub serves the UI itself |
| Native only | `open_in_editor`, `open_config_file`, `open_global_mcp_config`, the file dialog (`plugin:dialog`) | Keep in the shell. In a browser, show the path and let the user open it. |
| Keychain | the Anthropic and OpenAI keys (Part 7) | Keep in the shell. The shell gives the keys to the hub when it launches the hub. |

## Design sketch

1. **The hub serves the UI.** The hub serves the `ui/` files over HTTP. The desktop window and a browser load the same page.
2. **Terminal over the hub.** The agents already run in tmux sessions. Two options for the terminal stream:
   - The hub uses tmux control mode (`tmux -C`). Output arrives as `%output` events, and input goes in with `send-keys`. No PTY library is necessary in Bun.
   - The hub opens a PTY with a library. Check first that the library works in Bun.
   The hub sends the bytes to the browser over a WebSocket, and the xterm in the page draws them. Test the first option before you choose.
3. **The desktop app becomes thin.** It launches the hub, opens the window, reads the Keychain, and handles file dialogs and "open in editor".
4. **One mode switch.** A setting `browser_access: off | local | network`, default `off`:
   - `off`: as today.
   - `local`: a browser on the same computer can open the UI.
   - `network`: the UI is reachable from other devices, only through a private network such as Tailscale (`tailscale serve`). The hub never listens on a public address.

## Security requirements

A hub that can launch shell commands is a target. Other websites in the user's browser can try to send requests to it.

1. Keep listening on `127.0.0.1` (`hub/hub.ts:302`). For `network` mode, let Tailscale forward to the local port. Do not listen on `0.0.0.0`.
2. Require the auth token on every route that reads or changes data, and on the WebSocket. Send the token in a header, not in a cookie, so other sites cannot use it.
3. Check the `Origin` header. The mutating routes already do this (`hub/core/auth.ts:62`). Do the same for the WebSocket and for every route that reads data.
4. Check the `Host` header against the expected names (`127.0.0.1`, `localhost`, the Tailscale name). This blocks DNS rebinding.
5. Check the current CORS header `Access-Control-Allow-Origin: *` (`hub/core/auth.ts:11`). It must not let another site read data from a route that needs no token.
6. Pairing for a new device: the desktop app shows a QR code with a one-time code. The phone exchanges it for a device token. The human can see and remove device tokens.
7. Actions from a remote device that change state (allow an approval, cancel a handoff, send text to a terminal) need the device token. Sending text to a terminal from a remote device is off by default.

## Linux checklist

Found in the code on 2026-10-17:

| Area | Where | Fix |
|---|---|---|
| Data folder hard-coded as a macOS path | `hub/channel/hub-client.ts:9` (`DISCOVERY_DIR`), `hub/core/transcript.ts:42`. The Rust side uses `dirs::data_dir()` (`src-tauri/src/lib.rs:242`), which is `~/.local/share` on Linux. The bridge then looks in the wrong folder and does not find the hub. | One source for the data folder. The hub and the bridge read it from an environment variable (for example `A2A_DATA_DIR`). The rebrand adds this variable (Part 1, item 3.1). |
| Other macOS paths | Logs `~/Library/Logs` (`lib.rs:666`). Pi `~/Library/pnpm/bin/pi` (`lib.rs:326`). Claude `/opt/homebrew/bin/claude` (`hub/core/summariser/claude.ts:49`). | Use the standard folders of the platform. Find `claude` and `pi` on `PATH`. |
| Bundled binaries for macOS ARM only | `src-tauri/resources/tmux` is a Mach-O arm64 file. `scripts/build-sidecars.sh:22` uses `--target=bun-darwin-arm64`. | Build the hub for each platform (`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`). On Linux, use tmux from the system package manager. The Doctor (Part 7) checks it. |
| `open` command | `lib.rs:1062`, `lib.rs:1087` | Use `xdg-open` on a Linux desktop. In the browser UI, show the path. |
| Keychain | Planned for the OpenAI and OpenRouter keys (Part 7, Part 13) | Linux desktop: Secret Service (libsecret). Linux server: a file with mode 0600 in the data folder. |
| Packaging | `codesign`, `ditto` and the Homebrew cask are macOS only (`scripts/install.sh`, `scripts/release.sh`, `scripts/bootstrap-tap.sh`) | Linux: a compiled hub binary, the `ui/` files and a systemd user unit, in a tarball or a `.deb`. |
| Terminal layer in the Tauri shell | `src-tauri/src/pty.rs` | Move it into the hub (design step 2 above). |
| Toolchain binaries (Part 7) | rg, fd, uv for macOS | Add the Linux builds. Part 2 finding 8 lists rg and fd checksums for Linux musl x64 and arm64. |

Already works on Linux: Claude Code (it supports sign-in on a server without a browser), Pi, tmux, git worktrees, Graphify, Serena, ripgrep and fd.

Tests for Linux:
1. The hub launches as a systemd user service on a Linux server, and a browser on another device opens the UI through Tailscale.
2. A Claude agent and a Pi agent that the hub launches on Linux find the hub (same data folder for the hub and the bridge).
3. The Doctor on Linux finds a missing tmux and shows the install command.
4. The Linux build has no macOS path in its code (a test searches for `Library/` and `/opt/homebrew`).

## Order of work

- Build the earlier parts first, in the current app on macOS. They do not depend on this part.
- Part 7 (Doctor) and Part 11 (dashboard) come before this part. When you do this part, move their logic into the hub.
- First step: move the settings commands. Second step: the terminal stream (after the tmux control mode test). Third step: browser access and pairing.

## Open questions

1. Does tmux control mode give a stream that is good enough for the Claude Code and Pi interfaces (colours, cursor moves, resize)?
2. The mobile view: show the board, "Waiting for you" and the chat only, or also the terminals?
3. Notifications to the phone for "Waiting for you" items: web push from the hub, or a different channel?

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
