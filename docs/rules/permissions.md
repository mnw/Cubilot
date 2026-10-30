# Rules: permissions

Permission relay, no-TTL rule and trust-model accepted risks.

## Mutating structured-message endpoints use trust-on-self-assertion

- **Mutating structured-message endpoints use trust-on-self-assertion.** `by` and `from` are validated against the expected actor for the route but not cryptographically verified. Token-holder can claim any identity. Documented hardening target: per-sidecar tokens bound to agent identity.

## Permission relay is a hub-first wait in the `classic.PermissionRequest` hook

- **Permission relay is a hub-first wait in the `classic.PermissionRequest` hook.** The hook `POST /permissions`, then waits on `GET /permissions/:id/wait?timeout_ms=<n>` (default 60 000, hub cap 300 000). `allowed`/`denied` answers the hook, and the local dialog closes without a local answer. On timeout it `POST /permissions/:id/dismiss`es as the agent: 2xx → `next(e)`, so the decision stays with Claude's local dialog; 409 → a verdict won the race, re-read the snapshot (`wait?timeout_ms=0`) and honour it; any other dismiss failure → re-read once, honour a terminal verdict, else `next(e)`. **Every request in the hook is bounded** (`curl --max-time`; the wait passes `timeout_ms + 5000`) — the hook must never hang. Hub unreachable or POST rejected → `next(e)`. On Claude Code 2.1.296 (verified live, M18) the local dialog opens immediately, concurrently with the hook: the room and the terminal race and the first answer wins. A room verdict applies through the hook and closes the dialog; a terminal answer decides at once. After a terminal No the card is dismissed within ~50 ms and a later room click gets 409 (observed on install 9; mechanism not traced). After a terminal Yes the hook keeps waiting until its timeout, then dismisses the room card (it stays visible for up to 60 s; a room click in that window is recorded at the hub but has no effect — known limitation, there is no native signal for a local Yes, and the earlier tool.call-entry heuristic was wrong because the permission prompt runs beneath tool.call's next(e)). On 2.1.287 the dialog waited for the hook (observed in M15/M16). Sender gating via `hub.token` on `/permissions/*` is still the precondition for trusting a verdict; if a future deploy mode drops auth there, the relay hook must be removed in the same change.

## Permissions have no TTL

- **Permissions have no TTL.** Claude Code's local dialog owns the effective timeout. Never add auto-expiry to the `permissions` table — auto-denying a tool the human actually wanted is annoying, auto-allowing is a security violation, and there is no safe default. Policy-driven per-tool timeouts may land later as a separate feature.

## A token holder can act as the human, so `blast_radius: high` is advisory

- **A token holder can act as the human, so `blast_radius: high` is advisory.** Any agent that can run Bash can read `hub.token` (mode `0600`, same user) and send `by: "<human name>"`. That lets it do what only the human may do: approve a request (`/requests/<room>/<id>/approve`), answer a decision (`/decisions/<id>/answer`), start a checkpoint (`/checkpoints`), lower a radius below the rule, move a ticket to any column, and dismiss any permission request (`/permissions/:id/dismiss`). The checks hold against an agent that reports its own name honestly, not against a hostile one. Accepted until per-agent tokens bound to identity exist. P6-03 does not change this: the radius rule sets a floor for honest callers only. Do not describe a radius, an Approve or a decision as enforcement.

## Who decides what

- **The human approves.** One Approve per request releases its draft tickets, and later tickets of it (L1). Only the human approves a request, answers a decision (`escalate`) and changes the origin of a request. A high ticket has no Allow step: it closes on the full suite and two Validator PASSes (P6-04). No route and no `ticket:done` permission exist for it.
- **The radius has a floor.** The radius rule (terms and paths in `config.yml`, `hub/core/radius-rule.ts`) gives the lowest `blast_radius` of a ticket text. The stored radius is never below it. The room lead, the creator or the human raises a radius with `edit_ticket`. Only the human lowers it below the rule. A permission request (`/permissions`) is for a Claude Code tool call and has no link to the radius.
- **The room lead opens, the human answers.** Only the room lead opens a decision. Another agent and the human get 403. Only the human answers it.

## The launch stream has no per-role token

- **The launch stream has no per-role token.** Any holder of `hub.token` can read `GET /launches/stream` (the prompts and the stage ids of every launch) and send `POST /launches/<id>/ack`. A forged ack can mark a launch `running` that never started, or end an attempt. Launches are gated by code path only (`enqueueLaunch`). Accepted for the same reason as the item above. Fix it together with per-agent tokens.
