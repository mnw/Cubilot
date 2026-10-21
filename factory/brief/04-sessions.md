# Part 4: visible sessions, one session for each ticket stage

Status: decision 2026-10-18. Build it with Part 2.

## Decision

1. **No sub-agents.** A sub-agent runs inside another agent's session. The human cannot see what it reads, writes or runs. The factory does not use them. Every agent runs in its own pane, where the human can watch it and interrupt it.
2. **The Orchestrator decides. The app launches the agents.** The Orchestrator creates the tickets, gives each ticket a role, and sets `blocked_by`. The hub and the Rust shell launch and close the sessions. The Orchestrator cannot launch a session.
3. **One new session for each ticket stage.** A stage is one role's work on one ticket: Worker, Tester, Validator, Writer, Editor or Reviewer. When the stage ends, the app closes the session. The next stage gets a new session.
4. **Only the Orchestrator stays open** for the whole room.
5. **Spec review before work (decision 2026-10-18).** The Validator reviews the plan of each request before an agent can claim any ticket. The plan is the tickets, their criteria and dependencies, and the spec when there is one.
## Why

These points come from the comparison with the Warp cloud factory (Part 6):
- A new session has no old context. It cannot drift, and it does not need compaction (Part 3).
- A failed stage can run again from the ticket and the branch. Nothing must be fixed first.
- Code launches the processes, not a model. Code does not forget a step, and it applies the limits that the human sets.
- Only the app can launch the Pi roles (Validator and Reviewer). A Claude agent cannot launch them.

## Design

1. **Ready stage.** A stage is ready when three conditions are true. The ticket has a role. No ticket in `blocked_by` is open. The role has no session for the ticket yet, or a new handoff for that role arrived.
2. **Handoffs go to a role.** A handoff names a role (`tester`, `validator`), not a session name. The hub picks a free slot for that role. Today handoffs name an agent. Keep agent names for sessions that the human launches by hand.
3. **Launch.** The hub asks the Rust shell to launch the role (Part 2, step 2) with the session name `<role>-<n>`.
   - Worker and Writer: a worktree for the ticket branch (`ticket/<ticket_id>`). A later Worker session on the same ticket uses the same worktree.
   - Tester, Validator, Editor, Reviewer: a temporary worktree at the commit of the handoff. The Validator and the Reviewer get it read-only (Part 2, finding 6, item 3).
   - Today the Rust shell launches the PTYs and the hub cannot ask for a launch. Add a hub-to-shell launch request. Part 12 moves this into the hub.
4. **First message.** The hub writes the first message from the ticket. It contains the title, the acceptance criteria and the blast radius. It also contains the branch, the worktree, the graph status, the handoff context, earlier verdicts and findings, and the paths of the test reports. Use one template for each role, in `factory/<role>/first-message.md`. The agent reads files again from the worktree. The first message gives only the facts and the paths.
5. **Limits.** The human sets the maximum number of sessions for each role in the room settings, for example 3 Workers and 2 Testers. When all slots are full, the stage waits in a queue. The dashboard (Part 11) shows the queue.
6. **End.** The agent posts its result as a handoff or a verdict. The hub checks the content against a schema: the handoff context fields, and `review.json` for verdicts (Part 6). When the check fails, the hub sends the errors to the same session. When the check passes, the hub records the result and closes the session at the end of its turn. The transcript stays in the room history, and the pane moves to a "finished" list.
7. **Retry.** When a session stops without a result, or reaches the time limit for its role, the hub marks the stage `failed`. It launches the stage again one time, with the same first message and a note. After a second failure, the hub tells the Orchestrator, and the Orchestrator decides or asks the human.
8. **Interrupts.** The human can interrupt any session. An interrupt does not close the session. The human closes it, or the session continues.
9. **Spec review stage.**
   - Add the ticket status `draft` before `queued` (today: `queued | claimed | in_progress | in_review | done | cancelled`, `hub/kinds/ticket.ts:27`). A `draft` ticket cannot be claimed, and the hub launches no session for it.
   - The Orchestrator sends `send_handoff` to `validator` with context `{request_id, review: "spec"}`. The hub launches a new Validator session. Its first message has the request text, all `draft` tickets of the request, the spec files, and the findings of earlier spec reviews of this request.
   - The verdict uses the review schema (item 6) with `review: "spec"`, `verdict: PASS | FAIL`, findings with a ticket id each, and `questions_for_human`.
   - PASS: the hub moves the `draft` tickets of the request to `queued`. When the request has a `blast_radius: high` ticket, the tickets stay `draft` until the human approves the plan in the UI.
   - FAIL: the hub sends the verdict to the Orchestrator. After two FAIL verdicts on one request, the hub tells the human and shows the open findings.
   - A ticket that changes during the work goes back to `draft`, and only that ticket goes to spec review.
10. **State.** The SQLite ledger is the main record of the factory. Part 5 ("Backups and recovery") backs it up with the rest of the app data folder. Before each schema migration, also write a local snapshot to `<app data>/snapshots/`.

## Context pack: a new session without a full exploration

A new session must not read the codebase again for each ticket. It gets a small context pack for its ticket and reads more only when it needs it. Code builds most of the pack, so the pack uses no model tokens.

1. **Order of the first message.** Put the stable text first and the ticket last:
   1. system prompt, tool definitions and role prompt (the same for each session of a role),
   2. the project primer (item 2),
   3. the ticket part: ticket, notes from earlier stages, context pack.
   The API caches the first part of a prompt when it is the same text as an earlier prompt. The cache does not depend on the session. Correction (2026-10-18): an earlier version of this part said that the cache does not help across sessions. Not checked: the Claude Code prompt contains the working folder, which is different in each worktree. The cache can then stop at that point. Measure the cache hits for each role (item 6).
2. **Project primer.** `CONTEXT.md` plus the Nutshell, at most about 2,000 tokens: architecture, conventions, where the main parts are, how to run the tests. The Orchestrator keeps it current with `[nutshell]` handoffs. The primer changes rarely, so it stays in the cache.
3. **Context pack, built by the hub.** Before the launch, the hub runs these commands in the worktree. No model runs.
   - `graphify query "<ticket title and criteria>" --budget 1500`: the related files, symbols and links, in about 1,500 tokens.
   - The signatures of the files and symbols that the ticket and the spec name (Serena `get_symbols_overview`). Not the full files.
   - For the Validator and the Testers: `git diff --stat` and the list of changed files.
   The agent reads the full files itself, and only the ones that it needs.
4. **Notes for the next stage.** Each result handoff has a `notes` field, at most about 300 words: the files that matter, decisions, traps, and what the agent did not check. The hub puts all earlier notes of the ticket in the first message of the next session. The Orchestrator writes the first note when it plans. The Validator adds the facts that it found in the code during spec review. Add `notes` to the handoff schema (item 6).
5. **Depth for each role.**

   | Role | Gets | Explores |
   |---|---|---|
   | Worker | primer, ticket, notes, full context pack | yes, from the pack |
   | Tester | ticket, commands to run, changed files | no |
   | Validator (code) | ticket, notes, diff, changed files, test report | only the changed files and their callers |
   | Validator (spec) | request, draft tickets, spec, graph query for the request | only to check the claims of the plan |
   | Writer | primer, ticket, notes, context pack | yes, from the pack |
   | Editor | the document and the style guide | no |
   | Reviewer | the document, notes, context pack | only to check claims |

6. **Measure.** For each session, the hub records three numbers. These are the tokens of the first message, the cache read tokens, and the tokens used before the first file change or the first verdict. The dashboard (Part 11) shows them for each role. When sessions of one role often read the same files, add those facts to the primer or to the context pack. When a new Worker session after a FAIL reads the same files again, use the option in "Costs and limits", item 3.
7. **Tools before files.** The role prompts tell the agent to use `graphify query`, `rg` and Serena `find_symbol` before it opens a full file (Part 7, code-intelligence workflow).

## Effect on other parts

- Part 2, step 5: "New factory room" launches only the Orchestrator. The numbers of workers and testers become the limits in item 5.
- Part 2, step 3: a session launched by the hub gets the same pre-allowed tools.
- Part 7: each session has its own worktree and graph, as planned.
- Part 11: add the queue, the sessions that run, and the failed stages to the dashboard.
- Part 3: the context checkpoints apply to the Orchestrator only.
- Part 6: `review.json` and its check script become the verdict schema in item 6. The spec stage of Part 6, item 2, ends with a spec review (item 9) before the human approves the spec.
- Part 11: show the requests in spec review, and the plans that wait for the human's approval.

## Costs and limits

1. Each new session loads the system prompt, the role prompt and the skill descriptions again. The prompt cache can reuse this text across sessions when it comes first and does not change ("Context pack", item 1). Measure the launch cost in tokens for each role.
2. Many short sessions count against the Claude subscription limits like one long session. Count them in the dashboard cost panel.
3. A new Worker session after a FAIL does not have the earlier session's reasoning. It has the findings, the diff and the ticket history. If this causes repeated work, let the hub keep the Worker session open until the Validator's verdict, as an option for each project.

## Tests

1. A ticket with role `worker` and no open `blocked_by` launches one Worker session. A blocked ticket launches none.
2. With the Worker limit at 1, a second ready ticket waits in the queue and launches when the first session closes.
3. A handoff to `tester` launches a Tester session in a temporary worktree at the handoff commit.
4. A verdict that fails the schema goes back to the same session with the errors. The session stays open.
5. A valid verdict closes the session, and the transcript is in the room history.
6. A session that stops without a result launches again one time. A second stop sends a message to the Orchestrator.
7. A Claude session launched by the hub has `Task` and `Agent` blocked.
8. The Orchestrator cannot launch a session. No chatbridge tool launches one.
9. A `draft` ticket cannot be claimed, and the hub launches no Worker session for it.
10. A spec review PASS moves all `draft` tickets of the request to `queued`. With a `blast_radius: high` ticket in the request, they stay `draft` until the human approves.
11. A second spec review FAIL on one request sends a message to the human.
12. A follow-up spec review session gets the findings of the earlier spec review in its first message.
13. The first message has the stable part first and the ticket part last. Two sessions of the same role have the same stable part, byte for byte.
14. The context pack of a Worker session has the graph query result and the symbol signatures. Its size stays under the budget.
15. A result handoff without `notes` fails the schema check. The next session of the ticket gets all earlier notes.
16. The hub records the first-message tokens and the cache read tokens for each session.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
