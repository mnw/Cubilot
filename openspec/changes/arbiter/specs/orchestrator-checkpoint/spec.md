## Purpose

Keeps a checkpoint from starting while an arbiter stage is live.

## ADDED Requirements

### Requirement: No checkpoint during an arbiter stage
A checkpoint SHALL NOT start while the room has a live arbiter stage.

#### Scenario: Live arbiter stage
- **GIVEN** the room has a live arbiter stage
- **WHEN** the lead's turn ends and a checkpoint is due
- **THEN** no checkpoint starts
