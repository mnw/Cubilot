## ADDED Requirements

### Requirement: Tickets of one request share a request label

A ticket SHALL carry an optional `request_id`, a label that matches `^[A-Za-z0-9._-]{1,64}$`. All tickets of one human request SHALL carry the same label. The hub SHALL store no request entity: a request is the set of tickets in one Room with the same label. Ticket responses and broadcast entries SHALL carry `request_id` (or `null`). `GET /tickets` and `list_tickets` SHALL filter by `request_id`.

#### Scenario: A label groups tickets

- **WHEN** the Orchestrator creates three tickets with `request_id` `r-2026-10-22-login`
- **THEN** a list filtered by that label returns the three tickets and no others

#### Scenario: An invalid label is refused

- **WHEN** a ticket is created with `request_id` `"bad label!"`
- **THEN** the hub returns HTTP 400 and persists nothing

### Requirement: A ticket names the tickets that block it

A ticket SHALL carry an optional `blocked_by` list of at most 20 ticket ids. Each id SHALL name an existing ticket in the same Room and SHALL NOT name the ticket itself. The list SHALL NOT make a cycle. The hub SHALL store the list in `ticket_blockers` in the same transaction as the event that sets it. Ticket responses and broadcast entries SHALL carry `blocked_by` and `open_blockers` (the ids that are not `done`).

#### Scenario: A cycle is refused

- **GIVEN** B is blocked by A and C is blocked by B
- **WHEN** an edit sets A's `blocked_by` to [C]
- **THEN** the hub returns HTTP 400 that names the cycle and persists nothing

#### Scenario: A blocker in another Room is refused

- **WHEN** a ticket's `blocked_by` names a ticket in another Room
- **THEN** the hub returns HTTP 400 and persists nothing

#### Scenario: The list and the event are one transaction

- **WHEN** `edit_ticket` replaces a ticket's `blocked_by`
- **THEN** one `ticket.edited` event and the `ticket_blockers` rows commit in one transaction

### Requirement: A ticket cannot be claimed while a blocker is not done

A claim by an agent SHALL get HTTP 409 `blocked by <id> (<status>)` while any ticket in the ticket's `blocked_by` is not `done`. A `cancelled` blocker still blocks. The human SHALL NOT be gated.

#### Scenario: A blocked ticket refuses a claim

- **GIVEN** ticket B has `blocked_by` [A] and A is `in_progress`
- **WHEN** an agent claims B
- **THEN** the hub returns HTTP 409 `blocked by A (in_progress)` and B does not change

#### Scenario: The ticket unblocks when its blocker is done

- **GIVEN** ticket B has `blocked_by` [A]
- **WHEN** A moves to `done` and an agent then claims B
- **THEN** the claim succeeds

### Requirement: A draft ticket cannot be claimed and wakes no one

A `draft` ticket SHALL NOT be claimed (HTTP 409). `ticket.new` and `ticket.assigned` SHALL wake no one while the ticket is `draft`, and the room lead SHALL NOT be woken to triage it. The normal wakes SHALL run when the ticket moves to `queued`.

#### Scenario: A draft cannot be claimed

- **WHEN** an agent claims a `draft` ticket
- **THEN** the hub returns HTTP 409 and the ticket does not change

#### Scenario: A draft wakes no one until it is queued

- **GIVEN** a `draft` ticket assigned to `worker-1`
- **WHEN** the room lead moves it to `queued`
- **THEN** `worker-1` is woken once, and was not woken before the move

### Requirement: The human or the room lead approves a draft

The human or the room lead SHALL move a ticket from `draft` to `queued`. The room lead SHALL get HTTP 403 when a non-terminal ticket with the same `request_id` has `blast_radius: high`. A ticket without `request_id` is checked alone. The human or the room lead SHALL move a ticket from `queued` back to `draft`. From a later status only the human SHALL do it. The `transition_ticket` tool SHALL offer `draft` and `queued`.

#### Scenario: A high request needs the human

- **GIVEN** a request with two `draft` tickets, one of them `blast_radius: high`
- **WHEN** the room lead moves the low ticket to `queued`
- **THEN** the hub returns HTTP 403
- **AND** the same move by the human succeeds

### Requirement: Request and blockers freeze after the claim

`request_id` and `blocked_by` SHALL be changed only by the human, the creator or the room lead. They SHALL change only while the ticket is `draft` or `queued`, except by the human.

#### Scenario: Blockers freeze after the claim

- **WHEN** an agent edits `blocked_by` of a `claimed` ticket
- **THEN** the hub returns HTTP 409
- **AND** the same edit by the human succeeds

## MODIFIED Requirements

### Requirement: Ticket lifecycle is a state machine with one event per transition

A ticket SHALL move through `draft → queued → claimed → in_progress → in_review → done`, with
`in_review → in_progress` for rework, `queued → draft` to send a planned ticket back to review,
and `cancelled` reachable from any non-terminal status. A ticket MAY start in `queued` without
passing through `draft`. `done` and `cancelled` are terminal. Every transition SHALL write exactly one row
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

### Requirement: Any agent in the Room may claim a queued ticket

Claiming SHALL be first-come and SHALL set `assignee` to the claiming actor. Any agent in
the ticket's Room, or the human, MAY claim a `queued` ticket whose blockers are all `done`.
Claiming a ticket that is already claimed by another actor SHALL conflict rather than reassign.
A `draft` ticket, or a ticket with an open blocker, SHALL refuse an agent's claim with HTTP 409.

#### Scenario: First claim wins

- **WHEN** two agents in the Room claim the same `queued` ticket
- **THEN** the first transaction to commit sets `assignee` and moves the ticket to `claimed`
- **AND** the second receives HTTP 409 with the ticket unchanged

#### Scenario: Claim by an agent outside the Room is refused

- **WHEN** an agent whose room differs from the ticket's room attempts a claim
- **THEN** the hub returns HTTP 403

#### Scenario: Claim of a draft or blocked ticket is refused

- **WHEN** an agent claims a `draft` ticket, or a `queued` ticket with an open blocker
- **THEN** the hub returns HTTP 409 and the ticket does not change

### Requirement: A ticket may be created in any column

`POST /tickets` SHALL accept a `status` of `queued` (the default), `draft`, `in_progress`, `in_review` or `done`,
with or without an `assignee`. The ticket SHALL be created in that status by the single
`ticket.created` event, and SHALL stay there until it is assigned or moved. Creating a ticket as
`done` SHALL be allowed to the human only, and needs no approval request, as the human completes
directly. Any other status value, `claimed` and `cancelled` included, SHALL get HTTP 400. A ticket
that is outside `queued` and `draft` and has no assignee SHALL be moved only by the human until it is assigned.

#### Scenario: Created in a column

- **WHEN** an agent creates a ticket with `status` `in_progress` and no assignee
- **THEN** the ticket is `in_progress` and unassigned, with one `ticket.created` event
- **AND** an agent that is not its assignee cannot move it; the human can, and so can the assignee once it is assigned

#### Scenario: Done at creation is the human's

- **WHEN** an agent creates a ticket with `status` `done`
- **THEN** the hub returns HTTP 403 and persists nothing
- **AND** the same request from the human succeeds, also for a `high` radius ticket, with no permission request

#### Scenario: Created as a draft

- **WHEN** the Orchestrator creates a ticket with `status` `draft`
- **THEN** the ticket is `draft`, with one `ticket.created` event, and no one is woken

### Requirement: The Room backlog is ordered and queryable

The hub SHALL expose the tickets of one Room ordered by `priority` from `highest` to
`lowest`, then `created_at` ascending. The hub SHALL store `priority` as a rank
(`highest` 5 … `lowest` 1) and SHALL answer 400 for any other value, including an integer;
a stored rank outside 1–5 SHALL read and sort as `medium`. Listing SHALL be a read route. The webview SHALL render that
Room's tickets as a five-column board — `draft`, `queued`, `in progress` (covering `claimed` and
`in_progress`), `in review`, `done` — and nothing else: `cancelled` tickets do not appear
on the board (`list_tickets` and the list route with `status=all` still return them).
Each card SHALL show its assignee and blast radius, its `request_id` when it has one, and a blocked mark with the count of open blockers when it has any.
Each column SHALL end with a `+`
control that opens the ticket form in a modal. On save, the ticket SHALL be created and
then moved into that column through the ordinary verbs, with the human as the actor
(claim, then each transition). A ticket saved from the `draft` column SHALL be created as `draft`. A failed move SHALL leave the ticket in the last column it
reached and report the error.

#### Scenario: Backlog ordering

- **WHEN** a Room contains tickets of priority `high`, `low` and `high`
- **THEN** both `high` tickets precede the `low` ticket
- **AND** the older of the two `high` tickets is listed first

#### Scenario: Priority is a name, not a number

- **WHEN** a ticket is created with `priority: 3` or `priority: "urgent"`
- **THEN** the hub answers 400 `invalid priority`
- **AND** a ticket created without `priority` has `priority: "medium"`

#### Scenario: Board groups by status with the assignee visible

- **WHEN** a Room contains tickets across several statuses
- **THEN** each appears in the column for its status, priority-ordered within the column
- **AND** each card shows its assignee, so two agents cannot unknowingly work the same item

#### Scenario: A ticket created from a column lands in that column

- **WHEN** the human saves the form opened from the `in review` column's `+`
- **THEN** the webview creates the ticket, claims it as the human, and moves it
  `in_progress` then `in_review`
- **AND** a ticket saved from the `queued` column is only created

#### Scenario: A blocked card shows its blockers

- **WHEN** a `queued` ticket has two blockers that are not `done`
- **THEN** its card shows the blocked mark with the count 2
