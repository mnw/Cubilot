## Context

The first message is rendered by `hub/core/first-message.ts` (`renderFirstMessage`, `renderSpecFirstMessage`) from `factory/<role>/first-message.md`. It holds the ticket part only. The role prompt is passed by `factory-roles` with `--append-system-prompt-file`. Results are checked in `checkResult` (`hub/kinds/stage.ts`), called from `hub/kinds/handoff.ts`. The bridge reports end of turn to `POST /stages/<id>/turn-end`. `CONTEXT.md` is 14 KB today (about 3,600 tokens), so it is not a primer: the hub reads `docs/PRIMER.md`, which does not exist yet. A graph exists at `graphify-out/graph.json`. graphify is at `/Users/mnw/.local/bin/graphify`. See proposal.md for the motivation.

## Goals / Non-Goals

**Goals:**
- A small pack that the hub builds with code only.
- A first message whose stable part is byte-identical across sessions of a role.
- Notes that travel with the ticket.
- Numbers that show whether the pack and the cache help.

**Non-Goals:**
- Dashboard, model routing, keep-open Worker option, tool bundling. See the proposal.
- Changing the role prompts beyond the tool-order text and the notes rule (task 4.3).

## Decisions

1. **Message order.** The text a session sees is: system prompt and role prompt (from `--append-system-prompt-file`, already stable), then the first message. The first message is rendered as `stable block` + `ticket block`. The stable block is the primer only. The ticket block holds ticket, notes, pack, handoff section. The renderer takes the stable block from one function (`renderStable(room)`) and appends the ticket block. Alternative: put the primer in the role file. Rejected: the primer is per room, and the role file is per role and staged by the app.

2. **Byte-identical stable block.** `renderStable` has no stage field, no time, no session name, no path of the worktree. A unit test renders it for two stages and compares bytes. The worktree path is in the ticket block only. Not checked: the Claude Code system prompt holds the working folder, which differs in each worktree, so the cache can stop before our text. Measurement (decision 8) answers this; the design does not depend on it.

3. **Primer source and cap.** The primer is `docs/PRIMER.md` of the project folder plus the Nutshell (human decision, review of this change). The hub does not read `CONTEXT.md`. The cap is 2,000 tokens for `docs/PRIMER.md`, counted as `ceil(bytes / 4)` (an estimate, named as such). A file over the cap is cut at a heading boundary when it fits, else at a line, and one line says `[PRIMER.md cut at 2000 tokens]`. The Nutshell is never cut. A missing file gives the line `primer missing` and the launch continues. A Writer ticket writes `docs/PRIMER.md` (task 2.4). (interim: see the Interim line below) Alternative: summarise `CONTEXT.md` with a model. Rejected: the brief requires no model.

4. **Pack builder.** One module, `hub/core/context-pack.ts`, `buildPack(role, ticket, worktree)`. It runs, in the worktree and with a 20 s limit for each command:
   - `graphify query "<title> <criteria>" --budget 1500` (absolute path `/Users/mnw/.local/bin/graphify`, or PATH).
   - Symbol signatures: the named files come from paths in the criteria and the spec paths that exist in the worktree. For each, Serena `get_symbols_overview`. Serena is an MCP tool and the hub is not an MCP client (untested: how the hub calls it). Decision: the hub runs a `serena` CLI call if one exists. If it does not, the hub runs universal-ctags (`ctags --output-format=json -f - <files>`) and labels the section "signatures (ctags)". If ctags is also missing, the part is `missing`. A `rg` fallback is NOT used, because it would look like a signature tool. Not checked: that universal-ctags is installed on this machine; task 3.3 records it.
   - `git diff --stat <base>...HEAD` and `git diff --name-only <base>...HEAD` for Validator and Tester. The base is the branch that the room's `project_folder` has out (`git symbolic-ref --short HEAD` there), the HEAD that the `ticket/<id>` branch starts from.
   The pack needs the worktree, and `enqueueLaunch` creates it. So the build runs inside `enqueueLaunch`, after the `stage.launching` transaction and before the first-message render and `queue.push`. The part up to `stage.launching` stays synchronous. The commands run asynchronously (`Bun.spawn`, never `spawnSync`), one after another, so the hub keeps answering. The render and `queue.push` run when the pack resolves. If the stage is no longer `launching` then, nothing is pushed; the temporary worktree is removed, and the name and slot are free because no session and no close exist (a cancel during the build releases them at once in `cancelStage`). The launch-ack time-out starts at `queue.push`. Each command has its own 20 s limit. Worst-case launch delay = number of commands for the role x 20 s (Worker 2, Writer 2, Reviewer 2, spec Validator 2, Tester 2, code Validator 3, Editor 0; signatures, task 3.3, add 1). The build caches nothing. A failure or time-out of one command marks only that part `missing`. A runtime without a pack builder (tests) queues at once.
   Alternative: build the pack lazily inside the session. Rejected: then the agent spends its own tokens.

5. **Graph status.** `fresh` when `graphify-out/graph.json` exists and is not older than `HEAD`'s commit time. `stale` when it is older. `missing` when absent or when graphify is not found. The hub never builds or refreshes the graph (the shared workflow lets one coordinating agent do it). The status is one line in the ticket block.

6. **Depth by role.** One table in code maps `(role, review)` to the list of pack parts. The first-message template of each role names its parts with `{{pack}}`, `{{notes}}`, `{{diff}}`. The renderer fills only the parts in the table, so a template cannot widen a role. Source: brief item 5.

7. **Notes.**
   - Result handoffs carry `context.notes`. `checkResult` rejects a missing or empty value and a value over 400 words (the brief says about 300; the hard limit leaves a margin for the count method). Words are split on whitespace.
   - Storage is the handoff row (`context_json`). No new table. The hub reads earlier notes with a query on result handoffs whose `context.ticket_id` equals the ticket, ordered by `created_seq`.
   - Planning note: `tickets.planning_note TEXT` (nullable), set by `create_ticket` and `edit_ticket` under the same edit rule as `request_id`. It is the first note.
   - Spec-review facts: the spec result carries `notes`. They are attached to every ticket in its scope by `context.request_id` and the `stage_scope` rows. The query for a ticket includes spec results of its stage scope.
   - A retry gets the same notes and no note of its own failed attempt.
   - Alternative: a `notes` table. Rejected: duplicates the handoff, and the handoff is already one event with one row.

8. **Measurement.**
   - Table `stage_metrics (stage_id, attempt, role, first_message_bytes, first_message_tokens_est, prompt_tokens_first, cache_read_tokens, tokens_before_action, source, created_seq, PRIMARY KEY (stage_id, attempt))`.
   - Source for Claude sessions: the session transcript JSONL that Claude Code writes under `~/.claude/projects/<encoded cwd>/`. Each assistant line has `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). The hub reads it once, when the stage ends, from the worktree cwd. `prompt_tokens_first` is the sum of the three input fields of the first request. `cache_read_tokens` is the sum of `cache_read_input_tokens` over the first request only (the number that shows cross-session reuse). `tokens_before_action` is the sum of all usage fields up to the first `Edit`, `Write` or `NotebookEdit` tool call or the first result handoff, whichever is first. A Tester has no file change, so its action is the verdict.
   - Pi: the pi session file format is untested. Until task 5.3 reads it, `source = 'none'` and the three token fields are NULL for pi.
   - `first_message_tokens_est` is `ceil(bytes / 4)`, in a column named as an estimate.
   - The write happens after `stage.passed` or `stage.failed` and outside that transaction. A failure logs one line and changes nothing (requirement in `session-metrics`).
   - Route: `GET /rooms/<room>/stage-metrics` (bearer or `?token=`), rows grouped by role.
   - Alternative: the bridge reports usage at each turn end. Rejected for now: needs a host change in both adapters, and the transcript already has the data. Revisit if the transcript path is not stable.

9. **Role prompts.** Two texts. (a) One short paragraph, "Find before you read", added to `factory/shared` text that the six roles and the Orchestrator already load, if such a file exists; else to each role prompt. Text: use `graphify query`, then `rg`, then Serena `find_symbol`, then open a full file. (b) In the result section of the six role files (`worker.md`, `tester.md`, `validator.md`, `writer.md`, `editor.md`, `reviewer.md`): include `context.notes`, target 300 words, limit 400. (b) ships in the same release as the notes check, because the check rejects results without notes. Both are checked by a test that greps the staged files.

## Risks / Trade-offs

- **Cache stops early** (system prompt holds the cwd) → the stable block is still correct and cheap; metrics show the real cache read, and the decision to move text is data-driven.
- **`notes` breaks existing agents' results** → only hub-launched stage results are checked; the first message and role prompts say so; the reject message names the field.
- **Serena has no CLI the hub can call** → universal-ctags fills the section, labelled "signatures (ctags)"; with no ctags the part is `missing`, stated in the first message. Task 3.3 records the result before the change ships.
- **Notes rule not in role prompts when the check ships** → every Worker result is rejected; task 4.3 and task 1.3 ship together, and task 6.3 checks both.
- **Transcript path or format changes in a Claude Code release** → `source` and NULLs make the gap visible; no stage is affected. The format is read from Claude Code 2.1.296 (untested on later versions).
- **Stale graph misleads** → status line says `stale`; the agent checks current source.
- **No `docs/PRIMER.md` yet** → the first message says "primer missing" until the Writer ticket (task 2.4) lands. The file is written by the Writer, reviewed by the Reviewer, and kept current by the Orchestrator. (interim: see the Interim line below)
- Interim: until the writing chain runs on the hub (draft ticket t_a2beebfe4fc002e1 for the gap), [doc] tasks run as Worker → Tester → Validator. The Validator does the Reviewer's checks.
- **Long first message and the argv limit** → `stage-sessions` 4.3 owns the limit; this change adds about 8 KB at most (primer 8 KB, pack 6 KB), measured in task 2.3.

## Migration Plan

- `CREATE TABLE stage_metrics`, `ALTER TABLE tickets ADD COLUMN planning_note TEXT`, in `migrate()`, each guarded. A snapshot is written first (`stage-sessions` decision 13).
- Rollback: the first message renders without the new parts when the code is reverted; the table and column stay unused.
- Rebuild sidecars after `hub/` changes (`./scripts/build-sidecars.sh`). After any change under `hub/channel/**`, run `./scripts/check-mod.sh` too. This change plans no change there.

## Open Questions

- Which file in `factory/` holds shared text for all roles (decision 9a)? Task 4.1 finds it; it does not change specs.
