## Purpose

Adds the arbiter cases to the human escalation: the arbiter answer `human`, the arbiter failure and the second FAIL.

## ADDED Requirements

### Requirement: The arbiter can send a case to the human
The hub SHALL also open a human decision when the arbiter returns `human` or fails. A second FAIL SHALL NOT add a Needs-you line: it starts an arbiter stage.

#### Scenario: Second FAIL
- **WHEN** a ticket gets its second FAIL
- **THEN** no Needs-you line is added and an arbiter stage starts

#### Scenario: Arbiter answer human
- **WHEN** the arbiter of `t1` returns `human`
- **THEN** the Needs-you area has exactly one line for `t1`
