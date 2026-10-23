# factory-roles Specification

## Purpose
TBD - created by archiving change factory-roles. Update Purpose after archive.

## Requirements

### Requirement: An agent can be launched with a factory role

The app SHALL accept an optional role when it launches an agent. With a role, the launch command SHALL use the harness chosen at launch, and the role's instructions, skills and the tool limits for that harness from the role file. The role's harness SHALL be the default choice only. The role's model SHALL apply only on the role's harness; on the other harness the launch SHALL need a chosen model. Without a role, the launch command SHALL be the same as before this change. An unknown role SHALL be an error, and the app SHALL launch nothing.

#### Scenario: Launch without a role is unchanged

- **WHEN** the human launches an agent with the role "None"
- **THEN** the launch command is the same as before this change

#### Scenario: Claude role

- **WHEN** the human launches `worker-1` with the role `worker`
- **THEN** the command contains the role plugin directory, the role prompt file, the role settings file and `--model sonnet`
- **AND** the command blocks the `Task` and `Agent` tools

#### Scenario: Pi role on its own harness

- **WHEN** the human launches `validator` with the role `validator` and the harness Pi
- **THEN** the app launches Pi with `--provider openai-codex`, the role model, `--thinking`, the role prompt, the role skills and `--exclude-tools` containing `edit,write`
- **AND** the command does not contain `--tools`

#### Scenario: Role on the other harness

- **WHEN** the human launches `validator` with the role `validator`, the harness Claude Code and the cell opus × high
- **THEN** the app launches Claude Code with the role plugin, `--model opus --effort high`, and `--disallowed-tools` containing `Edit`, `Write`, `NotebookEdit`, `Task` and `Agent`

#### Scenario: Other harness with no chosen model

- **WHEN** the human launches `worker` with the harness Pi and no chosen cell
- **THEN** the app shows an error and launches no agent

#### Scenario: Unknown role

- **WHEN** the human launches an agent with a role that is not staged
- **THEN** the app shows an error and launches no agent

### Requirement: A role agent sees only its own skills

The app SHALL stage each role as a plugin with skills and hooks only. For each Claude role, the app SHALL turn off every installed and `--plugin-dir` plugin that is not the role plugin or the shared plugin, with `enabledPlugins`, and every user and project skill outside them, with `skillOverrides`. The app SHALL NOT turn off the chatbridge mod. Skills of account-synced plugins MAY stay visible, because no launch setting turns them off. A Pi role SHALL get only the skill folders of its role and the shared skills.

#### Scenario: Personal skills are hidden

- **GIVEN** the human has personal and plugin skills outside the factory
- **WHEN** an agent with the role `tester` starts
- **THEN** its skill listing contains only the skills of the `tester` plugin, the shared plugin and account-synced plugins

#### Scenario: Plugins outside the role are turned off

- **GIVEN** the human has an installed marketplace plugin that is not in the factory
- **WHEN** an agent with the role `tester` starts
- **THEN** the role settings file sets that plugin to `false` in `enabledPlugins`
- **AND** the plugin's skills are not in the agent's skill listing

#### Scenario: The chatbridge mod stays on

- **WHEN** an agent with a Claude role starts
- **THEN** the role settings file does not turn off `chatbridge@inline`
- **AND** the agent has the `mcp__chatbridge__*` tools and can send a handoff

#### Scenario: No sub-agent folder

- **WHEN** the app stages a role
- **THEN** the staged plugin contains no `agents/` folder

### Requirement: Role agents work without permission prompts for chatbridge coordination

An agent with a role SHALL have the handoff, interrupt and ticket tools pre-allowed. An agent with a role SHALL NOT be able to call `ack_permission`: a Claude role SHALL get `mcp__chatbridge__ack_permission` in `--disallowed-tools` and SHALL NOT get it in `--allowed-tools`; a Pi role SHALL get `ack_permission` in `--exclude-tools`. Blocking the tool SHALL NOT change how the human resolves a permission request.

#### Scenario: Worker coordinates without prompts

- **WHEN** a `worker` agent sends a handoff and creates a ticket
- **THEN** no permission prompt appears

#### Scenario: A Claude role cannot answer a permission request

- **WHEN** a Claude role agent tries to call `ack_permission`
- **THEN** the call is refused

#### Scenario: A Pi role cannot answer a permission request

- **WHEN** a Pi role agent lists its tools
- **THEN** the list does not contain `ack_permission`

#### Scenario: The human still resolves permission requests

- **WHEN** a role agent's tool call opens a permission request
- **THEN** the human can resolve it from the card in the UI
- **AND** the human can resolve it from the agent's terminal

### Requirement: The Reviewer refuses a document that fails the ASD-STE100 linter

The Reviewer role SHALL run `ste-lint.py` on the handed-in document before it accepts the handoff. When the linter reports a hard violation, the Reviewer SHALL decline the handoff and give the findings. The Editor role text SHALL tell the Editor to run `ste-lint.py` before each handoff. A deliberate break SHALL be listed by the Editor in `change_summary` as one line `ste_disable: <rule> at <line>: <reason>`. The Reviewer SHALL accept only when the linter with `--disable` for the listed rules exits 0 and every hit of a listed rule in a run without `--disable` is at a listed line. The Reviewer SHALL judge each listed reason in the review. No hook enforces this rule, because plugin hooks do not run for chatbridge tools.

#### Scenario: A document with a hard violation is declined

- **WHEN** the Editor hands a document with an ASD-STE100 hard violation to the Reviewer
- **THEN** the Reviewer declines the handoff without accepting it first
- **AND** the decline reason contains the linter findings

#### Scenario: A clean document is reviewed

- **WHEN** the Editor hands a document that passes the linter to the Reviewer
- **THEN** the Reviewer accepts the handoff and reviews the document

### Requirement: Every role loads the shared plugin

The app SHALL stage `factory/shared` as the plugin `factory-shared` and SHALL load it for every role: with `--plugin-dir` for a Claude role and with `--skill` for a Pi role. The `asd-ste100` skill SHALL exist only in the shared plugin.

#### Scenario: A role agent has asd-ste100

- **WHEN** an agent with any role starts
- **THEN** its skill listing contains `asd-ste100` from the shared plugin

### Requirement: The user can add or replace a role skill

The app SHALL stage the skills in `<app data>/factory-user/<role>/skills/` on top of the bundled skills of that role. A user skill folder SHALL replace the bundled skill folder with the same folder name as a whole. The app SHALL copy each bundled skill into `factory-user/<role>/skills/<name>/` when that folder does not exist, with a `.cubilot-seed` file that holds the hash of the copied content. The copy SHALL appear whole or not at all (temp folder, then rename). The app SHALL NOT change or delete an existing skill folder in `factory-user/`. The app SHALL NOT stage a `.cubilot-seed` file. The title bar SHALL have a button that opens `factory-user/` in Finder. The app SHALL stage each change into a new version folder and SHALL point the link `factory/active` at it. It SHALL NOT change the staged inputs of a published version, and it SHALL NOT delete a version in this change. After a new version, each running role agent SHALL reload its skills once: at once when idle, and at the end of its run when busy. A run that starts while the reload request is pending MAY see changed files. An agent with no role, or launched before this change, SHALL NOT reload.

#### Scenario: A user skill replaces a bundled skill

- **GIVEN** `factory-user/tester/skills/<name>/SKILL.md` exists and the bundled `tester` role has a skill with the same name
- **WHEN** the app stages the roles
- **THEN** the staged `tester` plugin contains the user's skill

#### Scenario: The provided skills are in the user folder

- **WHEN** the app starts for the first time
- **THEN** `factory-user/tester/skills/` contains each bundled `tester` skill and its `.cubilot-seed` file

#### Scenario: An app update never changes a copy

- **GIVEN** the user changed one seeded copy and did not change another
- **WHEN** a new app version has changed bundled copies of both skills
- **THEN** both copies stay the same
- **AND** the app logs one line for the unchanged copy that tells the user to delete the folder to get the new version

#### Scenario: Removing the user skill restores the bundled one

- **WHEN** the user deletes the skill from `factory-user/tester/skills/` and the app stages the roles again
- **THEN** the staged `tester` plugin contains the bundled skill

#### Scenario: Open the skills folder

- **WHEN** the human clicks the skills folder button in the title bar
- **THEN** Finder opens `<app data>/factory-user/`

#### Scenario: Restage while a role agent runs

- **GIVEN** an agent with a role runs
- **WHEN** the app stages the roles again, after a reload or an app restart
- **THEN** the old version folder does not change
- **AND** the link `factory/active` names the new version
- **AND** the next agent of that role uses the new version

#### Scenario: An idle running agent gets a changed skill at once

- **GIVEN** an idle agent with a role runs, on Claude Code or on Pi
- **AND** the user changed a skill of that role
- **WHEN** the human uses Reload settings
- **THEN** the agent reloads its skills once, with no model turn
- **AND** its next use of the skill reads the changed text

#### Scenario: A busy running agent is not interrupted

- **GIVEN** an agent with a role is in a run
- **WHEN** the human uses Reload settings after a skill change
- **THEN** the run continues with the old skills
- **AND** the agent reloads once, after the run ends
- **AND** only a new run that starts while the reload request is pending can see changed files (accepted limit)

#### Scenario: A Claude agent keeps its role text

- **GIVEN** a Claude Code agent with a role runs
- **WHEN** the role text changes and the agent reloads
- **THEN** the agent gets the changed skills
- **AND** it keeps the role text from its launch until it is started again

#### Scenario: A listed deliberate break is accepted

- **GIVEN** the document has a `present-perfect` hit at line 12
- **AND** `change_summary` has `ste_disable: present-perfect at 12: <reason>`
- **WHEN** the Editor hands the document to the Reviewer
- **THEN** the Reviewer accepts the handoff and judges the reason in the review

#### Scenario: A break at an unlisted line is declined

- **GIVEN** `change_summary` lists `present-perfect at 12`
- **AND** the document also has a `present-perfect` hit at line 30
- **WHEN** the Editor hands the document to the Reviewer
- **THEN** the Reviewer declines the handoff and names line 30

### Requirement: The human picks the model and the effort for one launch

The spawn modal SHALL show a model × effort grid. The rows SHALL be the models of the selected harness: the Claude models for Claude Code, and for Pi all models that `pi --list-models` reports, with a filter box; a provider that is not signed in SHALL be marked. The columns SHALL be the effort levels of that harness. The role's default cell SHALL be marked. A choice SHALL apply to one launch only.

#### Scenario: A Claude role with a chosen cell

- **WHEN** the human picks opus × high for a `worker` launch
- **THEN** the command has `--model opus --effort high`

#### Scenario: A Pi role with a chosen cell

- **WHEN** the human picks gpt-5.6-terra × medium for a `validator` launch
- **THEN** the command has `--model gpt-5.6-terra --thinking medium`

#### Scenario: The default cell adds nothing

- **WHEN** the human keeps the role's default cell
- **THEN** the command is the same as a launch without a choice

#### Scenario: Other harness has no default cell

- **WHEN** the human selects the role `worker` and then the harness Pi
- **THEN** the grid marks no default cell and Launch stays off until the human picks a cell

### Requirement: The human picks the orchestrator's harness and model for a new factory room

The New factory room window SHALL show the harness choice and the model × effort grid of the spawn modal, with the same rules. The default SHALL be the `orchestrator` role default.

#### Scenario: Factory room on Pi

- **WHEN** the human creates a factory room with the harness Pi and the cell gpt-5.6-sol [openai-codex] × high
- **THEN** the orchestrator launches on Pi with `--provider openai-codex --model gpt-5.6-sol --thinking high`

#### Scenario: Factory room with the defaults

- **WHEN** the human creates a factory room with no change to the harness or the grid
- **THEN** the orchestrator launches on Claude Code with `--model opus`
