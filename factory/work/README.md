# Work derived from the brief

Each folder here is one OpenSpec change, drafted from one part of the brief (`../brief/`). Copy each folder to `openspec/changes/<name>/`, and run `openspec validate <name> --strict`. Then work through `tasks.md` with `/opsx:apply`.

| Brief part | Change | Status |
|---|---|---|
| Part 1, `01-rebrand.md` | (done without an OpenSpec change) | done |
| Part 2, `02-factory-roles.md` | `openspec/changes/archive/2026-10-22-factory-roles/` | done (archived 2026-10-22) |
| Part 3, `03-ticket-grouping-checkpoints.md` | `openspec/changes/archive/2026-10-23-ticket-grouping/` | done (archived 2026-10-23) |
| Part 4, `04-sessions.md` | `openspec/changes/archive/2026-10-27-stage-sessions/` | done (archived 2026-10-27) |
| Part 4, `04-sessions.md` | `openspec/changes/archive/2026-10-27-spec-review-stage/` | done (archived 2026-10-27) |
| Part 4, `04-sessions.md` | `openspec/changes/archive/` (context-pack) | done (archived 2026-10-28, live check 7.1 passed) |
| Part 4a, `04a-agent-column.md` | (built from the brief's tickets, no OpenSpec change) | done 2026-10-26 (`4ec238f`). Built so that Part 4 can be tested. |
| Part 15, `15-ticket-card-dialog.md` | (built from the brief's tickets, no OpenSpec change) | done 2026-10-26 |
| Part 6, `06-warp-patterns.md` | `human-touchpoints-checkpoint` (items 11 and 7) in planning | next. Order inside the part: 11 and 7, then 8, 9, 10, 6, 1-5. Before Part 12 and Part 5. |
| Part 5, `05-delivery-backup.md` | not proposed yet | after Parts 6, 12 and 14 |

Rules:
- The brief keeps the research and the reasons. The change keeps the work. Do not copy the research into the change. Link to the brief.
- Each task is one ticket for one session: one clear result, and a `verify:` line that says how to check it.
- When a task changes a decision of the brief, change the brief first.

## Tickets from the old OpenSpec changes

On 2026-10-21, nine shipped changes went to `openspec/changes/archive/`, and their requirements went into the main specs. Their open tasks were old release steps, manual checks and a few gaps. These are the tickets that remain:

1. **Test the cross-room permission verdict.** The code refuses it (`hub/kinds/permission.ts`, "cross-room verdict not permitted"), but no test covers it. Add an integration test: a verdict from an agent in another room gets 403, and the request stays pending.
2. **Test concurrent appends at a transcript rotation.** Send 50 `appendEntry` calls across the rotation boundary. No entry is lost or written twice, and exactly one rotation occurs.
3. **Smoke test of the Cubilot build.** Do one manual checklist on the installed build. Check the terminal pane: a permission prompt, an external kill, and chat while the pane is open. Check the handoff and interrupt cards, attachments, slash commands to two agents, a narrow window, and the console (no errors). Record the results in the ticket.
4. **Review the main specs against the code** (`[spec]` ticket: Writer, then Validator). Parts of the main specs still have text from April. Example: the briefing in the code also has `kind_lines` and `room_summary`, and `agent-onboarding` does not describe them. Fix the specs, not the code.
5. **Optional, cosmetic.** These items are small UI changes:
   - The composer placeholder shows the room. The composer is off in the "All" view.
   - A Nutshell strip for each room.
   - A longer tooltip for pause.
   - A toast with the count after a bulk pause.

The two changes that never started are in `../backlog/`.
