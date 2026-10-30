## Purpose

Keeps the Orchestrator's context small. The hub sends it fewer and shorter entries, shows its context percentage, and at set points clears its session and gives it a state summary that code builds from the ledger.

## ADDED Requirements

### Requirement: The hub measures what reaches the room lead
The hub SHALL count each entry that it queues for a room lead, by kind (`briefing`, `ticket`, `handoff`, `interrupt`, `chat`, `stage`, `other`), with its size in bytes. At each full hour it SHALL append one JSONL line for each room lead, also with zeros, to `<app data>/metrics/lead-inbound.jsonl`. A line SHALL hold `hour` (UTC start of the hour), `room`, `lead` and the seven kind keys, each `{count, bytes}` (R6). A write error SHALL be logged and SHALL change nothing else.

#### Scenario: Hourly line
- **WHEN** the lead received 3 ticket entries of 400 bytes in one hour
- **THEN** the line of that hour has `ticket: {count: 3, bytes: 1200}`

### Requirement: A stage session does not re-brief the room lead
The briefing signature of a room lead SHALL NOT include the stage sessions of the roster. A stage session that joins or leaves SHALL NOT send a new briefing to the lead.

#### Scenario: Stage session joins
- **WHEN** session `worker-3` of a stage connects
- **THEN** the room lead gets no new briefing

### Requirement: The room lead gets ticket events as a digest
The bridge of a room lead SHALL hold `ticket.*` entries that need no decision and SHALL deliver them as one digest message every 10 minutes, or with the next entry that wakes the lead. A decision entry, a FAIL result with `fail_count` 2 or more, and a request that waits for approval SHALL come at once.

#### Scenario: Three ticket events
- **WHEN** three `ticket.update` entries arrive in 5 minutes
- **THEN** the lead gets one digest that lists the three tickets

#### Scenario: Escalation
- **WHEN** a decision opens for the human
- **THEN** the lead gets it at once

### Requirement: A result handoff to the lead is a summary
The bridge SHALL show a result handoff to the room lead as: the sender, the ticket id or the request id, the verdict, the count of findings by severity, and the handoff id. The `read_handoff` tool SHALL return the full handoff of the caller's room.

#### Scenario: FAIL result
- **WHEN** the Validator sends a FAIL with 6 findings to the lead
- **THEN** the lead's message holds the ticket id, `FAIL`, the counts and the handoff id, and no finding text

### Requirement: The agent column shows the context percentage
Each Claude role session SHALL have a status line command that writes the status line JSON to `<app data>/context/<agent>.json`. The roster route SHALL return `context_pct` from `context_window.used_percentage`, or null when the file or the value is missing. The agent column SHALL show it, or `–` for null.

#### Scenario: Empty value
- **WHEN** the file has no `used_percentage` just after a compaction
- **THEN** the agent column shows `–`

### Requirement: Code builds the state summary
The hub SHALL build the state summary of a room with no model, in this order: the open requests with their tickets, statuses and blockers; the decisions that wait for the Orchestrator or the human; the last 5 escalations and their state; the stage sessions that run; the last note of the Orchestrator. It SHALL end with the commands to read more. Its size SHALL be at most 2,000 tokens, counted as characters divided by 4.

#### Scenario: Large room
- **GIVEN** a room with 60 open tickets
- **WHEN** the summary is built
- **THEN** it is at most 8,000 characters, and it names the cut tickets by count and the command to list them

### Requirement: A request is done by a fixed predicate
A request SHALL be done when each ticket of the request is `done` or `cancelled`, and at least one is `done`. Its done time SHALL be the `ts` of the ticket event that made this true. A checkpoint is due when a done time is after the newest checkpoint of the lead. A ticket added later SHALL make the request not done again (R4).

#### Scenario: Ticket added later
- **GIVEN** all tickets of `r-1` are `done` or `cancelled` and at least one is `done`
- **WHEN** a new ticket is added to `r-1`
- **THEN** `r-1` is not done

### Requirement: A checkpoint is due by a fixed rule
A checkpoint of a Claude room lead SHALL be due when a request of the room reached `done` after the newest checkpoint of the lead (R4, see "A request is done by a fixed predicate"), or when `context_pct` is at least `checkpoint.context_pct` of `config.yml` (default 60). It SHALL start only at the end of a lead turn, and only when the room has no request that waits for approval, no `open` decision and no live spec review.

#### Scenario: Request done
- **WHEN** a request reaches done and the lead ends its turn with no open decision
- **THEN** a checkpoint starts

#### Scenario: Approval open
- **GIVEN** a checkpoint is due and a request waits for approval
- **THEN** no checkpoint starts until the approval is given

### Requirement: The checkpoint asks for the Orchestrator's note
A started checkpoint SHALL send the lead one entry that asks for a note of at most 200 words with the open points that are not on the board. The note SHALL come through the role plugin script `checkpoint-note.sh`. When the lead ends one turn with no note, the checkpoint SHALL continue without it. A longer note SHALL be cut at 200 words.

#### Scenario: No note
- **WHEN** the lead ends its turn without a note
- **THEN** the summary has no note part and the checkpoint continues

### Requirement: The hub clears the session through the shell
The hub SHALL write the summary to `<app data>/checkpoints/<agent>.md` with mode `0600`, then send a pane input request `/clear` for the lead's session to the shell. The `SessionStart` hook of the Orchestrator role plugin, matcher `clear`, SHALL return the file as `additionalContext` and remove it. The shell SHALL write the text only to the PTY of the named session.

#### Scenario: Clear
- **WHEN** a checkpoint clears the Orchestrator
- **THEN** its first context after `/clear` holds the summary and the file is gone

### Requirement: Each checkpoint is recorded
A `checkpoint` Kind SHALL record each checkpoint with the time, the trigger (`rule` or `human`), the context percentage before and after, and the summary size. Statuses: `noting`, `clearing`, `done`, `failed`. The human SHALL start one with `POST /checkpoints`. A checkpoint with no hook removal in 2 minutes SHALL be `failed`.

#### Scenario: Record
- **WHEN** a rule checkpoint ends
- **THEN** its row has trigger `rule`, both percentages and the summary size
