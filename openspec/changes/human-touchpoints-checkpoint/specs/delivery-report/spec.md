## Purpose

Gives the human, at the delivery of each request, one report built by code from the ledger and git, so that the human can test on staging and merge or open a fix request.

## ADDED Requirements

### Requirement: Code builds the delivery report
`GET /requests/<room>/<id>/delivery` SHALL return the report of a request whose tickets are all `done` or `cancelled`, with at least one `done`. No model SHALL write it. It SHALL return 409 while a ticket is open.

#### Scenario: Open ticket
- **WHEN** the human reads the report of a request with one `in_review` ticket
- **THEN** the hub returns 409

### Requirement: The report holds the facts of the request
The report SHALL hold, in this order: the origin and the features; each ticket with its status and its merge commit on staging (or `no merge commit`); each criteria edit after the Approve, with the text before and after; the factory requests whose parent is this request, with their tickets and statuses; the known limits (follow-up tickets and open suggestions). The checks part follows (next requirement).

#### Scenario: Criteria edit
- **GIVEN** a criteria line of `t1` was rewritten after the Approve
- **THEN** the report shows the old and the new criteria of `t1`

### Requirement: The report holds the checks of the request
After the facts, the report SHALL hold: each high-radius ticket with both PASS handoff ids and a mark when its merge message does not name both; the test counts of the staging suite log at the newest merge commit (or `no staging log`); the steps of the request's `[human]` live-check ticket.

#### Scenario: Test counts
- **GIVEN** the staging log of the newest merge commit says `412 pass` and `0 fail`
- **THEN** the report shows 412 pass and 0 fail with the commit hash

#### Scenario: High-radius change
- **GIVEN** a done high-radius ticket whose merge message names only the first PASS
- **THEN** the report lists it with both handoff ids and the mark `merge message incomplete`

### Requirement: Criteria edits keep their text before and after
The `ticket.edited` event of a criteria change SHALL hold `acceptance_criteria: {from, to}` with both full texts. The report SHALL read the edits from these events.

#### Scenario: Event payload
- **WHEN** the Orchestrator edits the criteria of `t1`
- **THEN** the `ticket.edited` event holds the old and the new text

### Requirement: A delivered request is one Needs-you line
The Needs-you area SHALL show one line for each request with a report, until each merge commit of the request is on `main`.

#### Scenario: Merged into main
- **WHEN** the human merges staging into main
- **THEN** the line of the request goes away
