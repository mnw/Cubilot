# Migration brief: A2AChannel to a new Cubilot repo

Status: approved plan, not begun. Do this before any part of the implementation brief (`brief/00-index.md`).
Date: 2026-10-17. Counts are from the working tree on that date.

## Decisions

| Item | Decision |
|---|---|
| New repo | Folder `~/Workspace/cubilot` and a private GitHub repo `mnw/Cubilot` |
| History | New history: one import commit. The old repo stays as the history archive. |
| Snapshot | The new repo is a copy of the working tree on the day of the migration, with the uncommitted work. Work continues in the old repo and in the installed A2AChannel app. Record the branch and the commit of the snapshot in `MIGRATION.md`. Changes in the old repo after the snapshot go to the new repo by hand. |
| Running app | The migration and the rebrand (Part 1) must not change the state of A2AChannel: its data folder, its hub, its tmux sessions and its settings. |
| Tauri shell (`src-tauri/`) | Carry it over and keep it working, until Part 12 of the implementation brief moves the terminal layer into the hub. |
| Old GitHub repo | Keep `mnw/A2AChannel` active while work continues there. Archive it when the human retires A2AChannel (Part 1, "Retire A2AChannel"). |

## What to carry over

The copy set is the working tree, with the uncommitted changes: `git ls-files -co --exclude-standard`, without `.serena/`, `factory/_to_delete/` and `.DS_Store` files. On 2026-10-19 this is **1233 files** (counted again after the factory changes of that day, which added the SEO and accessibility suites).

It contains:
- `hub/`, `ui/`, `src-tauri/` (without `target/`), `scripts/`, `tests/`, `docs/`, `openspec/`
- the 53 changed files and the 10 new files that are not committed (ticket kind, kanban board, pause, new tests, `review-2026-10-14.md`)
- `CONTEXT.md`, `README.md`, `LICENSE`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `icon.svg`, `.gitignore`

The old `.gitignore` excludes `CLAUDE.md`, `skills-lock.json`, `.claude/` and `.agents/`. The `git ls-files` copy does not include them. Copy `CLAUDE.md`, `skills-lock.json` and `.claude/` (`add-kind` skill, `opsx` commands, settings) separately, in step 2. `.agents/` contains only a `.DS_Store` file: do not copy it. Keep the same `.gitignore` rules in the new repo.
- `factory/` (roles, skills, hooks, licenses, the brief in `brief/`, the archive, this file)

## What to leave behind

| Item | Size | Reason |
|---|---|---|
| `.*.bun-build` files in the repo root | 133 files, 7.9 GB | Old Bun build output. Already in `.gitignore`. |
| `src-tauri/target/` | 9.7 GB | Rust build output |
| `node_modules/` | 289 MB | Install again with `bun install` |
| `dist/` | empty | Build output |
| `src-tauri/resources/tmux`, `src-tauri/binaries/a2a-bin-*` | | Build outputs, in `.gitignore`. Build them again with `scripts/build-tmux.sh` and `scripts/build-sidecars.sh`. |
| `.serena/` | | Local Serena state (implementation brief, Part 7) |
| `factory/_to_delete/` | | Old files that are no longer used |
| `.DS_Store` | | macOS Finder files |

## Steps

1. **Check the copy set.** In `A2A-app`, run `git ls-files -co --exclude-standard`, leave out `.serena/`, `factory/_to_delete/` and `.DS_Store`, and compare the count with 1233. Look at any difference before you continue.
2. **Create the folder and copy.** Create `~/Workspace/cubilot`. Copy the file list with its folder structure, for example: `git ls-files -co --exclude-standard -z | ... | tar --null -T - -cf - | tar -xf - -C ../cubilot`. Then copy the ignored files: `cp -p CLAUDE.md skills-lock.json ../cubilot/` and `rsync -a --exclude .DS_Store .claude ../cubilot/`.
3. **Move the review file.** Move `review-2026-10-14.md` to `docs/reviews/review-2026-10-14.md`.
4. **Add `MIGRATION.md`** in the new repo root. Record:
   - the source repo (`mnw/A2AChannel`), and the branch and commit of the snapshot,
   - that the uncommitted changes are included, with the list of the 53 changed and 10 new files,
   - what was left behind, and why (table above),
   - the date.
   A new history loses the link to the old history. This file keeps it.
5. **First commit.** `git init -b main`. Commit as Michel Wakim, with the attribution lines of the session.
6. **Build and test, but do not launch.** Run `bun install` and `bun test`. Build the tmux and hub binaries with the two build scripts, then build the Tauri app. Do not launch the app, the hub or a bridge from the new repo. Before the rebrand (Part 1), they use the A2AChannel data folder and tmux socket. Before `bun test`, check that the tests use a temporary data folder and not `~/Library/Application Support/A2AChannel`.
7. **Update OpenSpec.** The OpenSpec files in the old repo come from version 1.3.0 (April 2026). The current version is 1.14.3 (checked 2026-10-18). Do this step in a separate commit, after the first commit:
   - Run `npx @fission-ai/openspec@1.14.3 init --tools claude,pi --force` in the new repo root. Pin the version. This replaces the four commands in `.claude/commands/opsx/` (apply, archive, explore, propose). It adds the commands `sync` and `update`, six skills in `.claude/skills/openspec-*`, and the Pi prompts and skills in `.pi/`.
   - Compare `openspec/config.yaml` with the old file. The old file has only template comments, so no project setting is lost.
   - Make sure that `.claude/skills/add-kind/` is not changed.
   - Run `openspec validate --all --no-interactive`. On the old specs, 20 of 22 items pass. The warnings (requirement text longer than 500 characters) do not block.
8. **Fix the two failing OpenSpec changes.** Do this in a separate commit. The human decides for each scenario: keep it or delete it.
   - `architecture-cycle-2a`, `kind-runtime/spec.md`: the MODIFIED requirement "Persistent state-machine kinds implement the `KindModule` contract" does not have the scenario "Registered kind's routes are wired into Bun.serve".
   - `terminal-pane-pty`, `terminal-projection/spec.md`: the MODIFIED requirement is "A2AChannel bundles tmux and orchestrates one session per agent". It does not have two scenarios. These are "New terminal session for a Claude agent" and "No confirm prompt to dismiss".
   - To keep a scenario, copy it into the MODIFIED block. A MODIFIED block replaces the full requirement, so the archive step refuses a block that does not have all the scenarios.
   - Information only: in `v09-rooms-and-controls`, three MODIFIED requirements name headers that are not in the current specs. The validator does not count them as errors, but the archive step refuses them. Fix them before that change is archived.
9. **GitHub.** The human created the private repo `mnw/Cubilot` on 2026-10-21. Description: "Continuous Software Foundry: AI agent teams that build software through tickets, reviews and human approval." Add it as the remote `origin` and push `main`.
10. **Next: the rebrand.** Do Part 1 of the implementation brief directly after the migration. Then launch Cubilot for the first time.
11. **When the human retires A2AChannel** (Part 1, "Retire A2AChannel"):
   - archive `mnw/A2AChannel` on GitHub (read-only, so its links continue to work),
   - add one line to the old README that points to the new repo.

## Not part of the migration

These stay in the implementation brief (`brief/`), and happen in the new repo after the migration:
- the rename to Cubilot in the code, first after the migration (Part 1)
- the new data folder, the new bundle identifier and the new cask (Part 1)
- the Linux changes (Part 12)

The migration copies the code as it is. It changes no code. Steps 7 and 8 change only OpenSpec tool files and spec files.

## Permissions for the agent that does the migration

1. Access to `~/Workspace`, or, narrower: the human creates the empty folder `~/Workspace/cubilot` and connects it.
2. Permission to delete files in the new folder only. Git deletes its own lock files during a commit. Without this permission, commits fail.
3. GitHub: check that the session can push to `mnw/Cubilot`. If it cannot, the human runs `git push -u origin main` in the new folder.

## Checks after the migration

1. The file count in the new repo matches the copy set (1233 files, plus `MIGRATION.md`, with the review file moved).
2. `git status` in the new repo is clean after the first commit.
3. `bun test` passes as it does in the old working tree.
4. The Tauri app builds. Do not launch it. The first launch is after the rebrand (Part 1, order of work, step 4).
5. No file larger than 10 MB is in the commit (`.bun-build` files and build output stay out).
6. `openspec validate --all --no-interactive` shows no errors.
7. A2AChannel still runs, and its data folder did not change.
