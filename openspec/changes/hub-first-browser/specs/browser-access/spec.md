## ADDED Requirements

### Requirement: The hub serves the UI
The hub SHALL serve the files of `ui/` at `/`, with `index.html` for `/`. It SHALL refuse a path outside `ui/` and SHALL list no folder. The desktop window SHALL load the page from the hub URL.

#### Scenario: Path outside the folder
- **WHEN** a human caller requests `/../hub/hub.ts` or `/%2e%2e/config.yml`
- **THEN** the hub returns 404

#### Scenario: Window and browser load the same page
- **WHEN** the desktop window and a signed-in browser load `/`
- **THEN** both get the same `index.html`

### Requirement: One mode switch for browser access
`config.yml` SHALL have `browser_access: off | local | network | internet`, default `off`. `off` SHALL accept only the human token and the agent token. `local` SHALL add sessions from `localhost` and `127.0.0.1` on the hub port. `network` (a private network such as `tailscale serve`) and `internet` (a TLS front) SHALL add sessions from `browser_access_host` over HTTPS. The hub SHALL listen on `127.0.0.1` in every mode.

#### Scenario: Local mode
- **GIVEN** `browser_access: local`
- **WHEN** a browser on the same computer opens `http://localhost:<port>/`
- **THEN** it gets the sign-in page

#### Scenario: Never a public address
- **WHEN** the hub runs in any mode
- **THEN** it listens on `127.0.0.1` only

### Requirement: Network and internet modes need a host name and HTTPS
The hub SHALL refuse `network` and `internet` without `browser_access_host` and `browser_access_https: true`, SHALL run as `off`, and SHALL log the reason.

#### Scenario: Internet without a host name
- **GIVEN** `browser_access: internet` and no `browser_access_host`
- **WHEN** the hub starts
- **THEN** it runs as `off` and logs "internet mode needs browser_access_host and browser_access_https"

#### Scenario: Network mode without HTTPS
- **GIVEN** `browser_access: network`, a `browser_access_host` and no `browser_access_https`
- **WHEN** the hub starts
- **THEN** it runs as `off` and logs "network mode needs browser_access_host and browser_access_https"

### Requirement: Host and Origin checks on every route and the WebSocket
The hub SHALL refuse with 403 a request or a WebSocket upgrade whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>`, or `browser_access_host` in `network` and `internet` modes. When `Origin` is present it SHALL be one of the same names with its scheme, else 403. A request without `Origin` SHALL pass this check.

#### Scenario: DNS rebinding
- **WHEN** a request arrives with `Host: evil.example:4321`
- **THEN** the hub returns 403

#### Scenario: Wrong Origin on a read route
- **WHEN** `GET /agents` arrives with a valid session and `Origin: https://evil.example`
- **THEN** the hub returns 403

#### Scenario: Wrong Origin on the WebSocket
- **WHEN** a WebSocket upgrade to `/terminal/w1` has `Origin: https://evil.example`
- **THEN** the hub refuses the upgrade with 403

### Requirement: Strict response headers
Every response SHALL carry a Content-Security-Policy with `default-src 'self'` and `frame-ancestors 'none'`, `Referrer-Policy: same-origin` and `X-Content-Type-Options: nosniff`. No response SHALL carry `Access-Control-Allow-Origin: *`. In `internet` mode every response SHALL carry `Strict-Transport-Security`.

#### Scenario: No wildcard CORS
- **WHEN** any route answers
- **THEN** the answer has no `Access-Control-Allow-Origin: *`

#### Scenario: HSTS in internet mode
- **GIVEN** `browser_access: internet` with a host and HTTPS
- **WHEN** the sign-in page is served
- **THEN** the answer has `Strict-Transport-Security`
