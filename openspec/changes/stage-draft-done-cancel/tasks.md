## 1. Hub

- [x] 1.1 `StageHooks.onTicketParked(ticketId, to, cap)` and `cancelQueuedStagesOfTicket` in `hub/kinds/stage.ts`; only `queued` stages move, reason `ticket moved to <to>` → verify: `tests/integration/stage-draft-done-cancel.test.ts` (a), (b), (c), (f)
- [x] 1.2 `hub/kinds/ticket.ts`: the edit route calls the hook when a queued ticket becomes draft; the transition route calls it for draft and done → verify: tests (a), (b), (c)
- [x] 1.3 Final PASS: after `stage.passed` commits and the ticket is done, `cancelQueuedStagesOfTicket(..., "done")` → verify: test (i)
- [x] 1.4 Hub start: queued stages of draft and done tickets are cancelled before the `launching` sweep → verify: test (h)
- [x] 1.5 Pickup guard: `enqueueLaunch` already refuses draft, done and cancelled tickets before any write (`hub/kinds/stage.ts`, the ticket check). Every refusal is a `return { ok: false }`; the stage row is unchanged → verify: test (d)
- [x] 1.6 Role start: `evaluateStages` ignores `cancelled` stages when it checks "no stage of the ticket role" → verify: tests (a)+(e), (j)

## 2. Spec

- [x] 2.1 `docs/PROTOCOL.md`: stage-kind section and "Cancelled stages"
- [x] 2.2 `npx @fission-ai/openspec@1.14.3 validate stage-draft-done-cancel --strict` → exit 0

## 3. Not checked

- Tests (g): no retry, no failure handoff, no FAIL count is checked in test (a) with the G4 helper `expectNoFailureTrail`.
