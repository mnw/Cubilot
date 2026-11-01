## MODIFIED Requirements

### Requirement: The human or the room lead approves a draft

The human or the room lead SHALL move a ticket from `draft` to `queued`. The room lead SHALL get HTTP 403 when the request of the ticket needs the human's Approve and has none, or its scope changed after the latest Approve (see `plan-approval`). Only the human SHALL queue a ticket without `request_id`. The human or the room lead SHALL move a ticket from `queued` back to `draft`. From a later status only the human SHALL do it. The `transition_ticket` tool SHALL offer `draft` and `queued`.

#### Scenario: A high request needs the human

- **GIVEN** a request of origin `human` with two `draft` tickets, one of them `blast_radius: high`, and no Approve
- **WHEN** the room lead moves one ticket to `queued`
- **THEN** the hub returns HTTP 403
- **AND** the same move by the human succeeds

#### Scenario: An approved request is queued by the lead

- **GIVEN** an approved request whose ticket went back to `draft` after a criteria edit
- **WHEN** the room lead moves it to `queued`
- **THEN** the ticket is `queued`

## REMOVED Requirements

### Requirement: High-blast-radius tickets complete only with the human's approval
**Reason**: Part 6 item 11: high radius means stricter checks, not a human gate.
**Migration**: `high-radius-checks` replaces it: a high-radius ticket reaches `done` after the review PASS and the second review PASS. `POST /tickets/:id/approval` is removed. Pending `ticket:done` permission requests are dismissed at the migration. `approval_request_id` stays as data and is not read.

### Requirement: The board shows each ticket's approval state
**Reason**: The `ticket:done` approval no longer exists.
**Migration**: The card of a high-radius ticket shows its two PASS marks (`high-radius-checks`) and its radius source (`ticket-radius`).
