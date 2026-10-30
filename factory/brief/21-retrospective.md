# Part 21: weekly retrospective (self-improvement loop)

Status: decision of the human, 2026-10-30. Build it after Part 20. It needs the flow report (Part 6, item 9).

## Why

The factory improves today only when the human and Claude look at the ledger by hand (2026-10-29: the analysis that led to Part 18). The pieces of a loop exist but nothing runs them: Part 6 idea 12 (learn from the human's corrections), the stage-diagnosis pattern run (Part 4), the one-week measures of Parts 18 to 20, and the "remove the cause" step of `unblocking.md`. Warp's factory team logs each human intervention and has agents review the factory's work to reduce them. This part makes that a weekly loop.

## The loop

1. **Collect (code, no model).** Once a week, on a schedule, the hub builds one evidence file for the room from the last 7 days:
   - the flow report: slot use per role, ready tickets, wait reasons, FAIL rates (Part 6, item 9);
   - stage metrics: duration, turns, tokens, retries, stages with no result;
   - review findings by kind, and tickets with a second FAIL;
   - each human action (Approve, Allow, decision answers, overrules, edits by the human, radius changes) with its reason when one exists;
   - the "remove the cause" tickets of the week, and the Orchestrator's reports;
   - the open improvement tickets of earlier retrospectives with their target measure.
2. **Review (one stage).** A `retrospective` stage (Claude, opus, effort high, read-only, new session) reads the evidence file and returns, schema-checked:
   - for each improvement merged in an earlier week: its measure before and after, and **keep** or **revert**;
   - at most **3 proposals**. Each one names the problem with numbers from the evidence, the change, the measure it must move and by how much, and the kind of change. A check in code is preferred; a role-file change must replace a line (rule budget, Part 18).
3. **Tickets (code).** Each proposal becomes a draft ticket in the request `r-<date>-retro`, as a user story, with the target measure in its criteria. A **revert** becomes a draft ticket that undoes the earlier change.
4. **Human.** The request goes to the normal spec review and the human's one Approve. The human can drop any proposal.
5. **Effect.** The next week's retrospective checks the target measure first.

## Who does what

- **The hub (code)** does the schedule, the evidence file, the schema check, the draft tickets and the request. No model.
- **A dedicated role, `retrospective`,** does the review. It is not the Orchestrator: he plans and runs the work, so he would grade himself. It is a stage role like the others: `factory/retrospective/retrospective.md` (the job, the limits, the result format), `first-message.md` (the evidence file and last week's proposals), its own skills, read-only worktree, a new session each week. Model: Claude opus, effort high, set in `role_models`. It reads the code and the role files only to back a proposal with a file and line.
- Skills and drafts: see `21-retrospective/README.md`. The role file and the `retrospective-review` skill are drafted in `21-retrospective/retrospective/`. Skills from ECC (loop-design-check, agent-architecture-audit, agent-introspection-debugging, growth-log), Agency (workflow-optimizer, test-results-analyzer) and Osmani (context-engineering). ECC continuous-learning is not used: it writes skills by itself.
- The hub needs `retrospective` in `STAGE_ROLES` and `DEFAULT_ROLE_LIMITS` (1), refused as a ticket role and as a handoff `to_role`, and in the read-only role list of `factory.rs`.

## Limits

- The retrospective never changes files, role files or settings itself. It only proposes.
- At most 3 proposals a week, so the factory does not spend its slots on itself.
- It never proposes to remove a human gate (start, delivery, main, security, actions that cannot be undone). Those are the human's decision.
- A proposal without numbers from the evidence is refused by the schema check.

## Fold-ins

- Part 6, idea 12 (learning from the human's corrections) becomes the "human actions" input of step 1.
- The stage-diagnosis pattern run (Part 4) stays for single failures; this part looks at the week.
- The one-week measures of Parts 18, 19 and 20 are the first retrospective's questions.

## Tests

1. A week of ledger data gives one evidence file with each input of step 1; the same ledger gives the same file.
2. A result with 4 proposals, or a proposal with no evidence numbers, is refused.
3. Each accepted proposal becomes one draft ticket in `r-<date>-retro` with its target measure in the criteria.
4. A proposal that removes a human gate is refused.
5. In week 2, the evidence file lists the week 1 improvements with their measures, and the result has keep or revert for each.

## Measure

After four weeks: how many proposals the human approved, how many were kept, and the change in human actions per merged ticket and in tester hours per merged ticket.
