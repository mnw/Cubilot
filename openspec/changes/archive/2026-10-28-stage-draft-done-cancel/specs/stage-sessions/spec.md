## ADDED Requirements

### Requirement: A ticket that moves to draft or done cancels its queued stages

After the commit of a move of a ticket to `draft` or `done`, the hub SHALL move each `queued` stage of the ticket to `cancelled` with the reason "ticket moved to draft" or "ticket moved to done". Each move SHALL use the stage API in its own transaction after the ticket transaction. A `launching`, `running` or `retrying` stage SHALL NOT change. The cancel SHALL NOT retry, send a failure handoff or count as a spec FAIL.

#### Scenario: Criteria edit

- **GIVEN** a `queued` ticket with a `queued` stage
- **WHEN** a criteria edit moves the ticket to `draft`
- **THEN** the stage is `cancelled` with the reason "ticket moved to draft"
- **AND** no launch request exists for it

#### Scenario: Transition to done

- **GIVEN** a `queued` stage of a ticket
- **WHEN** the ticket moves to `done`
- **THEN** the stage is `cancelled` with the reason "ticket moved to done"

#### Scenario: Final PASS

- **GIVEN** a low-radius ticket in `in_review` with a running Validator stage and a `queued` stage of another role
- **WHEN** the Validator PASS moves the ticket to `done`
- **THEN** after `stage.passed` commits, the queued stage is `cancelled` with the reason "ticket moved to done"

#### Scenario: Running stage

- **GIVEN** a `running` stage
- **WHEN** its ticket moves to `draft`
- **THEN** the stage stays `running`

### Requirement: Hub start cancels the queued stages of a draft or done ticket

At hub start, each `queued` stage of a `draft` or `done` ticket SHALL move to `cancelled` with the same reason, before the sweep of `launching` stages.

#### Scenario: Seeded stages

- **GIVEN** a queued stage of a draft ticket and a queued stage of a done ticket in the ledger
- **WHEN** the hub starts
- **THEN** both stages are `cancelled` and no launch request exists

### Requirement: The launch check refuses a stage of a draft, done or cancelled ticket

The launch check SHALL refuse a stage whose ticket is `draft`, `done` or `cancelled`. A refusal SHALL NOT change the stage row.

#### Scenario: Slot frees

- **GIVEN** a `queued` stage of a draft ticket in the ledger
- **WHEN** a slot of its role frees
- **THEN** no launch request exists for it and its row is unchanged

## MODIFIED Requirements

### Requirement: The ticket role starts only the first stage

The ticket's `role` SHALL start a stage only when no stage exists for the ticket and that role. A `cancelled` stage SHALL NOT count, whatever its reason. The ready seq SHALL be the latest `ticket.queued` event. A `done` or `cancelled` ticket cannot be queued, so its cancelled stages start nothing. Stages of any role after that SHALL come from `to_role` handoffs.

#### Scenario: New ticket with a role

- **GIVEN** a `queued` ticket with `role` `worker` and no stages
- **WHEN** the hub evaluates the ticket
- **THEN** the hub creates one `worker` stage

#### Scenario: A handoff starts a stage of another role

- **GIVEN** a `queued` ticket with `role` `worker` and a `passed` worker stage
- **WHEN** a `to_role: "tester"` handoff arrives for the ticket
- **THEN** the hub creates one `tester` stage for the ticket

#### Scenario: New handoff starts a new stage

- **GIVEN** the last `tester` stage of a ticket has passed
- **WHEN** a handoff to role `tester` arrives for that ticket
- **THEN** the hub creates one new `tester` stage

#### Scenario: Draft and queued again

- **GIVEN** a ticket whose only stage of its role was cancelled by a move to draft
- **WHEN** the ticket moves to `queued`
- **THEN** the hub creates exactly one new `queued` stage of the ticket role

#### Scenario: Done ticket

- **GIVEN** a cancelled stage of a done ticket
- **WHEN** the hub evaluates the ticket
- **THEN** no stage is created
