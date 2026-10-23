## Why

Today one agent session does many ticket stages. Its context grows, it drifts, and a failed stage cannot run again from a clean state. The human cannot tell which role did which work.

Part 4 of the factory brief fixes this: one new session for each ticket stage, launched by the hub, closed when the stage ends. This change adds the stage model, role handoffs, launch requests, worktrees, limits and the retry rule.

Brief: `factory/brief/04-sessions.md`, Decision items 1 to 4, Design items 1 to 8 and 10.
Depends on: `openspec/changes/ticket-grouping` (not yet archived). It supplies `draft` status and `blocked_by`. Reuses the role launch from `openspec/specs/factory-roles`.

## What Changes

- **Ticket role:** a ticket carries an optional role: `worker`, `tester`, `validator`, `writer`, `editor` or `reviewer`.
- **Stage:** a new state-machine kind, `stage`. One stage is one role's work on one ticket. The hub creates a stage when the stage is ready.
- **Ready stage:** the ticket has a role, no `blocked_by` ticket is open, the ticket is not `draft`, and the role has no session for the ticket or a new handoff to that role arrived.
- **Role handoffs:** a handoff can name a role. The hub picks a free slot for that role. Handoffs that name an agent keep working.
- **Launch request:** the hub asks the Rust shell to start a session named `<role>-<n>`, and to close it later. The Orchestrator and the chatbridge tools cannot start a session.
- **Worktrees:** Worker and Writer use the branch `ticket/<id>`. Tester, Validator, Editor and Reviewer use a temporary worktree at the handoff commit. Validator and Reviewer get it read-only.
- **Ticket ownership:** a launch assigns the ticket to the session (actor `system`). A retry reassigns it.
- **First message:** the hub renders the ticket part from `factory/<role>/first-message.md` and passes it as the launch command's initial prompt. The role prompt stays with `factory-roles`.
- **Missing project folder:** a room with no project folder refuses the launch with a clear error.
- **Limits:** the room settings hold the maximum number of sessions for each role. A full role queues the stage.
- **End of stage:** the result is checked against a minimal schema. A failed check sends the errors to the same session. A passed check records the result, closes the session at the end of its turn, and moves its pane to a "finished" list.
- **Retry:** one reminder at the first end of turn without a result. A second end of turn without a result, or a time-out, counts as a stop and runs the stage once more. A second failure sends a message to the Orchestrator.
- **Snapshot:** the ledger is copied to `<app data>/snapshots/` before each schema migration.

## Capabilities

### New Capabilities

- `stage-sessions`: stages, role handoffs, launch requests, worktrees, first messages, limits, results and retries.

### Modified Capabilities

None. The delta for `agent-handoffs` is in `stage-sessions` (the role target) so the change stays in one spec.

## Not in this change

- Spec review before work (Decision item 5, Design item 9). Change `spec-review-stage`.
- The context pack and the notes of earlier stages (Context pack section). Change `context-pack`.
- Review schema `review.json` (Part 6). This change uses a minimal verdict schema that Part 6 replaces.
- Windows, Linux and Intel support. macOS ARM64 only.

## Impact

- `hub/kinds/stage.ts` (new), `hub/kinds/ticket.ts`, `hub/kinds/handoff.ts`, `hub/hub.ts` (`KINDS`).
- `hub/` launch-request channel to the Rust shell (new, high blast radius).
- `src-tauri/src/pty.rs`: launch and close from a hub request, and a finished list.
- `factory/<role>/first-message.md` (new, one per role).
- Room settings: role limits and the stage time-out.
- Ledger migration (adds `tickets.role`, `stage` table, `room_settings` columns). Snapshot first.
