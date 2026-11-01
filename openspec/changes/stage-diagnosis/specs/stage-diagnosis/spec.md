## Purpose

Finds the cause of each stage failure with the least effort that is sufficient: code rules first, then a read-only Diagnostician whose model comes from a deterministic score, and then one fixed action for each failure.

## ADDED Requirements

### Requirement: Code computes a complexity score from the failure record
Code SHALL compute the score from the failure record and the ledger only. No model SHALL choose the score or the tier. Points: +1 for each component involved beyond the first (hub, shell, bridge, agent, git/worktree); +1 for each earlier attempt; +1 for each 3 distinct error lines, max 3; +2 for a gap in the trace; +2 if the same ticket or request has a failure record of another stage; +2 if the category is `unknown`.

#### Scenario: Simple first failure
- **WHEN** attempt 1 ends with category `no result`, only the agent is involved, there are no error lines, no gap and no other failure of the ticket
- **THEN** the score is 0

#### Scenario: Error lines are capped
- **WHEN** the record has 14 distinct error lines
- **THEN** the error lines add 3 points

#### Scenario: Gap in the trace
- **WHEN** the trace has a `turn_end` line and no `bridge_connect` line in the same attempt
- **THEN** the score has +2 with the fact `trace gap: bridge_connect`

#### Scenario: Same trace, same tier
- **WHEN** the score is computed twice from the same record, ledger and settings
- **THEN** the score, the facts and the tier are equal

### Requirement: The score sets the tier
The tier SHALL be: score 0 = tier 0 (code rules only, no agent); score 1 to 3 = tier 1 (sonnet, effort low); score 4 to 6 = tier 2 (sonnet, effort medium); score 7 or more = tier 3 (opus, effort high). The record SHALL store the score, each fact with its points, and the tier.

#### Scenario: Tier from score
- **WHEN** the score is 5
- **THEN** the record has tier 2 (sonnet, medium) and the facts whose points add up to 5

### Requirement: Points and tier limits are settings
The points (including the 3 lines for each error point and the cap of 3) and the tier limits SHALL be read from the `diagnosis:` block of `config.yml`. A missing block SHALL give the defaults of this spec. An invalid value SHALL give the default for that value and one log line.

#### Scenario: Changed point value
- **WHEN** `config.yml` sets the trace gap to 3 points and the app restarts
- **THEN** a record with one trace gap gets 3 points for it

#### Scenario: Invalid value
- **WHEN** `config.yml` sets a point value to `-1`
- **THEN** the default is used and the hub log names the setting

### Requirement: Code rules act on known categories without a diagnosis stage
Code SHALL take the action for these categories and SHALL NOT start a diagnosis stage for them: `missing setup` gets `setup-fix-and-retry` when a fix from the fix list applies, else `escalate`; `no connect` gets `retry`; `time-out` with no `turn_end` line in the attempt gets `retry`.

#### Scenario: No connect
- **WHEN** a failure record has the category `no connect`
- **THEN** no diagnosis stage is created and the action is `retry`

#### Scenario: No project folder
- **WHEN** a failure record has the category `missing setup` because the room has no project folder
- **THEN** the action is `escalate`

### Requirement: Tier 0 retries without an agent
A failure at tier 0 that no code rule matches SHALL get the action `retry` from code. No diagnosis stage SHALL start.

#### Scenario: Tier 0
- **WHEN** a failure record has tier 0 and the category `no result`
- **THEN** no diagnosis stage is created and the stage relaunches once

### Requirement: The Diagnostician is a read-only factory role
The role `diagnostician` SHALL run on Claude. Its worktree SHALL be read-only, as for the Validator. It SHALL NOT have Edit, Write, NotebookEdit, Task, Agent, or the Bash commands of the blocked list. It SHALL have the core skills `agent-introspection-debugging`, `debugging-and-error-recovery`, `silent-failure-hunter`, `agency-testing-evidence-collector` and `stage-failure-categories`. A ticket and a `to_role` handoff SHALL NOT name it.

#### Scenario: Launch flags
- **WHEN** the hub launches a diagnosis stage
- **THEN** the launch command blocks Edit, Write, NotebookEdit, Task, Agent and each Bash command of the blocked list

### Requirement: The pattern run has three more skills
The role SHALL also have the skills `loop-design-check`, `agent-architecture-audit` and `growth-log`. The first message of a pattern run SHALL tell the Diagnostician to use them. The first message of a single diagnosis SHALL NOT name them.

#### Scenario: Pattern-run skills
- **WHEN** the hub writes the first message of a pattern run
- **THEN** it names `loop-design-check`, `agent-architecture-audit` and `growth-log`, and the first message of a single diagnosis names none of them

#### Scenario: The Diagnostician names the action, code runs it
- **WHEN** the skill `agent-introspection-debugging` describes a recovery action
- **THEN** the Diagnostician's result names one action from the action list, and the Diagnostician does not run it

### Requirement: The Diagnostician's Bash commands have a blocked list
The launch SHALL block `git commit`, `git push`, `git checkout`, `git reset`, `git clean`, `git restore`, `git stash`, `git rebase`, `git merge` and `rm` as Bash commands. The blocked list and the read-only worktree are limits, not a sandbox: Bash can still write through other commands. The role file and `docs/rules/` SHALL state this.

#### Scenario: Blocked command
- **WHEN** the Diagnostician runs `git stash` with Bash
- **THEN** the harness refuses the call

#### Scenario: Not a sandbox is stated
- **WHEN** a reader opens `factory/diagnostician/diagnostician.md`
- **THEN** it states that the limits are not a sandbox

#### Scenario: Not a ticket role
- **WHEN** a ticket is created with role `diagnostician`
- **THEN** the hub returns 400 and writes nothing

### Requirement: One diagnosis stage for each failure at tier 1 or higher
The hub SHALL create exactly one diagnosis stage for each failure record at tier 1 or higher that no code rule matches. The launch SHALL use the model and the effort of the tier. A failure SHALL never get a second diagnosis stage.

#### Scenario: Tier 2 failure
- **WHEN** a failure record has tier 2
- **THEN** one diagnosis stage is queued with role `diagnostician`, and its launch request has model `sonnet` and effort `medium`

#### Scenario: No second diagnosis
- **WHEN** the hub restarts while a diagnosis stage of a failure runs
- **THEN** no new diagnosis stage is created for that failure

### Requirement: A retrying stage waits for its failure action
A stage in `retrying` SHALL relaunch only after the failure record of that attempt has the action `retry` or `setup-fix-and-retry`. Any other action SHALL move the stage to `failed`. This replaces the immediate relaunch of `stage-sessions`.

#### Scenario: Waits during diagnosis
- **WHEN** attempt 1 of a stage fails at tier 1 and a slot of its role is free
- **THEN** the stage stays `retrying` until the diagnosis result is recorded

#### Scenario: Gap ticket ends the stage
- **WHEN** the diagnosis result of attempt 1 has the action `gap-ticket`
- **THEN** the stage moves to `failed` and does not relaunch

### Requirement: A diagnosis stage has its own time-out
A diagnosis stage SHALL stop after `diagnosis.timeout_min` of `config.yml` (default 15 minutes). On that time-out the failure SHALL get `escalate`, and a stage that waits in `retrying` for that failure SHALL move to `failed` without a relaunch.

#### Scenario: Diagnosis time-out
- **WHEN** the diagnosis stage of a failure of attempt 1 runs for 15 minutes without a result
- **THEN** the diagnosis stage is `failed`, the failure has `escalate`, and the waiting stage moves to `failed` and does not relaunch

### Requirement: The diagnosis stage gets the evidence in its first message
The first message of a diagnosis stage SHALL hold: its own stage id, the failure id, the trace, the failure record, the ticket (title, acceptance criteria, blast radius), and the verdicts and findings of the earlier stages of the ticket. Each of the trace and the record SHALL be capped at 64 KiB; a cut SHALL keep the newest lines and add one line that names the trace path.

#### Scenario: First message content
- **WHEN** a diagnosis stage launches for a tester failure
- **THEN** its first message holds the tester stage's trace lines, the failure record and the ticket's acceptance criteria

### Requirement: The diagnosis result is checked against a schema
A diagnosis result SHALL hold `stage_id`, `failure_id`, `cause`, at least one `evidence` item (`trace` or `pane` with the quoted line, or `command` with the command and its output), `confidence` (`proven` | `probable`) and one `action` (`retry`, `setup-fix-and-retry`, `gap-ticket`, `ticket-change`, `escalate`). `setup-fix-and-retry` needs `fix`; `gap-ticket` needs `title` and `acceptance_criteria`; `ticket-change` needs `change`.

#### Scenario: Invented quote
- **WHEN** a result quotes a pane line that is not in the failure record
- **THEN** the hub sends the error to the same session as `stage.rejected` and the stage stays `running`

#### Scenario: Valid result
- **WHEN** a result has a quoted trace line, `confidence` `probable` and `action` `retry`
- **THEN** the diagnosis stage passes and the failure gets the action `retry`

#### Scenario: Missing field for the action
- **WHEN** a result has `action` `gap-ticket` and no `acceptance_criteria`
- **THEN** the hub refuses the result with `stage.rejected`

### Requirement: Evidence quotes are checked against the record
Each `trace` or `pane` quote of a diagnosis result SHALL occur in the trace or the failure record of that failure. A `proven` result SHALL have at least one such quote.

#### Scenario: Proven without a quote
- **WHEN** a result has `confidence` `proven` and only `command` evidence
- **THEN** the hub refuses the result with `stage.rejected`

### Requirement: A diagnosis names its cause key
A diagnosis result and each pattern proposal SHALL hold `component` (one of `hub`, `shell`, `bridge`, `agent`, `git/worktree`) and `cause_slug` (lowercase letters, digits and `-`, at most 60 characters). The cause key SHALL be `<category>/<component>/<cause_slug>`. The first message SHALL list the open, resolved and ignored keys of the room, so that the Diagnostician can reuse a key.

#### Scenario: Bad slug
- **WHEN** a result has `cause_slug` `Bridge died!`
- **THEN** the hub refuses the result with `stage.rejected`

#### Scenario: Known keys listed
- **WHEN** the room has an open gap ticket with key `no first message/bridge/mod-not-loaded`
- **THEN** the first message of a diagnosis stage in that room lists that key

### Requirement: Code runs retries only within the limits
Code SHALL run `retry` and `setup-fix-and-retry` at most once for each failure. `setup-fix-and-retry` SHALL run only for a `proven` cause; for a `probable` cause it SHALL become `escalate`. When the stage has no attempt left, `retry` and `setup-fix-and-retry` SHALL become `escalate`. The fix list SHALL be: `recreate-worktree`, `install-deps`.

#### Scenario: Probable setup fix
- **WHEN** a result has `setup-fix-and-retry` with `confidence` `probable`
- **THEN** no fix runs, the action taken is `escalate`

#### Scenario: Last attempt
- **WHEN** attempt 2 fails and its diagnosis result is `retry`
- **THEN** the stage stays `failed` and the action taken is `escalate` with the note `no attempt left`

#### Scenario: Install deps
- **WHEN** a proven result has `setup-fix-and-retry` with `fix` `install-deps`
- **THEN** the hub runs the install once in the stage worktree under the heavy-process lock, then relaunches the stage

### Requirement: Non-retry actions go to people, not to code
`gap-ticket` SHALL create one `draft` ticket with the title and acceptance criteria of the result, actor `system`, for spec review. `ticket-change` SHALL send a handoff to the room lead with the change text. `escalate` SHALL add the failure to "Needs you" until the human dismisses it.

#### Scenario: Gap ticket
- **WHEN** a result has `action` `gap-ticket`
- **THEN** one `draft` ticket exists with that title and acceptance criteria, and no stage starts for it

#### Scenario: Escalate
- **WHEN** a failure gets the action `escalate`
- **THEN** "Needs you" shows the failure with its cause, and only the human can dismiss it

### Requirement: One gap ticket for each cause key
A gap ticket SHALL carry its cause key. When a gap ticket with the same key is open in the room, the failure SHALL be added to that ticket and no new ticket SHALL be created. A key SHALL be resolved when its newest gap ticket is `done`, and ignored only when that ticket was cancelled with `ignore_cause`. A failure with a resolved key, or with a key whose ticket was cancelled without `ignore_cause`, SHALL create a new gap ticket that names the earlier one.

#### Scenario: Repeat onto the open ticket
- **WHEN** a second failure gets `gap-ticket` with a key whose gap ticket is open
- **THEN** no new ticket is created, and the open ticket lists both failures

#### Scenario: Regression
- **WHEN** a failure gets `gap-ticket` with a key whose gap ticket is `done`
- **THEN** a new draft gap ticket is created that names the earlier ticket

#### Scenario: Plain cancel keeps the key active
- **WHEN** a failure gets `gap-ticket` with a key whose gap ticket was cancelled without `ignore_cause`
- **THEN** a new draft gap ticket is created that names the cancelled ticket

### Requirement: An ignored cause key stays quiet
For a failure whose key is ignored, the hub SHALL create no gap ticket, add no "Needs you" entry and send no line to the room lead. It SHALL still record the failure and run `retry` when the rules allow it.

#### Scenario: Reopen ends the ignore
- **WHEN** the human reopens the gap ticket of an ignored key, and a new failure gets `gap-ticket` with that key
- **THEN** the failure is added to the reopened ticket and the lead gets the line

#### Scenario: Ignored key
- **WHEN** a failure gets `gap-ticket` with a key whose gap ticket was cancelled with `ignore_cause`
- **THEN** no ticket, no "Needs you" entry and no message to the lead is created, and the failure is recorded with the note `ignored key`

### Requirement: A proven diagnosis saves a fixture
When a `proven` result links its failure to a gap ticket, the hub SHALL copy the trace and the failure record to `<app data>/fixtures/<failure_id>/` (mode `0600`). The gap ticket SHALL name the fixture and SHALL have the criterion that a minimal synthetic test reproduces the failure. The Worker's first message SHALL hold the fixture; the fixture SHALL NOT be copied into the repository.

#### Scenario: Fixture saved
- **WHEN** a proven result with `gap-ticket` is recorded
- **THEN** the fixture folder holds `trace.jsonl` and `failure.json`, and the gap ticket names the fixture and has the reproduction criterion

#### Scenario: Probable result
- **WHEN** a probable result with `gap-ticket` is recorded
- **THEN** no fixture is saved and the gap ticket has no fixture

### Requirement: The reproduction test is synthetic
The test that the Worker adds SHALL be a minimal synthetic reproduction. It SHALL NOT contain raw pane text, absolute paths, or values copied from the fixture (ids, timestamps, tokens, file contents). The Validator SHALL check this before PASS.

#### Scenario: Copied pane line
- **WHEN** the diff of a gap ticket holds a line of the fixture's pane text
- **THEN** the Validator gives FAIL with a finding that names the line

#### Scenario: Absolute path
- **WHEN** the reproduction test holds `/Users/` or another absolute path
- **THEN** the Validator gives FAIL

### Requirement: A gap ticket with a fixture needs the test and the suite to pass
A Validator PASS on a ticket with a fixture SHALL hold `fixture_test` (path, command, before `FAIL`, after `PASS`, output excerpt) and `suite` (command, result `PASS`, output excerpt). Each excerpt SHALL be non-empty and at most 2 KiB. The hub SHALL refuse a PASS without both. Without such a PASS the ticket SHALL NOT reach `done`.

#### Scenario: PASS without an excerpt
- **WHEN** the Validator sends PASS with `suite` that has no output excerpt
- **THEN** the hub refuses the result with `stage.rejected`

#### Scenario: PASS without the suite
- **WHEN** the Validator sends PASS on a gap ticket with a fixture and no `suite`
- **THEN** the hub refuses the result with `stage.rejected` and the ticket does not move

#### Scenario: Complete PASS
- **WHEN** the Validator PASS has `fixture_test` with its command, `FAIL` then `PASS` and an excerpt, and `suite` with its command, `PASS` and an excerpt
- **THEN** the ticket moves as `stage-sessions` requires for a final PASS

### Requirement: The human marks a diagnosis right or wrong
"Needs you" SHALL list each diagnosis of the room that has no mark, with its cause, evidence and action. Only the human SHALL mark it `right` or `wrong`, with an optional note. A later mark SHALL replace the earlier one. A diagnosis of an ignored key SHALL NOT be listed.

#### Scenario: Mark
- **WHEN** the human marks a diagnosis `wrong` with a note
- **THEN** the failure stores the mark and the note, and "Needs you" no longer lists it

#### Scenario: Agent cannot mark
- **WHEN** an agent sends a mark
- **THEN** the hub returns 403 and stores nothing

### Requirement: The hub reports the diagnosis success share for each tier
For each tier of a room, the hub SHALL return the number of acted failures whose action started a next attempt, the number of those whose next attempt passed, and their share. It SHALL also return the count of each other action for that tier.

#### Scenario: Share for tier 1
- **WHEN** tier 1 has 4 failures with `retry` and 3 of their next attempts passed
- **THEN** the report for tier 1 shows 3 of 4, share 0.75

### Requirement: A pattern run reads new failure records together
For each room, the hub SHALL start one pattern run (diagnosis stage, opus with effort high) when 10 failure records are new, when one category has 3 new records within one hour, or when 24 hours passed since the last pattern run and at least one record is new. A record is new until a pattern run that included it passes. Each repeated cause in its result SHALL be handled as a gap ticket.

#### Scenario: Ten records
- **WHEN** the tenth new failure record of a room is written
- **THEN** one pattern run is queued with those ten records

#### Scenario: Same category three times in one hour
- **WHEN** a room gets three failure records with the category `no first message` within 40 minutes
- **THEN** one pattern run is queued at the third record

#### Scenario: Proposal needs a repeated cause
- **WHEN** a pattern result proposes a gap ticket that names only one item of its scope
- **THEN** the hub refuses the result with `stage.rejected`

### Requirement: The pattern run reads the human's marks
The first message of a pattern run SHALL hold each record in its scope with the human's mark (`right`, `wrong` or none) and the mark note, and the outlier attempts in its scope.

#### Scenario: Marked wrong
- **WHEN** the human marked the diagnosis of a record in scope as wrong with a note
- **THEN** the pattern run's first message shows `wrong` and the note next to that record

### Requirement: Diagnosis has hard limits
A diagnosis stage and a pattern run SHALL NOT get a failure record, a diagnosis or a retry. When a diagnosis stage fails, its failure SHALL get the action `escalate`. The Diagnostician SHALL NOT edit files, commit, or start a session or stage.

#### Scenario: Diagnosis stage times out
- **WHEN** a diagnosis stage runs past the time-out
- **THEN** it moves to `failed` with no retry, and its failure gets `escalate` with the cause `diagnosis stage failed`

### Requirement: The Orchestrator gets one line for each failure
When a failure gets its action, and its key is not ignored, the hub SHALL send the room lead one line with the ticket id (or the request id, or `no ticket`), the stage, the cause (or the category when no diagnosis ran), one evidence item and the action taken. For `ticket-change` the line SHALL be the task of the handoff. The diagnosis result itself SHALL NOT be delivered to the lead.

#### Scenario: One line
- **WHEN** a failure of ticket `t_0123456789abcdef` gets the action `retry` after a diagnosis
- **THEN** the lead receives exactly one message about that failure, it holds `t_0123456789abcdef`, and no diagnosis result handoff

### Requirement: The ticket shows why it failed
The ticket card SHALL show "Why it failed" for the newest failure of the ticket: the cause or the category, the action taken, and a link that opens the trace.

#### Scenario: Ticket card
- **WHEN** a stage of a ticket has a failure with an action
- **THEN** the ticket card shows "Why it failed" with the cause and a trace link
