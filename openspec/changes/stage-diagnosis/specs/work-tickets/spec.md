## MODIFIED Requirements

### Requirement: Ticket lifecycle is a state machine with one event per transition

A ticket SHALL move through `draft → queued → claimed → in_progress → in_review → done`, with
`in_review → in_progress` for rework, `queued → draft` to send a planned ticket back to review,
and `cancelled` reachable from any non-terminal status. A ticket MAY start in `queued` without
passing through `draft`. `done` and `cancelled` are terminal, except that the human MAY reopen a cancelled gap ticket. Every transition SHALL write exactly one row
in the shared `events` table and one `tickets` row update inside a single SQLite
transaction, and its broadcast SHALL carry `version` equal to that event's `seq`.

#### Scenario: Transition writes a single atomic event

- **WHEN** a ticket transitions from `claimed` to `in_progress`
- **THEN** one `events` row and one `tickets` row update are committed in one transaction
- **AND** the broadcast carries `version` equal to that event's `seq`

#### Scenario: Same-status retry is idempotent

- **WHEN** a transition to `in_progress` is requested for a ticket already `in_progress`
- **THEN** the hub returns HTTP 200 and writes no new event

#### Scenario: Different-status retry conflicts

- **WHEN** a transition to `in_progress` is requested for a ticket already `done`
- **THEN** the hub returns HTTP 409 and writes no new event

#### Scenario: Draft to queued is one event

- **WHEN** the room lead moves a `draft` ticket to `queued`
- **THEN** one `ticket.queued` event and one `tickets` row update are committed in one transaction

#### Scenario: Cancelled ticket without a cause key stays cancelled

- **WHEN** the human asks to reopen a `cancelled` ticket that has no cause key
- **THEN** the hub returns HTTP 409 and writes no new event

## ADDED Requirements

### Requirement: A gap ticket cancel can ignore its cause
A cancel of a ticket with a cause key SHALL accept an optional `ignore_cause` (boolean, default false), stored with the `ticket.cancelled` event and on the ticket. Only the human SHALL set it to true; an agent that sends true SHALL get HTTP 403 and nothing SHALL change. A cancel without it SHALL leave the cause key active.

#### Scenario: Cancel and ignore
- **WHEN** the human cancels a gap ticket with `ignore_cause: true`
- **THEN** the ticket is `cancelled` with `cause_ignored` true in one event and one row update

#### Scenario: Plain cancel
- **WHEN** the creator cancels a gap ticket without `ignore_cause`
- **THEN** the ticket is `cancelled` and its cause key is not ignored

#### Scenario: Agent cannot ignore
- **WHEN** an agent cancels a gap ticket with `ignore_cause: true`
- **THEN** the hub returns HTTP 403 and the ticket does not change

### Requirement: The human reopens a cancelled gap ticket
The human SHALL move a `cancelled` ticket that has a cause key to `draft`, with one `ticket.reopened` event and one row update. The reopen SHALL set `cause_ignored` to false. Agents SHALL get HTTP 403.

#### Scenario: Reopen ends the ignore
- **WHEN** the human reopens a gap ticket that was cancelled with `ignore_cause: true`
- **THEN** the ticket is `draft`, `cause_ignored` is false, and its cause key is open again

#### Scenario: Agent reopen
- **WHEN** an agent asks to reopen a cancelled gap ticket
- **THEN** the hub returns HTTP 403 and writes no event
