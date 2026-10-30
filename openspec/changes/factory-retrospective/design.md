## Context

The brief fixes the loop and the limits. Five points are not in the brief. This file gives the choice for each.

## Decisions

1. **Schedule and window.** The stage sweep creates the stage at its first pass on or after Monday 06:00 hub local time. The window is the 7 days before that Monday 06:00, so the window never depends on the time of the pass. A unique partial index on `(room, retro_week)` for review `retro` allows one stage that is not `cancelled` for each room and ISO week. A hub that was down on Monday creates the stage at its next start. A missed week is not built later.
2. **Human-gate check.** A gate removal is found by text: the hub refuses a proposal whose `title` or `change` has a removal word (`remove`, `drop`, `skip`, `bypass`, `disable`, `auto-approve`, `without`) and a gate word (`approve`, `allow`, `human`, `main`, `security`, `delivery`, `undone`, `irreversible`) in the same sentence. Ceiling: a proposal can avoid the words. The human's Approve of `r-<date>-retro` is the second check. A field in which the model states "no gate" is not used, because the model would grade itself.
3. **The line a role-file proposal replaces.** The schema of the draft skill has no field for it. The hub adds `replaces` (the current text of the line). A `role-file` proposal names one `factory/**/*.md:<line>` in `files`, and `replaces` must equal that line, trimmed, at the commit of the stage worktree.
4. **The Approve.** The request `r-<date>-retro` has origin `factory`, `source` the retrospective stage id, and the feature `retrospective`. The current rule (a factory request with a feature needs the Approve) then applies. No new approval code.
5. **Link from a ticket to its measure.** The criteria of a proposal ticket end with one fixed line, `Target measure: <name> from <now> to <target> (retrospective <stage id>)`. The `improvements` section is built from this line. No new table. A criteria edit that breaks the line puts the ticket in `improvements` with `measure: null`.

## Risks

- The evidence file goes into the first message. A busy week makes a long first message. The `stages` section holds one line for each stage, not the stage results.
