## Purpose

Sets the blast radius of each ticket by a fixed rule in code, so that the human does not set it and an agent cannot lower it below the rule.

## ADDED Requirements

### Requirement: Code computes the rule radius
On create and on each edit of the title, the criteria or the planning note, the hub SHALL compute `radius_rule`: `high` when that text holds a term or a path of `radius_rule` in `config.yml`, else `low`. It SHALL store the matched terms in `radius_reasons`. A term SHALL match as a whole word without case. The defaults SHALL cover launch, ownership, permissions, read-only worktrees and data loss.

#### Scenario: Launch term
- **WHEN** a ticket is created with the criteria "the launch queue refuses a stage"
- **THEN** `radius_rule` is `high` and `radius_reasons` holds `launch`

#### Scenario: No term
- **WHEN** a ticket names only `ui/features/emoji.js`
- **THEN** `radius_rule` is `low`

### Requirement: The stored radius is never below the rule
The hub SHALL store `blast_radius` as the higher of `radius_rule` and the requested radius. `radius_source` SHALL be `rule`, `raised`, `arbiter` or `human`. When an edit makes `radius_rule` higher than `blast_radius`, the same `ticket.edited` event SHALL raise `blast_radius`.

#### Scenario: Low requested, rule high
- **WHEN** the Orchestrator creates a ticket with `blast_radius: low` and the criteria name `hub/core/worktrees.ts`
- **THEN** the ticket has `blast_radius: high` and `radius_source: rule`

### Requirement: The Orchestrator can raise the radius
The human, the room lead and the creator SHALL set `blast_radius: high`. The source SHALL be `raised`, or `human` for the human.

#### Scenario: Lead raises
- **WHEN** the room lead edits a low ticket to `high`
- **THEN** the ticket is `high` with `radius_source: raised`

### Requirement: A radius below the rule needs a ruling
An agent's edit to `blast_radius: low` SHALL get 403 when `radius_rule` is `high`, with the text "a radius below the rule needs an arbiter ruling". An applied arbiter waiver for the radius SHALL set `low` with `radius_source: arbiter`. The human SHALL set any radius, with `radius_source: human`.

#### Scenario: Lead lowers
- **WHEN** the room lead edits a ticket with `radius_rule: high` to `low`
- **THEN** the hub returns 403 and the ticket stays `high`

#### Scenario: Arbiter waiver
- **WHEN** an arbiter waiver for the radius of that ticket is applied
- **THEN** the ticket is `low` with `radius_source: arbiter`

#### Scenario: Raised ticket lowered by its raiser
- **GIVEN** a ticket with `radius_rule: low` that the lead raised to `high`
- **WHEN** the lead edits it to `low`
- **THEN** the ticket is `low` with `radius_source: rule`

### Requirement: The rule is a setting
The terms and paths SHALL be read from `radius_rule` in `config.yml` at each computation. A missing or malformed block SHALL use the defaults and log one line.

#### Scenario: Malformed block
- **WHEN** `radius_rule` is a string
- **THEN** the hub uses the default terms and logs one line
