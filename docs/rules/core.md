# Rules: core

Hub core: build, auth, attachments, registry, SSE invariants, architecture, resource paths (extra topic: fits none of the six).

## Architecture

Two processes bundled into one `.app`, plus an in-process bridge inside each agent runtime:

1. **Tauri Rust shell** (`src-tauri/src/lib.rs`) — spawns `cubilot-bin` (with `CUBILOT_MODE=hub`) as a sidecar on startup, kills it on exit, streams its stdout/stderr to `~/Library/Logs/Cubilot/hub.log`, and stages the Claude mod folder. Exposes one `#[tauri::command]` for external sessions: `get_mcp_template()` (legacy name) returns a `claude --plugin-dir …` launch line.

2. **cubilot-bin** (`hub/main.ts` dispatches on `CUBILOT_MODE`; `hub/hub.ts` is the hub, Bun-compiled by `build-sidecars.sh`) — HTTP + SSE server on `127.0.0.1:<port>` where `<port>` is OS-assigned at app startup (via the Rust shell) and passed in via the `PORT` env var. Owns all state: chat log, per-agent message queues, presence counts. `hub.ts` is the composition root: generic routes live in `hub/features/*.ts` (`HubFeature`), state-machine kinds in `hub/kinds/*.ts` (`KindModule`), shared plumbing in `hub/core/`. **Roster is fully dynamic** — `ensureAgent(name)` is called the first time a name appears on `/agent-stream`, auto-registering it with a hash-derived HSL color. `/post` never registers an agent: an unknown sender gets 409 "connect /agent-stream first" (a post that created the agent would pin it to the default room, because the room is fixed by its first stream). No `agents.json`.

3. **Bridge** (`hub/channel/core.ts` + one adapter per runtime — no separate process) — one instance per agent session, living inside the agent: the Claude Code mod (`hub/channel/claude-mod/register.ts`, bundled to `chatbridge-mod.js`) or the pi extension (`hub/channel/pi-extension.ts`, bundled to `pi-extension.js`). Resolves the hub via `CHATBRIDGE_HUB` env (if set) or the paired discovery files (`hub.url` + `hub.token`); re-reads both on each retry so stale values self-heal. Tails `/agent-stream?agent=<name>&room=<label>` and delivers each event into the agent's context in `context`, `steer` or `wake` mode. Registers the `post`, `post_file` and kind tools (`mcp__chatbridge__*` in Claude). Sends `Authorization: Bearer <token>` to the hub; on 401 (token rotated), re-reads the token file once and retries.

Data flow:

```
agent session ─► bridge (mod / pi extension) ─► hub /post ─► chat_log ─► all ui_subscribers (SSE /stream)
                                                    └─► all agent_queues  (SSE /agent-stream)
webview  ───────► hub /send ────────────────────────► chat_log ─► ui_subscribers + agent_queues
```


## Bundled resource path resolution (Rust)


`resolve_pi_extension()` and `resolve_chatbridge_mod_js()` in `lib.rs` try the same candidates:
- `Contents/Resources/resources/<file>` and `Contents/Resources/<file>` (bundled app — `bundle.resources` keeps the source structure)
- `../../resources/<file>` relative to the executable (during `tauri dev`)

Keep all of them working when changing how bundled resources are located. The Claude mod is then staged out of the bundle (see the hard rule on staging).

## Never commit unless explicitly asked

- **Never commit unless explicitly asked.** Stage, diff, `git status` — yes. `git commit` / `git push` — no. Exception: a hub-launched stage session (Worker, Writer) commits on its own `ticket/<id>` branch only, never on main, and never pushes. The next stage sees only committed work (human decision 2026-10-24, live check 6.5).

## Heavy processes run one at a time under `/tmp/cubilot-heavy.lock`

- **Heavy processes run one at a time under `/tmp/cubilot-heavy.lock`.** A full `bun test`, `cargo test`, a `pty-plumbing` run, a stress test or a test hub needs the lock (a lock directory: `mkdir` takes it, `rm -r` releases it, the `owner` file names the holder). `./scripts/test.sh` takes the lock itself and is not reentrant: do not take the lock before you call the script.

## Never introduce a framework to `ui/index.html`

- **Never introduce a framework to `ui/index.html`.** The UI is vanilla HTML/CSS/JS by choice. No React, Vue, Svelte, bundler, or build step for the UI. `withGlobalTauri: true` means no bundler is needed to call Tauri commands from JS.

## The hub port is dynamic, not hardcoded

- **The hub port is dynamic, not hardcoded.** The Rust shell binds `127.0.0.1:0` at startup, writes the chosen URL to `~/Library/Application Support/Cubilot/hub.url`, and passes `PORT=<n>` to the `cubilot-bin` sidecar (launched with `CUBILOT_MODE=hub`). Do not reintroduce a hardcoded port anywhere. The webview calls `invoke('get_hub_url')` to learn the URL; the bridge (Claude mod / pi extension) reads the discovery file (or uses `CHATBRIDGE_HUB` env as an override).

## After changing `hub/hub.ts`, rebuild sidecars

- **After changing `hub/hub.ts`, rebuild sidecars** (`./scripts/build-sidecars.sh`) before testing. The `.app` runs the compiled binaries, not the TypeScript source.

## Never mutate `knownAgents`, `agentQueues`, `agentConnections` or `staleTimers` individually

- **Never mutate `knownAgents`, `agentQueues`, `agentConnections` or `staleTimers` individually.** They are sealed inside `createAgentRegistry()` (`hub/core/agents.ts`); go through the registry (`agents.ensure` / `agents.remove`, aliased `ensureAgent` / `removeAgent` in `hub.ts`) so the four stay in sync atomically.

## Hub endpoints require auth

- **Hub endpoints require auth.** Mutating routes require `Authorization: Bearer <token>`. Read routes (`/agents`, `/presence`, `/stream`, `/agent-stream`, `/image/<id>`, `/handoffs`, `/interrupts`, `/nutshell`) accept EITHER the bearer header OR a `?token=<token>` query param — required because `EventSource` and `<img>` can't set custom headers. The token is minted by the Rust shell, written to `~/Library/Application Support/Cubilot/hub.token` (mode `0600`), and delivered to the `cubilot-bin` hub sidecar via the `CUBILOT_TOKEN` env var. The bridge reads the file; the webview gets it from `get_hub_url`'s return value. `hub.log` is also mode `0600` because tokens land in it via query-string-authenticated requests.

## Upload allowlist is by file extension, configured in `config.yml` under `attachment_extensions`

- **Upload allowlist is by file extension, configured in `config.yml` under `attachment_extensions`.** Defaults: `["jpg","jpeg","png","pdf","md","txt"]`. Extension is the single source of truth — no MIME check, no magic-byte check. Magic-byte and MIME checks are bypassable, and execution is prevented regardless of MIME confusion by the serve route's strict CSP (`default-src 'none'; sandbox`) and `X-Content-Type-Options: nosniff`. The Rust shell validates entries (lowercase alnum, ≤10 chars, no dots), passes the cleaned set via `CUBILOT_ALLOWED_EXTENSIONS=jpg,jpeg,…` env. The hub rejects uploads whose filename extension isn't in the set with HTTP 400.

## Attachments persist to disk at `<CUBILOT_ATTACHMENTS_DIR>/<id>.<ext>`

- **Attachments persist to disk at `<CUBILOT_ATTACHMENTS_DIR>/<id>.<ext>`.** No in-memory cache. Rust resolves the dir (config override via `attachments_dir`, legacy `images_dir` still honored; default `~/cubilot-attachments/` — top-level home avoids macOS TCC) and passes it via env. Files are chmod'd 0600 on write. Agents receive absolute file paths in channel text via `[attachment: <path>]`; the hub's `agentEntry()` does the URL→path rewrite. The HTTP route is `/image/<id>.<ext>` (legacy name; serves any allowed extension, not just images).

## JSON bodies on mutating routes are capped at 256 KiB

- **JSON bodies on mutating routes are capped at 256 KiB** (`JSON_BODY_MAX`). `requireJsonBody()` checks `Content-Length` before `req.json()`. Exception: `POST /handoffs` uses 1 MiB (`HANDOFF_BODY_MAX`) to accommodate diffs/contracts in `context`.

## Always use `./scripts/install.sh` for dev rebuilds, never a `pkill + cp` shortcut

- **Always use `./scripts/install.sh` for dev rebuilds, never a `pkill + cp` shortcut.** `install.sh` runs an orphan-hub sweep (kills any `cubilot-bin` process with `CUBILOT_MODE=hub` whose ppid is 1, i.e. was reparented to launchd when the previous app died without clean exit). Skip the sweep and accumulated orphan hubs listen on stale ports, agent bridges attach to the orphan instead of the current hub, the agent column shows empty, and you waste an hour diagnosing.

## Human is a permanent roster member

- **Human is a permanent roster member.** Registered at hub startup under the name from `CUBILOT_HUMAN_NAME` (config-overridable, default `"human"`). Excluded from stale cleanup via `permanentAgents`. The chat routing keyword `to: "you"` in the `post` tool is retained for backward compat but is NOT the human's identity in structured messages.

## Never skip the ad-hoc re-sign step when compiling sidecars

- **Never skip the ad-hoc re-sign step when compiling sidecars.** Bun-compiled binaries inherit a stale Bun signature that macOS Sonoma+ rejects; `build-sidecars.sh` strips it and re-signs. Skip it and the sidecar dies silently at spawn with exit code 137.

## Never add Windows/Linux/Intel-Mac support speculatively

- **Never add Windows/Linux/Intel-Mac support speculatively.** macOS ARM64 is the only target.

## `devtools` feature is on in release builds

- **`devtools` feature is on in release builds** (`src-tauri/Cargo.toml`). Ships the WKWebView "Inspect Element" / Cmd+Opt+I console in the installed app so end-user bug reports can include console logs. Consequence: any local process that can attach to the webview can read the token out of `window` / console. Accepted because the hub is loopback-only and the trust boundary is "anything on this Mac as this user is already inside." Revisit if the hub ever moves off `127.0.0.1`.

## Drop-oldest queue semantics

- **Drop-oldest queue semantics.** Bounded `DropQueue<T>` in `hub/core/sse.ts` — when full, oldest item is evicted, not pushed. Prevents a slow subscriber from indefinitely growing memory.

## SSE heartbeats every 15s + `idleTimeout: 0`

- **SSE heartbeats every 15s + `idleTimeout: 0`** on `Bun.serve`. Without both, Bun kills long-idle SSE connections after 10s by default, which silently breaks agent message delivery during quiet periods.

## Message dedup by server-assigned `id` + session id

- **Message dedup by server-assigned `id` + session id.** Each chat entry gets a monotonic `id`. Client persists `lastSeenId` and `serverSession` in `localStorage`. On reconnect, client sends both as query params so the hub skips already-seen entries. Hub restart mints a new session id → client resets dedup state.

## Reserved agent names

- **Reserved agent names:** `you`, `all`, `system`. Validator also enforces `[A-Za-z0-9_.-]` with spaces allowed in the middle, max 64 chars.

## Stale-agent removal

- **Stale-agent removal.** When an agent's last SSE connection drops, a 15s timer is armed (`STALE_AGENT_MS`). If no reconnect arrives, the agent is auto-removed from the roster. Reconnecting cancels the timer. Manual removal via `POST /remove` or the × button on an offline agent's row in the agent column is also supported.

## Adding a Tauri command

- **Adding a Tauri command:** declare `#[tauri::command]` in `lib.rs`, add to `generate_handler![]`, call from JS via `window.__TAURI__.core.invoke('command_name')`. `withGlobalTauri: true` is set so no bundler is needed in the UI.

## Icons

- **Icons:** `src-tauri/icons/icon.icns` and friends are generated from a source PNG via `bun x tauri icon <source.png> -o src-tauri/icons`. Do not hand-edit the generated files.
