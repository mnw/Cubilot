## Purpose

Records what happens in each stage session, and writes a failure record with evidence when a stage attempt ends without a result, so that a cause can be found from facts.

## ADDED Requirements

### Requirement: Each stage has one trace file
The hub SHALL write one JSONL file for each stage at `<app data>/traces/<stage_id>.jsonl`, with mode `0600`. Each line SHALL hold `ts` (ISO time), `elapsed_ms` (from the first line of the file), `attempt`, `source` (`hub`, `shell` or `bridge`), `step` and the fields of that step. The hub is the only process that writes the file.

#### Scenario: Lines of a normal stage
- **WHEN** a worker stage is launched, runs one turn and sends a valid result
- **THEN** its trace file has, in this order, the steps `launch_request`, `shell_ack`, `tmux_spawn`, `bridge_connect`, `first_message`, `result`, `turn_end` and `close`
- **AND** each line has `ts`, `elapsed_ms`, `attempt` and `source`

#### Scenario: Elapsed time
- **WHEN** a line is written 4 seconds after the first line of the file
- **THEN** its `elapsed_ms` is 4000 within the clock resolution

### Requirement: The trace records every stage event that the brief names
The trace SHALL have a line for each of these events: launch request, shell ack, tmux spawn, bridge connect, first message delivered, each turn end, a refused result, a reminder, a result, a close, a retry and a final failure.

#### Scenario: Refused result and reminder
- **WHEN** a session sends a result that fails the schema check, then ends a turn without a valid result
- **THEN** the trace has one `result_refused` line with the error list and one `reminder` line

#### Scenario: Retry
- **WHEN** attempt 1 of a stage ends by a time-out
- **THEN** the trace has one `retry` line with the reason, and the lines of attempt 2 have `attempt` 2

### Requirement: The shell and the bridge supply their own lines
The shell SHALL report the time it received a launch and the time tmux started the session in its ack. The bridge SHALL report the start of the first run of a stage session and each tool error. The hub SHALL write these reports as lines with `source` `shell` or `bridge` and the reporter's own time.

#### Scenario: Shell times
- **WHEN** the shell acks a launch as spawned
- **THEN** the trace has a `shell_ack` line and a `tmux_spawn` line with `source` `shell`

#### Scenario: Bridge first message
- **WHEN** a stage session starts its first run
- **THEN** the trace has one `first_message` line with `source` `bridge`, and later runs add no `first_message` line

### Requirement: Trace writes never block a stage
A trace write that fails SHALL be logged by the hub and SHALL NOT change a stage, a ticket or a launch.

#### Scenario: Trace folder not writable
- **WHEN** the traces folder cannot be written and a stage launches
- **THEN** the stage moves to `launching` as before, and the hub log has one error line

### Requirement: On-disk trace and record text is redacted
The hub SHALL remove `<private>...</private>` blocks from each trace line and from each failure record before it writes them to disk. It SHALL cut a trace line at 4 KiB.

#### Scenario: Private text in a tool error
- **WHEN** a tool error text holds `<private>abc</private>`
- **THEN** the trace line and the failure record do not hold `abc`

### Requirement: Known secret patterns are masked before a write
Before the hub writes a trace line, a failure record or a fixture, it SHALL replace each match of the known secret patterns with `[masked:<kind>]`. The list SHALL cover at least: Anthropic, OpenAI, GitHub, AWS, Slack and Google keys, JWTs, private key blocks, `Bearer` tokens, `password=`/`secret=`/`token=`/`api_key=` values, and the hub token. No opt-in SHALL be needed.

#### Scenario: Key in the pane
- **WHEN** the pane holds `sk-ant-api03-abc…` and `AKIAABCDEFGHIJKLMNOP`
- **THEN** the record file holds `[masked:anthropic]` and `[masked:aws]` and neither value

#### Scenario: Hub token
- **WHEN** a tool error text holds the hub token
- **THEN** the trace line holds `[masked:hub-token]`

### Requirement: Failure records and fixtures are deleted after a retention time
The hub SHALL delete trace files and failure record files `retention.records_days` after their last write (default 30), and a fixture `retention.fixtures_days` after its gap ticket became `done` or `cancelled` (default 30). A reopened ticket SHALL keep its fixture. The ledger rows SHALL stay; the record path SHALL get the note `deleted after retention`. The settings live in `config.yml`.

#### Scenario: Old record
- **WHEN** a failure record file is 31 days old
- **THEN** the hub deletes it and its trace, and `GET /traces/<stage_id>` returns 404 with `deleted after retention`

#### Scenario: Fixture of an open ticket
- **WHEN** a fixture is 90 days old and its gap ticket is still open
- **THEN** the fixture stays

### Requirement: A failure record is written for each attempt that ends without a result
The hub SHALL write one failure record when a stage moves to `retrying` or `failed`, before the session of that attempt is closed. A diagnosis stage and a pattern run SHALL get no failure record.

#### Scenario: Time-out
- **WHEN** attempt 1 of a tester stage runs past the time-out
- **THEN** the hub asks the shell for the pane, then closes the session
- **AND** one failure record exists for that stage and attempt

#### Scenario: Launch without a session
- **WHEN** a launch fails because the room has no project folder
- **THEN** one failure record exists with no pane and the note `no session`

#### Scenario: One record for each attempt
- **WHEN** both attempts of a stage end without a result
- **THEN** the stage has exactly two failure records

### Requirement: The failure record holds the evidence
A failure record SHALL hold: the last 200 lines of the pane, the exit status of the session command, the last tool error, a worktree check (branch, commit, `node_modules` present, staged bridge present, tmux present, session present), the trace path, the stop reason and the category. A field with no value SHALL be `null` with a note that gives the reason.

#### Scenario: Live session
- **WHEN** a record is written for a session that still runs
- **THEN** the pane field holds at most 200 lines from that session, and the exit status is `null` with the note `still running`

#### Scenario: Session gone
- **WHEN** a session process ended with exit status 1 before the record
- **THEN** the exit status is 1 and the pane field is `null` with the note `session gone`

#### Scenario: Pane capture gets no answer
- **WHEN** the shell does not answer the pane request in 15 seconds
- **THEN** the record is written with the pane `null` and the note `capture timed out`, and the close goes ahead

### Requirement: Code sets the category from a fixed list
Code SHALL set exactly one category from this list: `missing setup`, `no connect`, `no first message`, `crash`, `time-out`, `refused result`, `no result`, `unknown`. The first rule that matches in this order SHALL set it. `unknown` SHALL be set only when no other rule matches.

#### Scenario: No connect
- **WHEN** the shell acked the launch as spawned and the attempt has no `bridge_connect` line
- **THEN** the category is `no connect`

#### Scenario: Missing node_modules
- **WHEN** the worktree has `package.json` and no `node_modules`, and the session ended without a result
- **THEN** the category is `missing setup`

#### Scenario: Same record, same category
- **WHEN** the category is computed twice from the same record
- **THEN** both results are equal

### Requirement: A trace can be read through the hub
The hub SHALL serve the trace of a stage at `GET /traces/<stage_id>` with the hub token. An unknown or malformed stage id SHALL get 404.

#### Scenario: Read a trace
- **WHEN** the UI requests the trace of a stage that has one, with the token
- **THEN** the hub returns the JSONL text

#### Scenario: No token
- **WHEN** a request has no token
- **THEN** the hub returns 401
