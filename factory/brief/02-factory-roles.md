# Part 2: factory roles

Work: `factory/work/factory-roles/` (an OpenSpec change. After the migration it moves to `openspec/changes/factory-roles/`).

## Research findings

### 1. Do not use `claude --agent <role>`

`--agent` replaces the default Claude Code system prompt with the agent body. CLAUDE.md and project memory still load, but the built-in coding instructions do not. The docs do not say if the chatbridge mod's prompt section survives.

Source: https://code.claude.com/docs/en/sub-agents.md

Effect: a Worker or Tester loses Claude Code's coding behaviour. Use the flags in section 3 instead.

### 2. A role folder can be a plugin

- A plugin loaded with `--plugin-dir <dir>` can give skills (`skills/<name>/SKILL.md`) and sub-agents (`agents/<name>.md`). The factory uses only skills (Part 4).
- The manifest `.claude-plugin/plugin.json` is optional. Its only required key is `name` (kebab-case). Without it, the plugin takes the directory name.
- `--plugin-dir` can occur more than once in one command. It accepts directories and `.zip` files.

Sources: https://code.claude.com/docs/en/plugins/create.md, https://code.claude.com/docs/en/plugins/manifest-reference.md, https://code.claude.com/docs/en/plugins/cli-reference.md

Effect: stage each `factory/<role>/` as its own plugin. Each agent then loads only the skills of its role.

### 3. Flags that keep the default prompt

`claude --help` (version 2.1.301) lists `--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt-file`, `--agents`, `--model`, `--plugin-dir` and `--settings`. Use:

| Need | Flag |
|---|---|
| Role instructions | `--append-system-prompt-file <role body file>` |
| Role skills | `--plugin-dir <staged role plugin>` |
| Model | `--model <opus\|sonnet\|haiku>` from the role frontmatter |
| Tool limits | `--disallowed-tools <list>` from `disallowedTools` in the role frontmatter. Every Claude role blocks `Task` and `Agent` (Part 4). The Orchestrator also blocks the edit tools. |

### 4. Skills load on demand. Keep it that way.

The factory follows the ECC behaviour model:
- A skill enters the agent's context only when the task matches the skill's `description`. Role prompts stay short, and context stays small.
- The factory does not use the ECC sub-agent pattern. The human cannot see what a sub-agent does (Part 4).

Rules for the build:
1. **Do not preload.** In an agent file, `skills:` injects the full skill text at launch (maximum 32 names). It does not stop the agent from using other skills. Do not use it. To limit skills, load only the role's plugin (finding 2).
2. **Descriptions are the routing rules.** A vague `description` means the skill never loads, or loads at the wrong time. Treat a description change like a code change.
3. **Small models name their skills.** Haiku is less reliable at choosing skills by description. The Tester's role file names each skill it must run. Keep that pattern for every Haiku role.
4. **No sub-agents.** On 2026-10-18 the ECC and Agency agent files in `factory/` became skills. Every Claude role launches with `Task` and `Agent` blocked. One skill tells the agent to give a step to a sub-agent (`search-first`). It has a factory note at the top: do the step in the same session.

### 5. Skills that every role needs

`asd-ste100` is already in the shared project skills. Every agent needs it, because `hub/channel/instructions.json` (section `language`) tells every agent to write chatbridge messages in ASD-STE100. Do not copy it into each role plugin.

### 6. The Validator and the Reviewer run on OpenAI through Pi

The Validator and the Reviewer challenge the work. They use a different model family (OpenAI) than the agents that produce it (Anthropic), so they do not share the same blind spots. The app launches them with the Pi harness (pi.dev).

Pi CLI facts (source: `packages/coding-agent/docs/cli.md` and `providers.md` in https://github.com/earendil-works/pi, read on 2026-10-16):

| Need | Pi flag |
|---|---|
| Provider and model | `--provider openai --model <id>` (also `--model openai/<id>`) |
| Reasoning level | `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max>` |
| Role instructions | `--append-system-prompt <path>`. It keeps the default prompt and can occur more than once. |
| Role skills | `--skill <path>`. It can occur more than once. Skills load on demand. |
| Tool limits | `--exclude-tools edit,write` |
| OpenAI sign-in | `OPENAI_API_KEY`, or `/login openai` (OAuth or API key, saved in Pi's `auth.json`) |

Consequences:

1. **Use `--exclude-tools`, not `--tools`.** `--tools` with plain names is an allowlist. It removes every tool it does not name, the chatbridge tools from the pi extension too. `--exclude-tools edit,write` removes only those two.
2. **Pi has no sub-agents.** This fits the factory rule (Part 4). The review checklists of the Validator and the Reviewer (`code-review`, `silent-failure-hunter`, `pr-test-analyzer`, `php-reviewer`, `typescript-reviewer`, `code-explorer`, `comment-analyzer`, `agency-*`) are already skills in `factory/`. The role loads them on demand, in its own context.
3. **Pi has no permission prompts.** The `--no-approve` flag in the current Pi command only ignores trust-gated project files. It does not gate tools. Without `edit` and `write`, a Pi Validator can still change files through `bash`. The role file forbids this. For a hard limit, run Pi roles in a read-only checkout of the branch, or add a Pi permission-gate extension that blocks writing `bash` commands.
4. **Model ID.** The role files propose `gpt-5.5`, which occurs in the Pi source. A public Pi setup from September 2026 (finding 8) lists `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra`, so `gpt-5.5` can be one version old. The `openai-codex` provider can also mean a different sign-in than `OPENAI_API_KEY`. Run `pi --list-models` and pick the model and provider before release. **Decision (human, 2026-10-21):** use the ChatGPT subscription: `provider: openai-codex`, `model: gpt-5.6-sol` in `validator.md` and `reviewer.md`. `openai` `gpt-5.5` failed live with a ChatGPT sign-in (task 1.4). The human picks the model and the effort for each launch in the spawn modal.
5. **No `ack_permission` for Pi roles.** Pi has no tool approvals to relay. This matches ground rule 7.

### 7. Hooks can enforce a gate, but not on chatbridge tools

**Result of check 0.4 (2026-10-21, Claude Code 2.1.306): the hook below never runs.** PreToolUse and PostToolUse hooks from a plugin do not run for `mcp__chatbridge__*` tools, because the mod answers the call itself. A control hook on `Bash` ran. **Decision (human, 2026-10-21):** the Reviewer runs `ste-lint.py` on `context.path` before it accepts the handoff, and declines a handoff that fails, with the findings. An accepted handoff cannot become declined. Deliberate breaks (human decision 2026-10-21): the Editor lists each one in `change_summary` as `ste_disable: <rule> at <line>: <reason>`. The Reviewer runs the linter twice: with `--disable` for the listed rules (must exit 0), and with `--json` without it (every hit of a listed rule must be at a listed line). The Reviewer judges each reason. The Editor role text keeps the rule to run `ste-lint.py` before each handoff. A gate inside the chatbridge bridge is a backlog item (high blast radius). The text below is the original plan, kept for reference.

ECC uses hooks to enforce rules, not to ask for them. A Claude Code plugin can ship hooks in `hooks/hooks.json`, and `${CLAUDE_PLUGIN_ROOT}` points to the staged plugin folder.

First use: the Editor's ASD-STE100 gate. Today the Editor must remember to run `ste-lint.py` before hand-in. A `PreToolUse` hook on `mcp__chatbridge__send_handoff` can enforce it:
1. The hook reads the tool input. It acts only when `to` is `reviewer`.
2. It runs `python3 ${CLAUDE_PLUGIN_ROOT}/skills/asd-ste100/scripts/ste-lint.py <context.path>`.
3. When the linter exits with 1, the hook exits with 2 and writes the findings to stderr. Claude Code blocks the handoff and gives the findings to the Editor.

The hook is in `factory/editor/hooks/` (`hooks.json` and `ste-gate.py`). Its tests pass for five cases: a handoff to another agent, a clean doc, a doc with hard violations, no `context.path`, and a missing file. Set `FACTORY_REVIEWER` when the reviewer has another name.

Only Claude roles can use these hooks. Pi has no hook system of this kind. Use a Pi extension for the same job on Pi roles.

### 8. Parts to reuse from a public Pi setup

Source: https://github.com/davis7dotsh/my-pi-setup (MIT, Benjamin Davis, last commit 2026-09-06). Copy code only with its license notice. Pin the source commit.

| Part | Path in that repo | Use in the factory |
|---|---|---|
| fd and rg versions and checksums | `extensions/file-search/src/binaries.ts` | Part 7 `toolchain.lock`: fd 10.4.2, rg 15.2.0, SHA-256 for macOS arm64 and x64. Its lookup order (system binary, local copy, checked download) also fits the Doctor. |
| Agent-folder layout | `SETUP.md`, `package.json` | Part 7 Pi folder: a `package.json` that lists the extensions, installed with `npm install` into `PI_CODING_AGENT_DIR` |
| Git status in the footer | `extensions/git-info` | Optional. Each Pi tab shows its branch and changed files. |
| Tool-call timeout | `extensions/shared/tool-call-timeout.ts` | Optional. Stops a tool call that hangs in an agent that runs without a human watching it. |

Do not use these parts:
- `extensions/subagents`, both backends. The factory uses no sub-agents (Part 4). The Claude backend also runs the Agent SDK with `permissionMode: "bypassPermissions"`, as a hidden nested agent with no permission checks.
- `extensions/workflows`. It runs its own orchestration, which competes with tickets and handoffs.
- `extensions/ask-user`. Questions to the human go through chatbridge.
- `extensions/spark-strict-tools`. Strict tool schemas reject the chatbridge tools, which have optional fields.

**Decision (2026-10-18): no sub-agents for the Pi roles.** The earlier choice between agents as skills (option A) and real Pi sub-agents (option B) is closed. Option A is done in `factory/`. When one Validator context is too small for a review, the Orchestrator splits the review into more tickets. The app launches a separate visible session for each.

## Code locations

| What | Where |
|---|---|
| Claude launch command | `src-tauri/src/pty.rs:748` `format_claude_command`, string at `:771` |
| Spawn entry point | `src-tauri/src/pty.rs:984` `pty_spawn(agent, cwd, session_mode, room, harness)` |
| Plugin staging pattern to copy | `src-tauri/src/lib.rs:858` `stage_chatbridge_mod`, note at `:753` (stage into app data, not into the signed bundle) |
| Pi launch and `--skill` folders | `src-tauri/src/pty.rs:529` `claude_resource_flags`, `:580` pi command |
| Pi system prompt hook | `hub/channel/pi-extension.ts:139` `before_agent_start` |
| Spawn modal | `ui/terminal.js:30` (`spawn-*` inputs) |
| Roster pills | `ui/features/roster.js` |
| Room lead route | `hub/kinds/ticket.ts:576-627`, `POST /rooms/:room/lead` with body `{ "by": "<human>", "agent": "<name>" }`. The agent must already be registered. |
| Agent tool definitions | `hub/channel/tools.ts` |
| Ticket kind tool list for the Briefing | `hub/kinds/ticket.ts:1013` |
| Launch-command tests | `src-tauri/src/pty.rs:1872` and later |

## Design

### Step 1. Bundle and stage
1. Add `factory/` to the Tauri bundle resources.
2. When the app opens, stage all roles and `shared` into a new version folder `<app data>/factory/v-<hash>/<role>/` (build in a temp folder, then rename, like `stage_chatbridge_mod`), and write the version name to `<app data>/factory/current` (tmpfile + rename). The hash covers only the staged inputs, and an existing `v-<hash>` is reused. The staged inputs never change after the rename. Claude Code may add `.claude-plugin/types/`, `.gitignore` and `tsconfig.json` to a loaded plugin folder; they are not staged inputs and not in the hash. Running agents keep their version, also after an app restart (tmux sessions survive it). A spawn reads `current`, so it never sees a half-staged folder. This change deletes no old version: a spawn can read the old `current` just before a new one is published, and a cleanup could remove that version before the pane exists. Cleanup is a backlog item. Each role folder gets (below, `<current>` is the version name in `<app data>/factory/current`):
   - `.claude-plugin/plugin.json` with `{"name": "factory-<role>"}`
   - `skills/` from `factory/<role>/skills/`
   - `role.md`: the body of `factory/<role>/<role>.md` without the frontmatter
   - `hooks/hooks.json` from `factory/<role>/hooks/`, when the role has hooks (finding 7)
3. Do not stage an `agents/` folder. The role plugin has skills and hooks only.
4. **Skill listing (decision 2026-10-19).** Claude Code puts the name and the description of every skill it can find in a listing. The listing has a budget of 1 % of the context window. When the listing is too long, Claude Code removes the descriptions of the skills that are used least. The agent then cannot find them. Source: https://code.claude.com/docs/en/skills, "Skill descriptions are cut short". The human's own skills and plugin skills (for example 27 SEO skills) are in that listing too. For each Claude role, the app writes `<app data>/factory-settings/<agent>.json` at each launch (outside the version folders: the lists depend on the agent's project folder):
   - `enabledPlugins`: `false` for each installed plugin (`<plugin>@<marketplace>`) and each `--plugin-dir` plugin (`<name>@inline`) that is not the role plugin or the shared plugin. Never turn off the chatbridge mod (`chatbridge@inline`): the agent needs it to join the room.
   - `skillOverrides`: `"off"` for each user and project skill outside the role plugin and the shared plugin. The key is the bare skill name.
   - No change for the role plugin and the shared plugin.
   The app makes the lists at launch from the plugins and skills that Claude Code finds.
   **Result of check 0.2 (2026-10-21, Claude Code 2.1.306):** `skillOverrides` does not affect plugin skills (docs: "Plugin skills are not affected by `skillOverrides`"). `enabledPlugins` in `--settings` turns off a whole plugin for one launch only. Account-synced plugins (from claude.ai, under `~/.claude/plugins/synced/`, for example the 27 SEO skills) stay on: no tested setting turns them off for one agent. **Decision (human, 2026-10-21):** accept them in the listing. A separate `CLAUDE_CONFIG_DIR` for each role is a backlog experiment.
   Pi roles need no change: the app gives Pi only the role's `--skill` folders and its own `PI_CODING_AGENT_DIR` (Part 7).
5. **Skill size.** After compaction, Claude Code attaches again only the first 5,000 tokens of each skill that the agent used. Keep the rules that must always apply at the top of each factory skill. Keep `SKILL.md` under 500 lines, and put reference material in `references/`. The factory skills `code-review` and `api-design` follow this rule since 2026-10-19.
6. **Shared plugin (decision 2026-10-21).** Stage `factory/shared/` into `<app data>/factory/<current>/shared/` with `{"name": "factory-shared"}`, and load it for every role (`--plugin-dir` for Claude, `--skill <app data>/factory/<current>/shared/skills` for Pi). It holds `asd-ste100` (moved from `factory/editor/skills/`, one copy only). Without it, the settings generator would turn off `asd-ste100`, a user skill today, for every Claude role.
7. **User skill layer (decision 2026-10-21).** A user of the downloaded app cannot edit the bundle, and staging replaces `<app data>/factory/`. So the app stages `<app data>/factory-user/<role>/skills/` on top of the bundled skills. A user skill replaces a bundled skill with the same name. To go back, the user deletes the folder. A title-bar button next to the settings button opens `factory-user/` in Finder. The key is the folder name (it must equal the frontmatter `name`). A user folder replaces the bundled folder as a whole, with no file merge. The user layer is part of the version hash, so a change gives a new version (item 2) and never touches a running agent. A running agent reads skill text from its version folder when it uses a skill. **Proposed, needs the human's approval:** reload stages a new version and does not block.

### Step 2. Spawn with a role
1. Add `role: Option<String>` to `pty_spawn` and to `format_claude_command`.
2. Parse the role frontmatter: `harness` (default `claude`), `provider`, `model`, `thinking`, `disallowedTools` (Claude) and `excludeTools` (Pi). The role's `harness` overrides the harness choice in the spawn modal.
3. For a Claude role, add to the Claude command: `--plugin-dir '<app data>/factory/<current>/<role>' --plugin-dir '<app data>/factory/<current>/shared' --append-system-prompt-file '<app data>/factory/<current>/<role>/role.md' --settings '<app data>/factory-settings/<agent>.json' --model <model>`, and `--disallowed-tools ...` from `disallowedTools`. Every Claude role sets `Task, Agent`.
4. When `role` is `None`, the command does not change.
5. Many agents share one role. `worker-1` and `worker-2` both use `worker`. `tester-1` and `tester-2` both use `tester`.

### Step 3. Pre-allowed tools
The command pre-allows only `mcp__chatbridge__ack_permission`, `mcp__chatbridge__post` and `mcp__chatbridge__post_file`. For an agent with a role, also pre-allow these tools:

- handoffs: `send_handoff`, `accept_handoff`, `decline_handoff`, `cancel_handoff`
- interrupts: `send_interrupt`, `ack_interrupt`
- tickets: `create_ticket`, `claim_ticket`, `transition_ticket`, `assign_ticket`, `attach_ticket_file`, `list_tickets`

Without this, the human must approve each call and the factory stops.

Block `ack_permission` for factory roles. Ground rule 7 in the README says only the human acks permissions.

Removing `ack_permission` from `--allowed-tools` is not enough. In `default` mode the chatbridge mod runs all fifteen chatbridge tools with no prompt (CLAUDE.md, the `$.tool.check` rule). So a role agent could still call `ack_permission`. Block the tool instead:

- Claude role: add `mcp__chatbridge__ack_permission` to `--disallowed-tools`, and leave it out of `--allowed-tools`. The mod refuses the call through `$.tool.check`. Not tested.
- Pi role: add `ack_permission` to `--exclude-tools`. Not tested.

Blocking the tool does not change the permission relay. The human still resolves a permission request from the card in the UI and from the agent's terminal.

### Step 4. UI
1. Add a Role dropdown to the spawn modal. Fill it from the staged roles. "None" keeps the current behaviour.
2. When the user selects a role, show its harness and model as defaults. Let the user override the model for one launch, for example `worker-2` on `opus` for a hard ticket. Do not let the user change the harness of a Pi role, because its tool limits and skills are built for Pi.
3. Remember the role and any model override for each agent name, like the cwd cache (`ui/terminal.js:142`).
4. Show the role and the model on the roster pill.

### Step 5. Factory preset
"New factory room" does these steps:
1. Ask for the room name, the project folder, the number of workers and the number of testers.
2. Launch only `orchestrator` first. The app launches the other roles for each ticket stage, each in a new session and its own worktree (Part 4). The numbers of workers and testers are the concurrency limits.
3. Show an empty pane slot for each limit, so the human sees how many sessions can run.
4. When `orchestrator` connects, set it as room lead through the room lead route.
5. Seed the Nutshell from a template: product, repo, branch policy, style guide path, definition of done.

### Step 6. Pi harness (Validator and Reviewer)
1. Stage the Pi role like a Claude role (step 1).
2. Add `role: Option<&str>` to `pi_command` (`src-tauri/src/pty.rs:560`).
3. Add to the Pi command, before `-e`:
   `--provider '<provider>' --model '<model>' --thinking '<thinking>' --append-system-prompt '<app data>/factory/<current>/<role>/role.md' --skill '<app data>/factory/<current>/<role>/skills' --exclude-tools '<excludeTools>'`
4. Keep `--no-approve` and `-e <pi extension>`. For a role, pass `--no-skills`, then only the role and `factory-shared` `--skill` folders, and drop the `--skill` and `--prompt-template` folders of `claude_resource_flags`. Finding of task 1.4 (2026-10-21, pi 1.3.0): Pi loads `~/.claude/skills` by itself, and that folder has its own `asd-ste100`, so the order of `--skill` flags alone does not pick the shared copy. A launch without a role keeps today's flags.
5. Do not add the role text in `pi-extension.ts` `before_agent_start`. The flag `--append-system-prompt` does this without a code change in the extension.
6. Show the provider and model on the roster pill, so the human sees which agents run on OpenAI.
7. When `OPENAI_API_KEY` is not set and Pi has no stored OpenAI credential, the launch fails. Run `pi auth check --provider openai --json` before the launch and show a clear message.

## Open items found during the research

1. **No review verdict kind.** Verdicts travel as handoffs, because only the assignee can move a claimed ticket. A `review` kind (`pass | fail | approve | changes`, findings, `ticket_id`) would show verdicts on the board. Use the `add-kind` skill.
2. **`attach_ticket_file` is not in the ticket kind `toolNames`** (`hub/kinds/ticket.ts:1013`), so the Briefing does not list it. Check if this is on purpose.
3. **Hard write limit for Pi roles.** Pi has no permission prompts, and `bash` can still write files. See finding 6, item 3.

## Check before you build

1. Your local Claude Code version accepts `--append-system-prompt-file`, more than one `--plugin-dir`, and `--disallowed-tools` in the same command. The research used version 2.1.301. Run `claude --help` on your install.
2. With `--append-system-prompt-file`, the chatbridge mod's prompt section still loads. Launch one agent and ask it to repeat its chatbridge rules.
3. A skill in a role plugin is visible to that agent and not to an agent of another role.
4. Two agents with the same role in different worktrees do not conflict on the staged plugin folder. The agents only read the plugin, so a shared folder must work.

5. The Pi command with `--exclude-tools edit,write` still lists the chatbridge tools (`post`, `send_handoff`, `list_tickets`). Launch a Pi Validator and ask it to list its tools.
6. A converted agent skill loads on demand in Pi. Ask the Validator to look for silent failures and check that it loads `silent-failure-hunter`.

7. **Superseded by check 0.4 (2026-10-21): the hook does not fire.** See finding 7. Original text: a plugin hook loaded through `--plugin-dir` fires for a tool of the chatbridge mod. Use the name `mcp__chatbridge__send_handoff` in the matcher, as the launch command does in `--allowed-tools`.
8. A Claude role launched with `--disallowed-tools Task,Agent` cannot launch a sub-agent. Ask it to launch one and check that the tool is not available.

## Tests

Follow the existing launch-command tests in `src-tauri/src/pty.rs`:
1. No role: the command is the same as today.
2. Role `worker`: the command contains the role plugin, the role prompt file and `--model sonnet`.
3. Role `editor`: the command contains `--model sonnet` and `--disallowed-tools` with `Task` and `Agent`.
4. The builder escapes a quote in a role name, like it does for agent and room names.
5. An unknown role returns an error and launches nothing.
6. Role `validator`: the app uses the Pi harness even when the modal says Claude. The Pi command contains `--provider 'openai-codex'`, `--model`, `--thinking`, `--append-system-prompt`, `--no-skills`, exactly two `--skill` folders (the staged role and `shared` skills), `--exclude-tools 'edit,write,ack_permission'`, no `--skill` or `--prompt-template` folder from `claude_resource_flags`, and does not contain `--tools`.
7. Staging a role writes no `agents/` folder.
8. Staging a Claude role copies `hooks/hooks.json` when the role has one.
8a. The `settings.json` of a role sets `skillOverrides` to `"off"` for a user skill that is not in the role plugin, and `enabledPlugins` to `false` for an installed plugin that is not the role plugin or the shared plugin. In the launched agent, the skill list shows only the skills of the role, the shared plugin and account-synced plugins. The settings do not turn off `chatbridge@inline`, and the agent has the chatbridge tools and sends a handoff.
9. Editor gate: before it accepts, the Reviewer declines a handoff for a file with an ASD-STE100 hard violation, and the findings reach the Editor in the decline reason. The Reviewer accepts and reviews a clean file. `editor.md` tells the Editor to run `ste-lint.py` before each handoff and does not say that a hook enforces it. A break listed as `ste_disable: <rule> at <line>: <reason>` passes; the same rule at an unlisted line is declined.
10. A model override in the modal changes `--model` for that launch only.
11. Shared plugin: every role command loads the staged `shared` folder, and no role plugin contains `asd-ste100`. For a Pi role, the command has `--no-skills` and no inherited `--skill` or `--prompt-template` folder, and the loaded `asd-ste100` path is in the shared folder, not `~/.claude/skills`.
12. User skill layer: a user skill folder replaces the bundled folder of the same name as a whole; deleting it restores the bundled skill; a deleted user-only skill is absent from the next version.
13. Versioned staging: with a running role agent, a restage (reload or app restart) leaves that agent's staged inputs unchanged; a spawn during staging gets a complete version; staging the same inputs twice reuses one `v-<hash>`; no old version is deleted.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
