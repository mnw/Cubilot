## ADDED Requirements

### Requirement: The hub serves the settings the UI reads
The hub SHALL serve, to a human caller, the values that the Tauri commands `get_ui_settings`, `get_human_name`, `get_app_version`, `get_mcp_template`, `resolve_default_room`, `list_roles`, `pty_roles` and `pty_harness` return today, with the same values. The hub SHALL read `config.yml` at each request, so a theme or font scale change shows at the next request without a reload.

#### Scenario: Theme change without reload
- **GIVEN** `config.yml` has `theme: dark`
- **WHEN** the human changes it to `theme: light` and the UI requests the UI settings
- **THEN** the answer has `theme: light`

#### Scenario: Same values as the shell
- **WHEN** the UI requests the human name, the app version, the roles and the harness of agent `w1`
- **THEN** each value equals what the removed Tauri command returned for the same config

### Requirement: The hub does not restage the Claude mod
The hub SHALL NOT restage the Claude mod. When the mod folder is stale, missing or incomplete, the mcp template answers 503. The next Claude spawn in the shell stages the mod again.

#### Scenario: Stale mod folder
- **GIVEN** the mod folder is missing
- **WHEN** the UI requests the mcp template
- **THEN** the answer is 503 and the hub stages no files

### Requirement: The hub serves models, slash commands and skills
The hub SHALL serve the model list of a harness (`claude` at once, `pi` from `pi --list-models` with a time limit), the slash commands of an agent, and the skill switches of an agent (read, set, apply). Only the hub SHALL write `<app data>/factory/agents/<agent>/.skills-off`.

#### Scenario: Unknown harness
- **WHEN** the UI requests the models of harness `foo`
- **THEN** the hub returns 400 `invalid harness: foo`

#### Scenario: Pi does not answer
- **GIVEN** `pi --list-models` does not end within 10 seconds
- **WHEN** the UI requests the models of harness `pi`
- **THEN** the hub ends the process and returns an empty list with a `warning`

#### Scenario: Skill switch set
- **WHEN** the human sets skill `grill-with-docs` off for agent `w1`
- **THEN** `.skills-off` of `w1` holds `grill-with-docs` and the next read lists it as off

### Requirement: Native-only actions show the path in a browser
The hub SHALL serve the paths of the config file, the skills folder, the global MCP config and an agent's working folder. In the desktop window the UI SHALL open them with the shell's native commands. In a browser the UI SHALL show the path with a Copy button and SHALL NOT call a Tauri command.

#### Scenario: Open config in a browser
- **GIVEN** the UI runs in a browser
- **WHEN** the human clicks "Open config"
- **THEN** the UI shows the config path and a Copy button, and no error

### Requirement: Reload in a browser names the restart
`reload_settings` SHALL stay a shell command. In a browser the Reload control SHALL show the text "Restart the hub to apply these settings" and the restart command.

#### Scenario: Reload in a browser
- **WHEN** the human clicks Reload in a browser
- **THEN** the UI shows the restart text and makes no hub request
