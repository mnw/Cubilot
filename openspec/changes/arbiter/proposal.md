## Why

When a ticket fails review twice, the Orchestrator parks it and asks the human (Part 18, rule "park, do not loop"). An arbiter stage can decide the next step instead. Part 6 ships without it. Build it only if the measure of Part 19 says so. Source: `factory/brief/19-arbiter.md`, decision of the human of 2026-10-30.

Depends: the `request` Kind (P6-02) and the flow report (Part 6, item 9) are merged. The ticket FAIL count (task 5.1) comes first. Design decisions 5 to 9, 11 and 15 stay in `openspec/changes/human-touchpoints-checkpoint/design.md` (after its archive: `openspec/changes/archive/`).

## What Changes

- A ticket FAIL count and a gate: a third review after two FAILs needs a ruling or the human.
- A new read-only stage role `arbiter` (Claude, opus × high, new session each time). It starts at the second FAIL of a ticket or a plan, or when the Orchestrator asks it. One arbiter for each ticket and FAIL count.
- The result is schema-checked: one option (rework, waiver, third review, follow-up ticket, cancel, human), the reasons and the rule applied. Code applies it and writes the ruling as a ticket note.
- The arbiter cannot change the scope or the features. It cannot rule on an implementation detail without a code reference.
- The human can overrule a ruling. Each overrule is recorded. The overrule rate measures the arbiter.

## Capabilities

### New Capabilities
- `arbiter`: the arbiter stage, its first message, its result, the ticket FAIL count and gate, and how code applies a ruling.

### Modified Capabilities
- `delivery-report`: the human can overrule a ruling, and the room has arbiter stats.

## Not in this change

- Any change to the other Part 6 specs. Arbiter text there stays until the Part 6 change is archived.

## Impact

- Hub: `hub/kinds/stage.ts`, `handoff.ts`, `decision.ts`; the ticket arbiter route; `GET /rooms/<room>/arbiter-stats`.
- Shell: `src-tauri/src/factory.rs` (arbiter role, read-only list).
- Factory: new `factory/arbiter/`.
- Risk: build it only after the measure of Part 19 (second-FAIL waits for the human).
