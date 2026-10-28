# spec-review-stage Specification

## Purpose
Agents claim tickets before anyone checks the plan of a request. A spec review by a Validator session checks the plan before any ticket of the request can start, so missing work, unclear criteria and wrong dependencies do not waste sessions.

## Requirements

### Requirement: A spec review is a stage of the request

The hub SHALL create one spec-review stage for a request when a handoff names `to_role: "validator"` with `review: "spec"` and a `request_id`. The stage SHALL NOT have a ticket. The handoff SHALL contain `request_text` and MAY contain `spec_paths`, `ticket_ids` and `commit`. When the sender is the human, `ticket_ids` SHALL be a non-empty list, and the room of the review SHALL be the room of those tickets. All named tickets SHALL be in one room. Otherwise the hub SHALL return HTTP 400 and record nothing. The error for a missing or empty list SHALL name `ticket_ids`. When the sender is an agent, the room of the review SHALL be the room of the agent.

#### Scenario: Spec handoff creates a stage

- **WHEN** the Orchestrator sends a handoff to `validator` with `request_id` `r-1` and `review` `spec`
- **THEN** the hub creates one spec-review stage for `r-1`
- **AND** the stage has no ticket id

#### Scenario: Missing request text

- **WHEN** a spec handoff has no `request_text`
- **THEN** the hub returns HTTP 400 and records nothing

#### Scenario: Human names tickets of two rooms

- **WHEN** the human sends a spec review whose `ticket_ids` name tickets in two rooms
- **THEN** the hub returns HTTP 400 and records no handoff, stage or event

#### Scenario: Human names no tickets

- **WHEN** the human sends a spec review with no `ticket_ids`, or with an empty list
- **THEN** the hub returns HTTP 400 with an error that names `ticket_ids`
- **AND** the handoff, stage and event counts do not change

### Requirement: The scope of a spec review holds draft tickets only

The scope of a spec review SHALL be the `ticket_ids` of the handoff. Without `ticket_ids`, for an agent sender only, the scope SHALL be every `draft` ticket of the request in the room. Every ticket in the scope SHALL be `draft` and SHALL carry the request id. Otherwise the hub SHALL return HTTP 400 and record nothing.

#### Scenario: Default scope

- **GIVEN** a request with three `draft` tickets and one `queued` ticket
- **WHEN** an agent sends a spec handoff that names no ticket ids
- **THEN** the scope holds the three `draft` tickets

#### Scenario: Ticket outside the draft state

- **WHEN** a spec handoff names a `queued` ticket
- **THEN** the hub returns HTTP 400 and records nothing

### Requirement: One live spec review per request

At most one spec-review stage of a request SHALL be `launching`, `running` or `retrying`. A later spec handoff for the same request SHALL create a stage in `queued` with its own scope. That stage SHALL wait until the live one ends.

#### Scenario: Second handoff waits

- **GIVEN** a spec-review stage for `r-1` is `running`
- **WHEN** a second spec handoff for `r-1` arrives
- **THEN** the hub creates a `queued` spec-review stage for `r-1`

### Requirement: The first message of a spec review holds the request

The first message of a spec-review session SHALL hold the request text, the scope tickets with their criteria, `blocked_by` and `blast_radius`, the spec paths, the worktree path and commit, and the findings of every FAIL verdict of the request since its last PASS verdict. It SHALL hold the line "This is spec review N of this request since its last PASS.", where N is the hub count of FAIL verdicts plus one. The role prompt SHALL NOT appear in the first message.

#### Scenario: Follow-up review gets earlier findings

- **GIVEN** the request `r-1` has one FAIL verdict with two findings
- **WHEN** a second spec review of `r-1` starts
- **THEN** its first message holds both findings
- **AND** its first message says "This is spec review 2 of this request since its last PASS."

### Requirement: A spec verdict uses the spec result schema

A spec-review result SHALL contain `review` `spec`, `request_id`, `verdict` `PASS` or `FAIL`, `findings`, `suggestions` and `questions_for_human`. Each finding SHALL have a `ticket_id` in the scope, a `severity` of `blocking` or `suggestion`, and `text`. A PASS SHALL have no `blocking` finding. A result that fails the check SHALL return its errors to the same session and SHALL NOT change the stage.

#### Scenario: Finding outside the scope

- **WHEN** a finding names a ticket id that is not in the scope
- **THEN** the hub returns the schema error to the same session

#### Scenario: PASS with a blocking finding

- **WHEN** a result has verdict `PASS` and one `blocking` finding
- **THEN** the hub returns the schema error to the same session

### Requirement: A PASS queues the scope tickets

A spec-review PASS SHALL write `stage.passed` with verdict `PASS` and one `ticket.queued` event for each scope ticket still in `draft`, in one transaction. The actor of each `ticket.queued` event SHALL be `system`. When the request has a non-terminal ticket with `blast_radius: high`, the transaction SHALL write only `stage.passed`, and the scope tickets SHALL stay `draft`.

#### Scenario: Normal PASS

- **GIVEN** a request with two scope tickets and no high ticket
- **WHEN** the Validator sends a PASS
- **THEN** both tickets are `queued`
- **AND** the ledger holds one `ticket.queued` event for each, by `system`

#### Scenario: PASS with a high ticket

- **GIVEN** a request with one `blast_radius: high` ticket
- **WHEN** the Validator sends a PASS
- **THEN** the scope tickets stay `draft`
- **AND** the request is shown as waiting for approval

### Requirement: The human approves a high-radius plan

The hub SHALL queue every `draft` ticket of a request when the human approves the plan. The route SHALL accept only the human. It SHALL write one `ticket.queued` event for each ticket in one transaction. Any other caller SHALL get HTTP 403 and the tickets SHALL stay `draft`.

#### Scenario: Human approves

- **GIVEN** a request waiting for approval with two `draft` tickets
- **WHEN** the human approves it
- **THEN** both tickets are `queued`

#### Scenario: Agent approves

- **WHEN** an agent calls the approval route
- **THEN** the hub returns HTTP 403 and no ticket changes

### Requirement: A FAIL verdict goes to the Orchestrator

A spec-review FAIL SHALL be recorded as `stage.passed` with verdict `FAIL`. The hub SHALL NOT move any ticket and SHALL NOT relaunch a session. The Validator SHALL send the result to the Orchestrator.

#### Scenario: FAIL

- **WHEN** the Validator sends a FAIL
- **THEN** no ticket changes state
- **AND** no session is relaunched

### Requirement: The second FAIL goes to the human

When the request has two spec verdicts of FAIL since its last PASS, the hub SHALL add a `ui-only` entry for the human that lists the open findings, and SHALL send the same text to the room lead. When the lead is the human, the hub SHALL send one copy. The hub SHALL show the same list in the "Needs you" area with the approvals. The open findings SHALL be the findings of the latest FAIL.

#### Scenario: Second FAIL

- **GIVEN** the request `r-1` has one FAIL verdict
- **WHEN** a second FAIL verdict arrives for `r-1`
- **THEN** the human sees a system entry with the open findings of the second FAIL
- **AND** the room lead receives the same text
- **AND** the "Needs you" area lists the same findings

#### Scenario: Lead is the human

- **GIVEN** the human is the room lead
- **WHEN** the second FAIL verdict arrives
- **THEN** exactly one notice is sent

### Requirement: An answered finding leaves the Needs-you list

The hub SHALL leave a finding out of the list when its ticket was answered after the latest FAIL stage ended. The ticket is also answered when it is `done` or `cancelled` now.

#### Scenario: Answered finding

- **GIVEN** a FAIL listed a finding for ticket `t-1`
- **WHEN** `t-1` gets a `ticket.edited` event that includes `acceptance_criteria` after the FAIL stage
- **THEN** the list leaves that finding out

### Requirement: Only some ticket events answer a finding

The ticket is answered when it has, with an event `seq` greater than the `stage.passed` event of that FAIL stage, a `ticket.done`, a `ticket.cancelled`, or a `ticket.edited` whose `fields` include `acceptance_criteria` or `title`. The kinds `ticket.assigned`, `ticket.noted`, `ticket.attached`, `ticket.archived` and any other edit SHALL NOT answer it.

#### Scenario: Assigned ticket stays listed

- **GIVEN** a FAIL listed a finding for ticket `t-1`
- **WHEN** `t-1` gets a `ticket.assigned` event after the FAIL stage
- **THEN** the list keeps that finding

### Requirement: A fully answered or finished request leaves the Needs-you area

The hub SHALL leave the request out when every finding of a FAIL that listed findings is left out. The hub SHALL also leave the request out when it has one or more tickets in the room and all are `done` or `cancelled`. A request with no ticket left in it stays listed. Each item SHALL carry `latest_fail_stage_id`, the newest FAIL stage of the request.

#### Scenario: All tickets finished

- **GIVEN** the request `r-1` has two tickets in the room
- **WHEN** both tickets are `done` or `cancelled`
- **THEN** the "Needs you" area does not list `r-1`

### Requirement: The system actor is refused on every mutating HTTP route

Only hub-internal code SHALL write the `system` actor. Every mutating HTTP route SHALL refuse `by: "system"` with HTTP 400 and record nothing, including the approval route.

#### Scenario: Approval route refuses system

- **WHEN** a client sends `by: "system"` to the approval route
- **THEN** the hub returns HTTP 400 and no ticket changes

### Requirement: A queued ticket returns to draft when it changes

When a `queued` ticket changes its criteria, role or `blocked_by`, the hub SHALL move the ticket to `draft` in the same transaction as the edit. The edit SHALL write one `ticket.edited` event that carries the status change. A ticket in `claimed`, `in_progress` or `in_review` SHALL NOT move. The hub SHALL NOT move such a ticket back to `draft`; the Orchestrator SHALL cancel it or create a new `draft` ticket.

#### Scenario: Queued ticket changes

- **GIVEN** a `queued` ticket
- **WHEN** the lead changes its criteria
- **THEN** the ticket is `draft`
- **AND** the ledger holds one `ticket.edited` event with the status change

#### Scenario: Claimed ticket changes

- **GIVEN** a `claimed` ticket
- **WHEN** the lead changes its criteria
- **THEN** the ticket stays `claimed`

### Requirement: The PASS path is a second cross-kind transaction

The spec-review PASS SHALL be the second transaction that writes events of two kinds. The first is the stage launch in `stage-sessions`. CLAUDE.md SHALL name both.

#### Scenario: One transaction for PASS

- **WHEN** a normal PASS queues two tickets
- **THEN** the `stage.passed` event and both `ticket.queued` events commit together or not at all

### Requirement: The hub refuses a third spec review from a non-human sender

The hub SHALL refuse a spec review handoff with 409 when the sender is not the human and the request has two or more spec FAIL verdicts since its last PASS in the room. The error text SHALL name the count and say "the human must send this review". The hub SHALL NOT record a handoff, a stage or an event. A spec review from the human SHALL name `ticket_ids` and SHALL take the room of those tickets (see "A spec review is a stage of the request"). A PASS SHALL reset the count.

#### Scenario: Third review from the Orchestrator

- **GIVEN** the request `r-1` has two FAIL verdicts since its last PASS
- **WHEN** the Orchestrator sends a spec review of `r-1`
- **THEN** the hub answers 409 with the count and "the human must send this review"
- **AND** the handoff, stage and event counts do not change

#### Scenario: Human sends the review

- **GIVEN** the request `r-1` in room `cubilot` has two FAIL verdicts since its last PASS
- **WHEN** the human sends a spec review of `r-1` that names its `draft` ticket in `ticket_ids`
- **THEN** the hub creates a stage and starts it in room `cubilot`
- **AND** the stored handoff room is `cubilot`
- **AND** the first message says "This is spec review 3 of this request since its last PASS."

#### Scenario: PASS resets the gate

- **GIVEN** the request `r-1` had two FAIL verdicts and then a PASS
- **WHEN** the Orchestrator sends a spec review of `r-1`
- **THEN** the hub creates a stage

### Requirement: The second FAIL stops the queued spec stages from non-human handoffs

When the hub records the FAIL that makes the count two or more, each queued spec stage of the request and room made by a handoff of a non-human sender SHALL move to `failed` with the reason "spec FAIL limit: the human must send this review". It SHALL NOT launch. A queued stage made by a handoff of the human SHALL stay queued.

#### Scenario: Two stages wait

- **GIVEN** a spec stage runs and two more spec stages of the same request wait, made by the Orchestrator
- **WHEN** the running stage ends with the second FAIL
- **THEN** both waiting stages are `failed` with the exact reason
- **AND** neither launches

### Requirement: The hub stores the FAIL count in the result

On each spec FAIL result the hub SHALL write `fail_count`, the count after this FAIL, into the stored result context. The hub SHALL overwrite any `fail_count` that the sender wrote. No hub code SHALL read `escalate`.

#### Scenario: False value from the Validator

- **WHEN** the Validator sends a first FAIL with `fail_count` 9
- **THEN** the stored context holds `fail_count` 1

### Requirement: The Needs-you area keeps a request with two FAILs while a newer review is open

The hub SHALL list a request in the "Needs you" area when it has two or more FAIL verdicts since its last PASS, also while a newer spec review of it is open. A PASS SHALL remove the row.

#### Scenario: Human review is open

- **GIVEN** the request `r-1` has two FAIL verdicts and the human's newer review of `r-1` is `running`
- **THEN** the "Needs you" area lists `r-1`
