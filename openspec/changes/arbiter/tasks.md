Moved from `human-touchpoints-checkpoint` (Part 6, groups 5 to 7, task 8.3 and task 18.1). Task numbers are the old Part 6 numbers, so that the archived tickets still match. Build only if the measure in `factory/brief/19-arbiter.md` says so.

## 5. Ticket FAIL count and third-review gate (radius high: permissions; blocked_by: 4, same file `hub/kinds/stage.ts`; was group 5 of human-touchpoints-checkpoint)

- [ ] 5.1 `ticketFailState`; `stampResult` writes `fail_count` into ticket review FAILs → verify: `bun test tests/integration/ticket-fail-gate.test.ts` (spec scenario "Two FAILs"; the count resets only after a complete cycle, R1: low radius the Validator PASS, high radius the second-review PASS; a second-review FAIL continues the count)
- [ ] 5.2 Gate in `hub/kinds/handoff.ts` for a role handoff to `validator`/`reviewer` at a count of 2 or more; no Worker stage at that count without a ruling → verify: `bun test tests/integration/ticket-fail-gate.test.ts` (spec scenario "Orchestrator sends a third review"; the human's handoff passes; no handoff, stage or event is written on 409)

## 6. Arbiter stage (radius high: launch, read-only worktree; blocked_by: 5, same files `stage.ts`, `handoff.ts`, output FAIL count; 11, same file `src-tauri/src/factory.rs`; was group 6 of human-touchpoints-checkpoint)

- [ ] 6.1 `arbiter` in `STAGE_ROLES` and `DEFAULT_ROLE_LIMITS` (1); refused as a ticket role and as `to_role`; `READ_ONLY_ROLES` and the `factory.rs` read-only list → verify: `bun test tests/integration/arbiter-stage.test.ts` (spec scenarios "Agent names the role", "Worktree"); `cargo test --manifest-path src-tauri/Cargo.toml read_only`
- [ ] 6.2 Stage column `fail_count`, review `arbiter`, unique partial index → verify: `bun test tests/unit/stage-migrate.test.ts` (new cases: twice gives the same schema; a second arbiter row for one case and count is refused)
- [ ] 6.3 Starts: second ticket FAIL, second spec FAIL (replaces `noticeRepeatedFail`), `POST /tickets/<id>/arbiter` (room lead; `question` in `waiver`, `radius`, `criteria`, `criteria_edit`, `third_review`); the first message lists the criteria edits of the case after the Approve with both texts → verify: `bun test tests/integration/arbiter-stage.test.ts` (spec scenarios "Second ticket FAIL", "Second question at the same count")
- [ ] 6.4 Launch: Claude, `role_models.arbiter` with default opus × high; a Pi value refused with one log line → verify: `bun test tests/integration/arbiter-stage.test.ts` (the launch request has harness claude, opus, high)
- [ ] 6.5 `factory/arbiter/arbiter.md`, `factory/arbiter/first-message.md`; `factory.rs` stages the role and copies `unblocking.md` and `validator.md` into its staged folder; the first message holds the full case → verify: `cargo test --manifest-path src-tauri/Cargo.toml factory`; `bun test tests/integration/arbiter-stage.test.ts` (spec scenario "Case of a second FAIL")

## 7. Rulings applied (radius high: permissions; blocked_by: 6, same file `stage.ts`, output arbiter stage; was group 7 of human-touchpoints-checkpoint)

- [ ] 7.1 Result schema check (option fields, `rule_applied`, `implementation_detail`, `code_refs` checked against the reviewed commit, `meaning_changed` holds only edit event ids of the case) → verify: `bun test tests/integration/arbiter-ruling.test.ts` (spec scenarios "Unknown option", "Missing reference"; a `code_refs` line past the end of the file is refused)
- [ ] 7.2 Application order (`decision.recorded` → ticket note → effect → `decision.applied`), each step idempotent, recovery at start → verify: `bun test tests/integration/arbiter-ruling.test.ts` (spec scenario "Rework"; a crash after each step, then a restart, gives one note, one effect and `applied`)
- [ ] 7.3 Effects for each option and target (design decision 7); the follow-up is a `factory` request with parent and source, its draft ticket and a spec review by `system`; grants and `decision.grant_spent`; the spec FAIL gate and the ticket gate accept a grant → verify: `bun test tests/integration/arbiter-ruling.test.ts` (spec scenarios "Follow-up" (a low follow-up is queued by its spec PASS with no human action; a high one waits for the Approve), "Third spec review", "Arbiter ruling grants the review"; a second review without a new grant gets 409)
- [ ] 7.4 Escalation checks (design decision 9) and a failed arbiter stage open a human decision; Validator findings accept `category: security` → verify: `bun test tests/integration/arbiter-ruling.test.ts` (spec scenarios "Cancel of an approved ticket", "Criteria edit changes the meaning", "Criteria edit keeps the meaning", "Arbiter fails", "Arbiter answer human", "Second FAIL")
- [ ] 7.5 `needsYouRequests` lists a two-FAIL request only when escalated, human or failed; the old two-FAIL list in `ui/features/plan-approval.js` follows → verify: `bun test tests/integration/spec-fail-gate.test.ts` (new cases: spec scenarios "Human review is open", "Ruling applied")

## 8. Delivery report and overrule (was group 8 of human-touchpoints-checkpoint; only task 8.3 is here; blocked_by: 7)

- [ ] 8.3 `POST /decisions/<id>/overrule` (human only) and `GET /rooms/<room>/arbiter-stats`; the report shows overrules → verify: `bun test tests/integration/delivery-report.test.ts` (spec scenario "Overrule"; an agent gets 403)

## 18. Closing (was group 18 of human-touchpoints-checkpoint; only task 18.1 is here)

- [ ] 18.1 Remove the interim rule: `orchestrator.md` item 10 ("Part 6, item 11, interim rule"), `unblocking.md` step 4a, and step 1 "Only the human can allow a third review" (now: "the arbiter rules") → verify: `rg -n -i "interim" factory/orchestrator/orchestrator.md factory/orchestrator/unblocking.md` finds nothing
