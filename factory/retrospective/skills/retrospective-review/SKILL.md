---
name: retrospective-review
description: Weekly review of the factory from one evidence file. Use when the hub starts a retrospective stage. Judges last week's improvements (keep or revert) and writes at most three proposals with numbers and a target measure.
---
# Retrospective review

## Input: the evidence file (one week, one room)

| Section | Content |
|---|---|
| `flow` | Slot hours per role (busy, idle with ready tickets, idle with nothing ready), ready tickets over time, wait reasons, FAIL rate per role |
| `stages` | Per stage: role, duration, turns, tokens, retries, result or "no result" |
| `findings` | Review findings by kind; tickets with a second FAIL; follow-up tickets made from findings |
| `human` | Each human action: kind (Approve, Allow, answer, overrule, edit, radius change, manual move), ticket, wait time before the action, reason if given |
| `causes` | The "remove the cause" tickets of the week (unblocking.md step 5) |
| `reports` | The Orchestrator's reports of the week |
| `improvements` | Earlier proposals that were merged: change, target measure, value before |

## Procedure

1. **Earlier improvements first.** For each item in `improvements`: compute the target measure for this week from the same sections. Compare with the value before.
   - Moved as planned: **keep**.
   - Did not move, or moved the wrong way, and the week is normal: **revert**.
   - Too few cases this week: **keep**, note "too early".
2. **Cost of this week's problems.** Make a short table of the top problems with a cost in one unit each:
   - slot hours lost (`flow`: idle with ready tickets; `stages`: no-result sessions);
   - human actions and their wait time (`human`);
   - defects found late (staging failures, reverts, findings after a PASS).
3. **Find the cause, not the symptom.** For each top problem, check the loop with `loop-design-check` (does it spin or game its check?), the failure pattern with `agent-introspection-debugging`, and the agent stack with `agent-architecture-audit` when the cause is in a role file, a hook or the hub. Name file and line.
4. **Choose at most three proposals,** the ones with the largest cost they remove. A check in code or a script beats a role-file rule. A role-file change replaces a line.
5. **Write each lesson as a pattern** (`growth-log`): "When X, the factory does Y, because Z" — not a diary of the week.

## Result (send as the stage result)

```json
{
  "verdicts": [
    {"improvement": "<ticket id>", "measure": "<name>", "before": 0, "after": 0, "verdict": "keep|revert", "note": "<one line>"}
  ],
  "proposals": [
    {
      "title": "<outcome in a few words>",
      "problem": "<one sentence with numbers from the evidence>",
      "evidence": ["<section>: <numbers>"],
      "change": "<what changes>",
      "kind": "code-check|script|role-file|setting",
      "files": ["<path>:<line>"],
      "replaces": "<role-file only: the current text of the line in files, trimmed>",
      "measure": {"name": "<measure>", "now": 0, "target": 0},
      "risk": "<one sentence>"
    }
  ],
  "lessons": ["When <situation>, <what happens>, because <cause>."],
  "notes": "<what you checked, what you found, what is open; 300 to 400 words>"
}
```

The hub refuses: more than three proposals, a proposal without `evidence` numbers, a proposal that removes a human gate, a role-file proposal whose `replaces` differs from the line in `files` at the worktree commit. `replaces` is only for `kind: role-file`.

## Do not

- Do not change files, tickets or settings.
- Do not propose more work for the human (a new gate, a new approval) unless the evidence shows a defect that reached main.
- Do not judge single agents. Judge the process: rules, checks, the order of stages, limits.
