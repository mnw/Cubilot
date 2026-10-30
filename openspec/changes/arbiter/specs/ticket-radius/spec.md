## Purpose

Lets an applied arbiter waiver lower the radius of a ticket below the rule.

## ADDED Requirements

### Requirement: An arbiter waiver lowers the radius
An applied arbiter waiver for the radius SHALL set `low` with `radius_source: arbiter`.

#### Scenario: Arbiter waiver
- **WHEN** an arbiter waiver for the radius of that ticket is applied
- **THEN** the ticket is `low` with `radius_source: arbiter`
