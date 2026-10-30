One group for each ticket. Build after Part 20 is merged.

## 1. Retrospective stage role (radius high: launch, read-only worktree)

- [ ] 1.1 `retrospective` in `STAGE_ROLES` and `DEFAULT_ROLE_LIMITS` (1); refused as a ticket role in `hub/kinds/ticket.ts` and as `to_role` in `hub/kinds/handoff.ts`; not in `TICKET_ROLES` of `hub/channel/tools.ts` → verify: `bun test tests/integration/retro-stage.test.ts` (spec scenario "Agent names the role")
- [ ] 1.2 Stage review `retro` with no ticket; `READ_ONLY_ROLES` in `hub/core/worktrees.ts`; detached worktree of the staging head → verify: `bun test tests/integration/retro-stage.test.ts` (spec scenario "Launch": worktree detached and not writable)
- [ ] 1.3 Launch on Claude with `role_models.retrospective`, default opus × high; a Pi value is refused with one log line → verify: `bun test tests/integration/retro-stage.test.ts` (spec scenario "Launch": harness claude, opus, high)
- [ ] 1.4 `retrospective` in the read-only role list of `src-tauri/src/factory.rs` → verify: `cargo test --manifest-path src-tauri/Cargo.toml read_only`

## 2. Role folder and skills (radius low; blocked_by: 1, the app stages a role folder only when the hub knows the role)

- [ ] 2.1 Move `factory/brief/21-retrospective/retrospective/` to `factory/retrospective/`; add `first-message.md` (the evidence file, the previous proposals); add `replaces` to the result schema of `skills/retrospective-review/SKILL.md` (design decision 3) → verify: `cargo test --manifest-path src-tauri/Cargo.toml factory` (the staged folder holds `retrospective.md`, `first-message.md`, `skills/retrospective-review/SKILL.md`)
- [ ] 2.2 Copy the skills of `factory/brief/21-retrospective/README.md`: ECC at one pinned commit, the Agency `workflow-optimizer` as a skill, `agency-testing-test-results-analyzer` and `context-engineering` as the existing copies → verify: `cargo test --manifest-path src-tauri/Cargo.toml factory` (each of the 8 skill folders has a `SKILL.md`)
- [ ] 2.3 `factory/orchestrator/unblocking.md` step 5: replace "open one low draft ticket that removes the cause" with "open one low draft ticket in the request `r-<date>-cause-<topic>` (origin `factory`, the blocked ticket as `source`) that removes the cause"; the ticket title stays a user-story outcome → verify: `rg -n "r-<date>-cause-<topic>" factory/orchestrator/unblocking.md` finds one line in step 5

## 3. Evidence file (radius low)

- [ ] 3.1 `hub/core/retro.ts`: `buildEvidence(db, room, since, until)` with the seven sections; fixed key and list order; no wall-clock time other than the window → verify: `bun test tests/unit/retro-evidence.test.ts` (spec scenario "One week of ledger data": each section holds its input; two builds give the same bytes)
- [ ] 3.2 `improvements` from the `Target measure:` line of `r-*-retro` tickets; a broken line gives `measure: null`; a `done` revert ticket removes its item; done items drop out after 4 windows → verify: `bun test tests/unit/retro-evidence.test.ts` (spec scenario "Week 2 lists week 1 improvements"; cases: broken line, done revert, fifth window)

## 4. Weekly schedule and first message (radius high: launch; blocked_by: 1, same file `hub/kinds/stage.ts`; 3, output `buildEvidence`)

- [ ] 4.1 Stage column `retro_week`, unique partial index on `(room, retro_week)` for review `retro` and status not `cancelled` → verify: `bun test tests/unit/stage-migrate.test.ts` (new cases: twice gives the same schema; a second live row for one room and week is refused)
- [ ] 4.2 The stage sweep creates the stage at its first pass on or after Monday 06:00 local time for each room with a ticket event in the window; it writes the evidence file to `<dir of CUBILOT_LEDGER_DB>/retro/<room>/<iso-week>.json` first → verify: `bun test tests/integration/retro-schedule.test.ts` (spec scenario "Second sweep in the same week"; cases: a room with no ticket event gets no stage; a hub started on Tuesday creates the stage of the current week)
- [ ] 4.3 The first message holds the evidence file and the proposals of the previous retrospective of the room → verify: `bun test tests/integration/retro-schedule.test.ts` (spec scenario "First message")

## 5. Result check (radius low; blocked_by: 4, same file `hub/kinds/stage.ts`, output retrospective stage)

- [ ] 5.1 Schema check in `hub/core/retro.ts` and the result route of the stage: refusals for more than 3 proposals and for a proposal without evidence numbers; a refused result keeps the stage `running` → verify: `bun test tests/integration/retro-result.test.ts` (spec scenarios "Unknown kind", "Four proposals", "Proposal with no evidence numbers")
- [ ] 5.2 Human-gate text check (design decision 2) → verify: `bun test tests/integration/retro-result.test.ts` (spec scenario "Proposal removes a human gate"; a proposal "Add a check before the human Approve" passes)
- [ ] 5.3 `role-file` proposals: `replaces` equals the `files` line at the worktree commit → verify: `bun test tests/integration/retro-result.test.ts` (spec scenario "Role-file proposal without the line it replaces"; a `replaces` that differs from the line is refused)
- [ ] 5.4 One verdict for each `done` item of `improvements` → verify: `bun test tests/integration/retro-result.test.ts` (spec scenario "Week 2 result has a verdict for each improvement")

## 6. Draft tickets and request (radius low; blocked_by: 5, output accepted result)

- [ ] 6.1 Request `r-<date>-retro` (origin `factory`, `source` the stage id, feature `retrospective`), its spec review started as `system`, one draft ticket for each proposal with the `Target measure:` line → verify: `bun test tests/integration/retro-tickets.test.ts` (spec scenarios "Request waits for the Approve", "Accepted proposals"; no ticket is queued)
- [ ] 6.2 One draft ticket `Revert <ticket id>: <title>` for each `revert`; no ticket for `keep`; no request when the result has no proposal and no `revert` → verify: `bun test tests/integration/retro-tickets.test.ts` (spec scenario "Revert verdict"; case: an empty result creates no request)
- [ ] 6.3 Two weeks end to end: week 1 result, its ticket set to `done`, week 2 evidence file and result → verify: `bun test tests/integration/retro-tickets.test.ts` (test "week 2 judges week 1": the week 2 file lists the week 1 ticket with its measure and the accepted result has `keep` or `revert` for it)
