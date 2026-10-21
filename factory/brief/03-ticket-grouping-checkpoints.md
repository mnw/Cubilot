# Part 3: ticket grouping and context checkpoints

Status: the grouping (`request_id`, `blocked_by`, the `draft` status) is a decision (2026-10-19). Build it before Part 4. The context checkpoints stay an idea.

**Change 2026-10-18 (Part 4).** The app launches a new session for each ticket stage, so most agents never fill their context. The checkpoints in this part then apply to the Orchestrator only, because it stays open for the whole room. The first message of a new session comes from the ticket: criteria, earlier verdicts, findings and files (Part 4). The grouping in this part (`request_id`, `blocked_by`) does not change. Build the checkpoint design only if the Orchestrator's context fills in real use.

## Idea

1. **Group tickets in two levels.** Today tickets are flat. Use:
   - **Request**: one human request. This is the `request_id` of Part 11.
   - **Task**: the ticket that one agent claims, as today.
   A task can also name the tasks that block it (`blocked_by`).
2. **Use task completion as the context checkpoint.** A task reaches `done`. Then each agent that worked on it gets a decision: do nothing, compact its context, or clear its context.
3. **A small decision model makes the decision.** Jev (Part 13) answers a typed question for each agent: `none | compact | clear`.
4. **A strong model writes the summary.** For `compact`, a strong model (for example Opus) reads the agent's transcript. It removes tool output and noise, and keeps what is relevant for the next work. The app then replaces the agent's context with that summary.

## Decision: two levels, not three (2026-10-18)

An earlier version of this idea had three levels (epic, story, task), as in agile work. The decision is two levels, for these reasons:
- Sprints, story points, velocity and ceremonies coordinate humans over weeks. An agent team does one request in hours. These items have no use here.
- A story level makes the Orchestrator plan two times (request to stories, then stories to tasks). It adds a second acceptance gate, more state changes and more tokens.
- Most requests have 3 to 10 tasks. A flat list of tasks under the request is sufficient.
- The context checkpoint does not need stories. A task that is done is already a clean point.

A request that needs design first gets a spec task first (Part 6, "Ready to spec"). The spec does the work that a story level did.

Add a story level only when one of these is true:
- Requests often have more than about 15 tasks.
- The dashboard is hard to read with a flat list.

## Why

- Long sessions fill the context window. Claude Code and Pi then compact automatically, at a moment that has no relation to the work. Information can go at a bad moment, in the middle of a task.
- A task that is done is a clean point. The work is done, and the results are in the ticket and the files. The next task is known.
- The summary model knows the factory structure (request, task, verdicts), so its summary keeps what the next ticket needs. The default compaction does not know this structure.

## What the harnesses allow (checked 2026-10-17)

### Claude Code
- `/compact [instructions]` takes focus instructions. It does **not** take a ready-made summary. Source: https://code.claude.com/docs/en/commands
- The `SessionStart` hook runs after `/clear` with `source: "clear"`, and after compaction with `source: "compact"`. It can add text to the new context with `hookSpecificOutput.additionalContext`. `/clear` keeps `CLAUDE.md`. Sources: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/context-window
- The `PreCompact` hook (matchers `manual`, `auto`) can block a compaction (exit code 2, or `"decision": "block"`). It cannot add context.
- Context usage is in the status line JSON: `context_window.used_percentage`, `context_window.context_window_size`, `context_window.current_usage.*`, `exceeds_200k_tokens`. `used_percentage` counts input tokens only, and it can be `null` early in a session and just after `/compact`. Source: https://code.claude.com/docs/en/statusline
- The auto-compact window is configurable: `--autocompact <value>` for one launch, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or `autoCompactWindow` in settings (100K to 1M tokens). `DISABLE_COMPACT` turns off all compaction. Source: https://code.claude.com/docs/en/model-config

**Effect:** for a Claude agent, "compact with our summary" is a **clear followed by an injection**:
1. The app writes the summary to `<app data>/checkpoints/<agent>.md`.
2. The app sends `/clear` to the agent's tmux pane.
3. A `SessionStart` hook in the role plugin, matcher `clear`, reads that file and returns it as `additionalContext`. Then it removes the file.

Not verified: the input fields of `PreCompact`, and the usage fields in the transcript JSONL.

### Pi
- `/compact [instructions]` takes focus instructions.
- The extension event `session_before_compact` fires before auto-compaction and `/compact`. It can cancel the compaction or **give a custom summary**. Its event has `preparation.messagesToSummarize`, `preparation.previousSummary`, `preparation.tokensBefore`, `preparation.fileOps` and `reason` (`manual`, `threshold`, `overflow`). Source: Pi `packages/coding-agent/docs/compaction.md`
- `reserveTokens` in Pi settings sets the threshold for auto-compaction (default 16384 tokens kept free).

**Effect:** for a Pi agent, the app's Pi extension (`hub/channel/pi-extension.ts`) handles `session_before_compact` and returns the summary from the summary model. A real compaction then happens with our summary.

## Design sketch

1. **Ticket grouping.** Tickets keep `request_id` (Part 11). Add `blocked_by` (list of ticket ids). A ticket cannot be claimed while a ticket in `blocked_by` is not `done`. The Orchestrator splits a request into tasks and sets the dependencies. A spec task, when there is one, blocks the other tasks of the request. Only the human closes a request.
2. **Context data.**
   - Claude agents: the role plugin sets a status line command. The command writes the status line JSON to `<app data>/context/<agent>.json`. The hub reads it.
   - Pi agents: the Pi extension reports context usage to the hub.
3. **Checkpoint events.** On `ticket.done`, the hub lists the agents that worked on the ticket. For each agent, it builds a small state:
   - context percent and tokens,
   - the agent's next ticket (same request or not),
   - the request status (open, or all tasks done),
   - the minutes since the last checkpoint.
4. **Decision.** The hub asks Jev one `choice` question for each agent: `none | compact | clear`. The state has only numbers and status values, no code. Without a Jev key, a fixed rule decides. For example: clear when all tasks of the request are done. Also clear when the next ticket is in a different request. Compact when the context is over 50 %. Else do nothing.
5. **Summary.** For `compact`, the hub calls the summary model with the agent's transcript and a factory template:
   - the ticket ids and their status,
   - decisions and their reasons,
   - open findings,
   - files changed,
   - the next ticket.
   Use the existing summariser path (`hub/core/summariser/claude.ts`, `claude --print`) with `--model opus`. It runs the official Claude Code CLI, so it uses the human's Claude subscription.
6. **Apply.** Claude agents: clear and inject (above). Pi agents: the extension returns the summary at the next `/compact`, and the app sends `/compact` to the pane.
7. **Control auto-compaction.** Option: a `PreCompact` hook blocks an automatic compaction while the agent is in the middle of a task. Then only the checkpoints compact. Keep the harness default as the last line of defence when the context is almost full.
8. **Wait for a quiet agent.** Send `/clear` or `/compact` only when the agent is idle (end of a turn). Never interrupt a running tool call.

## Open questions

1. Does Jev add value over a fixed rule here? The state is small and numeric. Test both.
2. A clear with injection loses the files that the agent read. The summary must list the files that the next ticket needs, so the agent reads them again.
3. Summaries use the Claude subscription limits (Part 2: subscription use). Count them in the dashboard cost panel.
4. The Validator and the Reviewer (Pi, OpenAI) get summaries from a Claude model. Check that this does not bring Claude's blind spots into the challenger roles. Option: an OpenAI model writes the summaries for these roles.
5. Fit with the dashboard (Part 11): the Requests panel shows the tasks of each request, and which tasks wait on `blocked_by`.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
