## REMOVED Requirements

### Requirement: Mutating endpoints require bearer-token authentication

**Reason**: The agents and the human no longer share one token (capability `caller-identity`). The scenario "Agent and human tokens are the same" is false after this change.

**Migration**: Replaced by "Mutating endpoints require a token or a sign-in session" below. The bridge keeps the token of `hub.token`; the desktop window gets the human token from `get_hub_url`.

## ADDED Requirements

### Requirement: Mutating endpoints require a token or a sign-in session

The hub SHALL reject a mutating request (`/send`, `/post`, `/remove`, `/upload`, `/handoffs*`, `/interrupts*` and every later mutating route) without a valid agent token, human token or sign-in session with its CSRF token, with HTTP `401` and `{ "error": "unauthorized" }`. The token comparison SHALL be constant-time. The hub SHALL know from the credential whether the caller is the human or an agent (capability `caller-identity`).

#### Scenario: Unauthenticated POST is rejected

- **WHEN** a client issues `POST /send` without an `Authorization` header and without a session
- **THEN** the hub responds `401` with body `{"error":"unauthorized"}`
- **AND** no entry is written to the chat log

#### Scenario: Wrong token is rejected

- **GIVEN** the current agent token is `T-current`
- **WHEN** a client issues `POST /post` with `Authorization: Bearer T-stale`
- **THEN** the hub responds `401`

#### Scenario: Agent and human tokens are different callers

- **GIVEN** agent token `abc` and human token `xyz`
- **WHEN** the desktop window POSTs `/upload` with `Bearer xyz`
- **AND** a channel-mode sidecar POSTs `/upload` with `Bearer abc`
- **THEN** both requests succeed
- **AND** the hub records the first as the human and the second as an agent

#### Scenario: Read endpoints require auth via header, query token or session

- **WHEN** a client issues `GET /agents`, `/presence`, `/stream`, `/agent-stream`, `/image/<id>`, `/handoffs`, `/interrupts`, or `/nutshell` with no `Authorization` header, no `?token=` query parameter and no session
- **THEN** the hub responds `401`
- **WHEN** the same client retries with `?token=<valid>`
- **THEN** the hub responds `200` with the expected body, or `403` where the route refuses that caller
