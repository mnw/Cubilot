## ADDED Requirements

### Requirement: The Briefing lists the agent's own open tickets

The Briefing SHALL list the tickets in the agent's Room that are assigned to that agent
in a non-terminal status, highest priority first, through the `ticket` kind's
`briefingLines` hook. When the agent owns none, the Briefing SHALL contain no ticket
lines. Tickets SHALL NOT be replayed through `pendingFor`, so a reconnect does not
deliver the same list twice. The existing Briefing delivery and re-send rules are
unchanged.

#### Scenario: Briefing carries the agent's own open tickets

- **GIVEN** `alice` is the assignee of two non-terminal tickets in her Room
- **WHEN** a Briefing is assembled for `alice`
- **THEN** it lists exactly those two tickets, highest priority first
- **AND** tickets assigned to other agents in the same Room are omitted

#### Scenario: Claiming a ticket re-sends the Briefing

- **WHEN** `alice` claims a ticket
- **THEN** `alice` receives a new Briefing that lists it

#### Scenario: Reconnect does not replay tickets twice

- **WHEN** `alice` reconnects while she owns an open ticket
- **THEN** the ticket appears in her Briefing
- **AND** no separate ticket event is replayed for it
