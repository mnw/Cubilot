## MODIFIED Requirements

### Requirement: UI obtains hub URL via Tauri command

The Rust shell SHALL expose a Tauri command named `get_hub_url` that returns the current hub URL and the human token. The desktop window SHALL load its page from that URL. In the desktop window the UI SHALL invoke this command at startup before opening any SSE, WebSocket or HTTP connection to the hub. In a browser the UI SHALL use its own origin as the hub URL and SHALL NOT invoke a Tauri command.

#### Scenario: Webview bootstrap fetches the URL

- **WHEN** the desktop window loads `index.html` from the hub
- **THEN** the first hub request is preceded by `invoke('get_hub_url')`
- **AND** that call returns a `url` matching `http://127.0.0.1:<port>` where `<port>` matches the port in the discovery file

#### Scenario: Browser uses its origin

- **WHEN** a signed-in browser loads `index.html`
- **THEN** the UI sends its hub requests to `location.origin` and calls no Tauri command

### Requirement: Hub publishes an auth token alongside the URL

On successful hub startup, the Rust shell SHALL mint two cryptographically-random tokens (each at least 32 bytes of entropy, URL-safe base64 encoded): the agent token and the human token. It SHALL write only the agent token to `<app data>/hub.token`. The file SHALL contain exactly the token, optionally terminated by a newline. The write SHALL be atomic. The token file SHALL be created with file mode `0600`. The shell SHALL give the human token to the hub as the first line of its stdin and SHALL NOT write it to a file or an environment variable. Both tokens SHALL be re-minted on every app launch (no persistence across restarts).

#### Scenario: Token file created at startup

- **WHEN** the app starts
- **THEN** `<app data>/hub.token` exists with mode `0600`
- **AND** its contents match `/^[A-Za-z0-9_-]{40,}\n?$/`
- **AND** the contents differ from any token written by a previous app session
- **AND** the contents differ from the human token

#### Scenario: Token rotates on restart

- **GIVEN** the app is running with agent token `T1`
- **WHEN** the app quits and is relaunched
- **THEN** `hub.token` is replaced with a new token `T2`
- **AND** `T2` != `T1`

### Requirement: Tauri `get_hub_url` command returns both URL and token

The `get_hub_url` Tauri command SHALL return a JSON object of shape `{ url: string, token: string }`, where `token` is the human token. The desktop window SHALL use `url` as the base for all hub requests and `token` as the `Authorization: Bearer <token>` header on every request that carries a header, and as `?token=` on `EventSource` and the terminal WebSocket.

#### Scenario: Webview receives full auth bundle

- **WHEN** the desktop window invokes `get_hub_url`
- **THEN** the returned value has `url` matching `http://127.0.0.1:<port>`
- **AND** `token` differs from the contents of `hub.token`

## ADDED Requirements

### Requirement: The human token is in one Keychain item for the Terminal command

At every app start the shell SHALL store the human token in one macOS Keychain item (service `Cubilot`, account `human-token`) with user presence (Touch ID or the login password), replacing the item of the previous launch. No file and no environment variable holds the token. `cubilot hub <METHOD> <path> [json-body]` SHALL send that request to the URL in `hub.url` with the token as bearer, print the status and body, and never print the token.

#### Scenario: Terminal command with the human token

- **GIVEN** the app is running and has stored the item
- **WHEN** the human runs `cubilot hub GET /agents` and accepts the prompt
- **THEN** the command prints `HTTP 200` and the response body
- **AND** neither the output nor an error line holds the human token

#### Scenario: No item

- **GIVEN** the Keychain has no item `Cubilot` / `human-token`
- **WHEN** the human runs `cubilot hub GET /agents`
- **THEN** the command exits not 0 with one line that says there is no Keychain item
- **AND** a refused prompt or a hub that does not answer also gives one cause line and exit not 0
