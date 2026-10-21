## ADDED Requirements

### Requirement: Ticket events start a turn only for the agent a ticket is handed to

The bridge core SHALL deliver every `ticket.*` event kind in `context` mode for both
runtimes, with two exceptions. A `ticket.new` or `ticket.assigned` event whose snapshot names
the receiving agent as `assignee` SHALL be delivered in `wake` mode. A `ticket.new` or `ticket.assigned`
event for a ticket with no assignee, whose `lead` field names the receiving agent (the room lead),
SHALL also be delivered in `wake` mode, so the lead triages it. A `ticket.new` event never wakes the
ticket's own `creator` (it created the ticket itself and already knows); a `ticket.assigned` event is
a later event the creator has not seen, so it wakes the assignee or the room lead like any other agent. Every other ticket event SHALL NOT
wake an agent. Work that needs another agent's attention SHALL reach it as a
handoff, a chat message, or an assignment. This requirement depends on the
`chatbridge-claude-mod` change, which introduces the delivery modes; that change SHALL be
archived first.

#### Scenario: A new unassigned ticket does not wake the Room

- **GIVEN** agents `alice` and `bob` are idle in the Room
- **WHEN** the human creates a ticket in that Room with no assignee
- **THEN** both agents have the ticket event in their context
- **AND** no turn starts for either agent

#### Scenario: Assigning a ticket wakes the assignee once

- **GIVEN** agents `alice` and `bob` are idle in the Room
- **WHEN** the human assigns a ticket to `alice`, or creates it with `alice` as assignee
- **THEN** `alice` receives the event in `wake` mode and a turn starts
- **AND** `bob` receives it in `context` mode and no turn starts for `bob`

#### Scenario: An unassigned new ticket wakes the room lead

- **GIVEN** the Room has a lead `lee` and agent `bob`, all idle
- **WHEN** the human creates a ticket with no assignee
- **THEN** `lee` receives the `ticket.new` event in `wake` mode and a turn starts
- **AND** `bob` receives it in `context` mode and no turn starts for `bob`

#### Scenario: A ticket that is unassigned again wakes the room lead

- **GIVEN** the Room has a lead `lee`, and a ticket is assigned to `bob`
- **WHEN** the human unassigns the ticket
- **THEN** `lee` receives the `ticket.assigned` event in `wake` mode
- **AND** `bob` receives it in `context` mode

#### Scenario: A Room without a lead wakes nobody for an unassigned ticket

- **WHEN** the human creates an unassigned ticket in a Room that has no lead
- **THEN** every agent receives the `ticket.new` event in `context` mode

#### Scenario: A ticket an agent creates for itself does not wake it

- **WHEN** `alice` creates a ticket with herself as assignee
- **THEN** the `ticket.new` event reaches `alice` in `context` mode

#### Scenario: A later assignment to the creator wakes it

- **GIVEN** `alice` created a ticket that is assigned to `bob`
- **WHEN** the human assigns the ticket to `alice`
- **THEN** `alice` receives the `ticket.assigned` event in `wake` mode

### Requirement: A ticket approval wakes its requester and no one else

A `permission.resolved` event whose permission has `tool_name` `ticket:done` SHALL be delivered in `wake` mode to the agent that raised the request (the event's `from`) and in `context` mode to every other agent. A `permission.new` event for `ticket:done` SHALL be delivered in `context` mode to every agent, so a peer is not woken to vote on a request only the human may answer. Every other permission event keeps its delivery mode.

#### Scenario: The human's verdict wakes the assignee

- **GIVEN** agent `alice` requested approval for a ticket and waits for the human
- **WHEN** the human allows or denies the request
- **THEN** `alice` receives the `permission.resolved` event in `wake` mode and a turn starts
- **AND** `bob` in the same Room receives it in `context` mode

#### Scenario: A ticket approval request does not wake peers

- **WHEN** `alice` raises a `ticket:done` approval request
- **THEN** `bob` receives the `permission.new` event in `context` mode and no turn starts
