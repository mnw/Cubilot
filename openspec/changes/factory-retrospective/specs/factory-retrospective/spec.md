## ADDED Requirements

### Requirement: The hub starts one retrospective each week
The hub SHALL create one retrospective stage (review `retro`, no ticket) for each room with at least one ticket event in the window, at the first stage sweep on or after Monday 06:00 hub local time. The window SHALL be the 7 days before that Monday 06:00. At most one retrospective stage that is not `cancelled` SHALL exist for each room and ISO week. No model SHALL take part in the schedule.

#### Scenario: Second sweep in the same week
- **GIVEN** the retrospective stage of room `r1` for week `2026-W45` exists
- **WHEN** the stage sweep runs again in `2026-W45`
- **THEN** the hub creates no second retrospective stage for `r1`

### Requirement: Code builds one evidence file for the room and week
Before the stage starts, the hub SHALL write `<dir of CUBILOT_LEDGER_DB>/retro/<room>/<iso-week>.json` with the sections `flow`, `stages`, `findings`, `human`, `causes`, `reports` and `improvements`, from the window only and with no model. The file SHALL hold no wall-clock time other than the window bounds. Its keys and lists SHALL be in a fixed order, so that the same ledger and window give the same bytes.

#### Scenario: One week of ledger data
- **GIVEN** a ledger with one week of stages, findings, human actions, a ticket in request `r-2026-11-04-cause-lock-wait` and a checkpoint note
- **WHEN** the hub builds the evidence file
- **THEN** `flow` holds the flow report of the room for the window
- **AND** `stages` holds for each stage the role, duration, turns, tokens, attempts, and the verdict or `no result`
- **AND** `findings` holds the review findings by kind and the tickets with a second FAIL
- **AND** `human` holds each event with the human as actor (Approve, Allow, decision answer, overrule, ticket edit, radius change, status move), with the record id, the wait since the previous event of that record, and the reason when the payload has one
- **AND** `causes` holds the tickets created in the window whose request id matches `r-<YYYY-MM-DD>-cause-<topic>`, with the ticket id, title, status and request id
- **AND** `reports` holds the checkpoint notes of the room lead
- **AND** a second build from the same ledger gives the same bytes

### Requirement: The evidence file lists earlier improvements
`improvements` SHALL list each ticket of an earlier `r-<date>-retro` request that is not `done`, or that became `done` in the last 4 windows and has no `done` revert ticket. Each item SHALL hold the ticket id, its status, and the name, before value and target of its `Target measure:` line, or `measure: null` when the line does not parse.

#### Scenario: Week 2 lists week 1 improvements
- **GIVEN** a proposal ticket of week 1 is `done` with `Target measure: tester_hours_per_ticket from 3.2 to 2`
- **WHEN** the hub builds the evidence file of week 2
- **THEN** `improvements` lists that ticket with measure `tester_hours_per_ticket`, before `3.2` and target `2`

### Requirement: The retrospective is a stage role only
The hub SHALL accept `retrospective` as a stage role with a default role limit of 1. The hub SHALL refuse `retrospective` as a ticket role and as a handoff `to_role` with 400.

#### Scenario: Agent names the role
- **WHEN** an agent creates a ticket with role `retrospective`, or sends a handoff with `to_role: retrospective`
- **THEN** the hub returns 400

### Requirement: A retrospective stage runs read-only on Claude
A retrospective stage SHALL run on Claude with the `retrospective` pair of `role_models` (default opus, effort high), in a new session and a read-only detached worktree of the current staging head. The shell SHALL list `retrospective` as a read-only role.

#### Scenario: Launch
- **WHEN** a retrospective stage launches
- **THEN** the launch request has harness claude, model opus and effort high
- **AND** its worktree is detached and not writable

### Requirement: The first message holds the evidence
The first message of a retrospective stage SHALL hold the evidence file of its week and the proposals of the previous retrospective of the room.

#### Scenario: First message
- **WHEN** the retrospective stage of week `2026-W46` starts
- **THEN** its first message holds the `improvements` section of `2026-W46` and the proposal titles of `2026-W45`

### Requirement: The hub checks the result against the retrospective-review schema
The result SHALL follow `factory/retrospective/skills/retrospective-review/SKILL.md`. A verdict SHALL hold `improvement`, `measure`, `before`, `after`, `verdict` (`keep` or `revert`) and `note`. A proposal SHALL hold `title`, `problem`, `evidence`, `change`, `kind` (`code-check`, `script`, `role-file` or `setting`), `files`, `measure` (`name`, numeric `now` and `target`) and `risk`. A refused result SHALL get 400 and the stage SHALL stay `running`.

#### Scenario: Unknown kind
- **WHEN** a proposal has `kind: "process"`
- **THEN** the hub returns 400 and the stage stays `running`

### Requirement: A result has at most 3 proposals
The hub SHALL refuse a result with more than 3 proposals.

#### Scenario: Four proposals
- **WHEN** the retrospective sends a result with 4 proposals
- **THEN** the hub returns 400 "at most 3 proposals" and the stage stays `running`

### Requirement: A proposal holds numbers from the evidence
The hub SHALL refuse a proposal with no `evidence` item, or with an `evidence` item that does not start with a section name of the evidence file or holds no number.

#### Scenario: Proposal with no evidence numbers
- **WHEN** a proposal has `evidence: ["flow: testers seem slow"]`
- **THEN** the hub returns 400 and the stage stays `running`

### Requirement: A proposal cannot remove a human gate
The hub SHALL refuse a proposal that removes a human gate: the start of a request, the delivery, main, security, or an action that cannot be undone.

#### Scenario: Proposal removes a human gate
- **WHEN** a proposal has `change: "Remove the human Approve for factory requests"`
- **THEN** the hub returns 400 "a proposal cannot remove a human gate" and the stage stays `running`

### Requirement: A role-file proposal names the line it replaces
A `role-file` proposal SHALL hold `replaces`, and `replaces` SHALL equal the text of its `files` line at the commit of the stage worktree. The hub SHALL refuse it otherwise.

#### Scenario: Role-file proposal without the line it replaces
- **WHEN** a `role-file` proposal names `factory/worker/worker.md:12` and has no `replaces`
- **THEN** the hub returns 400 and the stage stays `running`

### Requirement: Each merged improvement gets a verdict
The result SHALL hold one verdict for each `done` item of `improvements`. The hub SHALL refuse a result that misses one.

#### Scenario: Week 2 result has a verdict for each improvement
- **GIVEN** the week 2 evidence file lists two `done` improvements
- **WHEN** the result has a verdict for one of them
- **THEN** the hub returns 400
- **WHEN** the result has `keep` or `revert` for each of them
- **THEN** the hub accepts the result

### Requirement: An accepted result opens the request r-<date>-retro
When the hub accepts a result with at least one proposal or one `revert`, it SHALL create the request `r-<date>-retro` (date of the window end, `YYYY-MM-DD`) with origin `factory`, `source` the stage id and the feature `retrospective`, and SHALL start its spec review as `system`. The request SHALL need the human's Approve. A result with no proposal and no `revert` SHALL create no request.

#### Scenario: Request waits for the Approve
- **WHEN** the hub accepts a result with 1 proposal at window end 2026-11-09
- **THEN** request `r-2026-11-09-retro` exists with origin `factory` and feature `retrospective`
- **AND** its spec review stage is `queued` and the request needs the human's Approve

### Requirement: Each proposal becomes a draft ticket
Each proposal SHALL become one draft ticket in `r-<date>-retro`. The title SHALL be the proposal title as a user story. The criteria SHALL hold the problem, the change, the files and the last line `Target measure: <name> from <now> to <target> (retrospective <stage id>)`. The tickets SHALL go through the normal radius rule. The hub SHALL NOT queue them. The human SHALL be able to cancel any of them before the Approve.

#### Scenario: Accepted proposals
- **WHEN** the hub accepts a result with 2 proposals at window end 2026-11-09
- **THEN** request `r-2026-11-09-retro` holds 2 draft tickets
- **AND** the criteria of each ticket end with its `Target measure:` line

### Requirement: A revert verdict becomes a draft ticket
Each `revert` verdict SHALL become one draft ticket in the same `r-<date>-retro` request, titled `Revert <ticket id>: <title of that ticket>`, with criteria that name the change to undo and the line `Target measure: <name> from <after> to <before> (retrospective <stage id>)`. A `keep` verdict SHALL create no ticket.

#### Scenario: Revert verdict
- **WHEN** the hub accepts a result with `revert` for `t_abc` and `keep` for `t_def`
- **THEN** the request holds one draft ticket `Revert t_abc: ...` and no ticket for `t_def`
