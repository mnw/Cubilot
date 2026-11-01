## MODIFIED Requirements

### Requirement: A late launch end of a cancelled stage gets one more close

When the launch of a cancelled stage ends by `spawned` or `error`, the hub SHALL queue one more close, and only the ack of that close SHALL release. When the launch ends by time-out, the hub SHALL keep the reservation until the late `spawned` or `error` ack arrives. It SHALL accept that ack and then queue one more close. A close ack, `absent` included, before the late ack SHALL release nothing. The stage SHALL NOT move to `running`, SHALL NOT be retried and SHALL NOT report a final failure. A late ack of a timed-out attempt of a stage that is not cancelled SHALL get 409 and SHALL NOT change the next attempt.

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

#### Scenario: Time-out, absent, then a late spawned ack

- **GIVEN** a cancelled stage whose launch timed out and whose first close was acked `absent`
- **THEN** nothing is released
- **WHEN** the late `spawned` or `error` ack arrives
- **THEN** the hub accepts it with 200 and queues one more close
- **AND** only the ack of that close releases the name, the slot and the worktree
- **AND** the stage stays `cancelled`, is not retried and sends no final-failure handoff

#### Scenario: Late ack of a stage that is not cancelled

- **GIVEN** a stage that is not cancelled and whose attempt 1 timed out
- **WHEN** the ack of attempt 1 arrives
- **THEN** the hub answers 409 and attempt 2 does not change

## ADDED Requirements

### Requirement: The shell closes a session after the launch of its name

The shell SHALL keep the session names of its launches in progress. A close for such a name SHALL wait until that launch ends, then run. A close for another name SHALL run at once. A close SHALL wait for at most one launch of its name.

#### Scenario: Close during a launch

- **GIVEN** the shell starts a launch for a session name
- **WHEN** a close for that name arrives before the launch ends
- **THEN** the close runs after the launch ends

#### Scenario: Close for another name

- **GIVEN** the shell has a launch in progress for one name
- **WHEN** a close for another name arrives
- **THEN** that close runs at once
