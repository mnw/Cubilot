## Purpose

Lets the human approve the plan of a request once, at the start, and lets the factory continue without a new Approve while the scope stays as approved. A request that the factory makes for itself with only low-radius tickets and no new feature needs no Approve.

## ADDED Requirements

### Requirement: A request is a Kind with an origin and a list of features
The hub SHALL keep a `request` Kind with room, request id, `origin` (`human` or `factory`), `features` (a list of strings), `parent_request_id`, `source` and the approved scope. `POST /requests` and the `create_request` tool SHALL create one (room lead or human). The default origin SHALL be `human`. Only the human SHALL change the origin.

#### Scenario: Default origin
- **WHEN** the room lead creates request `r-1` with two features and no origin
- **THEN** `r-1` has origin `human` and the two features

#### Scenario: Lead changes the origin
- **WHEN** the room lead edits the origin of `r-1` to `factory`
- **THEN** the hub returns 403

### Requirement: A factory request names its source
An agent's request with origin `factory` SHALL name in `source` a ticket, a decision or a stage of the same room, and SHALL name `parent_request_id` when the source belongs to a request. Else the hub SHALL return 400. Hub code SHALL create factory requests for arbiter follow-ups.

#### Scenario: No source
- **WHEN** the lead creates a request with origin `factory` and no `source`
- **THEN** the hub returns 400

### Requirement: A ticket names an existing request
A ticket create or edit with a `request_id` that has no request in the room SHALL get 400 "create the request first". A ticket without `request_id` SHALL be queued only by the human.

#### Scenario: Unknown request
- **WHEN** the lead creates a ticket with `request_id: r-9` and no request `r-9` exists
- **THEN** the hub returns 400

### Requirement: An Approve records the approved scope
The human's Approve SHALL write one `request.approved` event and the approved scope in its own transaction, before the transaction that queues the draft tickets. The scope SHALL hold the features and, for each ticket that is not `cancelled`, its id and its radius. A repeated Approve SHALL queue the drafts that are left. Only the human SHALL approve.

#### Scenario: Approve a plan
- **WHEN** the human approves request `r-1` with tickets `t1` (low) and `t2` (high)
- **THEN** the approved scope holds the features, `t1` low and `t2` high

#### Scenario: Agent approves
- **WHEN** the room lead calls the approve route
- **THEN** the hub returns 403 and writes nothing

### Requirement: Code decides what a scope change is
After an Approve, the scope SHALL be changed when: (a) a ticket of the request is not `cancelled` and is not in the approved scope; (b) an approved ticket is `cancelled` or has another `request_id`; (c) an approved ticket's radius is now higher; (d) the features differ from the approved features. A criteria edit, a title, `blocked_by`, role or priority edit SHALL NOT be a scope change. The check SHALL read only the ledger.

#### Scenario: Criteria edit
- **GIVEN** request `r-1` is approved
- **WHEN** the Orchestrator rewrites a criteria line of `t1` and changes its `blocked_by`
- **THEN** the scope of `r-1` is not changed

#### Scenario: New ticket
- **WHEN** the Orchestrator creates ticket `t3` in `r-1` after the Approve
- **THEN** the scope of `r-1` is changed

#### Scenario: Radius raised
- **WHEN** approved low ticket `t1` becomes high
- **THEN** the scope of `r-1` is changed

#### Scenario: Removed ticket
- **WHEN** approved ticket `t2` is cancelled
- **THEN** the scope of `r-1` is changed

#### Scenario: Feature added
- **WHEN** the lead adds a feature to `r-1`
- **THEN** the scope of `r-1` is changed

### Requirement: Code decides which request needs the human's Approve
A request SHALL need the human's Approve when its origin is `human`, or when its origin is `factory` and it has a ticket with `blast_radius: high` that is not `cancelled` or a non-empty features list. Such a request SHALL be queued without the human only when it has an Approve and its scope is not changed. A factory request that needs no Approve SHALL be queued by a spec PASS or by the room lead.

#### Scenario: Human request, low radius
- **GIVEN** request `r-1` has origin `human` and only low tickets, and no Approve
- **WHEN** its spec review passes
- **THEN** its tickets stay `draft` and `r-1` is shown as waiting for approval

#### Scenario: Factory request, low radius
- **GIVEN** request `r-1-followup` has origin `factory`, no features and one low ticket
- **WHEN** its spec review passes
- **THEN** its ticket is `queued` and the human did nothing

#### Scenario: Factory request, high radius
- **GIVEN** a factory request with one high ticket and no Approve
- **WHEN** its spec review passes
- **THEN** its tickets stay `draft` and the request waits for approval

### Requirement: The room lead's queue follows the Approve rule
The room lead's move `draft → queued` SHALL get 403 "the request needs the human's Approve" when the request needs an Approve and has none or its scope changed. The human SHALL always queue.

#### Scenario: Edit and new spec PASS
- **GIVEN** human request `r-1` is approved and `t1` went back to `draft` after a criteria edit
- **WHEN** the spec review of `t1` passes
- **THEN** `t1` is `queued` and the human did nothing

#### Scenario: New ticket needs a new Approve
- **GIVEN** human request `r-1` is approved and the Orchestrator created `t3`
- **WHEN** the spec review of `t3` passes
- **THEN** `t3` stays `draft` and `r-1` is shown as waiting for approval

### Requirement: The Approve card shows the scope
The card of a request that waits for approval SHALL show its origin, its features, and each ticket with its radius, the radius source and the matched radius terms. When an earlier Approve exists, it SHALL list each scope change: added and removed tickets, raised radii, added and removed features.

#### Scenario: Second Approve
- **GIVEN** request `r-1` was approved and then `t3` was added
- **THEN** the card names `t3` as added and shows its radius

### Requirement: Existing requests keep their state at the migration
The migration SHALL create one request, origin `human`, no features, for each `request_id` of the ledger. A request with a ticket in a status after `draft` SHALL get an Approve by `system` with its tickets that are not `cancelled`.

#### Scenario: Request in progress
- **GIVEN** before the migration, `r-0` has one `in_progress` ticket
- **WHEN** the hub starts with the new schema
- **THEN** `r-0` exists with origin `human` and an Approve, and its scope is not changed
