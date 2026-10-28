## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: The first message of a spec review holds the request

The first message of a spec-review session SHALL hold the request text, the scope tickets with their criteria, `blocked_by` and `blast_radius`, the spec paths, the worktree path and commit, and the findings of every FAIL verdict of the request since its last PASS verdict. It SHALL hold the line "This is spec review N of this request since its last PASS.", where N is the hub count of FAIL verdicts plus one. The role prompt SHALL NOT appear in the first message.

#### Scenario: Follow-up review gets earlier findings

- **GIVEN** the request `r-1` has one FAIL verdict with two findings
- **WHEN** a second spec review of `r-1` starts
- **THEN** its first message holds both findings
- **AND** its first message says "This is spec review 2 of this request since its last PASS."

## REMOVED Requirements

### Requirement: A newer open spec review hides the request from the Needs-you area

**Reason**: After two FAILs the Orchestrator can no longer send a review, so a newer open review is the human's. The request stays listed until a PASS.
**Migration**: Use "The Needs-you area keeps a request with two FAILs while a newer review is open".
