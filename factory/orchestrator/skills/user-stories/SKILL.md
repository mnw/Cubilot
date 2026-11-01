---
name: user-stories
description: Writes factory tickets as user stories. Use when you split a request into tickets, rewrite a ticket, or answer a spec-review finding with a changed ticket.
---

> Factory skill (Cubilot, 2026-10-30). The rule is in `factory/orchestrator/orchestrator.md` step 2 and `factory/brief/18-lean-flow.md`; this skill is the how.

# User stories for factory tickets

## Shape

```
[code] <Title: the outcome in a few words>
As <the human | the Orchestrator | a Worker | a Validator | a Tester>, I want <capability>, so that <benefit>.
Acceptance criteria:
  - Given <situation>, when <action>, then <result the actor sees>.   (1 to 5 lines)
Verify:
  - Worker: <test file>, test "<name>"            (one line per scenario)
  - Tester: ./scripts/test.sh
Out of scope:
  - <what this ticket does not change>
Links: <request id>; <parent ticket id>; <review id>   (ids only)
```

Everything a new agent session needs to do the work goes in the `planning_note`, headed "For the agents": files and lines, the approach, test cases and edge cases, formats, limits, the base commit, rebase hints. The definition of done (branch, signed commit, test.sh, tsc, sidecars) is in the role files: never repeat it in a ticket.

## Checks before you send the plan (INVEST)

| Check | Question | If no |
|---|---|---|
| Independent | Can it run beside the other tickets? A blocker only when it needs another ticket's code | Remove the blocker, or make a small contract ticket first |
| Negotiable | Does it say what, not how? | Move the how to the agent notes |
| Valuable | Does the actor in the story see a result on its own? | Merge it with the ticket that gives the value |
| Estimable | Can one session finish it? | Split it |
| Small | One behaviour, about 400 changed lines at most | Split it |
| Testable | Does each criterion map to a named test? | Rewrite the criterion as Given/When/Then |

The human must be able to read and judge the criteria in one minute.

## Examples

Good:

```
[code] A decision answer survives a failed send
As the human, I want my answer to reach the Orchestrator even when the send fails once, so that no decision is lost.
Acceptance criteria:
  - Given the send to the lead stream fails, when I answer, then the answer stays undelivered.
  - Given an undelivered answer, when the next lead session connects, then it receives the answer once.
```

Not good (implementation, history and process in the criteria):

```
Mark delivered only after the SSE enqueue in decision.ts:387 (rework 4, msg 813). Commit signed with PATH=/opt/homebrew/bin; waiver: memory-limit test.
```

## Common mistakes

- History in the ticket ("rework 3", "msg 813", "the human said"): put ids in Links only.
- A test matrix in the criteria: it goes in the agent notes.
- Words that trip the radius rule ("launch", "token", "permissions") in a ticket that has no such risk: say what the ticket does in plain words; if the rule still raises it, tell the human.
- One ticket with several stories: split it; each story is one ticket.
