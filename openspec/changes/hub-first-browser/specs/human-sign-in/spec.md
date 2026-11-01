## ADDED Requirements

### Requirement: Nothing is reachable before sign-in
When `browser_access` is not `off`, a request without a valid session, human token or agent token SHALL get 401 on every route except the sign-in page, its files, the sign-in steps and the session check. This SHALL include `/stream`, `/terminal/<agent>` and the UI files. A browser navigation to `/` without a session SHALL redirect to `/sign-in`.

#### Scenario: No session (brief test 1)
- **WHEN** a client without a session requests `/`, `/index.html`, `/main.js`, `/stream`, `/agents` and `/terminal/w1`
- **THEN** each answer is 401, and `/` from a browser navigation redirects to `/sign-in`
- **AND** `/sign-in` answers 200

### Requirement: First run with a one-time setup code
When no account exists and `browser_access` is not `off`, the hub SHALL print a setup code on its console and SHALL give it to the desktop window. The code SHALL expire after 15 minutes and SHALL work once. Setup SHALL make the one account (`human_name`) and SHALL return ten one-time recovery codes. There SHALL be no sign-up page.

#### Scenario: Expired setup code
- **GIVEN** a setup code made 16 minutes ago
- **WHEN** it is sent to setup
- **THEN** the hub refuses it and makes no account

#### Scenario: Setup gives recovery codes
- **WHEN** a valid setup code is used
- **THEN** the account exists and the answer has ten recovery codes, each accepted once

### Requirement: Passkey sign-in with a password and TOTP fallback
The human SHALL sign in with a passkey (WebAuthn). The fallback SHALL be a password (argon2id) plus a TOTP code. A password alone SHALL NOT sign in. A recovery code SHALL replace the TOTP code once. A used TOTP step SHALL be refused again.

#### Scenario: Passkey sign-in makes a session (brief test 2)
- **GIVEN** `browser_access: internet` with a host and HTTPS
- **WHEN** the human signs in with a registered passkey
- **THEN** the hub makes a session and sets cookie `__Host-cubilot_session` with HttpOnly, Secure, SameSite=Strict and Path=/

#### Scenario: Password without TOTP
- **WHEN** a sign-in has the right password and no TOTP code
- **THEN** the hub refuses it and makes no session

#### Scenario: TOTP replay
- **GIVEN** a TOTP code that signed in once
- **WHEN** the same code is sent again in the same 30-second step
- **THEN** the hub refuses it

### Requirement: Recovery from the desktop window
`auth.db` is not in the ledger backup, so after a restore the desktop window (human token, no sign-in) SHALL be the way back. It SHALL list and remove the account's passkeys and make a one-time registration link for `browser_access_host` (15 minutes, once) that registers a new passkey in a browser without a sign-in. A session caller SHALL NOT make the link. The sign-in log SHALL record each removal and registration.

#### Scenario: Passkeys lost after a restore
- **GIVEN** the ledger was restored from a backup and no registered passkey works
- **WHEN** the human, in the desktop window, removes the old passkeys and opens the registration link in a browser on `browser_access_host`
- **THEN** the browser registers a new passkey, the old passkeys no longer sign in, the new one does, and the sign-in log has a `passkey_removed` row for each old passkey and a `passkey_registered` row

### Requirement: Server-side sessions with limits
A session SHALL be a server-side row. The idle limit SHALL be 12 hours and the absolute limit 7 days. The hub SHALL make a new session id at each sign-in and at each step-up. Sign-out SHALL delete the row. "Sign out all other sessions" SHALL delete every other row of the account. The cookie SHALL be `__Host-cubilot_session` (HttpOnly, Secure, SameSite=Strict, Path=/) in `network` and `internet` modes, and `cubilot_session` (HttpOnly, SameSite=Strict, Path=/) in `local` mode.

#### Scenario: Sign out all other sessions (brief test 7)
- **GIVEN** browser A and browser B are signed in
- **WHEN** A sends "sign out all other sessions"
- **THEN** B's next request gets 401 and A's next request succeeds

#### Scenario: Idle limit
- **GIVEN** a session with no request for 12 hours and 1 minute
- **WHEN** it makes a request
- **THEN** the hub returns 401 and deletes the row

### Requirement: CSRF token on each change from a session
Every request of a session caller that is not `GET` SHALL carry the CSRF token of that session in `X-CSRF-Token`. The `Origin` and `Host` checks SHALL apply as well. Agents SHALL keep the header token and need no CSRF token.

#### Scenario: Wrong Origin, Host or no CSRF token (brief test 3)
- **WHEN** a signed-in session sends `POST /send` with a wrong `Origin`, or with a wrong `Host`, or without `X-CSRF-Token`
- **THEN** each request gets 403 and no entry is written

### Requirement: Lock after failed sign-ins
Five failed sign-ins in 15 minutes SHALL lock the account and the IP address for 15 minutes. A locked attempt SHALL get 429 with the seconds to wait, and the page SHALL show them.

#### Scenario: Sixth failure (brief test 4)
- **GIVEN** five failed sign-ins in the last 15 minutes
- **WHEN** a sixth sign-in arrives, also with the right credentials
- **THEN** the hub returns 429 with `retry_after_s` and the sign-in log has a `lock` row

### Requirement: Sign-in log
Every sign-in, failure, lock, step-up and session removal SHALL be a row in a sign-in log with the time, the event, the IP address and the user agent. A human caller SHALL read the log.

#### Scenario: Session removal is logged
- **WHEN** the human removes a device session
- **THEN** the sign-in log has a `session_removed` row with the time

### Requirement: Step-up for sensitive actions
A session caller whose last passkey or TOTP check is older than 10 minutes SHALL be asked for it again before: Take control of a terminal, the Shell tab, Settings changes (config, MCP servers, room settings, skills), account and security changes, Kill session and Remove agent. The answer SHALL be 401 with `step-up required`. A step-up SHALL set the check time and make a new session id. The desktop window's human token SHALL need no step-up.

#### Scenario: Take control after 11 minutes (brief test 5)
- **GIVEN** a session whose last check was 11 minutes ago
- **WHEN** it sends Take control on `/terminal/w1`
- **THEN** the hub answers `step-up required` and the viewer stays read-only
- **WHEN** the human then completes a passkey step-up and takes control
- **THEN** the viewer has control

### Requirement: Pairing a device
A signed-in session (after step-up) or the desktop window SHALL make a pairing code that works once and expires after 5 minutes, with the URL to open on the phone. The phone SHALL exchange the code for a device session. The human SHALL list device sessions and remove one; a removed device's next request SHALL get 401. Typing into a terminal from a session SHALL be off by default; while off, Take control from a session SHALL be refused with `remote input off`.

#### Scenario: Pairing code used twice
- **GIVEN** a phone used a pairing code
- **WHEN** a second device sends the same code
- **THEN** the hub refuses it

#### Scenario: Remote input off
- **GIVEN** `terminal_input_remote` is off
- **WHEN** a paired phone sends Take control after a step-up
- **THEN** the viewer gets `{"t":"error","e":"remote input off"}` and stays read-only
