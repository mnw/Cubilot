# work-tickets Specification

## Purpose
TBD - created by archiving change ticket-kind. Update Purpose after archive.

## Requirements

### Requirement: Tickets are Room-scoped work items that exist before they have an owner

The hub SHALL persist a `ticket` kind whose rows are scoped to exactly one Room and
which require no assignee at creation. A ticket SHALL carry `title`,
`acceptance_criteria`, `blast_radius` (`low` or `high`), `priority` (`highest` | `high` | `medium` | `low` | `lowest`, default `medium`), `room`,
`creator`, an optional `assignee`, an optional `approval_request_id`, and an optional `external_ref` naming the work item in an
outside tracker (for example `EUSPACE-246`). `external_ref` SHALL be an opaque string:
the hub never parses, validates against, or synchronises with the external system.

#### Scenario: Ticket created without an assignee

- **WHEN** an agent or the human POSTs a ticket with a title, acceptance criteria and a room
- **THEN** the ticket is persisted with status `queued` and `assignee` null
- **AND** the creation is broadcast to that Room's members with `version = events.seq`

#### Scenario: Acceptance criteria are mandatory

- **WHEN** a ticket is created with missing or empty `acceptance_criteria`
- **THEN** the hub returns HTTP 400 and persists nothing

#### Scenario: External reference is carried, not interpreted

- **WHEN** a ticket is created with `external_ref` set to `EUSPACE-246`
- **THEN** the value is persisted verbatim and returned on the snapshot
- **AND** no request is made to any external system

#### Scenario: Cross-room creation is refused for non-human senders

- **WHEN** an agent in room `A` creates a ticket naming room `B`
- **THEN** the hub returns HTTP 403
- **AND** the same request from the human succeeds

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

### Requirement: The human or the creator may assign a ticket to an agent of its Room

A ticket MAY be created with an `assignee`, and `POST /tickets/:id/assign` SHALL set or change
the `assignee` of a ticket that is not `done` or `cancelled`. Only the human, the ticket's
creator and the Room's lead MAY assign. The assignee SHALL be a registered agent in the ticket's Room: an unknown
name or the human gets HTTP 400, an agent of another Room gets HTTP 403. Assigning SHALL NOT change
the ticket's `status`, SHALL write one `ticket.assigned` event and one `tickets` update in one
transaction, SHALL broadcast to the Room, and SHALL schedule a Briefing refresh. Assigning the
current assignee SHALL be an idempotent no-op. An `assignee` of `null` SHALL unassign a `queued` ticket and
SHALL be refused with HTTP 409 for any other status. A `queued` ticket with an assignee SHALL be claimable
only by that assignee: any other actor, the human included, gets HTTP 409 `assigned to <name>`.
Changing the assignee of a ticket in `in_review` SHALL clear its `approval_request_id` and dismiss a
still-pending request, as rework does.

#### Scenario: Assigning keeps the status

- **GIVEN** a `queued` ticket created by `alice`
- **WHEN** `alice` or the human assigns it to `bob`
- **THEN** the ticket stays `queued` with `assignee` `bob`, one `ticket.assigned` event is written, and the Room receives the update
- **AND** the ticket is in `bob`'s Briefing

#### Scenario: Only the assignee claims an assigned ticket

- **GIVEN** a `queued` ticket assigned to `bob`
- **WHEN** `carol` or the human claims it
- **THEN** the hub returns HTTP 409 `assigned to bob` and the ticket is unchanged
- **AND** `bob`'s claim moves it to `claimed`

#### Scenario: Unassigning a queued ticket

- **GIVEN** a `queued` ticket assigned to `bob`
- **WHEN** the human or the creator assigns `null`
- **THEN** the ticket stays `queued` with no assignee, and any agent of the Room may claim it
- **AND** the same request on a `claimed` or `in_progress` ticket returns HTTP 409 and changes nothing

#### Scenario: Assignment refusals

- **WHEN** an agent that is neither the human nor the creator assigns, or the assignee is unknown, the human, or in another Room, or the ticket is `done` or `cancelled`
- **THEN** the hub answers 403, 400, 400, 403 and 409 respectively and writes nothing

#### Scenario: Reassigning a ticket in review voids its approval

- **GIVEN** a `high` radius ticket in `in_review` with a pending approval request
- **WHEN** the human assigns it to another agent
- **THEN** `approval_request_id` is cleared and the pending request is dismissed in its own transaction

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

### Requirement: The human sets a lead agent per Room, and the lead triages unassigned tickets

The hub SHALL keep at most one lead agent per Room. `POST /rooms/:room/lead` with `{by, agent}` SHALL
set it, and an `agent` of `null` SHALL clear it. Only the human MAY set it (HTTP 403 otherwise). The
agent SHALL be a registered agent of that Room: an unknown name or the human gets HTTP 400, an agent
of another Room gets HTTP 403. A change SHALL write one event and schedule a Briefing refresh.
`GET /rooms/:room/lead` SHALL return `{room, lead}`, where `lead` is null when none is set or the stored
agent is no longer a registered agent of the Room. The lead MAY assign, reassign and unassign tickets of
its Room, as the human and the creator may. The `ticket.new` entry of a ticket without an assignee SHALL
carry `lead` (the room lead or null), and so SHALL the `ticket.assigned` entry of an unassign, because
the ticket is back in triage; an entry of an assigned ticket SHALL NOT. The lead's Briefing SHALL
list the open tickets of its Room that have no assignee, under the heading "Unassigned tickets to
triage:" and a line that tells it to use `assign_ticket`, highest priority first, in addition to its own
tickets. No other agent's Briefing has it. A change of the lead SHALL be announced to the UI as an
ambient `room.lead` entry that is not a `ticket.*` kind, so that no agent receives it.

#### Scenario: Only the human sets the lead

- **WHEN** an agent, the future lead included, posts to `/rooms/r1/lead`
- **THEN** the hub returns HTTP 403 and the lead is unchanged
- **AND** the human's request with a registered agent of `r1` sets it, and a name that is unknown, the human, or in another Room gets 400, 400 and 403

#### Scenario: The lead triages

- **GIVEN** `bob` is the lead of `r1` and two unassigned tickets are open there
- **THEN** `bob`'s Briefing lists both under "Unassigned tickets to triage:"
- **WHEN** `bob` assigns one to `carol`
- **THEN** that ticket leaves the list, and `carol`'s Briefing lists it as hers

#### Scenario: A lead change reaches the board only

- **WHEN** the human sets or clears the lead of `r1`
- **THEN** the UI stream receives one `room.lead` entry with the new `lead`
- **AND** no agent stream receives it

#### Scenario: A new unassigned ticket names the lead

- **GIVEN** `bob` is the lead of `r1`
- **WHEN** `alice` creates a ticket with no assignee
- **THEN** the `ticket.new` entry carries `lead` `bob`
- **AND** the entry of a ticket created with an assignee carries no `lead`

### Requirement: Finished tickets may be archived without changing their status

`POST /tickets/:id/archive` with `{by, archived}` SHALL set or clear an `archived_at_ms` flag on a `done` or
`cancelled` ticket; any other status SHALL get HTTP 409. Only the human and the Room's lead MAY archive or
unarchive (HTTP 403 otherwise). The status SHALL NOT change. A change SHALL write one `ticket.archived`
event and one `tickets` update in one transaction; a request that changes nothing SHALL be an idempotent
no-op. The update SHALL be sent to the UI stream only (an ambient entry), never to an agent. `GET /tickets`
SHALL hide archived tickets unless `archived=1` is given, and an archived ticket SHALL appear in no agent's
Briefing and in no `list_tickets` result.

#### Scenario: Archive and unarchive

- **GIVEN** a `done` ticket
- **WHEN** the human or the room lead archives it
- **THEN** it is still `done`, carries `archived_at_ms`, and one `ticket.archived` event is written
- **AND** `GET /tickets` omits it, and `GET /tickets?archived=1` lists it
- **WHEN** the human unarchives it
- **THEN** `archived_at_ms` is null and the default list shows it again

#### Scenario: Only finished tickets, only the human or the lead

- **WHEN** a ticket that is not `done` or `cancelled` is archived
- **THEN** the hub returns HTTP 409 and changes nothing
- **AND** the assignee, the creator or any other agent that archives gets HTTP 403

#### Scenario: Agents never see it

- **WHEN** a ticket is archived
- **THEN** no agent stream receives an entry for it
- **AND** its assignee's Briefing and the `list_tickets` tool do not list it

### Requirement: A ticket keeps append-only notes as an audit trail

A ticket SHALL have append-only notes (`author`, `text`, `created_at_ms`), each written in the same
transaction as the one event that records it. An agent that moves a ticket to `in_review` SHALL send a
non-empty `note` of at most 4096 UTF-8 bytes saying how the work was implemented and tested; without
it the hub SHALL return HTTP 400 and change nothing. The human MAY move without a note. The move and
its note SHALL be one event and one transaction, so a note that cannot be written fails the move. A repeat
move that changes nothing SHALL store no note. `POST /tickets/:id/notes` with `{by, text}` SHALL let the
ticket's assignee or the human add a note at any time, also after the ticket is done, cancelled or
archived (HTTP 403 for anyone else), as one `ticket.noted` event that leaves the ticket itself unchanged.
`GET /tickets/:id/notes` SHALL return the notes oldest first, and each ticket in `GET /tickets` SHALL
carry `notes_count`. Notes are for the audit trail and SHALL NOT replace chat messages: they SHALL NOT
appear in any agent's Briefing, and the text of a note SHALL be sent to the UI stream only.

#### Scenario: Handing a ticket in for review needs a note

- **GIVEN** an `in_progress` ticket assigned to `bob`
- **WHEN** `bob` moves it to `in_review` with no note, a blank note, or a note over 4096 bytes
- **THEN** the hub returns HTTP 400 and the ticket stays `in_progress`
- **WHEN** `bob` sends a note
- **THEN** the ticket is `in_review`, one event is written, and the note is stored with that event's seq as its id

#### Scenario: The human may move without a note

- **WHEN** the human moves the ticket to `in_review` with no note
- **THEN** the move succeeds and no note is stored

#### Scenario: Adding notes later

- **WHEN** the assignee or the human posts a note to a ticket in any status
- **THEN** one `ticket.noted` event is written and the note is listed after the earlier ones
- **AND** any other agent gets HTTP 403

#### Scenario: A failed note fails the move

- **WHEN** the note of a move to `in_review` cannot be written
- **THEN** the ticket stays as it was and no event is written

#### Scenario: Notes stay out of the agents' context

- **WHEN** a note is stored
- **THEN** the `ticket.update` entry of the move, which reaches the Room's agents, carries `notes_count` but not the text
- **AND** the `ticket.noted` entry of a later note goes to the UI stream only

### Requirement: A ticket may link files that were uploaded through the upload route

`POST /tickets/:id/attachments` with `{by, url, name}` SHALL link a file to a ticket. The file SHALL already be
uploaded through `/upload`, so the upload route's allowlist, size cap and file mode apply to it; the URL SHALL
be of the form `/image/<id>.<ext>`, the extension SHALL be on the upload allowlist when the link is made, and the file SHALL
exist; otherwise the hub SHALL return HTTP 400. The default allowlist SHALL be `jpg`, `jpeg`, `png`, `pdf`, `md` and
`txt`, and `config.yml` MAY override it. Only the human, the ticket's creator and its assignee MAY link a file
(HTTP 403 otherwise), at any ticket status, archived included. A link SHALL be append-only and SHALL write one
`ticket.attached` event and one row in one transaction, leaving the ticket's version unchanged. Linking a file that
is already linked to the ticket SHALL be an idempotent no-op. `GET /tickets/:id/attachments` SHALL list the links
oldest first with the path an agent reads, and each ticket in `GET /tickets` SHALL carry `attachments_count`. The
link SHALL be sent to the UI stream only; no agent receives an entry for it.

#### Scenario: Linking an uploaded file

- **GIVEN** a `.txt` file uploaded through `/upload`
- **WHEN** the assignee links it with a name
- **THEN** one `ticket.attached` event is written and the list shows the link with its path and `attachments_count` 1
- **AND** the same request for the same file writes nothing more

#### Scenario: Only uploaded files of allowed types

- **WHEN** the URL is not an `/image/<id>.<ext>` URL, its extension is off the allowlist, or the file does not exist
- **THEN** the hub returns HTTP 400 and links nothing

#### Scenario: Only the human, the creator or the assignee

- **WHEN** any other agent links a file
- **THEN** the hub returns HTTP 403 and links nothing

### Requirement: Only the owner or the human moves a claimed ticket

Only the assignee or the human SHALL move a claimed ticket to `in_progress`,
`in_review` or `done`, or back from `in_review` to `in_progress`. Only the assignee, the
creator or the human SHALL cancel a ticket. The event SHALL record the actor.

#### Scenario: Another agent cannot advance a ticket it does not own

- **WHEN** agent `carol` requests `in_review` for a ticket assigned to `bob`
- **THEN** the hub returns HTTP 403 and the ticket is unchanged

#### Scenario: The human may move any ticket

- **WHEN** the human moves `bob`'s ticket from `in_review` back to `in_progress`
- **THEN** the transition succeeds and its event records the human as the actor

#### Scenario: The creator may cancel

- **WHEN** the agent that created a ticket cancels it while `bob` owns it
- **THEN** the ticket becomes `cancelled`

### Requirement: High-blast-radius tickets complete only with the human's approval

A transition to `done` SHALL succeed when `blast_radius` is `low`, when the human
requests it, or when the permission request named by the ticket's `approval_request_id`
has `status` `allowed` and `resolved_by` equal to the configured human name. Otherwise the
hub SHALL return HTTP 409 with the current `approval_request_id`. The hub SHALL expose
`POST /tickets/:id/approval` for the assignee of an `in_review` ticket with `high`
radius. When `approval_request_id` names a `pending` request, or a request that is
`allowed` with `resolved_by` equal to the configured human name, the route SHALL return it
(`created: false` and its `status`) and write nothing: the human's Allow is never replaced.
Otherwise (no pointer, or a request that is `denied`, `dismissed`, or `allowed` by anyone
but the human) it SHALL create a `permission` request with `tool_name`
`ticket:done` and `input_preview` `{"ticket_id":"<id>"}` and set `approval_request_id` to
it, in ONE SQLite transaction that writes exactly one event (`permission.new`). The
`in_review → in_progress` transition SHALL clear `approval_request_id`. The
`permission` kind's verbs and routes SHALL NOT change.

#### Scenario: High radius without the human's approval is blocked

- **WHEN** the assignee requests `done` for a `high` radius ticket with no request allowed by the human
- **THEN** the hub returns HTTP 409 with the current `approval_request_id` and the ticket stays `in_review`

#### Scenario: Approval request and ticket link are atomic

- **WHEN** the assignee calls the approval route and no request is pending
- **THEN** one transaction writes one `permission.new` event, the `permissions` row and the ticket's `approval_request_id`

#### Scenario: Repeated approval calls make no duplicate card

- **WHEN** the assignee calls the approval route twice while the request is pending
- **THEN** both calls return the same request id
- **AND** only one `ticket:done` permission request exists for the ticket

#### Scenario: The human's Allow between the blocked move and the approval call is kept

- **GIVEN** the assignee's `done` was blocked with the pending request `R`
- **WHEN** the human allows `R` before the assignee calls the approval route
- **AND** the assignee calls the approval route
- **THEN** the route returns `R` with `created: false` and `status: "allowed"`, and creates no request
- **AND** the `transition_ticket` tool retries the move once, and the ticket becomes `done`
- **AND** exactly one `ticket:done` request exists for the ticket

#### Scenario: The human allows, then the ticket completes

- **WHEN** the human allows the request named by `approval_request_id`
- **AND** the assignee requests `done`
- **THEN** the ticket becomes `done` and the completion is broadcast to the Room

#### Scenario: An agent's Allow does not block a later human approval

- **WHEN** another agent allows the pending request
- **THEN** a `done` request returns HTTP 409
- **AND** the next approval call creates a new request and points the ticket at it
- **AND** the human's Allow on the new request lets the ticket complete

#### Scenario: Rework requires a fresh approval

- **GIVEN** the human allowed the ticket's approval request
- **WHEN** the assignee moves the ticket `in_review → in_progress → in_review` and requests `done`
- **THEN** the hub returns HTTP 409 because the rework cleared `approval_request_id`
- **AND** the ticket completes only after a new request is allowed by the human

#### Scenario: A request made moot is dismissed

- **GIVEN** a `high` radius ticket in `in_review` whose approval request is `pending`
- **WHEN** the ticket leaves `in_review` by rework, by cancel, or by the human's direct `done`
- **THEN** the hub dismisses that request in its own transaction after the ticket's (one event per transaction)
- **AND** the request is no longer `pending` and is not replayed to the assignee on reconnect
- **AND** a request that was already resolved is left as it is

#### Scenario: The human completes directly

- **WHEN** the human requests `done` for a `high` radius ticket
- **THEN** the ticket becomes `done` with no permission request

#### Scenario: Low radius needs no approval

- **WHEN** the assignee requests `done` for a `low` radius ticket
- **THEN** the ticket becomes `done` without any permission being consulted

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

### Requirement: The board shows each ticket's approval state

The list route SHALL return each ticket with `approval`: the `id`, `status`,
`resolved_by` and `version` of the request named by `approval_request_id`, or null. The webview SHALL
update a ticket's approval state from `permission.*` entries whose `tool_name` is
`ticket:done`. The `ticket_id` in `input_preview` SHALL be only a lookup hint: the
webview SHALL apply an entry only when its request id equals the ticket's current
`approval_request_id`, reconciled by the permission's `(id, max version)`, and SHALL
re-read the list route when an entry names a request it does not know for that ticket.

#### Scenario: A request raised by an agent appears on the board

- **WHEN** an agent's tool raises the approval request for a ticket
- **THEN** the board shows that ticket as waiting for the human's approval without a reload

#### Scenario: Unrelated and superseded requests do not replace the current approval

- **WHEN** an entry arrives for a `ticket:done` request that is not the ticket's current `approval_request_id` — an unrelated request naming the same `ticket_id`, or a late event of a superseded request
- **THEN** the card keeps its current approval state

#### Scenario: The human's verdict updates the card

- **WHEN** the human allows or denies the request
- **THEN** the card shows the verdict, and the ticket's own version is unchanged

### Requirement: Accepting a handoff claims the ticket it advances

A handoff SHALL accept an optional `context.ticket_id`. After the agent tool `accept_handoff` succeeds
for a handoff that names a ticket, the tool SHALL claim that ticket for the accepting
agent through the ordinary claim route. A claim that fails — HTTP 409, 403, 5xx or a
transport error — SHALL leave the accept in place, and the tool result SHALL state that the
handoff is accepted and name the claim outcome, without reporting a tool error. The hub's handoff kind SHALL NOT be modified, and no SQLite
transaction SHALL write events for both kinds.

#### Scenario: Accept claims an unclaimed ticket

- **WHEN** `bob` accepts a handoff whose `context.ticket_id` names a `queued` ticket in his Room
- **THEN** the handoff is accepted
- **AND** the ticket's `assignee` becomes `bob` and its status becomes `claimed`, as a separate transition

#### Scenario: Already-claimed or other-Room ticket is left alone

- **WHEN** the named ticket is already claimed, or belongs to another Room
- **THEN** the handoff is accepted and the ticket is not modified

#### Scenario: Claim failure after a successful accept is reported accurately

- **WHEN** the accept succeeds and the claim fails with a 5xx or a transport error
- **THEN** the tool result says the handoff is accepted and the claim failed, with the reason
- **AND** the tool call is not marked as an error

#### Scenario: Decline and cancel never move the ticket

- **WHEN** a handoff naming a `queued` ticket is declined or cancelled
- **THEN** the ticket remains `queued` and unassigned

#### Scenario: Handoff without a ticket reference is unaffected

- **WHEN** a handoff is created with no `context.ticket_id`
- **THEN** it is accepted exactly as before this change

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
