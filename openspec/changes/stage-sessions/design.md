## Context

Tickets live in `hub/kinds/ticket.ts` (a `KindModule`). Handoffs live in `hub/kinds/handoff.ts`. Room settings hold `persist_transcript` (`room_settings`). Sessions are tmux panes launched by `pty_spawn` in `src-tauri/src/pty.rs` (`Harness` enum at line 230, `claude_command` at line 692). Factory roles are staged plugins from `openspec/specs/factory-roles`, which already pass the role prompt with `--append-system-prompt-file`. The Stop hook settings file already writes an end-of-turn sentinel for the capture primitive. A room's project folder is set by "New factory room".

**Goal:** the hub runs one session per ticket stage, launches and closes it, and records the result.

**Non-goals:** spec review, the context pack, the notes field, `review.json`. See the proposal.

## Decisions

1. **`stage` is a kind.** `hub/kinds/stage.ts`, one entry in `KINDS`. Table `stage (id, ticket_id NULL, request_id NULL, review NULL, verdict NULL, role, attempt, status, session, slot_seq, created_seq, updated_seq)`. Check: `ticket_id` is set when `review IS NULL`; `request_id` is set when `review = 'spec'`. Spec-review stages (`spec-review-stage`) use this table and this lifecycle. Lifecycle:

   ```
   queued → launching → running → passed
               │           │
               └─────┬─────┘  (attempt 1 ends without a result)
                     ↓
                 retrying → launching   (relaunch, attempt 2)
   launching | running | retrying → failed   (attempt 2 ends, or no project folder: queued → failed)
   ```

   Every transition is one ledger event (`stage.queued`, `stage.launching`, `stage.running`, `stage.passed`, `stage.failed`, `stage.retrying`) and one `stage` row update, in one transaction (`applyWithSideEffect`). Schema errors in a result do not change the stage: the session stays `running`.

2. **Tickets carry `role`.** A nullable `tickets.role TEXT` column, set by `create_ticket` and `edit_ticket`. Allowed values: the six roles. Other values: 400. Who may change it follows the `request_id` rule of `ticket-grouping` (human, creator, lead; only while `draft` or `queued`).

3. **Ticket ownership on launch.** When a `launching` stage starts, the hub sets `ticket.assignee` to the session name (`<role>-<n>`) with actor `system`, in the same transaction as the `stage.launching` event. The write uses the existing `ticket.assigned` event from `ticket-grouping`. The assignment wakes no one for that session's first turn, because the initial prompt already carries the ticket. On a retry (`stage.retrying` → new `launching`), the hub reassigns the ticket to the new session name. On `passed`, the assignee stays as the last session name, as a record. Exception: the final PASS of a `validator` or `reviewer` stage moves an `in_review` ticket, with actor `system`. A `low` ticket goes to `done`. A `high` ticket is assigned to the room lead, who asks the human's Allow. The hub never writes `done` on a `high` ticket. A `system` assignment wakes no stage session, but it wakes an ordinary assignee such as the lead. Only hub-internal code writes the `system` actor. Every mutating HTTP route refuses it with 400.

   This is one of three transactions that write events of two kinds (`stage` and `ticket`). The others are the spec-review PASS and the final PASS of a ticket review. They break the one-kind-per-transaction pattern of the other kinds, so CLAUDE.md names all three. In each one, both events and both row updates commit or roll back together.

4. **Ready-stage evaluation.** One function, `evaluateStages(ticket)`, called in the same dispatch as each ticket event (`ticket.queued`, `ticket.edited`, `ticket.update`), each `handoff` to a role, and each blocker status change. A stage is created for `(ticket, role)` when all hold:
   - the ticket is not `draft`, `done` or `cancelled`,
   - no `ticket_blockers` row points to a ticket that is not `done`,
   - no stage for `(ticket, role)` is `queued`, `launching`, `running` or `retrying`,
   - and either (a) `role` equals `ticket.role` and no stage exists for `(ticket, role)`, or (b) a `to_role` handoff for that role and ticket exists, and, when a `(ticket, role)` stage already exists, the handoff was created after the last such stage's `created_seq`.

   `ticket.role` selects only the first stage. Every later stage, of the same role or another role, comes from a `to_role` handoff (human, 2026-10-23).

   Creating a stage writes `stage.queued`. The handoff keeps its own single event.

5. **Role handoffs.** `POST /handoffs` takes `to_role: "<role>"` instead of `to`. Exactly one of `to` and `to_role`. The handoff is one event. The stage evaluator in decision 4 turns it into a stage. The handoff does not name a session. Handoffs to a named agent work as before for sessions the human launched.

6. **Slots and limits.** `room_settings.role_limits` (JSON object, role → integer 0 to 10). Default `{ worker: 2, tester: 2, validator: 1, writer: 1, editor: 1, reviewer: 1 }`. A new room gets the defaults. The slot count is live sessions of the role in the room. A stage with a full role stays `queued`. The next `queued` stage of that role, by `created_seq`, starts when a slot frees (a session closes or fails). The session name is `<role>-<n>` with the lowest free `n ≥ 1` among all live sessions on the tmux socket, in every room. Names are unique across rooms because they share one socket. The limits stay per room; only the numbering is global.

7. **Launch request (high blast radius).** The hub does not start processes. It asks the Rust shell:
   - The shell opens an SSE client to `GET /launches/stream?token=<token>` at startup. The hub holds the request queue. The shell acknowledges each request with `POST /launches/<id>/ack` (`spawned` or `error`, plus the error text).
   - Request kinds: `launch` (session name, role, harness, cwd, initial prompt, env `CHATBRIDGE_AGENT`, `CHATBRIDGE_ROOM`, `CUBILOT_STAGE_ID`) and `close` (session name).
   - The shell calls `pty_spawn` for `launch` and `tmux kill-session` for `close`. It does not touch other sessions and does not kill sessions on app exit.
   - A `launch` with no ack in 15 s, or with an error ack, sets the attempt to failed (decision 10).
   - The hub creates the worktree (decision 8) before it queues the `launch`. The shell never runs git.
   - No route and no chatbridge tool queues a launch directly. One function, `enqueueLaunch`, queues launch requests. Only `evaluateStages` and the retry path of the stage kind call it. Creation eligibility (decision 4: role or handoff) applies only when a stage is created. Launch eligibility applies to every `enqueueLaunch` call, for a stage that is `queued` or a retry: the ticket is not `draft`, `done` or `cancelled`, no blocker is open, and the role has a free slot in the room (decision 6). A `queued` stage and a retry keep the authorization they were created with; they need no new handoff. No route has a launch parameter. A grep shows no other caller (task 4.1). This is enforced by code path, not by a per-role token: the bridge and the roles share one hub token (Risks).

8. **Worktrees.** The repository is the room's project folder, set by "New factory room". If the room has no project folder, the hub refuses the launch with the error `room has no project folder: set it in New factory room`, and the stage moves to `failed` without an attempt. No session starts.
   - Worker and Writer: `git -C <project> worktree add <app data>/worktrees/<room>/<ticket>/<session> ticket/<id>`. A new branch is created from the room base if the branch does not exist. A later Worker session on the same ticket reuses the existing worktree.
   - Tester, Validator, Editor, Reviewer: `git -C <project> worktree add --detach <path> <handoff commit>`. The commit is taken from the handoff context. When the handoff has none, the hub uses the head of `ticket/<id>` when that branch exists, else HEAD.
   - Validator and Reviewer: read-only. Enforced in three layers: the role's tool limits (`Edit`, `Write`, `NotebookEdit` blocked, as in `factory-roles`), `chmod -R a-w` on the work tree (not `.git`), and a check in the launch that the mode is read-only. The filesystem layer is untested until task 4.4.
   - Temporary worktrees are removed (`git worktree remove --force`, then `prune`) after the close of their session is acked. When no session runs (the stage fails for good, or an attempt ends before a retry), the hub removes the worktree at once.

9. **Prompt.** The role prompt is not part of the stage. `factory-roles` passes it with `--append-system-prompt-file`. The first message holds only the ticket part, rendered from `factory/<role>/first-message.md`, and it is passed as the initial prompt of the launch command. It is not a queued entry.
   - Fields: title, acceptance criteria, `blast_radius`, `request_id`, branch, worktree path, graph status (`fresh | stale | missing`), handoff context, earlier verdicts and findings, test report paths, and the stage id.
   - The launch command passes the prompt as one quoted argument, using the quoting that `claude_command` already uses for single quotes. The prompt is written to `<app data>/sessions/<session>/first-message.md` and the command reads it through `$(cat …)` inside the single `$SHELL -ic` argv element. Whether pi accepts a positional prompt is untested; task 4.3 checks it.
   - A retry renders the same ticket part and adds one line with the reason of the earlier stop.
   - When a `to_role` handoff started the stage, the first message also holds a section `## Handoff` with the sender, the task and the context JSON of that handoff. The hub finds it with the same lookup as the handoff commit. The section is capped at 64 KB. Over the cap, the hub cuts it and adds one line that names the handoff id. A stage that no handoff started (the first stage from `ticket.role`) gets no such section. A retry gets the same section. Before the context JSON, the section has one line that names the session's own stage id: the `stage_id` in the context is the sender's stage. The cap includes this line.
   - The briefing of an agent follows the newest stage row of its session name, in any status. It lists only the ticket of that stage while the ticket is open, else no ticket. A spec-review session gets no ticket list. An agent with no stage row keeps the usual list. Session names are used again, so an old ticket can still name the same assignee. The assignee stays as a record.

10. **Results, reminders and retries.**
   - A result is a handoff with `context.stage_id` and `context.ticket_id`. Validator and Reviewer results also need `context.verdict` (`PASS` | `FAIL`, uppercase for code and spec reviews alike) and `context.findings` (list of `{ticket_id, text}`).
   - The hub checks the schema when the handoff is created. A failing check creates no event for the stage. The hub delivers the errors to the same session as a `stage.rejected` entry (`wake` mode). The session stays open.
   - The bridge reports end of turn (`onRunEnd`, both harnesses) to `POST /stages/<CUBILOT_STAGE_ID>/turn-end`. The bridge reads the stage id from the env it was launched with (decision 7).
   - A turn end with no result: the hub sends one reminder (`stage.reminder`, `wake` mode). A second turn end with no result counts as a stop.
   - A passing result writes `stage.passed`. The hub then queues `close`. The transcript stays in the room history. The pane moves to the "finished" list. A `FAIL` verdict also passes the stage as a record; the Orchestrator receives the verdict as a handoff. No automatic relaunch.
   - A stop (a second turn end with no result, or agent gone longer than `STALE_AGENT_MS`) or a time-out (`room_settings.stage_timeout_min`, default 30) ends attempt 1 with `stage.retrying`. The hub relaunches once, with the same ticket part and a line that gives the reason. Attempt 2 ends with `stage.failed`, and the hub sends a handoff to the Orchestrator.

11. **Interrupts.** An interrupt delivered to a stage session does not change the stage or close the session.

12. **Tool limits.** Every session launched by the hub gets the `factory-roles` limits: Claude roles block `Task` and `Agent`, and `ack_permission` is blocked. The hub's launch request sets them. Chatbridge tools run as in `factory-roles`.

13. **Snapshot.** Before each schema migration, the hub copies `ledger.db` (after a WAL checkpoint) to `<app data>/snapshots/ledger-<utc>-<from>to<to>.db`, mode `0600`. The copy is written before the migration starts. A failed copy stops the migration.

## Risks and trade-offs

- **Launch stream token (accepted).** There are no per-role tokens. Any holder of `hub.token` can connect to `/launches/stream`, read launch requests, or send acks. This matches the accepted risk in CLAUDE.md (a token holder can act as any identity). Enforcement is by code path only. Revisit with per-sidecar tokens.
- The launch channel adds a second connection between the hub and the shell. If the shell is not connected, launches queue and the stages wait. The dashboard (Part 11) shows the queue.
- Read-only by `chmod` can break tools that write caches. The Validator and Reviewer may need an exception for `.git`. Measured in task 4.4.
- A long initial prompt is one argv element. Very large ticket parts can hit the argv limit. Untested; task 4.3 measures the largest ticket the hub can render.
- Time-outs count wall-clock time, so a long Worker run can hit the default of 30 minutes. The room setting is the control.
- Ownership by `system` writes a `ticket.assigned` event with no human actor. The audit trail shows the actor as `system`.

## Migration

- `ALTER TABLE tickets ADD COLUMN role TEXT`, `CREATE TABLE stage (...)` with `ticket_id`, `request_id`, `review` and `verdict` as in decision 1, `ALTER TABLE room_settings ADD COLUMN role_limits TEXT`, `ADD COLUMN stage_timeout_min INTEGER`, in `migrate()`, each guarded like `archived_at_ms`. Existing tickets get `role = NULL`. Existing rooms get the defaults. `stage` is new in this change, so no rebuild is needed later.
- A snapshot is written first (decision 13).

## Resolved questions

1. A finished stage pane stays in the "finished" list after close. It is not only in the transcript.
2. A `FAIL` verdict goes to the Orchestrator. There is no automatic Worker relaunch (Part 4, item 7).
