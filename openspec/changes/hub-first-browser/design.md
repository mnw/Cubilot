## Context

Part 12 steps 1 to 4 (`factory/brief/12-hub-first-linux.md`). Code today:
- `hub/hub.ts:342`: `Bun.serve` on `127.0.0.1`, dynamic port. No static files, no WebSocket. `/stream` and `/agent-stream` use `requireReadAuth` (header or `?token=`).
- `hub/core/auth.ts`: one token (`CUBILOT_TOKEN`, also in `<app data>/hub.token`). `requireAuth` checks `Origin` against `tauri://localhost` and `http://tauri.localhost` on mutating routes only. `corsHeaders` sends `Access-Control-Allow-Origin: *` on every response. `actorOr400` trusts `by`.
- `hub/core/dispatcher.ts`: one table of `RouteDef` with `auth: "mutating" | "read"`. `namesSystemActor` refuses a body that names `system` on every route; it is the model for the human guard.
- Human checks: `isHuman(actor) = actor === cap.config.humanName` (`hub/kinds/ticket.ts:246` and the other Kinds).
- `src-tauri/src/lib.rs:1414`: 30 commands. The UI calls them through `tauriInvoke` (`ui/core/state.js:131`). The brief's table is older than `list_roles`, `list_models`, `agent_skills*`, `pty_roles`, `open_skills_folder`; this change covers them.
- `src-tauri/src/pty.rs` (4059 lines): tmux on `tmux.sock`, raw PTY attach, output as Tauri events `ptyEventName('output', agent)`, turn capture, tap read. `src-tauri/src/launches.rs`: reads `/launches/stream`, runs `launch`, `close`, `input`, acks each.
- `hub/core/agents.ts`: `forDelivery` applies pause per entry at queue and at delivery.
- Bun 1.3.13 has `Bun.Terminal` (PTY). Bundled tmux is 3.5a (`attach -f read-only,ignore-size` exists).

## Goals / Non-Goals

**Goals:** the UI talks only to the hub; any browser opens the same page after sign-in; the hub owns the terminals; an agent cannot act as the human.

**Non-Goals:** Linux (step 5). Part 14 screens. More than one human account. Web push.

## Decisions

### 1. Step 1 decides the transport by one shared test
`tests/spike/terminal-transport.test.ts` runs the same cases against both transports on a hermetic tmux socket: SGR 256 and truecolor, cursor addressing, alternate screen enter and exit, a 4-byte UTF-8 glyph, resize 80×24 to 120×40 (the program sees the new size), input of arrows, Esc, Ctrl+C, Shift+Tab, bracketed paste. A fake TUI script (`tests/fixtures/fake-tui.ts`) prints the cases, so the test needs no Claude login. A manual run with real `claude` and `pi` records the same items in `docs/spikes/terminal-transport.md` with the bytes per second at a full redraw.
- Control mode: output from `%output` (octal escapes decoded); input by `send-keys -H` (hex).
- Raw PTY: `Bun.Terminal` on `tmux -S tmux.sock attach -t =<agent>`, bytes as is.
- Pick rule: raw PTY wins if it passes every case, because it keeps the hard rule "Raw PTY only" and the xterm already reads tmux's ANSI. Control mode is used only if raw PTY fails a case that control mode passes; then the result goes to the human first (it breaks a hard rule). Groups 5 to 10 assume raw PTY.

### 2. Settings routes, one module
`hub/features/settings.ts` holds the read routes; skills and models keep their own modules ported from Rust. Each route reads `config.yml` through `hub/core/config-file.ts` at each call, so a theme or font change needs no reload. The hub learns the app version from the env `CUBILOT_APP_VERSION` (the shell sets it). `reload_settings` stays in the shell: the hub cannot restart itself with a new port. In a browser, Reload shows "restart the hub" and the command.

Native actions stay in the shell. `GET /settings/paths` gives the config file, the skills folder, the MCP config and an agent's working folder; in a browser the UI shows the path with a Copy button.

### 3. The hub owns the terminal (raw PTY)
- `hub/core/tmux.ts`: the session primitives of `pty.rs`, unchanged in behaviour: `tmux -S <app data>/tmux.sock`, `new-session -d -x 80 -y 24`, the command wrapped as ONE `$SHELL -ic` argv element, `LANG`/`LC_ALL` from the locale rule on `new-session` and `attach`, `remain-on-exit off`, never killed on hub exit. The tmux path comes from env `CUBILOT_TMUX` (the shell passes the bundled one).
- `hub/core/terminal.ts`: for each open viewer, one `Bun.Terminal` running `tmux attach -t =<agent>`. A read-only viewer attaches with `-f read-only,ignore-size`, so a phone does not resize the agent. The controller attaches without flags and sets the size.
- The launch queue (`hub/kinds/stage.ts`) runs `launch`, `close` and `input` itself through `tmux.ts`, then writes the same ack records it writes today. The command line for Claude and Pi moves from `pty.rs` with its rules: `--plugin-dir <staged mod>`, `--allowed-tools`, `--settings <path>`, `CUBILOT_STAGE_ID` only for a stage. The shell still stages the mod and the factory and passes the staged paths in env (`CUBILOT_MOD_DIR`, `CUBILOT_PI_EXTENSION`, `CUBILOT_CLAUDE_BIN`, `CUBILOT_PI_BIN`). The hard rule "Hub decides launches; Rust shell only executes" becomes "the hub decides and executes launches".
- `pty_capture_turn` moves as `captureTurn` in `tmux.ts`; it stays the single TUI capture primitive.

### 4. Terminal WebSocket and Take control
`GET /terminal/<agent>` upgrades to a WebSocket (Bun's `websocket` handler in `Bun.serve`). Binary frames carry output; text frames carry JSON control (`{"t":"take"}`, `{"t":"hand_back"}`, `{"t":"resize","cols","rows"}`) and input (`{"t":"in","d":"<base64>"}`). Input or resize from a viewer without control is dropped and answered with `{"t":"error","e":"read-only"}`.
- `POST /terminal/<agent>/input {text}` (human caller) keeps the composer's slash mode (`slash-command.js`); it writes once, like `pty_write` today.
- One controller per agent. A second Take control moves control; the first viewer gets `{"t":"control","by":"other"}` and is read-only.
- Hold: `agents.setHeld(name, held)`. While held, `forDelivery` puts each entry for that agent in a hold list instead of its queue (drop-oldest at the queue cap). Hand back, the controller's socket close, or the agent's removal releases the list in order. `held` count is in `/agents` and `/presence`.
- `ponytail:` the hold list is in memory. A hub restart under control drops held plain chat; handoffs, tickets and interrupts are in the ledger and replay at reconnect. A persisted hold list waits for a real loss.

### 5. Human and agent are different callers
- Tokens: `CUBILOT_TOKEN` and `hub.token` stay the agent token, so the bridge and the mod do not change. The shell mints a second token, the human token, and writes it as the first line of the hub's stdin (`CommandChild.write`), not in env or a file, because agents run as the same OS user and can read env (`ps -E`) and files. `get_hub_url` returns `{url, token: <human token>}`.
- Each request gets a caller: `human` (human token or a valid session), `agent` (agent token) or none (401). `requireAuth` and `requireReadAuth` return the caller; the dispatcher passes it in `cap.caller`.
- Guard in the dispatcher, next to `namesSystemActor`: an `agent` caller with a JSON body whose actor field (`ACTOR_FIELDS`) is `human_name` gets 403 `"the human acts only from the UI"`. For a `human` caller, `actorOr400` returns `human_name` for `by` and `from` whatever they say; target fields (`agent` on `/remove`, pause) keep their value. One guard covers every existing `isHuman(actor)` check.
- `RouteDef.caller?: "human"`: the dispatcher answers 403 to an `agent` caller. Set on: the request Approve, permission verdicts and dismiss, decision answer, checkpoint create, radius lower (already covered by the guard), room settings, `POST /agents/<name>/pause`, `/remove`, bulk interrupt, `/launches/*`, the session create and kill routes of group 8, all settings writes, and every sign-in and pairing route. The arbiter rulings and overrule get the flag when that change lands (`openspec/changes/arbiter`).
- `/stream`, `/terminal/*` and the UI files refuse an `agent` caller (403). `/agent-stream` refuses a `human` caller (403): a UI session never gets the agent tools.
- Accepted risk: an agent with an unrestricted shell is the human's OS user. The guard stops a forged `by` over HTTP, not a hostile local process.

### 6. Browser access
- The hub serves `ui/` at `/` (`Bun.file`, `index.html` for `/`, no directory listing, no `..`). The release hub reads `ui/` from env `CUBILOT_UI_DIR` (the shell passes `Contents/Resources/ui`).
- The desktop window loads `http://127.0.0.1:<port>/` from the hub. A Tauri capability with `remote.urls: ["http://127.0.0.1:*"]` keeps the native commands. After `reload_settings` the shell navigates the window to the new URL. Same origin, so CORS is not needed for the window.
- `browser_access` in `config.yml`: `off` (only the desktop window's human token and agents), `local` (sessions from `http://localhost:<port>` and `http://127.0.0.1:<port>`), `network` (adds `https://<browser_access_host>`, for `tailscale serve`), `internet` (same host list, for Caddy, Cloudflare Tunnel or Tailscale Funnel). The hub refuses `network` and `internet` without `browser_access_host` and `browser_access_https: true`, runs as `off` and logs why. Listening is `127.0.0.1` in all modes.
- Host check on every request and the WebSocket: `127.0.0.1:<port>`, `localhost:<port>`, and `browser_access_host` when the mode is `network` or `internet`. Else 403.
- Origin check on every request and the WebSocket when `Origin` is present: the same names with their scheme; `tauri://localhost` and `http://tauri.localhost` are dropped after the window loads from the hub. No `Origin` (curl, the bridge) passes.
- Headers on every response: `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`; `Strict-Transport-Security: max-age=31536000` in `internet` mode. No `Access-Control-Allow-Origin`. Inline scripts and styles in `ui/index.html` move to files where the CSP needs it.

### 7. Sign-in store is not a Kind
Accounts, credentials, sessions, devices and the sign-in log live in `<app data>/auth.db` (SQLite, mode 0600, own migrations in `hub/core/auth-store.ts`). Not a Kind and not the ledger: this state must never be broadcast, replayed to an agent, or copied into ledger backups and retro evidence. Session ids and pairing codes are stored as SHA-256 hashes, so a copy of the file opens no session. The sign-in log is append-only rows with time, event, IP and user agent.

### 8. Sign-in
- One account (the `human_name`). First run: when no account exists and `browser_access` is not `off`, the hub prints a setup code (128 bits, base32) on stdout and keeps its hash for 15 minutes; `GET /settings/setup-code` gives it to the desktop window (human caller). `POST /auth/setup` with the code makes the account and returns ten recovery codes (argon2id hashes, each once).
- Passkey: `@simplewebauthn/server` (`rpID` = the request host name, origin from the host list). Registration needs a signed-in session, the setup code, or a recovery link from the desktop window. Recovery: `auth.db` is not in the ledger backup, so after a restore the desktop window (human token, no sign-in) lists and removes passkeys and makes a passkey registration link (`POST /auth/passkey/recovery-link`, human token only, 15 minutes, once, hash stored). The window does not register the passkey itself: a passkey is bound to its `rpID`, and one registered at `127.0.0.1` does not sign in at `browser_access_host`; WebAuthn in the WKWebView also needs an entitlement the app does not have. When `auth.db` is gone, there is no account and the setup code path applies.
- Fallback: password (`Bun.password`, argon2id) plus TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, a used step is refused again), in `hub/core/totp.ts` with `node:crypto`. The hub refuses to save a password without a confirmed TOTP secret. A recovery code replaces the TOTP code once.
- Session: a row (hash of id, kind `browser` or `device`, label, created, last seen, last check). Cookie `__Host-cubilot_session` (HttpOnly, Secure, SameSite=Strict, Path=/) in `network` and `internet` modes (HTTPS at the front); `cubilot_session` (HttpOnly, SameSite=Strict, Path=/, no Secure) in `local` mode only. Idle 12 hours, absolute 7 days, checked at each request. A new id at sign-in and at step-up.
- CSRF: the sign-in answer and `GET /auth/session` give a CSRF token (HMAC of the session id). Every non-GET request of a session caller needs header `X-CSRF-Token`; else 403. A human-token caller does not need it (no cookie).
- Without a session or a token, every route except `/sign-in`, `/sign-in.js`, `/sign-in.css`, `POST /auth/*` sign-in steps and `GET /auth/session` returns 401; a browser navigation to `/` redirects to `/sign-in`. This includes `/stream` and the UI files.
- Lock: count failures per account and per IP in the last 15 minutes; the sixth attempt and all attempts for 15 minutes from the fifth failure get 429 with `retry_after_s`. In `network` and `internet` modes the IP is the last value of `X-Forwarded-For` when the TCP peer is `127.0.0.1`; else the peer.

### 9. Step-up
`RouteDef.stepUp: true` and the WebSocket `take` message: a session caller whose last check is older than 10 minutes gets 401 `{"error":"step-up required"}`. `POST /auth/step-up` with a passkey assertion or a TOTP code sets the check time and rotates the session id. The desktop window (human token) needs no step-up: it is the local machine. Routes with the flag: Shell tab create, settings writes (config, MCP servers, skills, room settings), every `/auth/*` and `/devices/*` change, session kill, `/remove`.

### 10. Pairing and devices
`POST /pairing` (human caller, step-up for sessions) returns a code (128 bits, 5 minutes, once) and the URL `https://<host>/pair#<code>`. The page shows the URL; the QR image is Part 14 (T12). `POST /auth/pair` with the code makes a `device` session. `GET /devices` lists sessions with kind, label, last seen; `DELETE`-style `POST /devices/<id>/remove` and `POST /auth/sign-out-others` delete rows. Setting `terminal_input_remote` in `auth.db`, default false: a session caller's Take control is refused with `{"t":"error","e":"remote input off"}`.

### 11. Order and blockers
Groups run in brief order, with one exception: the terminal WebSocket (group 9) opens a new write path, so it waits for caller separation (group 11). Without it, an agent with the shared token could type into another agent's terminal.

## Risks / Trade-offs

- [The desktop window on a remote URL needs a Tauri remote capability] → group 12 checks that `open_in_editor` and the dialog still work from the hub origin; if Tauri refuses, the window keeps the bundled page with the hub origin in the allowlist (one extra origin).
- [Safari and `cubilot_session` without Secure on localhost] → needs verification in group 13; Chrome and Firefox treat localhost as secure.
- [`X-Forwarded-For` shape differs by front (Caddy, Cloudflare Tunnel, Tailscale Funnel)] → needs verification per front in group 15; the account lock works without the IP.
- [Removing `pty.rs` is a large deletion] → group 10 removes it only after groups 5 to 9 pass the ported integration tests.
- [New dependency `@simplewebauthn/server`] → WebAuthn verification (CBOR, COSE, signatures) is not a few lines; a hand-written verifier is the larger risk.

## Migration Plan

Each group installs alone. `browser_access` stays `off` until groups 11 to 17 pass; `internet` is not set before the sign-in tests (groups 13 to 17) pass on staging. Rollback: a previous install; `auth.db` is a separate file and is ignored by an older hub.

## Open Questions

- Open questions 2, 3 and 4 of the brief stay open; nothing here depends on them.
