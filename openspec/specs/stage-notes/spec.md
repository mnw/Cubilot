# stage-notes Specification

## Purpose
Carries what one stage learned to the next stage of the same ticket, in a short required field on each result handoff.

## Requirements

### Requirement: A result handoff carries notes

A result handoff of a hub-launched stage SHALL carry `context.notes`, a non-empty string of at most about 300 words. The hub SHALL reject a result without `notes`, or with notes over 400 words, as a schema error, in the same way as other result errors.

#### Scenario: Missing notes

- **WHEN** a stage session sends a result handoff with no `notes`
- **THEN** the hub creates no result, sends the errors to the same session as `stage.rejected`, and the stage stays `running`

#### Scenario: Notes too long

- **WHEN** the notes hold more than 400 words
- **THEN** the hub rejects the result with an error that gives the word count

#### Scenario: Valid notes

- **WHEN** the result has a non-empty `notes` within the limit
- **THEN** the hub accepts the result and stores the notes with the handoff

### Requirement: The next stage gets all earlier notes

The first message of a stage SHALL hold all earlier notes of the ticket, oldest first, each with its role and stage id. The Orchestrator's planning note and the Validator's spec-review facts count as earlier notes.

#### Scenario: Second stage

- **WHEN** a Tester stage launches after a Worker stage passed with notes
- **THEN** the Tester's first message holds the Worker's notes

#### Scenario: Three earlier stages

- **WHEN** a stage launches after three stages of the ticket passed with notes
- **THEN** the first message holds all three notes in order

#### Scenario: No earlier notes

- **WHEN** the first stage of a ticket launches and the ticket has no planning note
- **THEN** the first message has no notes section

### Requirement: Notes do not weaken the other result checks

The notes check SHALL be added to the existing result schema check. A result that is valid except for `notes` SHALL leave the stage unchanged.

#### Scenario: Only notes missing

- **WHEN** a result has a valid stage id, ticket id and verdict but no notes
- **THEN** the stage status does not change
