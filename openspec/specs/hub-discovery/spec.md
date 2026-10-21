# hub-discovery Specification

## Purpose
TBD - created by archiving change dynamic-port-discovery. Update Purpose after archive.
## Requirements
### Requirement: Hub binds an OS-assigned free port at startup

The Rust shell SHALL bind a listener on `127.0.0.1:0` at startup, read the OS-assigned port number, release the listener, and pass the port to the `hub-bin` sidecar via the `PORT` environment variable. The `hub-bin` sidecar SHALL bind that port when starting its HTTP server. The chosen port SHALL NOT be hardcoded anywhere in the codebase.

#### Scenario: Fresh startup on a machine with no port conflict

- **WHEN** the user launches `A2AChannel.app`
- **THEN** the Rust shell binds `127.0.0.1:0`, obtains a free port (e.g. `54831`)
- **AND** releases its listener
- **AND** spawns `hub-bin` with `PORT=54831` in its environment
- **AND** `hub-bin` logs `[hub] listening on http://127.0.0.1:54831`

#### Scenario: Port 8011 is already held by an unrelated process

- **WHEN** another process is listening on `127.0.0.1:8011`
- **AND** the user launches `A2AChannel.app`
- **THEN** the app obtains a different free port (any port ≠ 8011) and starts normally
- **AND** no `EADDRINUSE` error is written to `hub.log`

### Requirement: Hub URL is published to a discovery file

On successful hub startup, the Rust shell SHALL write the hub URL to `~/Library/Application Support/A2AChannel/hub.url`. The file SHALL contain exactly the URL (e.g. `http://127.0.0.1:54831`), optionally terminated by a newline. The parent directory SHALL be created if it does not exist. The write SHALL be atomic: the Rust shell SHALL write to a temporary file in the same directory and rename it over the target. The discovery file SHALL be created with file mode `0600` (owner read/write only) so that other local users cannot observe the running hub's URL.

#### Scenario: Discovery file is written on first launch

- **WHEN** the app starts for the first time on a machine
- **AND** `~/Library/Application Support/A2AChannel/` does not yet exist
- **THEN** the directory is created
- **AND** `hub.url` is written with content matching the hub's actual URL
- **AND** `hub.url` has filesystem mode `0600`

#### Scenario: Discovery file is replaced atomically on restart

- **GIVEN** a previous run left `hub.url` containing `http://127.0.0.1:54831`
- **WHEN** the app starts again and obtains port `62144`
- **THEN** `hub.url` is updated atomically (rename-into-place)
- **AND** any reader observes either the full old content or the full new content, never partial
- **AND** the new file retains mode `0600`

### Requirement: UI obtains hub URL via Tauri command

The Rust shell SHALL expose a Tauri command named `get_hub_url` that returns the current hub URL as a string. The webview SHALL invoke this command at startup before opening any SSE or HTTP connection to the hub. The hardcoded `BUS` constant SHALL be replaced with a value obtained from this command.

#### Scenario: Webview bootstrap fetches the URL

- **WHEN** the webview loads `index.html`
- **THEN** the first network activity to the hub is preceded by `invoke('get_hub_url')`
- **AND** that call returns a string matching `http://127.0.0.1:<port>` where `<port>` matches the port in the discovery file

### Requirement: CSP permits any local-loopback port

The app's Content-Security-Policy SHALL permit `connect-src` and `img-src` directives to include `http://127.0.0.1:*` (any port on loopback). The CSP SHALL continue to deny non-loopback origins.

#### Scenario: Webview connects to the dynamically-assigned port

- **GIVEN** the hub is listening on `http://127.0.0.1:54831`
- **WHEN** the webview issues `fetch('http://127.0.0.1:54831/agents')`
- **THEN** the request is not blocked by CSP

#### Scenario: CSP still blocks non-loopback origins

- **GIVEN** an attacker-controlled script (hypothetically) runs in the webview
- **WHEN** it attempts `fetch('http://evil.example.com/exfil')`
- **THEN** the request is blocked by CSP

### Requirement: Hub publishes an auth token alongside the URL

On successful hub startup, the Rust shell SHALL mint a cryptographically-random token (at least 32 bytes of entropy, URL-safe base64 encoded) and write it to `~/Library/Application Support/A2AChannel/hub.token`. The file SHALL contain exactly the token, optionally terminated by a newline. The write SHALL be atomic. The token file SHALL be created with file mode `0600`. The token SHALL be re-minted on every app launch (no persistence across restarts).

#### Scenario: Token file created at startup

- **WHEN** the app starts
- **THEN** `~/Library/Application Support/A2AChannel/hub.token` exists with mode `0600`
- **AND** its contents match `/^[A-Za-z0-9_-]{40,}\n?$/`
- **AND** the contents differ from any token written by a previous app session

#### Scenario: Token rotates on restart

- **GIVEN** the app is running with token `T1`
- **WHEN** the app quits and is relaunched
- **THEN** `hub.token` is replaced with a new token `T2`
- **AND** `T2` != `T1`

### Requirement: Tauri `get_hub_url` command returns both URL and token

The `get_hub_url` Tauri command SHALL return a JSON object of shape `{ url: string, token: string }`. The webview SHALL invoke this command at startup and use both values: `url` as the base for all hub requests, and `token` as the `Authorization: Bearer <token>` header on every mutating request.

#### Scenario: Webview receives full auth bundle

- **WHEN** the webview bootstrap invokes `get_hub_url`
- **THEN** the returned value has `url` matching `http://127.0.0.1:<port>` and `token` matching the contents of `hub.token`

### Requirement: The bridge discovers the hub URL without configuration

The bridge core, on every runtime, SHALL determine the hub URL using the following priority order:

1. If the `CHATBRIDGE_HUB` environment variable is set and non-empty, use it verbatim.
2. Otherwise, read `~/Library/Application Support/A2AChannel/hub.url` through `Host.readText` and use its contents (trimmed of whitespace).
3. Otherwise (file missing, empty, or unreadable), treat as connection failure and apply the backoff-and-retry loop.

On connection failure or stream end, the bridge SHALL re-run the resolution on each retry attempt so that stale URLs self-heal once the app restarts.

#### Scenario: Bridge with no env var finds the running hub

- **GIVEN** `A2AChannel.app` is running and has written `hub.url`
- **AND** an agent starts without `CHATBRIDGE_HUB`
- **WHEN** the bridge starts
- **THEN** it reads `hub.url`, connects to that URL, and registers the agent

#### Scenario: Bridge started before the app converges once the app starts

- **GIVEN** an agent's bridge started with no `CHATBRIDGE_HUB` env
- **AND** `A2AChannel.app` was not running at that moment
- **WHEN** the app is launched 30 seconds later
- **THEN** the bridge's next retry (within its 2-second backoff interval) reads the now-present `hub.url`
- **AND** connects successfully
- **AND** the UI displays the agent's pill as online

#### Scenario: Stale discovery file from a crashed previous run

- **GIVEN** `hub.url` contains `http://127.0.0.1:54831` from a previous run that crashed
- **AND** no process is listening on that port
- **WHEN** the app is relaunched and obtains port `60112`, overwriting `hub.url`
- **THEN** the bridge's current connection attempt fails
- **AND** its retry re-reads `hub.url`
- **AND** connects to `http://127.0.0.1:60112`

#### Scenario: Explicit CHATBRIDGE_HUB overrides discovery

- **GIVEN** the agent's environment sets `CHATBRIDGE_HUB=http://127.0.0.1:9999`
- **WHEN** the bridge starts
- **THEN** it connects to `http://127.0.0.1:9999` regardless of the contents of `hub.url`

### Requirement: The bridge reads the token alongside the URL

The bridge SHALL read the token from `hub.token` whenever it reads `hub.url`. If either file is missing or unreadable, the bridge SHALL treat the connection as unavailable and apply backoff-and-retry. The bridge SHALL send `Authorization: Bearer <token>` on every hub request it makes, including the `/agent-stream` read. On a 401 it SHALL re-read `hub.token` once and retry with the fresh token.

#### Scenario: Bridge authenticates POST requests

- **GIVEN** `hub.url` and `hub.token` both exist
- **WHEN** the agent calls the `post` tool
- **THEN** the bridge issues `POST /post` with `Authorization: Bearer <token>` matching `hub.token`
- **AND** the hub accepts the request

#### Scenario: Bridge retries if token file is missing

- **GIVEN** `hub.url` exists but `hub.token` is missing (e.g. race with app startup)
- **WHEN** the bridge attempts to resolve the hub
- **THEN** it waits 2 seconds and re-reads both files before trying again

### Requirement: Launch template carries no hub URL

The `get_mcp_template` Rust command SHALL return a shell launch line for an external Claude Code session of the form `CHATBRIDGE_AGENT='<name>' CHATBRIDGE_ROOM='<room>' claude --plugin-dir '<absolute path to the bundled chatbridge mod>'`. It SHALL NOT contain `CHATBRIDGE_HUB` or a hub token. Users who run this line SHALL obtain a connected agent without any URL configuration.

#### Scenario: Modal shows the launch line

- **WHEN** the user opens the launch-template modal from the app header
- **THEN** the text contains `--plugin-dir` followed by the bundled mod's absolute path
- **AND** it contains `CHATBRIDGE_AGENT=` and `CHATBRIDGE_ROOM=`
- **AND** it contains neither `CHATBRIDGE_HUB` nor `--mcp-config`

