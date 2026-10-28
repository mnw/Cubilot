## Why

The request `r-2026-10-26-context-pack` got six spec FAILs and no stop. The hub counts FAILs (`specFailState`) but never enforces the count. A fresh Validator session cannot count its own earlier FAILs, so the `escalate` rule in `factory/validator/validator.md` does not work. The notice of the second FAIL reaches only the human. The "Needs you" row disappears when the Orchestrator sends a newer review.

Human decision 2026-10-27: the second spec FAIL since the last PASS goes to the human. No third review starts without the human.

## What Changes

- **Gate:** a spec review handoff from a sender that is not the human gets 409 when the request has two or more FAILs since its last PASS. Nothing is recorded.
- **Queued stages:** when the second FAIL is recorded, each queued spec stage of the request from a non-human handoff moves to `failed` with a fixed reason and never launches.
- **Hub count:** each spec FAIL result stores `fail_count` in its context. The hub overwrites any value from the Validator. No hub code reads `escalate`.
- **Notice:** the notice of a repeated FAIL goes to the room lead and to the human with the same text. One copy when the lead is the human.
- **Needs you:** a request with two or more FAILs stays listed while a newer spec review is open.
- **First message:** the spec first message holds the review number.
- **Validator rule:** `factory/validator/validator.md` tells the Validator that the hub counts.

## Capabilities

### Modified Capabilities

- `spec-review-stage`: the gate, the count, the notice, the Needs-you rule and the first message.

## Impact

- Security: the gate trusts the self-asserted `from` (accepted risk, `docs/rules/permissions.md`). A non-human can no longer start a third review.
- Migration: none. `fail_count` is a new key in stored context JSON. Older results without it use `specFailState`.
- Accessibility: Needs-you keeps its row and controls. No new control.
- Performance: one count query for each spec POST and for each spec result.
- Compatibility: a non-human third spec POST gets 409. The Validator rule changes.
