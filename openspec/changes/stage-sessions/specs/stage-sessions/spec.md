## ADDED Requirements

### Requirement: A ticket carries a role

The hub SHALL store an optional role on each ticket. The allowed roles are `worker`, `tester`, `validator`, `writer`, `editor` and `reviewer`. The hub SHALL reject any other value with HTTP 400 and SHALL store nothing.

#### Scenario: Valid role

- **WHEN** an Orchestrator creates a ticket with the role `tester`
- **THEN** the ticket stores the role `tester`

#### Scenario: Unknown role

- **WHEN** a client sets the role `chef` on a ticket
- **THEN** the hub returns HTTP 400 and the ticket is unchanged

### Requirement: A launched session owns its ticket

When the hub starts a stage session, the hub SHALL set the ticket's assignee to the session name, in the same transaction as the stage's `launching` state. The hub SHALL reassign the ticket to the new session name on each retry. The assignment SHALL use the `ticket.assigned` event with the actor `system`. No other route SHALL accept the actor `system`. The assignment SHALL NOT wake the session on its first turn.

#### Scenario: Launch assigns the ticket

- **WHEN** a worker stage moves to `launching` as session `worker-1`
- **THEN** the ticket assignee is `worker-1`
- **AND** the ledger holds one `ticket.assigned` event with the actor `system`

#### Scenario: Retry reassigns the ticket

- **WHEN** the retry of a stage launches session `worker-2`
- **THEN** the ticket assignee is `worker-2`

#### Scenario: System actor is refused elsewhere

- **WHEN** a client sends `by: "system"` on a ticket edit
- **THEN** the hub returns HTTP 400 and records nothing

### Requirement: A stage is one role's work on one ticket

The hub SHALL keep a stage for each role's work on a ticket. The hub SHALL record each stage state change as one ledger event and one table update in one transaction. The states SHALL be `queued`, `launching`, `running`, `passed` and `failed`.

#### Scenario: One event per change

- **WHEN** a stage moves from `queued` to `launching`
- **THEN** the ledger holds one `stage.launching` event
- **AND** the stage row shows `launching`

### Requirement: A stage is ready only when all conditions hold

The hub SHALL create a stage for a ticket and a role only when all of these hold: the ticket has that role; the ticket is not `draft`, `done` or `cancelled`; no ticket in its `blocked_by` list is open; and either no stage exists for the ticket and role, or a handoff to that role arrived after the last stage was created. While a stage for the ticket and role is `queued`, `launching` or `running`, the hub SHALL NOT create another.

#### Scenario: Blocked ticket

- **GIVEN** a ticket with role `worker` and one open blocker
- **WHEN** the hub evaluates the ticket
- **THEN** the hub creates no stage

#### Scenario: Draft ticket

- **GIVEN** a ticket with role `worker` in status `draft`
- **WHEN** the hub evaluates the ticket
- **THEN** the hub creates no stage

#### Scenario: Done ticket

- **GIVEN** a ticket with role `worker` in status `done`
- **WHEN** the hub evaluates the ticket
- **THEN** the hub creates no stage

#### Scenario: New handoff starts a new stage

- **GIVEN** the last `tester` stage of a ticket has passed
- **WHEN** a handoff to role `tester` arrives for that ticket
- **THEN** the hub creates one new `tester` stage

### Requirement: A handoff can name a role

A handoff SHALL name either an agent (`to`) or a role (`to_role`), and not both. A handoff that names a role SHALL NOT name a session. Handoffs that name an agent SHALL work as before.

#### Scenario: Handoff to a role

- **WHEN** an agent sends a handoff with `to_role: "tester"`
- **THEN** the hub records the handoff with the role and creates or queues a `tester` stage

#### Scenario: Both targets

- **WHEN** a handoff names both `to` and `to_role`
- **THEN** the hub returns HTTP 400 and records nothing

### Requirement: Each role has a session limit per room

The room settings SHALL hold a maximum number of live sessions for each role. A room with no saved limits SHALL use the defaults: 2 workers, 2 testers, and 1 each for validator, writer, editor and reviewer. A stage whose role is full SHALL stay `queued`. When a slot frees, the hub SHALL start the oldest queued stage of that role in the room.

#### Scenario: Full role queues the stage

- **GIVEN** the worker limit of a room is 1 and a worker session is running
- **WHEN** a second ready ticket needs a worker
- **THEN** the second stage stays `queued`

#### Scenario: Queued stage starts when a slot frees

- **WHEN** the running worker session closes
- **THEN** the oldest queued worker stage moves to `launching`

### Requirement: The hub names sessions by role and number

The hub SHALL name a session `<role>-<n>`, where `n` is the lowest number of at least 1 that no live session of the role in the room uses.

#### Scenario: Name reuse

- **GIVEN** the sessions `worker-1` and `worker-2` are live
- **WHEN** a third worker session starts after `worker-1` closes
- **THEN** the name `worker-1` is used again

### Requirement: The hub launches and closes sessions through the shell

The hub SHALL NOT start or stop a process. For each session, the hub SHALL queue a launch request or a close request. The Rust shell SHALL read these requests from a stream that the shell opens with the hub token. The shell SHALL acknowledge each request with success or an error message. A launch with no acknowledgement within 15 seconds, or with an error, SHALL count as a failed attempt. A close request SHALL close only the named session.

#### Scenario: Launch request

- **WHEN** the hub queues a launch for `worker-1`
- **THEN** the shell starts a session named `worker-1` with the role `worker`
- **AND** the shell acknowledges the request

#### Scenario: Launch error

- **WHEN** the shell reports an error for a launch request
- **THEN** the hub counts the attempt as failed and does not wait for a session

#### Scenario: Close does not touch other sessions

- **WHEN** the hub queues a close for `tester-1`
- **THEN** the shell closes `tester-1` only

### Requirement: Only the hub launches sessions

The Orchestrator, a role session and every chatbridge tool SHALL NOT start a session. No route and no chatbridge tool SHALL queue a launch request. Only the stage evaluation and the stage retry path SHALL queue one. The hub SHALL NOT use per-role tokens for this; a holder of the hub token can reach the launch stream (see the design risks).

#### Scenario: Orchestrator cannot launch

- **WHEN** the Orchestrator calls a chatbridge tool that would start a session
- **THEN** the tool does not exist, or it returns an error and the shell starts nothing

#### Scenario: No route queues a launch

- **WHEN** a client calls every route that the hub exposes for tickets, handoffs and rooms
- **THEN** none of them queues a launch request

### Requirement: Stage worktrees come from the room's project folder

The hub SHALL create every stage worktree from the room's project folder. When the room has no project folder, the hub SHALL refuse the launch with an error that names the setting, SHALL mark the stage `failed`, and SHALL NOT count an attempt.

#### Scenario: No project folder

- **GIVEN** a room with no project folder
- **WHEN** a worker stage is ready
- **THEN** the stage moves to `failed` with the error `room has no project folder`
- **AND** no session starts

### Requirement: Worker and Writer stages use the ticket branch

For a Worker or Writer stage, the hub SHALL use the worktree of the branch `ticket/<id>`. A later stage of the same ticket and role SHALL reuse that worktree.

#### Scenario: Worker uses the ticket branch

#### Scenario: Worker uses the ticket branch

- **WHEN** a Worker stage starts for ticket `t42`
- **THEN** its worktree is on the branch `ticket/t42`

### Requirement: Temporary worktrees are detached and removed

For a Tester, Validator, Editor or Reviewer stage, the hub SHALL create a temporary worktree at the commit named in the handoff, or at HEAD when none is named. The hub SHALL remove a temporary worktree when its stage passes or fails for good.

#### Scenario: Tester uses the handoff commit

- **WHEN** a handoff names commit `abc123` for a Tester stage
- **THEN** the Tester worktree is detached at `abc123`

### Requirement: Validator and Reviewer worktrees are read-only

The Validator and the Reviewer SHALL get a read-only temporary worktree, and their sessions SHALL have `Edit`, `Write` and `NotebookEdit` blocked.

#### Scenario: Read-only review

- **WHEN** a Validator stage starts
- **THEN** its worktree files are not writable
- **AND** the Validator session has `Edit`, `Write` and `NotebookEdit` blocked

### Requirement: The first message is rendered from the role template

The hub SHALL render each session's first message from `factory/<role>/first-message.md`. The first message SHALL contain only the ticket part. The hub SHALL pass it as the initial prompt of the launch command. The role prompt SHALL NOT appear in the first message; it is passed by `factory-roles` with `--append-system-prompt-file`. The hub SHALL NOT queue the first message as a bridge entry.

#### Scenario: Ticket part only

- **WHEN** a worker session starts for ticket `t42`
- **THEN** the initial prompt holds the title, criteria, blast radius, branch, worktree and stage id of `t42`
- **AND** the initial prompt does not contain the role prompt text

#### Scenario: Retry carries the reason

- **WHEN** the retry of a stage launches a session
- **THEN** the initial prompt holds the same ticket part and one line with the reason of the earlier stop

### Requirement: Results are checked against a schema

A stage SHALL end with a result handoff that names `context.stage_id` and `context.ticket_id`. A Validator or Reviewer result SHALL also contain `context.verdict` (`pass` or `fail`) and `context.findings` (a list of objects with `ticket_id` and `text`). The hub SHALL check the result when it arrives. A result that fails the check SHALL NOT change the stage. The hub SHALL send the errors to the same session and the session SHALL stay open.

#### Scenario: Invalid verdict

- **WHEN** a Validator sends a result with `verdict: "maybe"`
- **THEN** the hub sends the schema errors to the same session
- **AND** the stage stays `running`

#### Scenario: Valid verdict

- **WHEN** a Validator sends a result with `verdict: "pass"` and an empty findings list
- **THEN** the stage moves to `passed`

### Requirement: A passed stage closes its session at the end of the turn

When a stage passes, the transcript SHALL stay in the room history. The session SHALL close at the end of its current turn. The shell SHALL move its pane to a "finished" list. An interrupt SHALL NOT close a session or change a stage.

#### Scenario: Close after the turn

- **WHEN** a stage passes while the agent is still in its turn
- **THEN** the session closes when the turn ends
- **AND** the room history keeps the transcript

#### Scenario: Interrupt

- **WHEN** the human interrupts a running stage session
- **THEN** the session stays open and the stage stays `running`

### Requirement: A stage is retried once

When a session reaches the end of a turn without a result, the hub SHALL send one reminder to that session. A second end of turn without a result SHALL count as a stop. A stop, or a session that passes the time-out in `stage_timeout_min` (default 30), SHALL be relaunched once with the same ticket part and a note with the reason. A second failure SHALL move the stage to `failed` and SHALL send a handoff to the Orchestrator.

#### Scenario: Reminder on first end of turn

- **WHEN** a Worker session ends a turn without a result
- **THEN** the session receives one reminder
- **AND** the stage stays `running`

#### Scenario: Second end of turn counts as a stop

- **WHEN** the same session ends a second turn without a result
- **THEN** the hub counts a stop and starts the retry

#### Scenario: First stop

- **WHEN** a Worker session stops without a result
- **THEN** the hub relaunches one Worker session for the stage with the same ticket part and a reason note

#### Scenario: Second stop

- **WHEN** the relaunched session also stops without a result
- **THEN** the stage moves to `failed`
- **AND** the Orchestrator receives a handoff about the failed stage

### Requirement: Schema migrations take a snapshot first

Before a schema migration runs, the hub SHALL copy the ledger to `<app data>/snapshots/` with mode `0600`. If the copy fails, the hub SHALL NOT run the migration.

#### Scenario: Snapshot before migration

- **WHEN** the hub starts with a ledger that needs a migration
- **THEN** a snapshot file exists before the migration changes the ledger

#### Scenario: Failed snapshot

- **WHEN** the snapshot cannot be written
- **THEN** the migration does not run and the hub reports the error
