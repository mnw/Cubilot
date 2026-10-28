# t_1d56be14bddc5d3b report (worker, stage s_08186325e2b14455)

Finding only. This ticket changes no product code, docs, factory/ or openspec/. The only new file is this report.

## Summary

1. The cached amount is the end of the system prompt of the session. It is not the working directory.
2. The system prompt of a stage holds no worktree path and no git status. The only part that changes with the stage agent is the agent name.
3. A repeat read of 12926 (sonnet) or 13670 (haiku) happens only when the same agent name and the same model made a request within the cache time. After a role prompt change, the read falls to 8165.
4. The cache read never went past the end of the system prompt in 40 transcripts. The stable block cannot be reused in the present layout.
5. The stable block is about 7.6 KB (about 1.9k tokens). This is about 4 to 5 percent of the first prompt. A full reuse saves little.
6. Recommendation: option A (no change). See item 4.
7. Pi validator transcripts exist and have the fields that stage-metrics needs. Stage-metrics can read them. See item 5.

## Method and sources

- The ledger `~/Library/Application Support/Cubilot/ledger.db` (read only). I read the `stage.launching` events for the launch cwd and time.
- The Claude transcripts in `~/.claude/projects/<cwd with each non-alphanumeric character replaced by "-">/`. I chose each file as `selectTranscript` does: the first entry time is in the attempt window and the first user message holds the stage id.
- The `GET /rooms/cubilot/stage-metrics` output (saved copy used only to compare numbers).
- The transcript entries of type `attachment` with `type = prompt_snapshot`. They hold a copy of the system prompt blocks and the tool list that Claude Code made. This is not the request body. See the gaps.
- `claude --help` (Claude Code 2.1.312) and the Claude Code documentation pages `cli-reference`, `prompt-caching` and `env-vars`.
- Pi session files under `~/.pi/agent/sessions/`.
- Privacy: I quote only numbers, file paths, field names, hashes and character counts. I copied no message text.

## Item 1: usage of the first assistant line

The first assistant line is the first transcript line of type `assistant` with `message.usage`. The numbers equal the stage-metrics rows: `prompt_tokens_first` = input + creation + read. All cache writes used the one-hour time (`ephemeral_1h_input_tokens`).

| Stage | Role, model | Attempt | Transcript file (session id) | input_tokens | cache_creation_input_tokens | cache_read_input_tokens | Row prompt_tokens_first | Row cache_read_tokens |
|---|---|---|---|---|---|---|---|---|
| s_3b5479208e098082 | worker, sonnet | 1 | c904307b-b613-4662-8894-0fe5f78b432f | 2 | 33282 | 8165 | 41449 | 8165 |
| s_e1505776ba717419 | worker, sonnet | 1 | 6eb1c118-b14f-4f6f-a8b3-84096038b34d | 2 | 33273 | 8165 | 41440 | 8165 |
| s_be5a782c49a3bf89 | tester, haiku | 1 | 7982b976-e6c2-4f41-952d-74df0d7d9fb3 | 2 | 30409 | 8165 | 38576 | 8165 |
| s_1a2af3aaae41e34d | worker, sonnet | 1 | 7778eb2e-0ecd-4dd6-b8df-2c7aa438c329 | 2 | 46561 | 0 | 46563 | 0 |
| s_1a2af3aaae41e34d | worker, sonnet | 2 | f1d6bbf0-b2c3-4555-8333-9d621eb8e734 | 2 | 33647 | 12926 | 46575 | 12926 |
| s_0422361412236645 | tester, haiku | 1 | 80e324a6-6be0-4fc8-9792-f40de673cddf | 2 | 31366 | 13670 | 45038 | 13670 |

Notes:

- The 12926 of the ticket text is attempt 2 of s_1a2af3aaae41e34d. Attempt 1 read 0.
- Folders (cwd): `.../worktrees/cubilot/t_aa1624cfe3393b70/worker-1`, `t_a027250a42c457b1/worker-2`, `t_aa1624cfe3393b70/tester-1`, `t_abf6172662f96df2/worker-1` (both attempts), `t_abf6172662f96df2/tester-1`.
- The model in the first line is `claude-sonnet-5-5` for workers and `claude-haiku-5-5` for testers.

## Item 2: what the cached tokens hold

Series: I read the first assistant line of the last 40 transcripts in the cubilot worktree folders (2026-10-28, 00:43 to 11:06 local). The cache read took only these values.

- sonnet: 0, 8165, 12926, 12991.
- haiku: 0, 8165, 13478, 13670, 13805.

The system prompt blocks come from the `prompt_snapshot` entries. Worker and tester have the same 8 tools (same hash) and the same system blocks 0 to 10. Block 2 is the text `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`. The worker has 15 blocks. The tester has 16 blocks.

| Block (worker numbering) | Content type | Chars | Differs by |
|---|---|---|---|
| 0-1 | Claude Code core text before the boundary | 2063 + 4107 | nothing |
| 2 | boundary marker | 34 | nothing |
| 3-10 | Claude Code text after the boundary (output style, memory, environment, context) | about 5100 | nothing |
| 11 (worker) | tool text | 231 | role or model |
| 12 | chatbridge instructions, with the agent name | 4530 | agent name |
| 13 | search tool text | 423 | nothing |
| 14 (worker) / 15 (tester) | role prompt (role.md) | 3621 / 3862 | role |

| Answer | Result | Evidence or gap |
|---|---|---|
| 8165 holds the 8 tool definitions and the start of the system prompt that all stages share on one model. The most likely end is the boundary marker (blocks 0-1). | Unresolved | Proven: tools and blocks 0 to 10 are identical in all five stages and in both roles (equal hashes). Not proven: the exact token count. The arithmetic (about 4 characters per token for tools plus blocks 0-1) fits the boundary end better than the end of block 10 (about 4.6). No tokenizer count and no request body. |
| 8165 is the same for sonnet (worker) and haiku (tester). | Unresolved | Both models read the same shared text. I did not check whether both models count tokens in the same way. |
| 12926 (worker, sonnet) holds tools plus the full system prompt: shared blocks, the agent name block and the role prompt. | Unresolved, strong support | Every 12926 read in the series follows an earlier request of the same agent name and model within one hour. Examples: worker-1 at 07:25 then 07:32. worker-2 at 07:26 then 07:38. The read is 0 at 09:57 for worker-1 after a gap of more than one hour. A change of the role prompt only (block 14) gave 8165 at 10:54. No request body. |
| 13670 (tester, haiku) holds the same, for the tester prompt. | Unresolved, strong support | Same pattern per agent name. The difference 13670 - 12926 = 744 tokens. The tester system prompt has about 2.9k more characters than the worker prompt (23432 against 20552 characters in the snapshot). This fits about 3.9 characters per token. |
| The read stays at 12926 for different worktrees. | Proven | worker-1 read 12926 in worktrees t_3186bc4426ddc3ab, t_abf6172662f96df2 and t_dc9f0e20286e5c3a. tester-1 read 13670 in four worktrees. |

## Item 3: the hypothesis

Hypothesis: Claude Code puts the working directory and git status in the system prompt, so the prefix differs per stage.

Result: refuted as written. Partly unresolved for the layer after the system prompt.

1. In all six transcripts, no system prompt block holds a worktree path, `Application Support` or a git status text. Checked in all blocks.
2. The system blocks that differ between stages: only the chatbridge block (agent name) and the role prompt block. Worker-1 and worker-2 differ only in block 12 (hash). The same agent in two worktrees has equal blocks.
3. The cached amount does not depend on the working directory. See item 2 (same amount in different worktrees).
4. The cached amount does not grow when the working directory is equal. Attempt 2 of s_1a2af3aaae41e34d used the same cwd as attempt 1 and read 12926. The first message differs by 88 bytes between the two attempts.
5. Unresolved: why the read stops at the end of the system prompt. Candidates: Claude Code sets no cache marker after the system prompt, the first message differs per stage, or the project context differs per worktree. I did not test them. The documentation page `prompt-caching` says that the cache is "effectively scoped to one machine and directory" because the conversation opens with the working directory and the git status.

Parts of the request before the first user message:

| Part | Differs per stage? | Evidence or gap |
|---|---|---|
| Working directory | Yes | Attachment `environment`, key `snapshot.workingDirectory`. The hash differs for worker A and worker B. It is an attachment of the first turn, not a system block. |
| Git status | Not shown | The `environment` snapshot has the keys `isGitRepo`, `isWorktree`, `platform`, `shell`, `osVersion`, `additionalWorkingDirectories` and no status text. The documentation says that the git status snapshot is in the conversation. Gap: no request body. |
| CLAUDE.md files | Yes, for one file | Attachment `instructions` has 4 files. The user CLAUDE.md, `code-intelligence.md` and `MEMORY.md` have equal hashes in all stages. The project CLAUDE.md has the worktree path in its record (hash differs, size equal at 10307 characters). |
| Skill list | By role | Attachment `skill_listing`: 30487 characters (worker), 25733 (tester). Equal hash for the two workers. |
| Tool list | No | Same 8 tools, same hash for worker and tester. Attachment `deferred_tools_delta` differs by role (5706 and 5668 characters). |
| Model | By role | worker sonnet, tester haiku (role_models). The model has its own cache (documentation). |
| System prompt: agent name | By agent | Block 12 holds the agent name from `CHATBRIDGE_AGENT` (set in `claude_command_using`, `src-tauri/src/pty.rs` around line 954). The mod writes it. |
| System prompt: role prompt | By role | `--append-system-prompt-file <role>/role.md` (`pty.rs` around line 916). It follows the agent name block. |
| Other launch arguments (`pty.rs` from line 706) | By role | `--plugin-dir` x3 (mod, role, shared), `--settings <agent>.json`, `--model`, `--effort`, `--disallowed-tools`, `--allowed-tools`. Not checked: the content of the `--settings` file for each agent. |

Request body: not available. I checked these sources: the Claude transcripts (including `prompt_snapshot`), the ledger, `claude --help`, the three documentation pages. There is no log of the request body in the app data folder.

## Item 4: can the stable block be cached across stages of one role?

Answer: not in the present layout.

- The stable block (`renderStable`: `docs/PRIMER.md` and the Nutshell) is at the start of the first user message. In the first message of validator-1 it is the first 7637 bytes, about 1.9k tokens. This is about 4 to 5 percent of a first prompt of 38k to 46k tokens.
- It follows the system prompt and the project context. The project context holds the working directory and the worktree CLAUDE.md path. Both differ per stage. The prefix is not equal before the block.
- In 40 transcripts the read stopped at the end of the system prompt. Even attempt 2 with the same cwd did not read more.
- The stable block is for a room, not for a role (`first-message.ts` comment). The role prompt is already in the system prompt.
- About 30k to 33k tokens per stage are written new. The largest parts are the skill list, the CLAUDE.md files and the tool and deferred-tool text, not the stable block.

| Option | Effect | Risk | Files a later ticket would change |
|---|---|---|---|
| A. No change | No change. The stage writes about 30k to 33k tokens each time. | None. The possible saving is small (see above). | None. |
| B. Documented flag `--exclude-dynamic-system-prompt-sections` | Documented in `cli-reference` (flag table) and in `claude --help` 2.1.312. It moves per-machine text (working directory, environment, memory paths, git status) out of the system prompt into the first user message. It applies with the default system prompt, and the stages use the default plus `--append-system-prompt-file`. Expected effect here: none or very small. The system prompt of the stages has no working directory. The memory path block is equal in all stages. Not tested. | Low. A flag change moves text into the message and changes every cache once. | `src-tauri/src/pty.rs` (flags near line 916, tests near line 2621). |
| B2. Other documented settings | No documented setting found that keeps the working directory or the CLAUDE.md path out of the prefix. Pages checked: `cli-reference`, `prompt-caching`, `env-vars` (the first 100000 of 186764 characters only). Found: cache time settings (`promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`) and `DISABLE_PROMPT_CACHING*`. The stage writes already use the one-hour time. | None. | None. |
| C1. Move the agent name out of the system prompt into the first message | All agents of one role and model would share the full system prompt. A first stage of a new agent name would read 12926 or 13670, not 8165. Gain: about 4.8k tokens for the first stage of each agent name per hour. | The chatbridge rules (identity, language) are policy and live in the bridge core. Rule: after a change in `hub/channel/**`, run `build-sidecars.sh` and `check-mod.sh`. | `hub/channel/instructions.ts`, `hub/channel/instructions.json`, `hub/channel/claude-mod/register.ts`, mod tests, `hub/core/first-message.ts`. |
| C2. Put the room stable block into the appended system prompt file | A repeat stage of the same agent name and model within one hour could read the block (about 1.9k tokens). It works only if Claude Code puts a cache marker at the end of the system prompt. The transcripts do not show the markers. | The file is no longer the same for every session of a role. A Nutshell edit changes the system prompt and so all caches. Not tested: no session shows a read past the system prompt end from this layout. | `hub/core/first-message.ts`, `hub/core/primer.ts`, `hub/kinds/stage.ts` (line 1028), `src-tauri/src/pty.rs`, `src-tauri/src/factory.rs`, tests. |
| C3. One fixed cwd for each agent | Not evaluated. | High. Stage-metrics finds the transcript by the cwd. The worktree is the isolation and the read-only rule. | Not listed. |

Recommendation: option A. The most that the stable block can save is about 1.9k of 38k to 46k tokens. If the human wants a test, run this before any build: add a marker line to a test role prompt file, run two stages of the same agent name within one hour, and read `cache_read_input_tokens` of the second stage. A value above the system prompt end would show that the block can be cached (C2). The same read shows the effect of option B if the flag is added to the test launch.

## Item 5: validator transcripts (pi)

| Stage | Pi session file |
|---|---|
| s_9bae7f18a19c61bf | `~/.pi/agent/sessions/--Users-mnw-Library-Application Support-Cubilot-worktrees-cubilot-t_aa1624cfe3393b70-validator-1--/2026-10-28T09-56-04-946Z_01a181f0-32d1-7136-8fe9-5178d2cd5348.jsonl` |
| s_8bc203114467df05 | `~/.pi/agent/sessions/--Users-mnw-Library-Application Support-Cubilot-worktrees-cubilot-t_a027250a42c457b1-validator-2--/2026-10-28T09-56-40-686Z_01a181f0-be6d-7471-a377-4a422564a041.jsonl` |

How the file is found:

1. The ledger event `stage.launching` has `launch.cwd` (`launchEvents` in `hub/core/stage-metrics.ts`). For s_9bae7f18a19c61bf it is `.../t_aa1624cfe3393b70/validator-1`.
2. The folder name is `--` + the cwd without the first "/" + `--`, with each "/" replaced by "-". Spaces and underscores stay. This differs from the Claude rule (each non-alphanumeric character becomes "-"). Seen on these two folders and on other validator folders. The Pi source is not checked.
3. Line 1 of the file is `type = session` with the field `cwd`. It equals the launch cwd. The stage id is in the file. The file name starts with the start time (UTC). The start of s_9bae7f18a19c61bf was 10:56:04 local = 09:56:04 UTC. This is 95 seconds after the first worker launch.
4. `PI_SESSION_FILE`: not verified. The repo does not use it (`rg` in `hub/`, `src-tauri/src/`). It is not set in this Claude stage. The spec review says that Pi sets it in a running stage. I did not check a running Pi stage.
5. Launch code: `pi_command` and `pi_role_flags` (`src-tauri/src/pty.rs`, lines 655 to 695) pass no `--session-dir`. The repo sets no `PI_CODING_AGENT_DIR` (a comment at `pty.rs:3265` and `factory/brief/07-toolchain.md` only). Pi uses the default folder `~/.pi/agent/sessions`.

First assistant line (line 6 of each file, `type = message`, `message.role = assistant`, model `gpt-5.6-sol`):

| Stage | input | output | cacheRead | cacheWrite | totalTokens |
|---|---|---|---|---|---|
| s_9bae7f18a19c61bf | 16650 | 587 | 0 | 0 | 17237 |
| s_8bc203114467df05 | 16602 | 509 | 0 | 0 | 17111 |

The `cacheRead` of the first line is 0 for both stages. Later lines of s_9bae7f18a19c61bf have a cacheRead above 0 (17152 in the second assistant line).

Can stage-metrics read it? Yes. The usage is in each assistant message and has integer fields.

| stage_metrics column | Pi source |
|---|---|
| prompt_tokens_first | `input + cacheRead + cacheWrite` of the first assistant message. Checked: line 2 has input 10648 + cacheRead 17152 = 27800 = totalTokens 27843 - output 43. For s_9bae7f18a19c61bf this is 16650. |
| cache_read_tokens | `cacheRead` of the first assistant message. For both stages this is 0. |
| tokens_before_action | The sum of `totalTokens` of the assistant messages up to and including the first action. `totalTokens` = input + output + cacheRead + cacheWrite (checked on 2 lines). The action in a validator is the tool call `send_handoff` (plain name, no `mcp__` prefix), in `message.content` with `type = toolCall`. The write tools of Pi are not checked (the validator excludes them). For s_9bae7f18a19c61bf the first `send_handoff` is in the sixth assistant message. The sum is 178521. This number is computed here and is not stored. |

Differences from the Claude reader: Pi has one line for each assistant message (no repeated message id seen in the first six lines), and the field names are `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`.

Files a later reader ticket would change (build nothing here; the reader is parked in t_aa346d8209bec505):

- `hub/core/stage-metrics.ts`: the type at line 21 (`source`), the pi branch at lines 238-239, a new folder function and a new usage reader.
- `hub/core/ledger.ts` (line 442): the `source` column is `TEXT NOT NULL`. The ticket must decide the new value (for example "pi").
- `docs/PROTOCOL.md` (lines 888 to 902) and the context-pack spec in `openspec/` (task 5.3).
- `tests/unit/stage-metrics.test.ts` and `tests/integration/stage-metrics.test.ts`.

## Item 8: risk

- Security and privacy: I read private local transcripts. This report holds only numbers, paths, field names, hashes and counts. A path under the home folder is written as `~/`.
- Not applicable: migration, accessibility, performance, compatibility (one report file).

## Open points and gaps

1. The request body that Claude Code sends is not available. The `prompt_snapshot` is a copy of the system prompt and the tools only.
2. The exact end of the 8165 prefix is not proven (boundary marker or end of block 10).
3. Why the read never passes the end of the system prompt is not proven (item 3, point 5).
4. The second half of the `env-vars` page was not read.
5. `PI_SESSION_FILE` was not checked in a running Pi stage.
6. I ran no test suite and wrote nothing under `~/.claude` or `~/.pi`.
