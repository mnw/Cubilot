# Skills

## Known limits

### Skills are added per role, not per agent

A skill cannot be added for one agent only. Skills are added per role. Each agent of that role gets the new skill.
The skill switches of an agent can turn role skills off and on, but they cannot add a skill.
An existing agent gets a new role skill only after its own Reload or relaunch.

Workaround: add the skill to the role, then turn it off for each other agent of that role.

1. Add the skill folder at `<app data>/factory-user/<role>/skills/<name>/`. The folder must contain `SKILL.md`.
   The folder name must be the same as the `name` in `SKILL.md`. If they differ, the app skips the folder and writes a line to the log.
   The toolbar button "Open role skills folder" opens `factory-user`.
2. Click Reload settings, or restart the app. The app stages the factory again. The new skill shows in the skill switches of each agent of that role.
   This step does not load the skill in a running agent.
3. For each other agent of that role, uncheck the new skill. Then click Reload or relaunch the agent, as the row tells you.
4. For the intended agent, click Reload or relaunch the agent, as the row tells you. The agent loads the new skill.
5. A new agent of that role starts with all role skills on. Repeat step 3 for each new agent of that role.
   An agent that you start again with the same name keeps its earlier choices.

### Edit only `factory-user`

Edit only the folders in `<app data>/factory-user/`. Never edit `<app data>/factory/agents/<key>` or a generated `.view` folder.

- `factory/agents/<key>` is a link to a staged version. Other agents that use the same version share these files. A change there can change the staged files of those agents.
- The app builds the `.view` folders again. It overwrites your change.
