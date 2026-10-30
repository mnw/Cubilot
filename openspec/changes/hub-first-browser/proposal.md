## Why

The human must reach the factory from other devices, and the factory must later run on a Linux server without a screen. Today the UI gets settings and every terminal from the Tauri shell, so only the desktop window works. Also, the human and the agents use the same token, and a human action is known only by `by` equal to `human_name`: an agent that sends `by: <human_name>` acts as the human. Source: `factory/brief/12-hub-first-linux.md` (decisions of the human of 2026-10-27, 2026-10-28 and 2026-10-29), steps 1 to 4 of "Order of work".

Depends: nothing that is not on staging. The Linux checklist (step 5) is a second change.

## What Changes

**Step 1: tmux control mode test (open question 1)**
- A test compares two terminal streams on the same tmux session: tmux control mode (`tmux -C`, `%output`) and a raw PTY that the hub opens with `Bun.Terminal` on `tmux attach`. It records colours, cursor moves, alternate screen, UTF-8, resize and input for Claude Code and Pi. The result picks the transport of step 3. The hard rule "Raw PTY only" stays unless the human changes it.

**Step 2: settings commands into the hub**
- New hub routes replace the Tauri commands `get_ui_settings`, `get_human_name`, `get_app_version`, `get_mcp_template`, `resolve_default_room`, `list_roles`, `pty_roles`, `pty_harness`, `list_models`, `slash_discover_for_agent`, `agent_skills`, `agent_skills_set` and `agent_skills_apply`. The UI calls the hub. The commands are removed from `generate_handler!`.
- `reload_settings` stays in the shell (it restarts the hub). The native commands (`open_in_editor`, `open_config_file`, `open_skills_folder`, `open_global_mcp_config`, the file dialog) stay in the shell; in a browser the UI shows the path from the hub.

**Step 3: terminal stream**
- The hub owns the tmux sessions: create, list, kill, shell tab, geometry heal, turn capture and tap read. The hub executes its own launch queue (launch, close, input). **BREAKING**: `src-tauri/src/pty.rs`, `src-tauri/src/launches.rs` and the `pty_*` Tauri commands are removed; the shell no longer reads `/launches/stream`.
- A WebSocket `/terminal/<agent>` carries the bytes to the xterm in the page. A viewer is read-only by default. "Take control" gives one viewer the input and the size; "Hand back" ends it. While the human has control, the hub holds new entries for that agent and delivers them at Hand back; the roster shows "held: N".

**Step 4: browser access, sign-in and pairing**
- Human and agent are different callers. The agent token stays in `hub.token`. The desktop window gets a separate human token that is never written to disk. The hub refuses a body that names the human from an agent token (403), refuses the human-only routes to an agent token (403), and refuses the UI, `/stream` and `/terminal/*` to an agent token. **BREAKING**: an agent `curl` with `by: <human_name>` now gets 403.
- The hub serves `ui/`. The desktop window loads the page from the hub, as a browser does. A setting `browser_access: off | local | network | internet`, default `off`. The hub listens on `127.0.0.1` in every mode. It checks `Host` and `Origin` on every route and on the WebSocket, drops `Access-Control-Allow-Origin: *`, and sends strict security headers. `internet` needs a host name and HTTPS.
- Sign-in for every browser caller: a one-time setup code (15 minutes), a passkey (WebAuthn), a fallback of password (argon2id) plus TOTP, ten recovery codes, no password-only sign-in. Server-side sessions with a cookie (HttpOnly, SameSite=Strict, `__Host-` prefix on HTTPS), idle 12 hours, absolute 7 days, a new id at each sign-in and step-up, a CSRF token on each change. Lock after five failures in 15 minutes for the account and the IP address. A sign-in log.
- Step-up (passkey or TOTP, older than 10 minutes) on Take control, the Shell tab, Settings changes, account and security changes, Kill session and Remove agent.
- Pairing: a signed-in session or the desktop window makes a one-time pairing code (QR); a phone exchanges it for a device session that the human can see and remove. Typing into a terminal from a browser session is off by default.

## Capabilities

### New Capabilities
- `terminal-transport-test`: the step 1 comparison and its recorded result.
- `hub-settings`: the settings routes and the UI path for native-only actions.
- `hub-terminal`: tmux sessions in the hub, the launch queue executed by the hub, the terminal WebSocket, Take control and the hold queue, turn capture.
- `caller-identity`: human and agent are different callers.
- `browser-access`: the mode switch, the hub serves the UI, Host, Origin, CORS and header checks.
- `human-sign-in`: setup, passkey, password and TOTP, recovery codes, sessions, CSRF, lock, sign-in log, step-up, pairing and devices.

### Modified Capabilities
- `hub-discovery`: `get_hub_url` returns the human token, not the token of `hub.token`; the window loads the page from the hub.
- `hub-request-safety`: the agent and the human tokens are different; read routes in the browser use the session cookie.
- `terminal-projection`: the pane renders the hub's terminal stream; the PTY plumbing tests cover the hub's code.

## Not in this change

- Step 5, the Linux checklist (data folder, platform paths, Linux builds, systemd unit, Doctor). A second change.
- The screens of Part 14 (T07, T09, T12): Settings, Security, the designed sign-in states, the pairing QR screen, the phone key strip. This change has a plain sign-in page and the routes those screens need.
- More than one human account (open question 4), web push (open question 3), a mobile layout (open question 2).
- Keychain keys (Part 7).

## Impact

- Hub: `hub/hub.ts` (static files, WebSocket, Host and Origin checks), `hub/core/auth.ts`, `hub/core/dispatcher.ts`, `hub/core/types.ts` (`RouteDef.caller`, `RouteDef.stepUp`), `hub/core/agents.ts` (hold), `hub/kinds/stage.ts` (launch queue executor); new `hub/core/tmux.ts`, `hub/core/terminal.ts`, `hub/features/settings.ts`, `hub/features/terminal.ts`, `hub/features/sign-in.ts`, `hub/core/auth-store.ts`, `hub/core/totp.ts`.
- Shell: `src-tauri/src/lib.rs` (human token on hub stdin, window URL, fewer commands), `src-tauri/capabilities/` (remote origin), `tauri.conf.json`; removed `pty.rs`, `launches.rs`, `models.rs`, `skills.rs` command code.
- UI: `ui/core/http.js`, `ui/core/state.js`, `ui/main.js`, `ui/terminal.js`, `ui/terminal/*.js`, `ui/features/{theme,mcp-modal,slash-command,roster,pill-card,orchestrator-lead}.js`; new `ui/sign-in.html`, `ui/sign-in.js`.
- New dependency: `@simplewebauthn/server` (WebAuthn verification). New data file: `<app data>/auth.db` (mode 0600).
- Docs: `CLAUDE.md` hard rules for terminal, launches and tokens; `docs/rules/terminal.md`, `docs/rules/core.md`, `docs/rules/permissions.md`, `docs/rules/bridge.md`; `docs/PROTOCOL.md` (new routes).
