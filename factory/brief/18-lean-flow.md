# Part 18: lean flow

Status: decision of the human, 2026-10-29. Build it first. It replaces the spec review against the code and the human gates between the Approve and the delivery. Where an older part disagrees, this part wins.

## Why: what the ledger shows

Measured from the ledger, 2026-10-28 06:00 to 2026-10-29 06:50 UTC (25 hours, 9 slots: worker 4, tester 2, validator 3):

| Measure | Value |
|---|---|
| Stage run time, all roles | about 14 h of 225 slot-hours (6 %) |
| Worker run time | 3.3 h |
| Wait from stage queued to launch | median 0 min, max 15 min |
| Ticket-hours in `draft` | 202 h |
| Ticket-hours `queued` but blocked by an open ticket | 259 h |
| Spec reviews | 27: 3 PASS, 23 FAIL (85 % FAIL) |
| Code reviews | 49: 23 PASS, 24 FAIL |
| Ticket edits by the Orchestrator | 96 |
| Tickets queued by the human by hand | 34 |
| Part 6 after 19 h | 22 tickets (12 high): 7 done, 6 queued and blocked, 9 draft |

The slots were never the limit. There was almost never a ticket that could run.

## Cause

1. **Plan before code, judged against the code.** No ticket starts before a spec review PASS. The Validator checks the plan against the code (validator.md, spec review step 5) and against a growing rule set. It fails plans for missing implementation detail. To pass, the Orchestrator writes the implementation into the tickets. That is why tickets read like messages between agents.
2. **Each FAIL makes edits, and each edit restarts the gate.** An edit sends a queued ticket back to `draft`. In a request with one high ticket, only the human can queue it again. Only one spec review runs per request, and the FAIL stop counts per request.
3. **What passes is made serial.** A blocker clears only on `done`. `done` of a high ticket needs the human's Allow. The rules require a blocker when two tickets edit the same file.
4. **Each incident adds a rule.** Each rule gives the reviewer one more reason to FAIL. unblocking.md already records the same chain on 2026-10-27 (row 8).

## The flow

```
Human: request  ->  Orchestrator: tickets (short, ticket format)  ->  Validator: tickets against the spec (once per request)  ->  Human: one Approve
  -> per ticket, in parallel:  Worker -> Tester -> Validator (high: two Validators): PASS to the Orchestrator
  -> Orchestrator: checks the PASS, merges into staging, runs the staging suite, moves the ticket to done
  -> Human: delivery test, merge staging into main
```

1. **One spec review per request, against the spec (four eyes).** Before the Approve, a Validator challenges the Orchestrator's plan: it finds what the plan missed and proposes the fix (the ticket to add or the change). The Orchestrator reviews each proposal and answers: accepted, changed differently (with why), or rejected (with the spec section). Neither side's view wins by default: the goal is a correct plan. An open disagreement goes to the human; the tickets it does not touch go on. The Validator checks that the tickets match the spec: each requirement has a ticket, each ticket traces to a requirement, no ticket contradicts the spec or another ticket. It does not check the tickets against the code. It fails only for those three faults; all else is a suggestion. One re-check of only the earlier findings; after a second FAIL the open findings go to the human with the Approve list (decision of the human, 2026-10-29).
2. **The code is the place of judgement.** The Tester runs the tests. The Validator reviews the diff against the ticket criteria, the tests and security (validator.md decision tree). A finding outside the criteria is a suggestion or a follow-up ticket.
3. **Tickets are user stories** (decision of the human, 2026-10-29): the request is the epic, each ticket is a story ("As <actor>, I want <capability>, so that <benefit>"), with 1 to 5 Given/When/Then criteria the human can judge in one minute, and the INVEST checks (independent, negotiable, valuable, estimable, small, testable). Test cases, formats and limits are the story's tasks, in the agent notes. The definition of done is in the role files.
4. **A blocker only for code.** Ticket B waits for A only when B cannot build or test without A's code. A shared file is not a blocker: the second ticket rebases before its review. A blocker clears when A is merged into staging.
5. **High radius means more checks, not a human gate.** The full suite, and two Validator PASSes from different sessions on the same commit. Then merge into staging. The human's gate is the merge of staging into main.
6. **Edits do not reset a ticket.** A criteria edit keeps the status. The next stage works against the new criteria. The edit is an event in the ledger and appears in the delivery report.
7. **The human is asked only for:** the Approve of a request, a scope change, an action that cannot be undone, a security finding with no fix in scope, and the delivery.
8. **A rule budget.** A new rule is a check in code, or it replaces an existing line in a role file. Role files stay under their current size.

## Hub changes

One request, four independent tickets, no blockers between them (they share `hub/kinds/ticket.ts` and `hub/kinds/stage.ts`: rebase, do not block).

| Ticket | Change | Code today |
|---|---|---|
| L1, high | After the human approves a request, the lead may queue and re-queue any ticket of that request. The approval is stored for the request. A new ticket added later needs no new Approve unless the human asks for it. | `hub/kinds/ticket.ts`, "The lead may not queue a request that holds a high blast_radius ticket" |
| L2, high | A criteria, role or blocker edit keeps the ticket status. The `ticket.edited` event keeps the old and new text. | `hub/kinds/ticket.ts`, `backToDraft` |
| L3, high | A blocker counts as cleared when it is `done`, or when the commit of its last tester PASS is an ancestor of staging. If the check fails, the blocker stays (fail closed). The hub checks again when staging moves. | `hub/kinds/stage.ts`, `enqueueLaunch`, "blocked by" query |
| L4, high | A Validator PASS no longer closes the ticket: it stays `in_review` and the PASS goes to the Orchestrator. A high ticket gets a second Validator stage after the first PASS, in a new session, on the same commit. The lead may move `in_review` to `done` only when the ticket has its PASSes (one, or two for high) on the commit that is merged into staging; else 409 with the missing item. This replaces the human Allow for `done`. | `hub/kinds/stage.ts`, "A final PASS of a validator or reviewer closes its ticket"; `hub/kinds/ticket.ts`, `APPROVAL_BLOCK_MESSAGE` |

Later, low: a flow measure route (`GET /rooms/<room>/flow`): slot use per role, tickets ready now, ticket-hours by wait reason, FAIL rate per role. It is the data of the table above, for the dashboard (Part 11).

The spec review code (one live spec stage per request, the FAIL stop) stays in the hub, unused. Remove it in a later cleanup when the lean flow has run for a week.

### Tests

1. A request with a high ticket, approved by the human: the lead queues each ticket (200). Before the Approve: 403.
2. A queued ticket with a criteria edit stays `queued`. The event has the old and new criteria.
3. Ticket B blocked by A: A is merged into staging but not `done`; B's stage launches. If git cannot answer, B stays blocked.
4. A low ticket: a Validator PASS leaves it `in_review`; the lead's move to `done` succeeds after the merge, and fails (409) before it. A high ticket: the first PASS starts a second Validator stage in a new session; the lead's move to `done` fails with one PASS and succeeds with two on the merged commit, with no human Allow. A FAIL in either goes back to the Worker.

## Until L1 to L4 are merged

- The Orchestrator creates the tickets of a request as `draft` and asks the human for one Approve (`POST /requests/<room>/<id>/approve`). That route queues all drafts of the request without a spec review.
- A request without high tickets: the Orchestrator queues the tickets itself.
- `done` of a high ticket still needs the Allow. The Orchestrator collects the Allows in one message per day. A merged ticket clears its blockers only after `done` until L3.

## Superseded

- Part 6, item 8 (plan check): only the checks that code can run stay. A plan check never blocks.
- Part 6, item 11: the arbiter is not needed for spec reviews. Keep it for code-review disputes only, if they still happen.
- Part 6, item 15: replaced by L3 and the flow measure. P6-15b (spec FAIL count) is not needed.
- Part 6, item 16: the ticket format and rule 1 (blocker only for code) stay. The other rules are this part.

## Measure

After one week of the lean flow, compare with the table above: slot use, worker hours, ticket-hours waiting, FAIL rates, human actions, and the defects that the human finds at delivery. The factory must beat one agent on speed and on defects. If not, this part is wrong too, and the numbers show where.
