# Part 12: hub-first architecture, browser access and Linux hosting

Status: planned (decision of the human, 2026-10-27). Build it directly after Part 6, before Part 5 and Parts 7 to 11. Reason: the desktop app approach limits the factory; the human must reach it from other devices, and the factory must be able to run on a Linux server.

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

## Accessibility

The browser UI is the UI that other people will use. It must meet WCAG 2.2 AA (Part 14, rule 6a). The accessibility council (Part 9) can audit it once it runs in a browser.

## Security requirements

A hub that can launch shell commands is a target. Other websites in the user's browser can try to send requests to it.

1. Keep listening on `127.0.0.1` (`hub/hub.ts:302`). For `network` mode, let Tailscale forward to the local port. Do not listen on `0.0.0.0`.
2. Require the auth token on every route that reads or changes data, and on the WebSocket. Send the token in a header, not in a cookie, so other sites cannot use it.
3. Check the `Origin` header. The mutating routes already do this (`hub/core/auth.ts:62`). Do the same for the WebSocket and for every route that reads data.
4. Check the `Host` header against the expected names (`127.0.0.1`, `localhost`, the Tailscale name). This blocks DNS rebinding.
5. Check the current CORS header `Access-Control-Allow-Origin: *` (`hub/core/auth.ts:11`). It must not let another site read data from a route that needs no token.
6. Pairing for a new device: the desktop app shows a QR code with a one-time code. The phone exchanges it for a device token. The human can see and remove device tokens.
7. Actions from a remote device that change state (allow an approval, cancel a handoff, send text to a terminal) need the device token. Sending text to a terminal from a remote device is off by default.

## Internet access and sign-in (decision of the human, 2026-10-28)

The human will reach Cubilot over the internet, not only through a private network. This changes item 1 of the security requirements: the UI can be public, the hub stays private.

### Shape

1. **The hub keeps listening on `127.0.0.1`.** A TLS front forwards to it: Caddy with automatic HTTPS, Cloudflare Tunnel or Tailscale Funnel. A fourth mode `browser_access: internet` sets the expected host name and turns on the rules below. The hub refuses `internet` mode without a host name and HTTPS.
2. **Nothing is reachable before sign-in.** The front serves only the sign-in page and its files. Every other route needs a valid session, also the files of the UI.
3. **The human signs in with a passkey (WebAuthn).** Fallback: a password (argon2id) plus a TOTP code. There is no password-only sign-in. Ten one-time recovery codes are made at setup.
4. **First run.** There is no sign-up page. The first account (the owner) is made with a one-time setup code that the hub prints on the server console, or that the desktop app shows. The code expires after 15 minutes.
5. **Session.** A server-side session row and a cookie `__Host-cubilot_session` (HttpOnly, Secure, SameSite=Strict, Path=/). Idle time-out 12 hours, absolute limit 7 days. A new session id at each sign-in and at each step-up. Sign-out and "sign out all other sessions" delete the rows.
6. **Cookie and the other checks together.** Item 2 of the security requirements says header, not cookie. In `internet` mode the browser uses the cookie, and items 3 and 4 (`Origin` and `Host` checks) stay on every route and on the WebSocket. Every request that changes state also needs a CSRF token from the page. Agents keep the header token.
7. **Step-up.** These actions ask for the passkey or a TOTP code again when the last check is older than 10 minutes: "Take control" of a terminal, the Shell tab, Settings changes (config, MCP servers, room settings), account and security changes, Kill session, Remove agent.
8. **Limits.** Five failed sign-ins in 15 minutes lock that account and that IP address for 15 minutes. The page says how long to wait. Every sign-in, failure, lock, step-up and session removal is a row in a sign-in log that the human can read in Settings, Security.
9. **Headers.** HSTS, a strict Content-Security-Policy, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, no `Access-Control-Allow-Origin: *` (item 5).
10. **Pairing (item 6) stays.** A signed-in session shows the QR code. A paired phone gets a device session that the human can remove.

### Human and agent are different callers

Today the human and the agents use the same token. The bridge reads `hub.token` (`hub/channel/hub-client.ts`), and a human action is identified only by `by` equal to `human_name` (`hub/core/auth.ts`, `actorOr400`; `hub/kinds/interrupt.ts:150`). So an agent that sends `by: <human_name>` acts as the human. Fix this before `internet` mode:
1. A human action takes its identity from the session, not from `by`. The hub ignores a `by` that names the human when the caller has an agent token.
2. The routes that only the human may call (Approve, Allow, rulings and overrule, radius raise, room settings, Pause room, launch and remove agents) refuse an agent token with 403.
3. An agent token never opens the UI. A UI session never gets the agent tools.

### Tests

1. Without a session, every route except the sign-in page returns 401, also `/stream` and the UI files.
2. A passkey sign-in makes a session; the cookie has `__Host-`, HttpOnly, Secure and SameSite=Strict.
3. A request with a wrong `Origin` or `Host`, or without the CSRF token, is refused (403).
4. The sixth failed sign-in in 15 minutes is refused with the wait time, and the log has the lock.
5. "Take control" 11 minutes after the last check asks for the passkey again.
6. A request with the agent token and `by: <human_name>` to an Approve route returns 403.
7. "Sign out all other sessions" ends a session on a second browser at its next request.

### Accounts: one human or many (open question 4)

The model has one human (`human_name` in `config.yml`). Sign-in above is for that one human on many devices. More accounts need a decision first; see open question 4.

## Linux checklist

Found in the code on 2026-10-17:

| Area | Where | Fix |
|---|---|---|
| Data folder hard-coded as a macOS path | `hub/channel/hub-client.ts:9` (`DISCOVERY_DIR`), `hub/core/transcript.ts:42`. The Rust side uses `dirs::data_dir()` (`src-tauri/src/lib.rs:242`), which is `~/.local/share` on Linux. The bridge then looks in the wrong folder and does not find the hub. | One source for the data folder. The hub and the bridge read it from the environment variable `CUBILOT_DATA_DIR`. The rebrand added this variable (Part 1). |
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

- Parts 1 to 4 and Part 6 come first, in the current app on macOS.
- Then this part, before Part 5 and Parts 7 to 11 (decision 2026-10-27). So the Doctor (Part 7), the setup screen (Part 8) and the dashboard (Part 11) are built in the hub and served to the browser from the start. Nothing moves later.
- Then Part 14 (UI redesign) (decisions 2026-10-28). The token system and the mockups are done (`design/system/`, `design/mockups/`), and Part 14 builds them on the UI that the hub serves, so the redesign is done once, in the browser.
- First step: the tmux control mode test (open question 1). It decides the terminal design. Second step: move the settings commands. Third step: the terminal stream. Fourth step: browser access, sign-in ("Internet access and sign-in") and pairing. Do not use `internet` mode before the sign-in tests pass. Fifth step: the Linux checklist.
- Start with an OpenSpec change for steps 1 to 4. The Linux checklist can be a second change.

## Open questions

1. Does tmux control mode give a stream that is good enough for the Claude Code and Pi interfaces (colours, cursor moves, resize)?
2. The mobile view: show the board, "Waiting for you" and the chat only, or also the terminals?
3. Notifications to the phone for "Waiting for you" items: web push from the hub, or a different channel?
4. More than one human account? Options: (a) one human, many devices (this part); (b) a small team on one instance: accounts with a role (owner, approver, viewer) and room membership, every human action records the account; (c) separate customers: one instance (server or container) for each customer, not shared tenants in one hub. Each Claude subscription belongs to one person, so each human who runs agents needs their own Claude plan or an API key.

## Mockups (2026-10-28)

Designed in `design/mockups/cubilot-prototype.html`:
- Sign-in (`#sign-in`) and its states (`#sign-in-states`): first run with the setup code, recovery codes, password and code, the lock, the step-up dialog. Settings, Security (`#app-settings`): passkeys, fallback, recovery codes, sessions and devices, pairing, sign-in log, typing into terminals from other devices.
- The terminal over the hub (`#session`): read-only by default; "Take control" (step-up) and "Hand back"; while the human has control, the hub holds new messages and handoffs for that agent and delivers them at Hand back. The phone version adds a key strip (Esc, Ctrl+C, Tab, Shift+Tab, arrows, Enter).

Hub work these screens need, in this part: the hold queue for an agent under human control (hold, release, show "held: N"), the step-up time on the session, and the routes for sessions, devices and the sign-in log. Part 14 builds the screens (T07, T09, T12).

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
