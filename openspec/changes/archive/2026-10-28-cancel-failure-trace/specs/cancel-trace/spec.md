## ADDED Requirements

### Requirement: A failed stage cancel or sweep leaves one open row

The hub SHALL write one `cancel_trace` row with status `open` when `cancelStage` or the sweep throws. The row id SHALL be `ct_` plus the first 16 hex of `sha256(stage_id + "\n" + site + "\n" + status_at_failure)`. The same id again, open or cleared, SHALL write no row and no event. The stage SHALL NOT change. Insert SHALL write one `cancel_trace.created` event and one row in one transaction, with scope `ui-only`.

#### Scenario: (a) Ticket cancel

- **GIVEN** a queued stage and a write that throws on `cancelled`
- **WHEN** the ticket is cancelled
- **THEN** one open row exists with the fields of the failure
- **AND** the stage is still `queued`
- **AND** one `cancel_trace.created` event exists

#### Scenario: (b) Draft, done and start sweep

- **GIVEN** the same failing write
- **WHEN** a ticket moves to draft, a ticket moves to done, or the hub starts with a cancelled ticket
- **THEN** one row exists with the caller `ticket_draft`, `ticket_done` or `start_sweep`

#### Scenario: (c) Sweep

- **GIVEN** a running stage whose move to `retrying` throws
- **WHEN** the sweep stops it
- **THEN** one row with site `sweep` exists

#### Scenario: (d) Same status

- **GIVEN** three ticks with the same status
- **WHEN** each tick fails
- **THEN** one row and one event exist

#### Scenario: (d2) Other status

- **GIVEN** a row for status `queued`
- **WHEN** the same stage fails again with status `retrying`
- **THEN** a second row exists

### Requirement: A failed trace write is logged and goes no further

A written trace SHALL add no log line beyond the existing `[stage] cancelling <id> failed:` or `[stage] sweep of <id> failed:` line. If the trace write throws, the hub SHALL log exactly one more line `[stage] trace for <id> failed: <message>`. Nothing SHALL leave the `catch`.

#### Scenario: (e) Trace write throws

- **GIVEN** the `cancel_traces` table is gone
- **WHEN** a cancel fails
- **THEN** exactly 2 `[stage]` lines are logged
- **AND** no error leaves the call

### Requirement: Only the human clears a row

`POST /rooms/<room>/cancel-traces/<id>/clear` with body `{"by": "<name>"}` SHALL move an open row to `cleared`, set `cleared_at` and write one `cancel_trace.cleared` event in one transaction. `by` missing or unknown SHALL give 400. `by` that is not the human SHALL give 403. No token SHALL give 401. An unknown id or an id of another room SHALL give 404. A cleared row SHALL give 200 and no event. A cleared row SHALL NOT reopen. A refusal SHALL change no row and no event.

#### Scenario: (f) Human clears X

- **GIVEN** open rows X and Y
- **WHEN** the human clears X
- **THEN** only X is `cleared`
- **AND** X is not in `GET /rooms/<room>/cancel-traces`
- **AND** one `cancel_trace.cleared` event exists

#### Scenario: (f2) Same key after clear

- **GIVEN** a cleared row X
- **WHEN** the same failure happens again
- **THEN** no new row and no event exist

#### Scenario: (g) Refusals

- **GIVEN** an open row
- **WHEN** `by` is an agent, `by` is missing, a request has no token, or the id is unknown
- **THEN** the answer is 403, 400, 401 or 404
- **AND** the row stays open

### Requirement: Open rows survive a reconnect and a restart

`GET /rooms/<room>/cancel-traces` SHALL return the open rows of the room, read from the table.

#### Scenario: (h) Reconnect and new runtime

- **GIVEN** an open row
- **WHEN** the SSE stream reconnects, or a new runtime opens the same ledger
- **THEN** the row is in the answer

### Requirement: The error text is redacted and capped

The stored `error` SHALL be `redactPrivateText` of the message, cut to 500 characters with one `...` (the 500 include it).

#### Scenario: (i) Private part

- **GIVEN** an error with `<private>x</private>`
- **WHEN** the row is written
- **THEN** the stored text has no private part

#### Scenario: (j) Long error

- **GIVEN** an error of 2,000 characters
- **WHEN** the row is written
- **THEN** the stored error has 500 characters and ends with one `...`

### Requirement: The Needs-you region shows each open row

The UI SHALL show one line per open row: stage, ticket (or "no ticket"), caller and error. The error SHALL be set with `textContent`. The UI SHALL read the rows again on `stage.*` and `cancel_trace.*` events. Clear SHALL call the route, then move focus to the next line, else to the region. A failed Clear SHALL keep the line.

#### Scenario: (k) No ticket

- **GIVEN** an open row with a null `ticket_id`
- **WHEN** the region renders
- **THEN** the line shows "no ticket"
