# Part 5: internal remote, clean delivery, backups and recovery

Status: decision 2026-10-19. Build it after Part 4.

## Goal

The client has its own Git remote and its own ticket system. The factory process must not show in them: no agent commits, no fix loops, no internal ticket names, no factory files. The client gets clean merge requests that refer to the client's tickets.

## Where the code is stored

Before you use any hosted service as the internal remote (for example GitHub), read the client contract. A copy of the client's code on a third-party service can break a contract for EU institutional work, also when the repository is private. The default is a remote that you control:
- **Decision (2026-10-19): bare Git repositories in the app data folder** (`<app data>/repos/<project>.git`). They are part of the one folder that the backup protects ("Backups and recovery"). The dashboard (Part 11) shows the tickets and their branches, so no web view is necessary.
- Forgejo, with a web view, is an option for later. When you add it, keep its data in the app data folder too.

The factory does not need GitHub issues or GitHub Actions. The hub has the tickets (Part 2, Part 3, Part 4).

## Layout: three places, two clones

| Place | Remotes | Who uses it | Content |
|---|---|---|---|
| Internal repository (`<app data>/repos/<project>.git`) | none (it is the internal remote) | the hub, the agents through the factory clone, the delivery clone | `main`: a copy of the client's main branch. `ticket/*`: the agents' work. |
| Factory clone | `internal` only | the agents, in one worktree for each ticket stage (Part 4) | the ticket branches |
| Delivery clone | `client` and `internal` | the human, or the Deliver step that the human runs | clean delivery branches |

Rules:
1. The factory clone has no `client` remote. The agents do not get the client URL or the client credentials.
2. The hub updates `main` in the internal repository on a schedule: in the delivery clone, it runs `git fetch client` and pushes the client's main branch to `internal`. Only the delivery clone keeps client credentials.
3. Only the delivery clone pushes to the client.
4. Changes from the client come to the factory only through the scheduled update of internal `main`.

## Branch lifecycle

1. A `[code]` or `[doc]` ticket that changes files gets one branch, `ticket/<ticket_id>`. The hub creates the branch from internal `main` when it launches the first Worker or Writer session of the ticket (Part 4, item 3). The agent does not create branches.
2. Only tickets in work have a branch. A `draft`, `queued` or blocked ticket has no branch. With a limit of 3 Workers, at most 3 code branches are in work at the same time.
3. All stages of a ticket use the same branch. The Tester and the Validator get a temporary worktree at the commit of the handoff. A fix loop adds commits to the same branch.
4. A ticket in `blocked_by` must be merged into internal `main` first. The hub then creates the branch of the blocked ticket from the new `main`.
5. After the final PASS, the hub rebases the branch on internal `main` and launches a Tester session for the test suite. When the tests pass, the hub merges the branch into internal `main`. When the rebase has a conflict, the hub launches a short Worker session to fix the conflict. Then the Tester runs again.
6. Tickets with no file change (a spec review, research) get no branch.
7. The hub removes the worktree when each session closes. It removes `ticket/<ticket_id>` after the client merges the delivery that contains it.

## The Deliver step

The human runs it from the UI, for one client ticket. A ticket uses `external_ref` to point to the client ticket. One client ticket can have one or more factory tickets.

1. In the delivery clone, run `git fetch` for the client's main branch and for the factory branches of the client ticket in the internal repository.
2. Create a branch from the client's main branch. Use the client's branch name rule, for example `feature/<client ticket>-<slug>`.
3. Apply the change as one commit, or as a small number of commits when the client wants them. The author is the human. The message uses the client's format and the client ticket ID.
4. Run the leak gate (next section). When it fails, stop and show the findings.
5. Show the diff and the commit message to the human. Push only after the human approves.
6. Push to the client and open the merge request with the client's template. Write a short summary for the client ticket. The human posts it, or a narrow tool posts only this summary.

## Leak gate

A script, `factory/delivery/leak-gate.py`. It fails (exit 1) when:
- the diff adds or changes a factory path: `.claude/`, `CLAUDE.md`, `.pi/`, `graphify-out/`, `.serena/`, `test-reports/`, `factory/`, `specs/` when the client does not use it, `review.json`.
- a commit message or branch name contains a factory term: `ticket/`, `worker-`, `tester-`, `validator`, `Co-Authored-By`, `Claude-Session`, internal ticket ids.
- the author or committer is not the human.
- the diff adds a line to `.gitignore` for a factory path.

Keep factory paths out of the client repository with `.git/info/exclude` in each clone. Do not add them to the project `.gitignore`, because that line shows in the client repository.

The patterns are in `factory/delivery/leak-patterns.txt`, so that each project can add its own.

## Disclosure

Some contracts and client policies require that you tell the client about AI-assisted development. The Deliver step does not remove a disclosure that a contract requires. Add a project setting `ai_disclosure: none | mr_note | commit_trailer`. The Deliver step writes the disclosure in the place that the setting names. Check the contract of each client before the first delivery.

## Effect on other parts

- Part 7: the factory clone and its worktrees replace the per-agent worktrees that the human creates. The delivery clone needs no toolchain.
- Part 11: show the delivery status of each client ticket: not delivered, delivered (merge request open), merged.
- Part 12: the internal repositories are in the app data folder on the same machine as the hub.
- Part 4: item 3 (launch) creates the branch and the worktree. Item 6 (end) merges into internal `main` after the final PASS.

## Tests

1. The factory clone has no `client` remote. A `git push client` in a worktree fails.
2. The hub creates `ticket/<id>` when the first Worker session launches, and not before.
3. A blocked ticket gets its branch only after the blocking ticket is in internal `main`.
4. The leak gate fails for a diff that adds `CLAUDE.md`, for a commit message with `Co-Authored-By`, and for a `.gitignore` line with `.claude/`. It passes for a clean diff.
5. The Deliver step does not push before the human approves.
6. A client change to the delivery branch comes back to internal `main` with the scheduled update.
7. With `ai_disclosure: mr_note`, the merge request text contains the disclosure.

## Backups and recovery (decision 2026-10-19)

Rule: **the whole factory is one folder, and the app backs up and restores that folder itself.** Recovery has three steps. The human does not look in many places or run many commands.

### One folder

```text
<app data>/
├── ledger.db       tickets, handoffs, verdicts, notes, settings (SQLite)
├── transcripts/
├── attachments/
├── config.yml
├── repos/          internal Git repositories, one bare repository for each client project
└── projects/       project settings: backup target, ai_disclosure, mutation_mode
```

Not in the backup, because the app makes them again: the toolchain (Part 7), Docker images, Drupal databases, worktrees, the delivery clones, `snapshots/`. Credentials are not in the backup.

### One tool, one target

1. **Tool.** The app bundles restic, like rg and fd (Part 7, `toolchain.lock`).
2. **Target.** The human selects one target in the settings: a Hetzner Storage Box (SFTP), or a OneDrive or Google Drive business account (through rclone, also bundled). Do not put the app data folder in a synced folder. Sync clients corrupt a live SQLite database and Git repositories.
3. **Encryption.** restic encrypts the backup before it leaves the machine. The password is in the macOS Keychain or the Linux secret store, and in the human's password manager. It is never in the backup and never in the agents' environment.
4. **Schedule.** Each hour, the app:
   1. writes a clean snapshot of the ledger with `VACUUM INTO` (never a copy of the live file and its `-wal` file),
   2. runs `restic backup` of the folder, with the snapshot in place of `ledger.db`,
   3. runs `restic forget` with a policy of 48 hourly, 14 daily and 8 weekly snapshots.
5. **Status.** The Doctor screen (Part 7) shows the time and the result of the last backup. It shows a red warning when a backup fails, or when the last good backup is older than 24 hours.
6. **No access for agents.** The agents' sessions do not get the restic password or the target credentials.

### Recovery: three steps

1. Install the app on a Mac or a Linux machine.
2. Select "Restore from backup". Enter the target and the password (both from the password manager).
3. Sign in to Claude, Pi and Tailscale.

Then the app does these steps without the human:
1. It restores the latest snapshot to the app data folder.
2. It installs the toolchain (Part 7).
3. It makes the worktrees again for the tickets that are in work, from the internal repositories.
4. It opens the rooms in the state of the snapshot.

The human keeps only two things safe: the backup password, and the target address with its login.

### Later options

- **Second copy.** One setting copies the same snapshots to a second target with `restic copy`, for example a Storage Box and a OneDrive account.
- **Append-only target.** A Storage Box account with append-only access, so that a compromised machine cannot remove old snapshots.
- **Restore test.** A Doctor action that restores the latest snapshot into a temporary folder and checks the ledger with `PRAGMA integrity_check`. Run it each month.

### Tests

1. The hourly backup writes a ledger snapshot with `VACUUM INTO` and does not read the live `ledger.db`.
2. A restore on an empty machine gives the same tickets, notes and internal branches as the source.
3. The backup does not contain the toolchain, worktrees, Docker data or credentials.
4. The Doctor shows a red warning when the last good backup is older than 24 hours.
5. An agent session has no restic password and no target credentials in its environment.
6. After a restore, the app makes the worktrees again for the tickets that are in work.

---

Index: [00-index.md](00-index.md). This part is one file of the implementation brief. "Part N" means file `NN-*.md` in this folder.
