## ADDED Requirements

### Requirement: A stage can be cancelled

A stage SHALL have a terminal status `cancelled`, reachable from `queued`, `launching`, `running` and `retrying`. A cancelled stage SHALL NOT retry, SHALL NOT start a launch, SHALL NOT send a final-failure handoff, SHALL NOT count as a spec FAIL, SHALL NOT add a Needs-you line, and SHALL NOT be a failure record or a diagnosis input. A `passed` or `failed` stage SHALL NOT change. The move SHALL write one `stage.cancelled` event and one row update in one transaction, actor `system`.

#### Scenario: Passed stage stays

- **GIVEN** a stage that is `passed`
- **WHEN** its ticket is cancelled
- **THEN** the stage stays `passed`

#### Scenario: No failure trail

- **GIVEN** a stage that is cancelled
- **THEN** no handoff goes to the room lead
- **AND** no `stage.retrying` or `stage.failed` event exists for it
- **AND** `GET /requests/<room>/needs-you` lists nothing for it

### Requirement: A cancelled stage carries its reason

The stage snapshot SHALL have `reason`, a string or null. For a cancelled stage it SHALL be the `reason` in the payload of its last `stage.cancelled` event. For any other stage it SHALL be null. `GET /stages`, `GET /stages/<id>` and the SSE stage entry SHALL carry it. No column SHALL store it. The UI SHALL show `cancelled` and the reason as text, live and after a reload.

#### Scenario: Reason after reload

- **GIVEN** a stage cancelled with the reason "ticket cancelled"
- **WHEN** a client reads `GET /stages?status=cancelled`
- **THEN** the stage has `reason` "ticket cancelled"

### Requirement: A ticket cancel cancels its open stages

After the commit of `ticket.cancelled`, the hub SHALL move each `queued`, `launching`, `running` or `retrying` stage of the ticket to `cancelled` with the reason "ticket cancelled". Each move SHALL use the stage API in its own transaction after the ticket transaction. A live stage SHALL get one close request before the move. A `queued` stage SHALL get none and SHALL NOT launch.

#### Scenario: Queued stage

- **GIVEN** a queued stage of a ticket
- **WHEN** the ticket is cancelled
- **THEN** the stage is `cancelled` with the reason "ticket cancelled"
- **AND** no close and no launch request exists for it

#### Scenario: Running stage

- **GIVEN** a running stage
- **WHEN** its ticket is cancelled
- **THEN** one close request is queued, then the stage is `cancelled`

#### Scenario: Two roles

- **GIVEN** two cancelled tickets with a worker stage and a validator stage
- **THEN** both stages are `cancelled`

### Requirement: A cancelled stage keeps its reservation until its close is acked

The session name, the role slot and the worktree of a cancelled stage SHALL stay reserved until a close ack arrives while no launch of that stage is in flight. A close ack, `absent` included, while the launch is in flight SHALL release nothing.

#### Scenario: First close acks absent before the spawn

- **GIVEN** a cancelled stage whose launch is not acked and whose first close acks `absent`
- **THEN** the name, the slot and the worktree stay reserved
- **WHEN** the `spawned` ack arrives and then the second close is acked
- **THEN** they are released

### Requirement: A late launch end of a cancelled stage gets one more close

When the launch of a cancelled stage ends by `spawned`, `error` or no ack, the hub SHALL queue one more close, and only the ack of that close SHALL release. The stage SHALL NOT move to `running`, SHALL NOT be retried and SHALL NOT report a final failure.

#### Scenario: Delayed spawned ack

- **GIVEN** a cancelled stage whose launch is not acked
- **WHEN** the `spawned` ack arrives
- **THEN** one more close is queued and the stage stays `cancelled`
- **AND** a new stage gets another name and another slot until that close is acked

#### Scenario: Launch error after the session exists

- **GIVEN** a cancelled stage whose launch is not acked
- **WHEN** the launch is acked with `error`
- **THEN** one more close is queued and its ack releases
- **AND** the stage is not retried

### Requirement: An undelivered launch of a cancelled stage is dropped

A launch request that the shell never received SHALL be dropped, with no close, and SHALL release the reservation at once.

#### Scenario: Undelivered launch

- **GIVEN** a cancelled stage whose launch request no shell received
- **THEN** the request is dropped, no close is queued and everything is released at once

### Requirement: A cancelled stage's worktree follows its kind

A `ticket/<id>` worktree (worker, writer) SHALL stay. A temporary worktree SHALL be removed at the releasing close ack, or at once for a dropped launch.

#### Scenario: Worker and validator

- **GIVEN** a cancelled worker stage and a cancelled validator stage
- **WHEN** each releasing close ack arrives
- **THEN** the worker worktree exists and the validator worktree is removed

### Requirement: Hub start cancels the open stages of a cancelled ticket

At hub start, before the sweep of `launching` stages, each open stage of a cancelled ticket SHALL move to `cancelled` with the reason "ticket cancelled". Each live one SHALL get one close request. The `launching` sweep SHALL then skip them: no retry and no final failure.

#### Scenario: Four states seeded

- **GIVEN** a ledger with a running, a launching, a retrying and a queued stage of cancelled tickets
- **WHEN** the hub starts
- **THEN** all are `cancelled`, each live one has one close request and no launch is queued
