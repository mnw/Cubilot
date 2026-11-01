# Part 19: arbiter

Status: decision of the human, 2026-10-30. Moved out of Part 6, item 11. Part 6 ships without it. Build it only if the measure below says so.

## Idea

When a ticket fails review twice, an arbiter stage decides the next step instead of the human. Today the Orchestrator parks the ticket and asks the human (Part 18, rule "park, do not loop").

## Design (from Part 6, item 11)

- A stage with role `arbiter`: Claude, opus with effort high, read-only, a new session each time.
- First message: the ticket, its criteria and notes, all findings, the FAIL history, earlier rulings, `factory/orchestrator/unblocking.md` and the decision tree of `factory/validator/validator.md`.
- Result (schema-checked): one option from a fixed list (rework with a named scope, waiver with its text, third review with its scope, follow-up ticket, cancel, human), the reasons, and the rule it applied.
- Code applies the result: it writes the ruling as a ticket note, sends the rework, starts the review or makes the draft ticket.
- The human sees each ruling in the delivery report and can overrule it. Each overrule is recorded; the overrule rate is the measure of the arbiter.
- Limits: one arbiter for each ticket and FAIL count. The arbiter cannot change the scope or the features. It cannot rule on implementation details without a code reference.

The detailed spec is in `openspec/changes/human-touchpoints-checkpoint/specs/arbiter/` and tasks groups 5 to 8 of that change (FAIL count gate, arbiter stage, rulings applied, overrule). Move them to their own change `openspec/changes/arbiter/` so that the Part 6 change can be archived without them.

## Role and skills

A stage role `arbiter` with its own role file `factory/arbiter/arbiter.md` (Claude, opus, effort high, read-only). Skills, all from repos the factory already uses:
- `intent-driven-development` (Osmani, in `validator/skills/`): judge a finding against what the ticket is for.
- `agency-testing-reality-checker` (Agency, in `validator/skills/`): check claims against evidence.
- `code-review` (factory, in `validator/skills/`): the decision tree for blocking or suggestion.
- `architecture-decision-records` (ECC, in `orchestrator/skills/`): write the ruling with its reason, so that a later ruling can cite it.
- `council` (ECC, not yet copied): for a dispute that is a decision between two valid options, not a technical failure.

## Tickets

Request `r-2026-10-29-part6-arbiter` (to be renamed for this part), archived until the decision:
P6-05 third review after two FAILs (t_8575), P6-06 arbiter stage (t_bef5), P6-07 rulings applied (t_79fa), P6-08b overrule (t_ca94), follow-up ruling as a factory request (t_4ebb), ruling for the human (t_83ec).

## Decision rule

After one week of the lean flow (Part 18, "Measure"), count with the flow report (Part 6, item 9):
- tickets that reached a second review FAIL,
- of those, how many came to the human, and how long they waited for the answer.

Build the arbiter if tickets with a second FAIL wait for the human more than about 3 times a week, or the waits cost more than half a day of work. Else cancel the tickets and close this part.

## Dependencies

P6-02 (request Kind) and the flow report (item 9) must be merged. P6-05 needs the review FAIL count per ticket.
