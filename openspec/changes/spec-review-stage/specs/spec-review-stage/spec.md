## ADDED Requirements

### Requirement: A spec review is a stage of the request

The hub SHALL create one spec-review stage for a request when a handoff names `to_role: "validator"` with `review: "spec"` and a `request_id`. The stage SHALL NOT have a ticket. The handoff SHALL contain `request_text` and MAY contain `spec_paths`, `ticket_ids` and `commit`.

#### Scenario: Spec handoff creates a stage

- **WHEN** the Orchestrator sends a handoff to `validator` with `request_id` `r-1` and `review` `spec`
- **THEN** the hub creates one spec-review stage for `r-1`
- **AND** the stage has no ticket id

#### Scenario: Missing request text

- **WHEN** a spec handoff has no `request_text`
- **THEN** the hub returns HTTP 400 and records nothing

### Requirement: The scope of a spec review holds draft tickets only

The scope of a spec review SHALL be the `ticket_ids` of the handoff. Without `ticket_ids`, the scope SHALL be every `draft` ticket of the request in the room. Every ticket in the scope SHALL be `draft` and SHALL carry the request id. Otherwise the hub SHALL return HTTP 400 and record nothing.

#### Scenario: Default scope

- **GIVEN** a request with three `draft` tickets and one `queued` ticket
- **WHEN** a spec handoff names no ticket ids
- **THEN** the scope holds the three `draft` tickets

#### Scenario: Ticket outside the draft state

- **WHEN** a spec handoff names a `queued` ticket
- **THEN** the hub returns HTTP 400 and records nothing

### Requirement: One live spec review per request

A request SHALL have at most one spec-review stage in `queued`, `launching` or `running`. A later spec handoff for the same request while one is live SHALL create a stage in `queued` with its own scope.

#### Scenario: Second handoff waits

- **GIVEN** a spec-review stage for `r-1` is `running`
- **WHEN** a second spec handoff for `r-1` arrives
- **THEN** the hub creates a `queued` spec-review stage for `r-1`

### Requirement: The first message of a spec review holds the request

The first message of a spec-review session SHALL hold the request text, the scope tickets with their criteria, `blocked_by` and `blast_radius`, the spec paths, the worktree path and commit, and the findings of every FAIL verdict of the request since its last PASS verdict. The role prompt SHALL NOT appear in the first message.

#### Scenario: Follow-up review gets earlier findings

- **GIVEN** the request `r-1` has one FAIL verdict with two findings
- **WHEN** a second spec review of `r-1` starts
- **THEN** its first message holds both findings

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

When the request has two spec verdicts of FAIL since its last PASS, the hub SHALL add a `ui-only` entry for the human that lists the open findings, and SHALL show the same list in the "Needs you" area with the approvals. The open findings SHALL be the findings of the latest FAIL.

#### Scenario: Second FAIL

- **GIVEN** the request `r-1` has one FAIL verdict
- **WHEN** a second FAIL verdict arrives for `r-1`
- **THEN** the human sees a system entry with the open findings of the second FAIL
- **AND** the "Needs you" area lists the same findings

### Requirement: The system actor is refused on every HTTP route

The `system` actor SHALL be accepted only on hub-internal paths: the launch, the retry, and the spec-review PASS. Every HTTP route SHALL refuse `by: "system"` with HTTP 400 and record nothing, including the approval route.

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
