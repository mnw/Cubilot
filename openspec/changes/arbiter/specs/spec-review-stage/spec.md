## Purpose

Lets an arbiter ruling grant a third spec review and sends the second spec FAIL to the arbiter instead of the human.

## ADDED Requirements

### Requirement: An arbiter ruling grants a third spec review
The hub SHALL accept a spec review handoff from a non-human sender when the request has two or more spec FAIL verdicts since its last PASS and an applied arbiter ruling grants that review. The grant SHALL be spent by that review.

#### Scenario: Arbiter ruling grants the review

- **GIVEN** the request `r-1` has two FAIL verdicts and an applied ruling `rework` of the arbiter
- **WHEN** the Orchestrator sends a spec review of `r-1`
- **THEN** the hub creates a stage and the grant is spent
- **AND** a second spec review from the Orchestrator gets 409

## MODIFIED Requirements

### Requirement: The Needs-you area keeps a request with two FAILs while a newer review is open

The hub SHALL list a request with two or more FAIL verdicts since its last PASS in the "Needs you" area only when its arbiter ruling is `escalated` or `human`, or its arbiter stage failed. It SHALL keep the row while a newer spec review of it is open. A PASS SHALL remove the row.

#### Scenario: Human review is open

- **GIVEN** the request `r-1` has two FAIL verdicts, an escalated ruling, and the human's newer review of `r-1` is `running`
- **THEN** the "Needs you" area lists `r-1`

#### Scenario: Ruling applied

- **GIVEN** the request `r-1` has two FAIL verdicts and an applied ruling
- **THEN** the "Needs you" area does not list `r-1`

## REMOVED Requirements

### Requirement: The second FAIL goes to the human
**Reason**: Part 6 item 11: the arbiter decides after two FAILs.
**Migration**: `arbiter` ("The hub starts the arbiter") replaces it. The human gets a Needs-you line only through `human-escalation`.
