## Purpose

Makes a high blast radius mean stricter checks by code instead of a human gate: the full suite, a second independent review, and a merge message that names both PASSes.

## ADDED Requirements

### Requirement: The Tester runs the full suite on a high-radius ticket
The first message of a Tester stage of a high-radius ticket SHALL name `./scripts/test.sh`. Its result SHALL hold `full_suite`: `command`, `exit_code`, `pass`, `fail` and `log_path`. A result without it SHALL be refused by the schema check.

A Tester result of a low-radius ticket SHALL name the run. An affected run (`scripts/test-affected.sh`) SHALL set `full_suite: false` and `tests_run`, an array of test file paths relative to the repo root. A full run, also a fallback to the full suite, SHALL set the `full_suite` object and no `tests_run`.

#### Scenario: Missing full suite
- **WHEN** the Tester of a high-radius ticket sends a result without `full_suite`
- **THEN** the hub refuses it and the stage stays `running`

#### Scenario: Affected run on a high-radius ticket
- **WHEN** the Tester of a high-radius ticket sends a result with `full_suite: false`
- **THEN** the hub refuses it and the stage stays `running`

### Requirement: A review PASS on a high-radius ticket needs a passing full suite
A Validator PASS on a high-radius ticket SHALL be refused by the schema check when the last Tester result of the ticket has no `full_suite` with `exit_code` 0.

#### Scenario: Suite failed
- **GIVEN** the last Tester result has `full_suite.exit_code` 1
- **WHEN** the Validator sends PASS
- **THEN** the hub refuses the result with "a high-radius PASS needs a full suite with exit code 0"

### Requirement: A second review runs in a new session
After the first Validator PASS of a high-radius ticket, the hub SHALL create one Validator stage with `review: second` in its own transaction. It SHALL launch it in a new session with the pair of `second_review` in `config.yml` (default: Claude, opus, high). Its first message SHALL NOT hold the first review's verdict or findings. The hub SHALL create a missing second review at start.

#### Scenario: First PASS
- **WHEN** the Validator sends PASS on a high-radius ticket
- **THEN** the ticket stays `in_review` and one second review stage is `queued`

#### Scenario: Restart between PASS and second review
- **GIVEN** the hub stopped after the first PASS and before the second stage row
- **WHEN** the hub starts
- **THEN** one second review stage exists

### Requirement: Two PASSes move a high-radius ticket to done
The PASS of the second review SHALL move the ticket to `done`, actor `system`, in the transaction of `stage.passed`. A FAIL of either review SHALL count as a ticket review FAIL. An agent's move to `done` on a high-radius ticket SHALL get 409 when the ticket has no first and second PASS after its last FAIL. The human SHALL move it.

#### Scenario: Both PASS
- **WHEN** the second review sends PASS
- **THEN** the ticket is `done` and no human action was needed

#### Scenario: Agent moves early
- **WHEN** the assignee moves a high-radius ticket with one PASS to `done`
- **THEN** the hub returns 409 "a high-radius ticket needs the review PASS and the second review PASS"

### Requirement: The hub gives the merge message
`GET /tickets/<id>/merge-message` SHALL return `Merge ticket/<id>: <title> (validator PASS <h1>)` for a low-radius ticket and `Merge ticket/<id>: <title> (validator PASS <h1>, second review PASS <h2>)` for a high-radius ticket, where `h1` and `h2` are the result handoff ids. It SHALL return 409 when a PASS is missing.

#### Scenario: High-radius message
- **WHEN** the Orchestrator reads the merge message of a done high-radius ticket
- **THEN** the text names both handoff ids

### Requirement: Main stays with the human
No hub route and no stage SHALL merge into, commit on or push `main`. Only the human merges staging into main.

#### Scenario: No main writes
- **WHEN** `rg -n "checkout main|merge main|push origin main" hub src-tauri/src` runs
- **THEN** it finds no match
