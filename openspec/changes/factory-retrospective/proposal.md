## Why

The factory improves today only when the human and Claude read the ledger by hand. This change makes that a weekly loop: code collects one week of evidence, a read-only `retrospective` stage judges earlier improvements and proposes at most three changes, and code turns the result into draft tickets for the human's one Approve. Source: `factory/brief/21-retrospective.md` (Part 21), decision of the human of 2026-10-30. Role and skill drafts: `factory/brief/21-retrospective/`.

Depends: Part 20 is merged. The flow report (Part 6, item 9; `hub/core/flow.ts`, `GET /rooms/<room>/flow`) and the `request` Kind exist.

## What Changes

- A weekly schedule in the hub: one retrospective stage for each active room and ISO week.
- An evidence file built by code with no model, with the sections `flow`, `stages`, `findings`, `human`, `causes`, `reports` and `improvements`. The same ledger gives the same file.
- A new read-only stage role `retrospective` (Claude, opus, effort high, new session, role limit 1). It is refused as a ticket role and as a handoff `to_role`.
- The result schema of `skills/retrospective-review/SKILL.md`, checked by the hub. The hub refuses more than 3 proposals, a proposal without evidence numbers, a proposal that removes a human gate, and a role-file proposal without the line it replaces.
- Each accepted proposal becomes a draft ticket in the request `r-<date>-retro`, with its target measure in the criteria. Each `revert` verdict becomes a draft ticket that undoes the earlier change.

## Capabilities

### New Capabilities
- `factory-retrospective`: the schedule, the evidence file, the retrospective stage role, the result check, and the draft tickets made from the result.

### Modified Capabilities
None.

## Not in this change

- The retrospective never changes files, tickets, settings or role files itself.
- ECC `continuous-learning` and `continuous-learning-v2` are not used.
- The four-week measure of the brief (approved proposals, kept proposals, human actions and tester hours per merged ticket) is read by the human from the evidence files. No report is built for it.

## Impact

- Hub: `hub/core/ledger.ts` (`STAGE_ROLES`, `DEFAULT_ROLE_LIMITS`), `hub/core/worktrees.ts` (`READ_ONLY_ROLES`), `hub/kinds/stage.ts` (review `retro`, schedule, result check), `hub/kinds/ticket.ts` and `hub/kinds/handoff.ts` (role refusals), new `hub/core/retro.ts` (evidence file, schema check, draft tickets).
- Shell: `src-tauri/src/factory.rs` (read-only role list, staging of the role folder).
- Factory: `factory/brief/21-retrospective/retrospective/` moves to `factory/retrospective/`; `factory/orchestrator/unblocking.md` step 5 puts a cause ticket in a request `r-<date>-cause-<topic>`.
- Risk: radius high for the role and the schedule (launch, read-only worktree).
