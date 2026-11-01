## 1. Hub

- [x] 1.1 `hub/kinds/handoff.ts` spec branch: a non-human sender with `specFailState(...).fails >= 2` gets 409 that names the count and "the human must send this review"; nothing is recorded → verify: `tests/integration/spec-fail-gate.test.ts` (a), (c), (d)
- [x] 1.2 `hub/kinds/stage.ts` spec FAIL result: before the stage passes, each queued spec stage of the request from a non-human handoff moves to `failed` with the reason "spec FAIL limit: the human must send this review" → verify: test (b)
- [x] 1.3 `StageHooks.stampResult`: a spec FAIL result stores `fail_count` and overwrites a Validator value → verify: test (e)
- [x] 1.4 `noticeRepeatedFail` sends the same text to the room lead and to the human; one copy when the lead is the human → verify: test (f)
- [x] 1.5 `needsYouRequests` lists a request with `fails >= 2` while a newer spec review is open → verify: test (g)
- [x] 1.6 Spec first message: "This is spec review N of this request since its last PASS." → verify: test (h)
- [x] 1.7 A FAIL with no `escalate` triggers 1.1, 1.2, 1.4 and 1.5 → verify: test (i)

## 2. Validator rule

- [x] 2.1 `factory/validator/validator.md`: replace the `escalate` rule with "The hub counts FAILs and escalates. Do not count them yourself." → verify: `rg escalate factory/validator/validator.md` finds nothing

## 3. Checks

- [x] 3.1 `./scripts/test.sh`, `bun x tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `./scripts/check-mod.sh` pass; `./scripts/build-sidecars.sh` exit 0
- [x] 3.2 The Orchestrator checks the Needs-you area in a browser before the install (done: Orchestrator browser check PASS on a test hub, Orchestrator status 2026-10-28 07:07, before install 27; covered: 2-FAIL row with its finding, Collapse and Expand, Clear kept after a reload, storage-failure block, a new FAIL shows the block, no console errors)
