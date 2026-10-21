## ADDED Requirements

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

## REMOVED Requirements

### Requirement: channel-bin discovers the hub URL without configuration

**Reason**: `channel-bin` (the MCP sidecar) is removed; discovery lives in the shared bridge core.
**Migration**: See "The bridge discovers the hub URL without configuration".

### Requirement: channel-bin reads token alongside URL

**Reason**: `channel-bin` is removed.
**Migration**: See "The bridge reads the token alongside the URL".

### Requirement: MCP config template omits hub URL

**Reason**: External sessions load the chatbridge mod instead of an MCP server.
**Migration**: See "Launch template carries no hub URL".
