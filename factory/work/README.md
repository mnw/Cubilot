# Work derived from the brief

Each folder here is one OpenSpec change, drafted from one part of the brief (`../brief/`). Copy each folder to `openspec/changes/<name>/`, and run `openspec validate <name> --strict`. Then work through `tasks.md` with `/opsx:apply`.

| Brief part | Change | Status |
|---|---|---|
| Part 1, `01-rebrand.md` | (done without an OpenSpec change) | done |
| Part 2, `02-factory-roles.md` | `factory-roles/` | draft |

Rules:
- The brief keeps the research and the reasons. The change keeps the work. Do not copy the research into the change. Link to the brief.
- Each task is one ticket for one session: one clear result, and a `verify:` line that says how to check it.
- When a task changes a decision of the brief, change the brief first.

## Open from the migration

Two OpenSpec changes fail validation. Fix them in a separate commit. The human decides for each scenario: keep it or delete it.
- `architecture-cycle-2a`, `kind-runtime/spec.md`: the MODIFIED requirement "Persistent state-machine kinds implement the `KindModule` contract" does not have the scenario "Registered kind's routes are wired into Bun.serve". The change has the scenario "…wired through the dispatcher" in its place.
- `terminal-pane-pty`, `terminal-projection/spec.md`: the MODIFIED requirement is "Cubilot bundles tmux and orchestrates one session per agent". It does not have two scenarios: "New terminal session for a Claude agent" and "No confirm prompt to dismiss".
- To keep a scenario, copy it into the MODIFIED block. To drop a scenario that the change renamed, delete it from the main spec in `openspec/specs/`.
- Information only: `v09-rooms-and-controls` and `permission-relay` have MODIFIED headers that are not in the current specs. The archive step refuses them. Fix them before these changes are archived.
