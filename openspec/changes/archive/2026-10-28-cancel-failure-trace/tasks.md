## 1. Hub

- [x] 1.1 `hub/kinds/cancel-trace.ts`: Kind, decl, key, `record`, `clear`, routes → verify: `bun test tests/unit/cancel-trace.test.ts tests/integration/cancel-trace-routes.test.ts`
- [x] 1.2 `hub/kinds/stage.ts`: `traceFailure` hook and `caller` in both `catch` blocks; `hub/kinds/index.ts` wires the Kind → verify: scenarios (a)-(e)
- [x] 1.3 Migration through the Store → verify: `bun test tests/unit/cancel-trace-migrate.test.ts`

## 2. UI

- [x] 2.1 `ui/features/plan-approval.js`: one line per open row, Clear, focus, refresh on `stage.*` and `cancel_trace.*` → verify: `bun test tests/unit/plan-approval.test.ts` (observer list)
- [x] 2.2 Orchestrator browser check before the install: load, line text, Clear, focus, a failed Clear keeps the line (done: Orchestrator browser re-check of t_3186bc4426ddc3ab at commit 90cdf63, PASS, 2026-10-28 before install 28, test hub with seeded traces; covered: load, line text, "no ticket", markup shown as text, Clear, focus, failed Clear (404) keeps the line and shows a message; merged in staging b18220e, installed in install 28 (982fed3))
- [ ] 2.3 Human VoiceOver check (unimplemented: deferred (human decision 2026-10-28, Part 14 rule 6a))

## 3. Docs

- [x] 3.1 `docs/PROTOCOL.md`: the `cancel_trace` kind, events, routes
- [x] 3.2 `openspec/changes/stage-diagnosis/tasks.md:3` names `t_3186bc4426ddc3ab` as a group-8 blocker → verify: `rg -n t_3186bc4426ddc3ab openspec/changes/stage-diagnosis/tasks.md`
