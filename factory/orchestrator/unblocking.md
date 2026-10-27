# Unblocking: what stopped the factory on 2026-10-27, and the procedure

Read this file when work stops: a plan has two FAILs, a ticket has no movement, the hub refuses a move (403), or a stage cannot start. Then do the procedure below, in order.

## What stopped the work on 2026-10-27

| # | Block | Root cause | Rule that prevents it |
|---|---|---|---|
| 1 | Context-pack spec review: 6 FAILs, no stop | The stop rule was text only. The Validator did not get the FAIL count. The hub counted, but told nobody who could act. A memory note overrode orchestrator.md. | A stop rule is enforced by code (t_65a8). A memory note never overrides the role file. |
| 2 | Each fix of a small finding needed a full review | Mechanical findings (character limit, wording) went through spec review again. | A finding that a command can check is closed by that command. No new review. |
| 3 | Human-only actions took a long time | Only the human can queue a request with a high-radius ticket, change a radius, or delete a read-only worktree. The board had no ticket search. | Each request to the human names the full ticket id, the action and a command that does it. |
| 4 | Doc tickets could never start | They had the role writer. The writing chain does not run on the hub. Nothing reported it. | Before you queue a ticket, check that its role runs on the hub. |
| 5 | Time spent on test fixes | Fixes without a proven cause (t_7fd5). A flaky timing test (TERM-wait) failed other tickets. | No fix without a reproduced cause. A flaky test gets a named waiver with an end, and one fix ticket. |
| 6 | A status report did not match the repository | Tickets were reported done, but no commit was on staging. | "Done" in a report names the commit on staging. |
| 7 | A design used "failed" for a cancel | The status had effects in other code (FAIL count, retry, diagnosis). | A new or reused status lists every place that reads it. |
| 8 | 18 queued tickets in one chain; one Worker slot idle | `blocked_by` was used for order and for caution ("after the archive", "same area"), not only for a real need. Each link added a full review cycle. | `blocked_by` only when a ticket needs the output of another, or both edit the same file. After planning, count the tickets that can start now against the free slots. |

## Procedure

### 1. Stop the loop

- At the second FAIL of a plan, or the second FAIL or CHANGES of a ticket, do not send it to review again. Escalate to the human (step 4).
- Do not resend a plan to get a PASS. Only the human can allow a third review.

### 2. Sort each open finding

For each blocking finding, write one of these:
- **Mechanical:** a command can check it (validate, grep, a test, a character count). Fix it in a ticket. The acceptance is the command and its output. The Validator checks only that output. No spec review.
- **Decision:** it needs a choice (design, scope, radius, waiver). Put it in the escalation with the options and your recommendation.
- **Not blocking:** use the decision tree in `factory/validator/validator.md`. A finding outside the ticket is a suggestion.

### 3. Check facts against the repository

- A ticket is done only if its commit is on staging. Name the hash.
- An OpenSpec change is archived only if it is in `openspec/changes/archive/`.
- A cause is proven only if a test or a trace reproduces it.

### 4. Escalate in one message

The message to the human has these parts:
1. **Block:** one sentence. What stops, since when.
2. **Facts:** numbered, each one checked (step 3).
3. **Options:** A, B (and C), each with its effect. Mark your recommendation.
4. **Human actions:** each with the full ticket id and the exact action. If the board cannot do it fast, add the hub command (see "Commands for the human").
5. **What you do next** after the answer.

### 5. Remove the cause

When the work moves again, ask: will this block come back? If yes, open one draft ticket that removes the cause in code or in a role file. Name the block number from the table above, or add a new row to the table.

## Checks before you queue

- The role of each ticket runs on the hub.
- Each `blocked_by` names an open ticket or a ticket that is done.
- Each `blocked_by` has a reason: the ticket needs the other ticket's output (code, table, file), or both edit the same file. Name the file. Order, caution or "same area" is not a reason.
- A shared record file (`tasks.md` ticks, a status table) is not a reason for a chain. Move the record edits into one closing ticket (for example the archive ticket), so the work tickets edit only their own files.
- After you plan a request, count the tickets that can start now. If that number is lower than the free Worker slots, check each chain link again. A chain longer than 5 links needs a reason in the request.
- The request needs the human to queue it if it has a high-radius ticket. Ask once, for the whole request, with all ticket ids.
- A doc ticket says which roles do the work while the writing chain is not on the hub (Worker, then Validator).

## Commands for the human

The hub accepts these moves from the human. Give the command when the board is slow to use. The human runs it in Terminal on the Mac.

```bash
D="$HOME/Library/Application Support/Cubilot"
N=$(awk -F': *' '/^human_name:/{gsub(/["'\'']/,"",$2);print $2}' "$D/config.yml"); N=${N:-human}
U=$(cat "$D/hub.url"); T=$(cat "$D/hub.token")
# Queue one ticket:
curl -sS -X POST "$U/tickets/<ticket id>/transition" -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"by\":\"$N\",\"to\":\"queued\"}"
# Change the blast radius:
curl -sS -X POST "$U/tickets/<ticket id>/edit" -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d "{\"by\":\"$N\",\"blast_radius\":\"high\"}"
```

A read-only Validator or Reviewer worktree: `chmod -R u+w <folder>`, then `git worktree remove --force <folder>`.
