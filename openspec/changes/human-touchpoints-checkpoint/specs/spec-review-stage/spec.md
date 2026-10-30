## MODIFIED Requirements

### Requirement: A PASS queues the scope tickets

A spec-review PASS SHALL write `stage.passed` with verdict `PASS` and one `ticket.queued` event for each scope ticket still in `draft`, in one transaction. The actor of each `ticket.queued` event SHALL be `system`. When the request needs the human's Approve (see `plan-approval`) and has none, or its scope changed after the latest Approve, the transaction SHALL write only `stage.passed`, and the scope tickets SHALL stay `draft`.

#### Scenario: Normal PASS

- **GIVEN** an approved request with two scope tickets and no scope change
- **WHEN** the Validator sends a PASS
- **THEN** both tickets are `queued`
- **AND** the ledger holds one `ticket.queued` event for each, by `system`

#### Scenario: PASS with a high ticket

- **GIVEN** an approved request with one `blast_radius: high` ticket and no scope change
- **WHEN** the Validator sends a PASS
- **THEN** the scope tickets are `queued`: the radius does not hold the request

#### Scenario: Factory request with low tickets

- **GIVEN** a request with origin `factory`, no features, only low tickets and no Approve
- **WHEN** the Validator sends a PASS
- **THEN** the scope tickets are `queued`

#### Scenario: PASS without an Approve

- **GIVEN** a request with origin `human` and no Approve
- **WHEN** the Validator sends a PASS
- **THEN** the scope tickets stay `draft`
- **AND** the request is shown as waiting for approval

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

## REMOVED Requirements

### Requirement: The human approves a high-radius plan
**Reason**: Part 6 item 11: a request of the human gets one Approve at the start, whatever its radius; a factory request needs one only with a high-radius ticket or a new feature.
**Migration**: `plan-approval` ("An Approve records the approved scope") replaces it. The approve route keeps its path and its human-only rule.
