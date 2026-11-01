## Why

Agents claim tickets before anyone checks the plan of a request. A plan can have missing work, unclear criteria or wrong dependencies, and the cost is paid in wasted sessions.

Part 4 of the factory brief adds a spec review before any ticket of a request can start. A Validator session reviews the plan. The hub moves the tickets to `queued` after a PASS, or waits for the human when the request is high blast radius.

Brief: `factory/brief/04-sessions.md`, Decision item 5 and Design item 9, tests 9 to 12.
Sources: `factory/validator/validator.md` (Spec review section), `factory/orchestrator/orchestrator.md` (step 7).
Depends on: `openspec/changes/stage-sessions` (stage kind, `to_role` handoffs, `evaluateStages`, `enqueueLaunch`, minimal result schema) and the archived `ticket-grouping` (`draft`, `request_id`, `blocked_by`).

## What Changes

- **Request-level stage:** a handoff to `validator` with `{request_id, review: "spec"}` creates one spec-review stage for the request. It is not a stage for one ticket. It reviews the draft tickets of the request, or the tickets the handoff names.
- **First message:** the request text, the scope tickets, the spec file paths, the worktree path at the handoff commit, and the findings of earlier spec reviews of the request.
- **Verdict:** the stage-sessions result schema with `review: "spec"`, `verdict` `PASS` or `FAIL`, findings with a ticket id and a severity, and `questions_for_human`.
- **PASS:** the hub moves the scope tickets from `draft` to `queued` in one transaction. A request with a `blast_radius: high` ticket keeps its tickets in `draft`, and the board shows "plan waits for your approval".
- **Human approval (high blast radius):** a human-only route queues the draft tickets of the request.
- **FAIL:** the Validator sends the verdict to the Orchestrator. There is no automatic Worker relaunch. After the second FAIL on one request, the hub tells the human in a notice and in the "Needs you" area, with the open findings.
- **Changed ticket:** a `queued` ticket whose criteria, role or `blocked_by` change returns to `draft`. Only that ticket goes to spec review. A claimed ticket that needs a change goes to the Orchestrator, which cancels it or creates a new draft.
- **Orchestrator text:** the PASS step is done by the hub. The Orchestrator no longer moves tickets to `queued` for a PASS.

## Capabilities

### New Capabilities

- `spec-review-stage`: request-level spec review, the spec result schema, the PASS and approval transitions, and the FAIL rules.

### Modified Capabilities

None in this change. One rule of `stage-sessions` is extended here by an ADDED requirement: the `system` actor also writes the PASS transition. The request-level columns of `stage` come from `stage-sessions` task 1.2.

## Not in this change

- The context pack and notes (Context pack section). Change `context-pack`.
- Review schema `review.json` for code reviews (Part 6). The spec schema here does not replace it.
- Moving claimed or in-progress tickets. The hub does not move them; the Orchestrator cancels or replaces them (`design.md`, decision 11).
- Windows, Linux and Intel support. macOS ARM64 only.

## Impact

- `hub/kinds/stage.ts`, `hub/kinds/handoff.ts`, `hub/kinds/ticket.ts`: the spec path, the PASS transition, the changed-ticket rule.
- Ledger migration: new table `stage_scope` and an index. The `stage` columns come from `stage-sessions` task 1.2.
- `ui/kinds/ticket.js` and the "Needs you" area: "plan waits for your approval", the approval button, the open findings.
- `factory/orchestrator/orchestrator.md`: step 7 (PASS by the hub).
- `docs/PROTOCOL.md`, `CLAUDE.md`: the spec result schema, the second cross-kind transaction (task 7.2).
