## Purpose

Measures every stage attempt, also a PASS, and marks the attempts that cost much more than usual, so that the pattern run sees slow or looping sessions that did not fail.

## ADDED Requirements

### Requirement: Every stage attempt records its run metrics
For each stage attempt that ends (`passed`, `retrying` or `failed`), the hub SHALL record in its metrics row: the duration from the launch request to the end, the number of turn ends, the total tokens, and the repeated tool calls. A repeated tool call is a call with the same tool and the same input as an earlier call in the same attempt.

#### Scenario: Passed stage
- **WHEN** a tester stage passes after 3 turns
- **THEN** its metrics row has the duration, turns 3, the total tokens and the repeated tool call count

#### Scenario: Repeated call
- **WHEN** a session calls `Bash` with the same command 4 times in one attempt
- **THEN** the repeated tool call count of that attempt is 3

### Requirement: Unknown metric values are stored as unknown
When the hub cannot read a value, it SHALL store NULL. It SHALL NOT store an estimate as a measured value. A metrics failure SHALL NOT change the stage.

#### Scenario: No transcript
- **WHEN** a Pi stage passes and its session file is not readable
- **THEN** the tokens and the repeated tool calls are NULL, and the duration and the turns are stored

### Requirement: Code marks outliers with a fixed rule
An attempt SHALL be an outlier for a metric when its value is more than `factor` times the median of the same role in the same room over the last 50 attempts, and at least `min_samples` attempts exist. Repeated tool calls SHALL be an outlier at `repeat_min` or more. The defaults SHALL be factor 3, min_samples 10 and repeat_min 3, read from the `diagnosis:` block of `config.yml`.

#### Scenario: Slow pass
- **WHEN** a worker stage passes in 95 minutes and the median of the last 20 worker attempts in the room is 25 minutes
- **THEN** the attempt is an outlier for duration

#### Scenario: Too few samples
- **WHEN** the room has 6 earlier tester attempts
- **THEN** no tester attempt is marked as an outlier for duration, turns or tokens

### Requirement: Outliers go into the pattern run
Each outlier attempt SHALL be in the scope of the next pattern run of its room, with its metrics and its trace path. An outlier alone SHALL NOT start a pattern run.

#### Scenario: Outlier in scope
- **WHEN** a pattern run starts after one outlier attempt was marked
- **THEN** its first message lists that attempt with the metric, the value, the median and the trace path
