## Purpose

Holds the decisions of the factory between start and delivery, and asks the human only in three cases, with one Needs-you line in the escalation format of `factory/orchestrator/unblocking.md`.

## ADDED Requirements

### Requirement: A decision is a Kind
The hub SHALL keep a `decision` Kind with id, room, `ticket_id` or `request_id`, `decider` (`arbiter` or `human`), `fail_count`, option, text and status. Statuses: `recorded`, `applied`, `escalated`, `open`, `answered`, `overruled`. Each change SHALL write one event and one row update in one transaction.

#### Scenario: One event per change
- **WHEN** a decision moves from `open` to `answered`
- **THEN** exactly one `decision.answered` event exists for it

### Requirement: A decision moves by a fixed list
A decision SHALL start `recorded` (arbiter ruling) or `open` (escalation). The legal moves are: `recorded` to `applied`, `recorded` to `escalated`, `escalated` to `answered` (the human answers an escalated ruling), `open` to `answered`, `applied` to `overruled`. `answered` is final: there is no move from `answered` to `overruled`. The hub SHALL refuse any other move with 409 (R5).

#### Scenario: Answered is final
- **WHEN** the human overrules a decision with status `answered`
- **THEN** the hub returns 409

### Requirement: The human is asked only in three cases
The hub SHALL open a human decision only when: a decision changes a feature or the approved scope; an action cannot be undone (data loss, a delete outside the factory, an external effect, secrets); a security finding has no fix in scope. No other hub path SHALL add a Needs-you line for a FAIL.

#### Scenario: Feature change
- **WHEN** a decision changes a feature of the request
- **THEN** the hub opens a human decision

### Requirement: An open decision uses the escalation format
An open human decision SHALL hold: `block` (one sentence), `facts` (a numbered list, each with a commit hash or a hub record), `options` (2 or 3, each with its effect, one marked as the recommendation), `human_actions` (each with the full ticket id and the exact action), and `next`. The hub SHALL refuse a decision without these parts with 400.

#### Scenario: Missing option
- **WHEN** the room lead opens a decision with one option
- **THEN** the hub returns 400

### Requirement: The room lead opens a decision for an action that cannot be undone
The `escalate` tool and `POST /decisions` SHALL let the room lead open a human decision with `reason` `scope`, `feature`, `irreversible` or `security`. Another agent SHALL get 403.

#### Scenario: Install question
- **WHEN** the Orchestrator escalates a delete outside the factory with reason `irreversible`
- **THEN** the human sees one Needs-you line

### Requirement: Each open decision is one Needs-you line
The Needs-you area SHALL show one line for each `open` or `escalated` decision of the room, with the block sentence and the ticket ids. The line SHALL open the full decision. Its answer buttons SHALL be the options.

#### Scenario: One open decision
- **WHEN** the room lead opens one decision for `t1`
- **THEN** the Needs-you area has exactly one line for `t1`

### Requirement: Only the human answers
`POST /decisions/<id>/answer` with an option SHALL move an `open` or `escalated` decision to `answered`. Only the human SHALL call it; another caller SHALL get 403. The hub SHALL send the answer to the room lead as one entry and write it as a ticket note. A request-only decision SHALL write no ticket note; its row, its events and the one lead entry are the audit trail (R5).

#### Scenario: Human answers
- **WHEN** the human answers option B
- **THEN** the decision is `answered` and the lead receives the answer once
