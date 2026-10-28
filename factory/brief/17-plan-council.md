# Part 17: Plan council

Status: needs work (human, 2026-10-28). This is a first draft. Do not plan or build it until the human has reviewed and changed it. Its place is at the end of the build order, after Part 10 (decision 2026-10-28: councils come last). It uses the council form that Part 9 builds and Part 10 reuses.

## Goal

Two agents on two different models make the plan of each request that the human asks for, independently. Code compares the two plans. The human approves one merged plan at the start (Part 6, item 11), with the differences shown. Today one agent writes a plan, and the spec review finds its faults late. On 2026-10-27 and 2026-10-28, most spec FAILs came from faults that a second, independent view finds at once: a store that does not follow the Kind contract, rulings that were not carried into a ticket, a radius that does not follow the rule.

## Members

| Seat | Harness and model | Job |
|---|---|---|
| Claude member | Claude Code, opus with effort high | Writes a plan from the request and the brief. |
| OpenAI member | Pi, provider `openai-codex`, the model of the Validator (`gpt-5.6-sol` or later; the ChatGPT subscription, Part 2, decision 2026-10-21) | Writes a plan from the same input. |

Both members are read-only for the product code. Each writes only its own plan folder. Neither sees the other's plan before the comparison (blind).

## Input (the same for both)

- The request text from the human, and the brief part when one exists.
- `CLAUDE.md`, `docs/PRIMER.md`, `factory/orchestrator/unblocking.md` (the checks before you queue, the radius rule, the Kind rule), the validator decision tree.
- The open and archived OpenSpec specs that the request touches.
- The plan check of Part 6, item 8. Each member runs it on its own plan before hand-in.

## Output of each member

An OpenSpec change in `openspec/changes/<change>-<seat>/`: `proposal.md`, `design.md`, the spec deltas and `tasks.md`, with tickets (title, radius with reason, `blocked_by` with reason, criteria with verify lines). It must pass `openspec validate --strict` with the pinned version and the plan check.

## Comparison and merge

1. **Code compares** the two plans by area: tickets, files named, radius, `blocked_by`, risks, open questions. It sorts each item:
   - **agreed:** both plans have it;
   - **single:** one plan has it. The other member checks it once (one turn) and answers "keep" or "drop" with a reason;
   - **conflict:** the plans disagree (a different radius, a different design choice, a different scope).
2. **The Claude member merges** the agreed items and the kept single items into one change `openspec/changes/<change>/`. It does not decide conflicts.
3. **Conflicts:** the arbiter decides (Part 6, item 11), unless the conflict is about scope or features. Those go to the human with the start Approve.
4. **The start Approve** shows: the merged plan, the conflicts and how they were decided, and the scope questions for the human. One Approve.
5. The merged plan then goes through the spec review (Validator) as today. The two member folders are deleted after the merge; the comparison is kept in `design.md` under "Plan council".

## When it runs

The hub calls the plan council by its rules and Jev (Part 9, "Calling a council"), not the Orchestrator. A starting rule: call it for a request with origin human that has a high-radius ticket, a new Kind, or more than a set number of tickets; skip it for a factory request with only low-radius tickets; "unsure" for the rest, which Jev decides after 50 calls. The human can always call it or ask for a single-member plan ("plan: single").

## Roles and launch

- Two stage roles: `plan-claude` and `plan-openai`. The hub launches both at the same time for one request, in separate read-only worktrees with write access only to the member's plan folder.
- The hub stage chain must know the roles (the role-chain gate refuses unknown roles today). Build the chain with the writing and design chains (Part 16), with one mechanism.
- The Orchestrator no longer writes plans for human requests. It starts the council, follows it, and sends the merged plan to the human.

## Skills

| Seat | Core |
|---|---|
| Both | `planning-and-task-breakdown` (Osmani), `spec-driven-development` (Osmani), `intent-driven-development` (ECC), `constraint-driven-development` (Osmani) |
| Claude member (merge) | `architecture-decision-records` (ECC) |

## Costs and limits

- Two plans cost about twice the tokens of one plan. The OpenAI member runs on the ChatGPT subscription, the Claude member on the Claude subscription.
- One council for each request. A new council only for a scope change that the human approves.
- Time limit for each member: the stage time-out of the room (today 60 minutes).

## Tests

1. A human request starts two plan stages at the same time, one on each harness, with the same input.
2. A member's plan that fails `openspec validate --strict` or the plan check is refused before the comparison.
3. An item in only one plan is checked by the other member and kept or dropped with a reason.
4. A radius conflict between the plans goes to the arbiter; a scope conflict goes to the human with the start Approve.
5. The start Approve shows the merged plan and the decided conflicts.
6. A factory request with only low-radius tickets gets no council.

## Open questions

1. Is a second plan worth its cost for every human request, or only for requests with a high-radius ticket? Measure with the spec FAIL count of council plans against single plans.
2. Should the OpenAI member run in the Codex CLI instead of Pi? Pi is the harness the factory already runs with `openai-codex`; the Codex CLI would be a third harness.

## Mockups (2026-10-28)

Not designed yet: the comparison of the two plans and the merged plan in the Approve. Design them with the council, after Part 9.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
