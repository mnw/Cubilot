## ADDED Requirements

### Requirement: A kind may gate a transition on another kind's table without orchestrator changes

A `KindModule` SHALL be able to read another kind's derived table inside its own
transition decision, through the injected `HubCapabilities` DB handle, without the
orchestrator in `hub.ts` gaining any kind-specific branch. A kind MAY create another
kind's row only through that kind's exported create helper, with its own derived update as
a side effect in the same transaction, so the transaction still writes exactly one event.

#### Scenario: Ticket completion reads permission rows

- **WHEN** the `ticket` kind decides a transition to `done` for a high-blast-radius ticket
- **THEN** it reads the `permissions` table through `HubCapabilities` within the same transaction
- **AND** `hub.ts` contains no branch naming either kind
- **AND** `hub/kinds/permission.ts` changes only by exporting its create helper

#### Scenario: Registration remains a single array entry

- **WHEN** the `ticket` kind is added
- **THEN** the only orchestrator change is one additional entry in the `KINDS` array

### Requirement: Kinds may add lines to the Briefing through an optional hook

`KindModule` SHALL gain an optional `briefingLines(agent, cap)` hook that returns text
lines for that agent's Briefing. The Briefing assembly SHALL collect the lines of every
kind in `KINDS` order with no kind-specific branch, SHALL include them in the Briefing
signature, and the bridge core SHALL render them in the Briefing text for both runtimes.
`HubCapabilities` SHALL gain `briefing.refresh()`, which schedules the Briefing dispatcher's
debounced fan-out; a kind SHALL call it after a committed change that can alter its lines.

#### Scenario: A change to a kind's lines re-sends the Briefing

- **GIVEN** agent `alice` received a Briefing
- **WHEN** a kind commits a change that alters its `briefingLines` for `alice` and calls `briefing.refresh()`
- **THEN** the dispatcher rebuilds the Briefing and its signature for `alice` changes
- **AND** `alice` receives a new Briefing in `context` mode

#### Scenario: Kinds without the hook are unaffected

- **WHEN** a kind does not define `briefingLines`
- **THEN** it contributes no lines and the Briefing is otherwise unchanged
