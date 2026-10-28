## Why

On 2026-10-27 the human had to act many times for each ticket: queue, Approve, Allow, radius, third reviews and decisions after FAILs. The factory was slower than work by hand. The Orchestrator's context also filled to 77 % in one day, and the human cleared it by hand. Part 6 item 11 limits the human to two points, the start and the delivery of a request. Part 6 item 7 keeps the Orchestrator's context small with a checkpoint that code runs. Source: `factory/brief/06-warp-patterns.md`, items 11 and 7, decisions of the human of 2026-10-27.

Depends: nothing that is not archived. `spec-review-stage`, `stage-sessions`, `context-pack`, `spec-fail-gate` (t_65a8), `stage-cancelled-status` (G10) and `cancel-failure-trace` (t_3186) are archived. Role models in `config.yml` (t_e524) are built. The unarchived change `stage-diagnosis` also adds stage roles and stage review types to the same files. The change that lands second rebases on the first (design decision 15).

## What Changes

**Start (item 11, scope 1 and 3)**
- A new `request` Kind stores each request with its `origin` (`human` or `factory`), its list of features, its parent and its source.
- A request of the human (origin `human`) needs one Approve at the start, whatever its radius. **BREAKING**: before, a request with only low-radius tickets needed none. A request that the factory makes itself (origin `factory`: follow-up, gap, fix) with only low-radius tickets and no features is queued by its spec PASS, as today, and the delivery report of its parent lists it. A factory request with a high-radius ticket or a feature needs the human's Approve.
- Scope change, in code terms: a ticket added or removed, an approved ticket's radius raised, or a change to the list of features. It needs a new Approve. A criteria edit is not a scope change: it needs no new Approve, the delivery report shows it with the text before and after, and the arbiter can flag an edit that changes the meaning; only then does it go to the human.
- Code sets the radius from the radius rule (terms and paths in `config.yml`). The Orchestrator can raise it. A radius below the rule needs an arbiter ruling. The Approve card shows the radius, its source and its reasons.

**Between start and delivery (scope 2, 4, 5)**
- High radius means stricter checks, not a human gate. The Tester runs the full suite. A second review runs in a new session (Claude, opus × high, until OpenAI on Pi is set up). Code moves the ticket to `done` after both PASSes. The hub gives the merge message, which names both PASSes. **BREAKING**: the human Allow on high-radius tickets (`/tickets/:id/approval`, the `ticket:done` permission) is removed. Main stays protected: only the human merges staging into main.
- The hub counts review FAILs for each ticket. A third ticket review needs the human or an arbiter ruling.
- A new read-only stage role `arbiter` (Claude, opus × high, new session each time). It starts at the second FAIL of a ticket or a plan, or when the Orchestrator asks it (waiver, radius, contradictory criteria, third review). One arbiter for each ticket or request and FAIL count.
- The arbiter result is schema-checked: one option (rework, waiver, third review, follow-up ticket, cancel, human), reasons, the rule applied. Code applies it and writes the ruling as a ticket note. A ruling that cancels an approved ticket, flags a criteria edit that changes the meaning, or leaves a security finding without a fix is not applied: it goes to the human. A ruling on an implementation detail without a code reference is refused.
- The spec FAIL gate (t_65a8) and the new ticket gate accept one review that a ruling starts.
- A new `decision` Kind holds rulings and questions to the human. The human gets one Needs-you line only for a scope or feature change, an action that cannot be undone, an arbiter answer `human`, or a security finding without a fix in scope. The line uses the escalation format of `unblocking.md`. **BREAKING**: the second spec FAIL no longer goes to the human; it goes to the arbiter.

**Delivery (scope 6)**
- When all tickets of a request are done, code builds the delivery report from the ledger and git: origin and features, tickets and merge commits, criteria edits (before and after), factory requests of the request, rulings, waivers, known limits, high-radius changes with both PASSes, test counts on staging, the human's test steps. The human can overrule a ruling; each overrule is recorded.

**Orchestrator checkpoint (item 7, steps 1 to 7 and 9; scope 7)**
- Measure the entries that reach the room lead, by kind and size.
- Quick fixes: no new briefing to the lead when a stage session joins or leaves; a digest of ticket events for the lead (an escalation, a second FAIL or an approval still comes at once); a result handoff to the lead carries a summary and the ticket id, and a read tool gives the full result.
- The agent column shows the context percentage of each Claude agent, from a status line command.
- A state summary built by code, at most 2,000 tokens.
- A new `checkpoint` Kind runs the fixed rule: a request is done or the context is at 60 % or more, no decision is open, at the end of a turn. The hub asks the Orchestrator for a note (at most 200 words), writes the summary file, and sends `/clear` through the shell. A `SessionStart` hook (matcher `clear`) gives the summary to the new context. Each checkpoint is recorded.
- Not in scope: Jev (item 7 step 8).

**Last**
- Remove the interim rule from `orchestrator.md` and step 4a of `unblocking.md` when the arbiter is live.

## Capabilities

### New Capabilities
- `plan-approval`: the `request` Kind with origin and features, the Approve rule by origin, the approved scope, the code definition of a scope change, and the queue gates.
- `ticket-radius`: the radius rule in code, raise by the Orchestrator, lower only by an arbiter ruling or the human.
- `high-radius-checks`: full suite by the Tester, second review, done after two PASSes, merge message.
- `arbiter`: the arbiter stage, its first message, its result, the ticket FAIL count and gate, and how code applies a ruling.
- `human-escalation`: the `decision` Kind, the four cases that reach the human, the Needs-you line.
- `delivery-report`: the report for each request and the overrule record.
- `orchestrator-checkpoint`: measure, quick fixes, context percentage, state summary, note, rule, `/clear` with the hook, record.

### Modified Capabilities
- `work-tickets`: the human Allow gate on high-radius `done` and the board's approval state are removed; the room lead's queue follows the request's Approve, not the radius.
- `spec-review-stage`: a PASS queues only when the Approve rule allows it; the second FAIL goes to the arbiter; the third review gate accepts an arbiter ruling; the Needs-you area lists a two-FAIL request only when it is escalated.

## Not in this change

- Jev (item 7 step 8; item 6 step B).
- OpenAI on Pi for the second review (Part 2 finding 6). A `config.yml` setting changes the model when it is set up.
- Items 1 to 6 and 8 to 10 of Part 6. The flow report (item 9) will use the state summary of this change.
- A checkpoint for a Pi Orchestrator (Pi has no `SessionStart` hook).

## Impact

- Hub: `hub/kinds/ticket.ts`, `stage.ts`, `handoff.ts`, `index.ts`; new `hub/kinds/request.ts`, `decision.ts`, `checkpoint.ts`; new `hub/core/radius-rule.ts`, `config-file.ts`, `delivery-report.ts`, `state-summary.ts`, `lead-inbound.ts`, `context-usage.ts`; `hub/core/role-models.ts`, `agents.ts`, `briefing.ts`, `ledger.ts`, `launch-queue.ts`, `worktrees.ts`; `hub/features/roster.ts`.
- Bridge: `hub/channel/core.ts`, `hub/channel/tools.ts` (rebuild sidecars, `check-mod.sh`).
- Shell: `src-tauri/src/factory.rs` (status line, arbiter role), `src-tauri/src/launches.rs` and `pty.rs` (a pane input request).
- UI: `ui/features/plan-approval.js`, new `ui/features/decisions.js`, `ui/kinds/ticket.js`, `ui/features/roster.js`, `ui/index.html`.
- Factory: new `factory/arbiter/`, new `factory/orchestrator/hooks/`, `factory/shared/` status line script, role files of the Orchestrator, Validator and Tester, `unblocking.md`.
- Ledger: three new Kinds (`request`, `decision`, `checkpoint`), new ticket columns (`radius_rule`, `radius_reasons`, `radius_source`), new stage column `fail_count`. `approval_request_id` stays as data and is no longer read.
- Docs: `CLAUDE.md`, `docs/rules/kinds.md`, `docs/rules/permissions.md`, `docs/PROTOCOL.md`, `factory/README.md`.
- Risk: the human has fewer gates. The arbiter's quality is measured by the overrules in the delivery reports.
