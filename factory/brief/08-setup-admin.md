# Part 8: setup and admin screen

Status: decision 2026-10-19. Build it with Part 7. It replaces the separate first-launch Doctor view.

## Goal

One screen makes a clean machine into a working factory. The human selects what to install, sees each step before it runs, agrees, and then watches the steps run. After the setup, the same screen is the admin screen for components, projects, backups and updates. The human does not run commands in a terminal and does not look in several places.

## Rules

1. **Show before you do.** Before any change, the screen shows the plan. The plan lists each step in order, with the exact command, the folder that it changes, and if it needs the administrator password. Nothing runs before the human selects "Install".
2. **One step, one status.** Each step shows `waiting`, `running`, `done`, `failed` or `skipped`, with its output. The full log stays in `<app data>/logs/setup-<date>.log`.
3. **Safe to run again.** A step checks first if its result exists. A finished step is `skipped`. After a restart of the app or the machine, the setup continues from the first step that is not done.
4. **A failure stops only its own step.** A failed step shows the error and two buttons: Retry and Skip. Steps that do not need the failed step continue.
5. **The app data folder first.** Install into `<app data>/` when possible (Part 7). Only these components change the system: Docker or OrbStack, and Tailscale. Their steps say so, and they use the vendor's signed installer.
6. **The app does not handle credentials.** For each sign-in, the app opens a terminal pane that runs the official command (`claude` with `/login`, `pi` with `/login`, `tailscale up`). The human signs in there. The app then checks only the result.

## Flow on a clean machine

### Step 0: choose a new factory or a restore
Two choices:
- **New factory:** go to step 1.
- **Restore from backup:** do the recovery of Part 5 ("Backups and recovery"). Then go to step 4 for the sign-ins, and then to step 6.

### Step 1: components

| Group | Components | Default |
|---|---|---|
| Core | hub and ledger, tmux, factory roles and skills | on. The human cannot turn it off. |
| Code intelligence | uv, ripgrep, fd, Graphify, Serena (versions from `toolchain.lock`) | on |
| Agents | Claude Code (official CLI), Pi (version from `toolchain.lock`) | on |
| Backup | restic, rclone | on |
| Drupal work | Docker or OrbStack, DDEV | off. Select it for Drupal projects. |
| Remote access | Tailscale, browser access (Part 12) | off |
| Accessibility | Accessibility Agents MCP server (Node, Playwright, Chromium, axe-core), Playwright MCP, Figma MCP (Part 9). veraPDF (Java) is optional. | on |
| Extras | jtt (Part 13), Jev decisions (Part 3). Both need an OpenRouter key. | off |

For each component, the screen shows what it does, why the factory needs it, its version, its size, and if it is installed already.

### Step 2: plan and approval
The screen shows the plan for the selected components (rule 1). The human selects "Install", or goes back to step 1.

### Step 3: installation
The steps run with a live status and log (rules 2 to 4).

### Step 4: accounts and secrets
1. **Claude.** The app opens a pane with `claude`. The human signs in with `/login`.
2. **Pi and OpenAI.** The app opens a pane with `pi`. The human signs in with `/login`. The app then runs `pi --list-models` and shows the models. The human selects the model of the Validator and the Reviewer (Part 2, finding 6, item 4).
3. **Backup target.** The human selects the target (Part 5). The app makes a strong backup password and shows it one time. The human must tick "The password is in my password manager" before the setup continues. The app stores the password in the macOS Keychain or the Linux secret store.
4. **Tailscale.** Only when the human selected it in step 1.
5. **OpenRouter key.** Only when the human selected an extra in step 1.

### Step 5: first project
1. Name and stack (the app finds the stack from the project files, Part 13).
2. Client Git URL and credentials. The app stores them only for the delivery clone (Part 5).
3. The app makes the internal repository and copies the client's main branch into it.
4. Project settings: `mutation_mode` (Part 13, default `off`), `ai_disclosure` (Part 5), the backup target for this project (Part 5).
5. The project primer (Part 4, "Context pack"). The app makes a draft from the README and the file tree. The human edits it.
6. The app builds the first graph (Part 7).

### Step 6: checks
The Doctor runs all checks: tools and versions, sign-ins, backup (a first backup runs now), and the project. When all checks pass, the screen shows "Create first room".

## Admin screen after the setup

The same screen has these tabs:

| Tab | Content |
|---|---|
| Components | Add, update or remove a component. The same flow: plan, approval, live status. |
| Accounts | The sign-in state of each account. A button opens the sign-in pane again. |
| Projects | Add a project, or change its settings. |
| Backup | Last result, "Back up now", "Restore test" (Part 5), the target and the snapshot list. |
| Updates | Components that are older than `toolchain.lock`, or a new app version. The same flow: plan, approval, live status. |
| Checks | The Doctor (Part 7). Each failed check has one fix button that uses the same flow. |

## Effect on other parts

- Part 7: the Doctor becomes the Checks tab. The toolchain install runs as steps of this screen.
- Part 13: the project settings `mutation_mode` and `mutation_triage` are in the Projects tab.
- Part 12: on a Linux server, the browser shows this screen. The steps that need the administrator password show the command for the human to run in a terminal, and then check the result.
- Part 5: "Restore from backup" is step 0. The backup target and the project settings are in steps 4 and 5.

## Tests

1. On a clean machine, the first launch shows step 0.
2. No step runs before the human selects "Install" in step 2.
3. A second run of the setup marks the finished steps `skipped`.
4. After a restart during step 3, the setup continues from the first step that is not done.
5. A failed step shows Retry and Skip. The steps that do not need it continue.
6. The app never reads or stores the Claude or OpenAI credentials. It checks only the sign-in result.
7. The setup does not continue after the backup password is shown, until the human ticks that the password is stored.
8. A restore in step 0 skips steps 1 to 3 and step 5, and ends with the checks.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
