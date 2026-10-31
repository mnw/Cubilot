# Unblocking

Read this file when work stops: a free slot with no ticket ready, a ticket without movement, the hub refuses a move (403 or 409), or a stage cannot start. The flow is `factory/brief/18-lean-flow.md`. The history of earlier blocks is in Part 18 and in git history of this file.

## Procedure

### 1. Keep the rest moving

A ticket that waits or fails stops only itself. Start every other ticket that can run. Never hold a free slot for a ticket that waits.

### 2. Sort the problem

- **Mechanical** (a command can check it: a test, a grep, a count): fix it in the ticket and continue. The check is the command output.
- **Implementation detail** (a value, a limit, an order, an API choice): the Worker decides with evidence from the code; the Validator checks it. Do not rule on it yourself.
- **A FAIL loop:** after two FAILs on one ticket, park it on the list for the human with the facts. Continue with the rest.
- **Decision you can undo, inside the scope:** decide. Write "Ruling (Orchestrator): <option>, because <reason>" as a ticket note. The delivery report lists the rulings.

### 3. Check facts against the repository

- A ticket is merged only if its commit is on staging. Name the hash.
- A cause is proven only if a test or a trace reproduces it.

### 4. Ask the human (scope, feature, an action that cannot be undone, a security finding with no fix in scope, or a hub refusal only the human can clear)

One message:
1. **Block:** one sentence. What stops, since when.
2. **Facts:** numbered, each one checked (step 3).
3. **Options:** A, B (and C), each with its effect. Mark your recommendation.
4. **Human actions:** each with the full ticket id and the exact action or command.
5. **What you do next** after the answer.

### 5. Remove the cause

When the work moves again, ask: will this block come back? If yes, open one low draft ticket in the request `r-<date>-cause-<topic>` (origin `factory`, the blocked ticket as `source`) that removes the cause in code (a check, a fix) or replaces a line in a role file. The ticket title stays a user-story outcome. Name the block and its evidence. The weekly retrospective (Part 21) reviews these tickets.

## Checks before you queue

- The role of each ticket runs on the hub.
- Each `blocked_by` names the code the ticket needs from the other ticket. A shared file, order or caution is not a reason.
- Count the tickets that can start now against the free worker slots.
- A ticket that adds persistent state uses a Kind. Read the `add-kind` skill and `openspec/specs/kind-runtime/spec.md` first, and name the Kind in the criteria.
- An archive ticket: validate each changed spec alone (`npx @fission-ai/openspec@1.14.3 validate <spec> --type spec --strict`), never the global `validate --specs --strict`. The Worker replaces a placeholder Purpose "TBD - created by archiving ..." with 1 or 2 sentences from the "Why" of the proposal.

## Commands for the human

The hub accepts these moves from the human. Give the command when the board is slow to use. The human runs it in Terminal on the Mac.

The command is the app binary: `/Applications/Cubilot.app/Contents/MacOS/cubilot hub <METHOD> <path> [json-body]`. It reads the human token from the Keychain (item "Cubilot" / "human-token") after Touch ID. Add this line to `~/.zshrc` once, so that `cubilot` works: `export PATH="/Applications/Cubilot.app/Contents/MacOS:$PATH"`. The command prints the HTTP status and the body.

```bash
D="$HOME/Library/Application Support/Cubilot"
N=$(awk -F': *' '/^human_name:/{gsub(/["'\'']/,"",$2);print $2}' "$D/config.yml"); N=${N:-human}
# Queue one ticket:
cubilot hub POST /tickets/<ticket id>/transition "{\"by\":\"$N\",\"to\":\"queued\"}"
# Change the blast radius:
cubilot hub POST /tickets/<ticket id>/edit "{\"by\":\"$N\",\"blast_radius\":\"high\"}"
```

A read-only Validator or Reviewer worktree: `chmod -R u+w <folder>`, then `git worktree remove --force <folder>`.
