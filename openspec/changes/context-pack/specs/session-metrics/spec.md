## Purpose

Measures what a stage session costs at the start, so the cost of the context pack and the cache can be compared across roles and used for later model routing.

## ADDED Requirements

### Requirement: The hub records start-up numbers for each session

For each stage session the hub SHALL record the tokens of the first message, the cache read tokens, and the tokens used before the first file change or the first verdict. The hub SHALL store them with the stage id and the role.

#### Scenario: Numbers stored at stage end

- **WHEN** a stage session ends
- **THEN** the ledger holds one metrics row for the stage with the three numbers

#### Scenario: A retry has its own row

- **WHEN** a stage runs a second attempt
- **THEN** each attempt has its own metrics row

### Requirement: Unknown numbers are stored as unknown

When the hub cannot read a number, it SHALL store NULL for that number and SHALL NOT store an estimate as a measurement. The first-message size MAY be stored as an estimate only in a column that is named as an estimate.

#### Scenario: Usage not readable

- **WHEN** the session's usage source is not readable
- **THEN** the cache read tokens and the tokens before the first action are NULL and the stage result is not affected

### Requirement: Measurement never changes the stage

A failure to read or store the numbers SHALL NOT change the stage status, delay the close, or reject a result.

#### Scenario: Store fails

- **WHEN** the metrics write fails
- **THEN** the stage still moves to `passed` and a log line records the failure

### Requirement: The numbers are readable by role

The hub SHALL return the stored numbers for a room, grouped by role, so that a later dashboard can read them.

#### Scenario: Read by role

- **WHEN** a client with the hub token requests the metrics of a room
- **THEN** the response lists each role with its rows
