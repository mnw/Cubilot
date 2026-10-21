## ADDED Requirements

### Requirement: An agent can be launched with a factory role

The app SHALL accept an optional role when it launches an agent. With a role, the launch command SHALL use the role's harness, model, instructions, skills and tool limits from the role file. Without a role, the launch command SHALL be the same as before this change. An unknown role SHALL be an error, and the app SHALL launch nothing.

#### Scenario: Launch without a role is unchanged

- **WHEN** the human launches an agent with the role "None"
- **THEN** the launch command is the same as before this change

#### Scenario: Claude role

- **WHEN** the human launches `worker-1` with the role `worker`
- **THEN** the command contains the role plugin directory, the role prompt file, the role settings file and `--model sonnet`
- **AND** the command blocks the `Task` and `Agent` tools

#### Scenario: Pi role overrides the harness choice

- **GIVEN** the spawn modal is set to Claude Code
- **WHEN** the human launches `validator` with the role `validator`
- **THEN** the app launches Pi with `--provider openai`, the role model, `--thinking`, the role prompt, the role skills and `--exclude-tools edit,write`
- **AND** the command does not contain `--tools`

#### Scenario: Unknown role

- **WHEN** the human launches an agent with a role that is not staged
- **THEN** the app shows an error and launches no agent

### Requirement: A role agent sees only its own skills

The app SHALL stage each role as a plugin with skills and hooks only. For each Claude role, the app SHALL turn off every skill that is not in the role plugin or the shared plugin. A Pi role SHALL get only the skill folders of its role and the shared skills.

#### Scenario: Personal skills are hidden

- **GIVEN** the human has personal and plugin skills outside the factory
- **WHEN** an agent with the role `tester` starts
- **THEN** its skill listing contains only the skills of the `tester` plugin and the shared plugin

#### Scenario: No sub-agent folder

- **WHEN** the app stages a role
- **THEN** the staged plugin contains no `agents/` folder

### Requirement: Role agents work without permission prompts for chatbridge coordination

An agent with a role SHALL have the handoff, interrupt and ticket tools pre-allowed. The app SHALL NOT pre-allow `ack_permission` for any role.

#### Scenario: Worker coordinates without prompts

- **WHEN** a `worker` agent sends a handoff and creates a ticket
- **THEN** no permission prompt appears

#### Scenario: Permission answers stay with the human

- **WHEN** a role agent calls `ack_permission`
- **THEN** the human must approve the call
