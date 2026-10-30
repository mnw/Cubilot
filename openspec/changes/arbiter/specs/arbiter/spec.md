## Purpose

Replaces the human for decisions after two FAILs, waivers, contradictory criteria, third reviews and a radius below the rule. A read-only arbiter stage gives one ruling from a fixed list, and code applies it.

## ADDED Requirements

### Requirement: The hub counts review FAILs for each ticket
The ticket FAIL count SHALL be the number of Validator and Reviewer stages of the ticket with verdict FAIL since the last complete cycle (R1): for a low-radius ticket the cycle ends with the Validator PASS, for a high-radius ticket with the second-review PASS. A FAIL in the second review continues the count. The hub SHALL write it as `fail_count` into each ticket review FAIL result and SHALL overwrite a sender's value.

#### Scenario: Two FAILs
- **WHEN** the Validator sends a second FAIL on `t1` with `fail_count` 7
- **THEN** the stored context holds `fail_count` 2

### Requirement: A third ticket review needs the human or a ruling
A role handoff to `validator` or `reviewer` for a ticket with a FAIL count of 2 or more SHALL get 409 unless the sender is the human or an applied ruling grants that review. A grant SHALL be spent by the first review stage it starts. The hub SHALL NOT start a Worker stage for a ticket with a count of 2 or more and no applied ruling.

#### Scenario: Orchestrator sends a third review
- **GIVEN** `t1` has two FAILs and no ruling
- **WHEN** the Orchestrator sends a role handoff to `validator` for `t1`
- **THEN** the hub returns 409 "ticket t1 has 2 review FAILs since its last complete cycle: the arbiter rules first"

### Requirement: The arbiter is a read-only stage role
The hub SHALL accept `arbiter` as a stage role and SHALL refuse it as a ticket role and as a `to_role`. An arbiter stage SHALL run on Claude with the `arbiter` pair of `role_models` (default opus, high), in a new session and a read-only detached worktree of the ticket branch or the spec commit. Its role limit SHALL be 1 for each room.

#### Scenario: Agent names the role
- **WHEN** an agent sends a handoff with `to_role: arbiter`
- **THEN** the hub returns 400

#### Scenario: Worktree
- **WHEN** an arbiter stage launches
- **THEN** its worktree is detached and not writable

### Requirement: The hub starts the arbiter
The hub SHALL create an arbiter stage when a ticket gets its second review FAIL, when a request gets its second spec FAIL, and when the room lead calls `POST /tickets/<id>/arbiter` with `question` `waiver`, `radius`, `criteria`, `criteria_edit` or `third_review` and a text. The stage SHALL hold `fail_count`. A unique index SHALL allow one arbiter stage that is not `cancelled` for each ticket or request and FAIL count.

#### Scenario: Second ticket FAIL
- **WHEN** `t1` gets its second FAIL
- **THEN** one arbiter stage for `t1` with `fail_count` 2 is `queued`
- **AND** no human Needs-you line is added

#### Scenario: Second question at the same count
- **GIVEN** an arbiter stage for `t1` with `fail_count` 0 exists
- **WHEN** the lead asks the arbiter about `t1` again
- **THEN** the hub returns 409 and creates no stage

### Requirement: The first message holds the full case
The first message of an arbiter stage SHALL hold: the ticket or the request, the criteria, the ticket notes, all findings, the FAIL history, the earlier rulings, each criteria edit of the case after the Approve with its text before and after, the question when the lead asked one, the text of `factory/orchestrator/unblocking.md`, the decision tree of `factory/validator/validator.md`, and the result schema.

#### Scenario: Case of a second FAIL
- **WHEN** the arbiter of `t1` starts
- **THEN** its first message holds the findings of both FAILs and the text of `unblocking.md`

### Requirement: The arbiter result is checked against a schema
The result SHALL hold `stage_id`, `option` (one of `rework`, `waiver`, `third_review`, `follow_up`, `cancel`, `human`), `reasons`, `rule_applied`, `implementation_detail` (boolean), `code_refs` (list of `path:line`) and `meaning_changed` (list of criteria edit event ids, may be empty). `rework` and `third_review` SHALL hold `scope`. `waiver` SHALL hold `waiver_text` and `waived_findings`. `follow_up` SHALL hold `title` and `acceptance_criteria`. A bad result SHALL be refused.

#### Scenario: Unknown option
- **WHEN** the arbiter sends `option: "merge"`
- **THEN** the hub refuses the result and the stage stays `running`

### Requirement: An implementation ruling needs a code reference
When `implementation_detail` is true, `code_refs` SHALL hold at least one `path:line`, and each SHALL name an existing file and line at the reviewed commit. Else the result SHALL be refused.

#### Scenario: Missing reference
- **WHEN** the arbiter rules on a limit value with `implementation_detail: true` and no `code_refs`
- **THEN** the hub refuses the result

### Requirement: Code applies the ruling
For a valid result the hub SHALL write a `decision` row with status `recorded`, then a ticket note "Ruling (arbiter): <option>, because <reasons>. Rule: <rule_applied>." on each ticket of the case, then apply the option, then set the decision `applied`. Each step SHALL be its own transaction. At start the hub SHALL finish each `recorded` decision.

#### Scenario: Rework
- **WHEN** the arbiter of `t1` returns `rework` with a scope
- **THEN** `t1` has the ruling note
- **AND** a system role handoff to `worker` holds the scope and the open findings
- **AND** one more review of `t1` is granted

### Requirement: Each option has one effect
The hub SHALL apply each option so. `rework`: a role handoff to `worker` (or, for a request, a line to the lead) and one granted review. `waiver` or `third_review`: one review that the hub starts, with the waiver or the scope in its first message. `follow_up`: a follow-up request (next requirement), then the effect of `waiver` for the named findings. `cancel`: the hub cancels the ticket. `human`: an open decision for the human.

#### Scenario: Third spec review
- **GIVEN** request `r-1` has two spec FAILs
- **WHEN** the arbiter returns `third_review`
- **THEN** the hub sends the spec review and the FAIL gate accepts it

### Requirement: A waived finding has a reference
A waived finding SHALL be named by `<handoff_id>#<n>`, where n is the 1-based index in the findings of a FAIL result of the case. The hub SHALL treat an unknown or duplicate reference as an invalid result. The hub SHALL NOT apply a waiver of a finding with `category: security`; it SHALL escalate it (R3).

#### Scenario: Unknown reference
- **WHEN** the result waives `h_1#9` and the FAIL result `h_1` has 3 findings
- **THEN** the result is invalid

#### Scenario: Security finding
- **WHEN** the result waives a finding with `category: security`
- **THEN** the hub does not apply the waiver and escalates it

### Requirement: A follow-up is a factory request
For `follow_up` the hub SHALL create one request for each ruling, named `<request_id>-fu-<n>` (cut to 64 characters; the hub assigns n, so two rulings cannot take the same name) with origin `factory`, the parent request and the decision as source, one `draft` ticket with the ruling's title and criteria, and a spec review sent by `system`. The Approve rule of `plan-approval` SHALL apply to it, and the ruling covers its follow-up (R2).

#### Scenario: Follow-up
- **WHEN** the arbiter of `t1` in `r-1` returns `follow_up`
- **THEN** request `r-1-fu-1` has origin `factory` and parent `r-1`, its `draft` ticket is in spec review, and a review of `t1` starts with the waived findings
- **AND** when the follow-up ticket is low radius, its spec PASS queues it without the human

### Requirement: A follow-up ticket has fixed fields
The follow-up ticket SHALL have role `worker`, the radius by the radius rule and priority `medium`. It SHALL have `blocked_by` the parent ticket when the parent is not `done`, else no `blocked_by` (R2).

#### Scenario: Parent not done
- **GIVEN** the parent ticket `t1` is `in_review`
- **WHEN** the follow-up ticket is created
- **THEN** it has `blocked_by` `t1`

#### Scenario: Parent done
- **GIVEN** the parent ticket `t1` is `done`
- **WHEN** the follow-up ticket is created
- **THEN** it has no `blocked_by`

### Requirement: A ruling that changes the scope goes to the human
The hub SHALL NOT apply a ruling, and SHALL set its decision `escalated` with an open human decision, when: it is `cancel` of an approved ticket or of a request; `meaning_changed` is not empty; or the last FAIL has a finding with `category: security` and the option is not `rework`.

#### Scenario: Cancel of an approved ticket
- **WHEN** the arbiter returns `cancel` for approved ticket `t1`
- **THEN** `t1` is not cancelled and the human gets one Needs-you line

#### Scenario: Criteria edit changes the meaning
- **WHEN** the arbiter of `t1` flags one criteria edit in `meaning_changed`
- **THEN** the ruling is not applied and the human gets one Needs-you line with the text before and after

#### Scenario: Criteria edit keeps the meaning
- **WHEN** the arbiter of `t1` returns an empty `meaning_changed`
- **THEN** the criteria edits need no human action

### Requirement: The arbiter stage has limits
An arbiter stage SHALL NOT start an arbiter about itself. An arbiter stage that ends `failed` SHALL open a human decision for its case.

#### Scenario: Arbiter fails
- **WHEN** both attempts of an arbiter stage end without a result
- **THEN** the human gets one Needs-you line for the case
