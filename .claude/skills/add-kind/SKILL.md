---
name: add-kind
description: Add a new persistent state-machine "kind" (alongside handoff, interrupt, permission) to the hub. Use this skill whenever the user asks to add, create, scaffold, implement, or design a new kind — whether they phrase it as "add a kind" / "new kind" / "another state-machine entity", name a specific one ("add a signoff kind", "I want a review primitive"), or describe something that smells like one (persistent entity with lifecycle verbs, broadcast on state change, replayable on reconnect). Covers the KindModule contract's five integration points (migrate, routes, pendingFor, toolNames, registration), the UI module + scoped CSS, the broadcast-scope decision per verb, the chatbridge (channel.ts) MCP tool wiring, the PROTOCOL.md update, and the pre-extraction reality of landing the kind inside the hub.ts monolith today.
---

# Add a new kind

This skill walks through adding a new persistent state-machine kind to the hub — the thing `handoff`, `interrupt`, and `permission` all are. The target architecture is defined in `references/design.md` (v0.9.5) and the testable requirements live in `references/spec.md`. Read the contract here; consult those for *why* (design) and *what must be true* (spec).

## Pre-extraction reality — read this first

**v0.9.5 has not shipped yet.** The code today is the monolith: one `hub/hub.ts` (~2500 lines pre-rooms, ~2800 post), `ui/main.js`, `ui/style.css`. The `hub/kinds/` directory, the `KindModule` type, the `HubCapabilities` shape, and the scope resolver **do not exist yet** as separate files — they are implicit patterns spread across the monolith.

This means when you add a kind today, you are **not** creating `hub/kinds/<kind>.ts` and registering it. You are:

1. Writing the kind's code **as if** the extraction had happened — using the contract below as your mental model.
2. Then landing it into `hub.ts` / `channel.ts` / `main.js` / `style.css` in the same shape the existing three kinds take, so that when v0.9.5 extracts, your kind moves out cleanly with them.

### Pre-v0.9.5 touch-site map (hub/hub.ts, verified against v0.8.1 at time of writing — re-grep before trusting)

```
Function / block                        Line       What to add
--------------------------------------- ---------  ------------------------------
migrateLedger()                         ~194       new `if (current < N)` block
type HandoffStatus (handoff types)      ~38        → your <kind> types go below
                                                     the existing permission section
                                                     (~line 910)
buildBriefing()                         ~1235      add your tool names into the
                                                     `tools:` array
handleAgentStream() replay block        ~1670      add your pendingFor() iteration
                                                     next to handoff/interrupt/
                                                     permission replays
broadcastHandoff / Interrupt / Permission ~1766     your broadcast<Kind> follows
                                                     the same shape
Bun.serve() route dispatcher            ~2338      add route matches next to the
                                                     existing /handoffs, /interrupts,
                                                     /permissions blocks
```

Re-run `grep -nE "^function (migrateLedger|buildBriefing|handleAgentStream|broadcast)" hub/hub.ts` to confirm current line numbers — the monolith grows with every feature.

### Chatbridge (hub/channel.ts) touch sites

Adding a kind is **not** complete without wiring its MCP surface into chatbridge. Users of this skill often miss this and ship a kind claude can't invoke.

```
Block / function                          Line       What to add
----------------------------------------- ---------  ----------------------------
ListToolsRequestSchema → tools: [...]     ~130       tool schemas (one per verb
                                                       claude can invoke)
CallToolRequestSchema → dispatcher        ~406       one `if (req.params.name ===
                                                       "<kind>_<verb>")` branch per
                                                       tool that POSTs via authedPost
Notification handlers (if applicable)     ~540       if claude emits upstream
                                                       notifications for your kind
                                                       (like permission_request),
                                                       add a setNotificationHandler
                                                       block near the existing
                                                       PermissionRequestSchema one
SSE tail relay (if applicable)            ~620       if claude expects a verdict
                                                       relayed back upstream (like
                                                       permission.resolved →
                                                       notifications/claude/channel/
                                                       permission), extend the tail
                                                       handler
```

### Pre-extraction mapping for each checklist step

- **Schema migration:** `hub.ts migrateLedger` block. Next unused schema version.
- **Types + state machine:** top of `hub.ts`, after the existing permission types (~line 910).
- **Routes:** add handlers as top-level functions; wire them into the `Bun.serve` switch.
- **Broadcast helpers:** follow `broadcastPermission` (hub.ts ~line 1855) as the template.
- **Replay:** inside `handleAgentStream` (hub.ts ~line 1670), next to the other replays.
- **Tools:** two places — `buildBriefing` in `hub.ts` adds the name; `channel.ts` adds the schema + dispatcher branch.
- **UI:** inline in `ui/main.js` next to `renderPermissionCard` (ui/main.js ~line 1191). CSS inline in `ui/style.css` next to `.permission-card`.
- **Docs:** new subsection in `docs/PROTOCOL.md` following the handoff / interrupt / permission pattern.

The templates in `assets/` are written against the **post-v0.9.5 layout** — they're what you copy into `hub/kinds/<kind>.ts` the day v0.9.5 lands. Until then, treat them as a specification of what your inline additions need to be equivalent to. When v0.9.5 ships, lifting your code out should be mechanical.

**If the user's request suggests v0.9.5 has already shipped** (they mention `hub/kinds/`, the `KindModule` type, or a clean extracted hub), re-read the repo layout before proceeding — the situation may have changed since this skill was written.

### Schema column note

Today the `events` table has `handoff_id` as its generic entity-id column (historical misnomer; it's used by handoff, interrupt, permission, and nutshell events). Use that name in your schema. v0.9.5 renames it to `entity_id` (design.md §7) — your code gets mechanically renamed along with everything else during the extraction.

## The KindModule contract

Every kind implements exactly these five integration points. This is the outer boundary; what the state machine does *inside* is the kind's own business.

```ts
type KindModule = {
  kind: string;                                                     // "handoff", "interrupt", "permission"
  migrate(db: Database): void;                                      // idempotent schema migration
  routes: RouteDef[];                                               // static declaration
  pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[];       // reconnect replay (see note below)
  toolNames: string[];                                              // briefing aggregates these
  priority?: number;                                                // optional replay-ordering hint
};
```

**Replay flag contract:** `pendingFor` returns `Entry[]` with the `replay: true` field already set on each entry. The orchestrator does not remark entries — kinds are responsible. The `buildEntry(snapshot, kind, replay)` pattern in the template accepts `replay` as an arg for exactly this reason.

**Why narrow.** The three existing kinds diverge meaningfully inside — handoffs have TTL and four verbs, interrupts have one verb, permissions have none of that. Trying to DRY their state machines produces awkward nullable fields. The contract only standardizes the boundary with the hub. See design.md §1.

## Four things to decide before writing code

Get clear answers to these before opening a file. The skeleton will write itself once they're settled; it will fight you if they're not.

1. **State machine shape.** What states does an entity pass through, and what verbs transition it? Examples from existing kinds: handoff goes pending → accepted/declined/cancelled/expired; interrupt is pending → acknowledged; permission is pending → allowed/denied/dismissed. Shapes diverge on purpose — pick what fits, don't imitate.

2. **Broadcast scope per verb.** For each verb, who needs to see the event? The four scopes are:
   - `{ kind: "broadcast" }` — UI + all non-permanent agents
   - `{ kind: "to-agents", agents: [...] }` — UI + specific agents (e.g. handoff.update → [from, to])
   - `{ kind: "ui-only" }` — human-visible state only
   - `{ kind: "room", room: "..." }` — room-filtered fan-out (v0.9)

   Pick deliberately per verb. Don't default to broadcast "to be safe" — a permission request shouldn't page every agent in the system. See design.md §4.

3. **ID source.** Two patterns exist. Pick one and commit:
   - **Hub-minted:** `cap.ids.mint("<short-prefix>")` returns `h_<16 hex>` style (handoff, interrupt).
   - **Caller-supplied:** permission takes claude's 5-letter request_id. Validate with a regex; reject on conflict.

4. **Replay policy.** On agent reconnect, which unresolved entities does this kind surface to that agent? Newest-first? Filtered by recipient? Include terminal-state entities within some window? This becomes the body of `pendingFor`.

5. **MCP tool surface.** Which tools do agents use to drive this kind's state machine? Name them `<kind>_<verb>` so the briefing aggregator groups them sensibly.

If you don't know the answers, ask the user. Guessing at the state machine and writing a template around a wrong guess is worse than one clarifying question.

## Implementation checklist

Walk these in order. Each step is independently landable; don't batch them into one giant change unless the user has a reason.

- [ ] **1. Schema.** Add the kind's tables + indexes inside a new `if (current < N)` block in `migrateLedger` (hub.ts). Wrap every DDL in `CREATE TABLE IF NOT EXISTS`. Bump the ledger schema version. Events land via the generic event-insert helper with the entity id as `handoff_id` (pre-v0.9.5) / `entity_id` (post-v0.9.5).

- [ ] **2. Types.** Define the row type, the snapshot type, the payload type per verb, and the outcome union (`transition | idempotent | conflict | not_found`). Put them where the other kinds' types live today (hub.ts, after the permission section).

- [ ] **3. State machine.** Write `create<Kind>`, `resolve<Kind>` (or `ack<Kind>` / `accept<Kind>` etc. per verb), `snapshot<Kind>`, `load<Kind>`, `list<Kind>`, `pending<Kind>For`. Each mutating function wraps its event insert + row update in one `db.transaction`. Terminal-state transitions are idempotent no-ops, not errors.

- [ ] **4. Routes.** One handler function per verb. Mutating routes call `requireAuth` + `requireJsonBody(req, MAX)`. Read routes call `requireReadAuth`. Wire the URL patterns into the `Bun.serve` route dispatcher. Body cap: 16 KiB unless you have real justification.

- [ ] **5. Transition + broadcast.** Inside each handler: validate input → verify current state allows this verb → write row update + ledger event in one transaction → construct the Entry shape (matching `handoffEntry` / `interruptEntry` / `permissionEntry`) → call the broadcast helper. Terminal-state transitions return success as no-ops.

- [ ] **6. pendingFor.** Implement the replay policy you decided above. Return entries with `replay: true` already set. Return entries in the order *this kind* wants them replayed; don't depend on any ordering relative to other kinds (design.md §6).

- [ ] **7. Tools — hub side.** Add the tool names into `buildBriefing()`'s `tools:` array (hub.ts). The briefing is what chatbridge uses to teach claude which tools exist.

- [ ] **8. Tools — chatbridge side (channel.ts).** This is the step most skill users miss. Add:
    - Tool schemas to `ListToolsRequestSchema`'s `tools: [...]` array (one entry per verb, with `inputSchema` mirroring the HTTP route's body shape).
    - Dispatcher branches to `CallToolRequestSchema` that POST via `authedPost` to the matching hub route.
    - If the kind receives upstream notifications from claude (like `permission_request`): a `setNotificationHandler` block with a Zod schema and a forward-to-hub handler.
    - If the kind relays back upstream (like `permission.resolved` → `notifications/claude/channel/permission`): extend the SSE tail handler in `tailHub()`.

- [ ] **9. UI — DOM + dispatch.** One card renderer, one dispatch switch keyed on verb, a version-reconcile map to drop stale events on reconnect. The template in `assets/kind-template.js` shows the pattern. Pre-v0.9.5 this goes inline in `ui/main.js` next to `renderPermissionCard`; post-v0.9.5 it goes in `ui/kinds/<kind>.js` as a module export.

    **Use `authedFetch`, not `fetch`.** Mutating routes require the Bearer token that `authedFetch` injects automatically. Raw `fetch` will 401 silently from the UI.

- [ ] **10. UI — CSS.** Scope everything under `.<kind>-card` (or a kind-specific root). Don't touch `ui/style.css`'s layout / composer / header sections (design.md Non-Goals). Pre-v0.9.5: add to `ui/style.css` scoped under your prefix, next to `.permission-card`. Post-v0.9.5: `ui/kinds/<kind>.css`.

- [ ] **11. UI — bootstrap.** Add a `loadPending<Kind>()` function to `ui/main.js` that GETs `/<kind>s?status=pending&limit=500` at page load and renders each entry via the same dispatch path. Call it from `bootstrap()` next to `loadPendingPermissions`. Without this, the UI shows nothing for entities that were pending before the page loaded.

- [ ] **12. Docs — docs/PROTOCOL.md.** Add a subsection following the handoff / interrupt / permission pattern: snapshot schema table, HTTP routes table, MCP tools, SSE events, terminal-state policy, trust semantics. A kind without a PROTOCOL.md section is a documentation regression.

- [ ] **13. Docs — README.md.** If the kind is user-facing, add a one-paragraph entry under "Four primitives" (or bump the count). Describe the UX, not the implementation.

- [ ] **14. Tests.** If tests exist (post-v0.9): add a lifecycle test under `tests/integration/<kind>-lifecycle.test.ts` — create → list → transition → broadcast, using real SQLite + dynamic port. If tests don't exist yet: at minimum, smoke with the curl matrix pattern the other kinds use (see `openspec/changes/permission-relay/` for the v0.8 pattern).

- [ ] **15. Registration.** Post-v0.9.5: add to `hub/kinds/index.ts` `KINDS` array — one import + one array entry. Pre-v0.9.5: registration is implicit via the touch-site edits above; there is no central array to add to yet.

## Using the templates

Three skeleton files live in `assets/`:

- `kind-template.ts` — the `hub/kinds/<kind>.ts` module (post-v0.9.5 shape; use as a specification pre-v0.9.5)
- `kind-template.js` — the UI module with `dispatch` / `bootstrap` exports
- `kind-template.css` — the scoped CSS stub (concrete starting values, not empty rules)

Copy them, then global-replace `<kind>` (lowercase — used everywhere in identifiers and class names) and `<Kind>` (PascalCase — used in type names like `<Kind>Snapshot`). Delete template comments once you've internalized each hook's purpose — they're scaffolding, not documentation you need to keep.

**Do not just fill in the blanks without understanding each hook.** The `pendingFor` return shape, the scope choice per verb, the terminal-state idempotency — these are design decisions, not code you can write on autopilot. If you don't understand why a line is there, read the matching section in `references/design.md` and the matching requirement in `references/spec.md`.

## Anchor invariants (do not violate)

These come from the design doc. If you find yourself about to break one, stop and raise it with the user:

- **Kinds formalize persistent state-machine entities backed by the event ledger.** If what you're adding has no persistence, no lifecycle, or no broadcast — it isn't a kind. See the "When the contract doesn't fit" section.
- **Kinds emit entries + scopes; the SSE layer resolves scopes to recipients.** Never enumerate agent queues from inside a kind. (design.md §4)
- **All kinds are statically registered.** No dynamic loading, no config-driven discovery. (§5)
- **Replay order across kinds is undefined.** Your kind's correctness must not depend on another kind replaying before or after it. (§6)
- **Each kind owns its schema evolution via `migrate(db)`. Migrations are idempotent and additive.** (§7)
- **Terminal-state transitions are idempotent no-ops, not errors.** (cross-cutting, matches all three existing kinds)
- **Byte-identical HTTP / SSE / MCP / DB behavior for existing kinds.** Adding a new kind must not change anything about the existing three. (Goals)

## When the user asks for something the contract doesn't fit

Sometimes what the user calls "a kind" isn't one. Two cases to watch for:

- **Ephemeral broadcasts** (typing indicators, presence, live cursors). No persistence, no state machine. These use their own pattern — don't force them into `KindModule`. (design.md §1, Non-Goals, §8)
- **Documents** (like nutshell). Single-row, no lifecycle, no list view. Nutshell lives standalone as `hub/nutshell.ts` today and that's the right pattern for N=1 documents. If the user brings a second document-like entity, *that's* when a `Document` sibling contract earns its keep. (§8)

If the user's "kind" is really one of these, say so early. Suggest the pattern that fits, not the one in this skill. Forcing a bad abstraction is exactly what the v0.9.5 design set out to prevent.
