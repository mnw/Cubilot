## Why

Gap G10: ticket `t_0c022e8d36b6de90` moved from `queued` to `draft` by a criteria edit, but its stage `s_48b9069055438036` stayed `queued`. Done ticket `t_5edd115a54e632b5` keeps queued stage `s_84a4d9b11fc01297`. A queued stage of a ticket that is draft or done must not wait for a slot.

## What Changes

- **Ticket moves to draft or done:** after the commit, each `queued` stage of the ticket moves to `cancelled` with the reason `ticket moved to draft` or `ticket moved to done`, actor `system`. Each stage moves in its own transaction through the stage API, as for a ticket cancel (G4). Routes: the criteria, role or blocker edit that sends a queued ticket back to draft, a transition to draft or done, and the final Validator or Reviewer PASS that closes the ticket. Launching, running and retrying stages do not change (G5).
- **Hub start:** each `queued` stage of a draft or done ticket moves to `cancelled` with the same reason, next to the G4 start step and before the `launching` sweep.
- **Pickup guard:** the launch check refuses a stage whose ticket is draft, done or cancelled. A refusal returns before any write, so the stage row does not change.
- **Role start:** a `cancelled` stage does not count for "the ticket role starts only the first stage", whatever its reason. A draft ticket that is queued again gets one new stage of its role.

## Capabilities

### Modified Capabilities

- `stage-sessions`: the draft/done cancel rule, the start rule, the pickup guard, and the role-start rule.

## Impact

- Risk: launch path, high radius. Items 2 and 3 guard a route that is missed.
- Security: none. Migration: none.
- Performance: per move to draft or done, and once at start, one selection query and one stage transaction per matched stage. The guard adds no query.
- Accessibility: no new UI. The Finished list shows `cancelled` and the reason as text.
- Compatibility: the status and the reason field exist since G4. The two new reasons are plain text.
- No fourth cross-kind transaction: the cancel runs after the ticket commit (for the final PASS, after the `stage.passed` transaction).
