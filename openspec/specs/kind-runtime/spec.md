# kind-runtime Specification

## Purpose
TBD - created by archiving change v095-kind-runtime. Update Purpose after archive.

## Requirements

### Requirement: Persistent state-machine kinds implement the `KindModule` contract

Every persistent state-machine primitive added to the hub (including the existing `handoff`, `interrupt`, and `permission` primitives) SHALL be implemented as a module conforming to the `KindModule` contract.

The full `KindModule` field list (including `routes` inherited from `HubFeature`, plus the kind-specific `kind`, `store`, `stateMachine`, `pendingFor?`, `toolNames`, `priority?`) is defined canonically in the `route-modules` capability spec. This spec does NOT re-list the fields; consult `route-modules/spec.md` for the authoritative field set.

The hub orchestrator (`hub/hub.ts`) SHALL contain no kind-specific code. It iterates a static `KINDS` array (a subset of `FEATURES`), calls each kind's `entity.migrate(db)` at startup (where `entity` is the kind's `LedgerEntity` instance — its internal Store handles the DDL), registers their routes through the dispatcher (which consumes the parent `HubFeature` contract), and invokes `pendingFor` on `/agent-stream` reconnect via the briefing path.

**Core invariant:** Kinds formalize persistent state-machine entities backed by the event ledger. Ephemeral broadcasts (presence, typing indicators), single-row documents (nutshell), and config/rules do not use this contract.

#### Scenario: Registered kind is migrated on startup

- **GIVEN** a new `KindModule` named `foo` is exported and listed in `hub/kinds/index.ts`
- **WHEN** the hub starts and `openLedger()` runs
- **THEN** `foo.entity.migrate(db)` is invoked exactly once (delegating to the entity's internal Store)
- **AND** subsequent hub restarts invoke `foo.entity.migrate(db)` again and the migration observes its own idempotency (no-op on second run)

#### Scenario: Registered kind's routes are wired through the dispatcher

- **GIVEN** `foo.routes` declares `[{ method: "POST", path: "/foos", auth: "mutating", bodyMax: 16384, handler }]`
- **WHEN** the hub dispatches an incoming request for `POST /foos`
- **THEN** the dispatcher applies `requireAuth` (because `auth: "mutating"`) and `requireJsonBody(req, 16384)` before invoking `handler(req, cap, {})`
- **AND** the handler receives a live `HubCapabilities` object whose `cap.sse.emit` delegates to the new `Fanout` module

#### Scenario: Adding a kind requires no edits to hub.ts

- **WHEN** a developer introduces a new kind `foo` by creating `hub/kinds/foo.ts` and adding one import + one array entry to `hub/kinds/index.ts`
- **THEN** the hub orchestrator in `hub/hub.ts` requires zero edits
- **AND** the kind's migration, routes, briefing tools, and replay all activate on the next hub start

### Requirement: `HubCapabilities` injection is the sole access path to shared hub services

Kind implementations SHALL access shared services (SQLite database, SSE emit, agent registry, auth helpers, event-log insert, id minting, config) exclusively through the `HubCapabilities` object passed into their hooks. Reaching for module-level globals or importing from `hub/hub.ts` is prohibited.

Each hook receives only the capabilities it needs:
- `migrate(db)` — receives the bare `Database` handle, nothing else.
- `handler(req, cap, params)` — receives full `HubCapabilities`.
- `pendingFor(agent, cap)` — receives full `HubCapabilities`.

`HubCapabilities` shape:

```
{
  db: Database,
  agents: { get(name), isPermanent(name), all() },
  sse: { emit(entry, scope), emitWhere(entry, predicate) },
  auth: { requireAuth, requireReadAuth, requireJsonBody },
  ids: { mint(prefix, bytes?) },
  events: { insert(db, entity_id, kind, actor, payload, at_ms) },
  config: { humanName, attachmentsDir }
}
```

#### Scenario: Kind hook receives scoped capabilities

- **GIVEN** `foo.migrate` is declared as `(db) => …`
- **WHEN** the orchestrator invokes it
- **THEN** the function receives only the `Database` handle
- **AND** the function cannot invoke `cap.sse.emit()` (SSE is not in its parameter list)

#### Scenario: Handler receives full capabilities

- **GIVEN** a route handler `(req, cap, params) => …`
- **WHEN** the orchestrator dispatches an inbound request to it
- **THEN** `cap` contains `db`, `agents`, `sse`, `auth`, `ids`, `events`, `config` as described
- **AND** the handler can perform any documented operation (insert an event, emit a broadcast, check agent presence) without reaching for globals

### Requirement: SSE broadcasts use named scopes; kinds emit, the SSE layer resolves recipients

Kinds SHALL construct an `Entry` and emit it with a `Scope` via `cap.sse.emit(entry, scope)`. The SSE layer SHALL be the sole owner of the mapping from scope to queue list.

**Core invariant:** Kinds emit entries + scopes. The SSE layer resolves scopes to recipients.

Named scopes at v0.9.5 ship:

- `{ kind: "broadcast" }` — UI subscribers + every non-permanent agent queue.
- `{ kind: "to-agents"; agents: string[] }` — UI subscribers + the listed agents' queues. Unknown or permanent agents in the list are skipped. Used for recipient-specific events (handoff.new → `[to]`; handoff.update → `[from, to]`).
- `{ kind: "ui-only" }` — UI subscribers only. Used for roster/presence/nutshell updates.
- `{ kind: "room"; room: string }` — UI subscribers + every non-permanent agent whose `AgentCtx.room === <room>` + the human (who exists in every room). Lands in conjunction with v0.9 rooms.

An `emitWhere(entry, predicate)` escape hatch exists for one-off use cases (admin actions, debug endpoints) but kinds SHOULD prefer named scopes. Promoting a predicate to a named scope is the right move when the same predicate appears in two or more kinds.

#### Scenario: Handoff broadcast lands in UI and recipient's queue

- **GIVEN** a `handoff.new` event for handoff id `h_xxx` from `alice` to `bob`
- **WHEN** the kind calls `cap.sse.emit(entry, { kind: "to-agents", agents: ["bob"] })`
- **THEN** every `/stream` UI subscriber receives the entry
- **AND** `bob`'s `/agent-stream` queue receives the entry
- **AND** no other agent queue (including `alice`'s) receives the entry unless `alice` happens to be a UI subscriber

#### Scenario: Room-scoped broadcast excludes agents in other rooms

- **GIVEN** agents `a1` in room `R` and `a2` in room `S`
- **WHEN** a kind emits an entry with scope `{ kind: "room", room: "R" }`
- **THEN** UI subscribers receive the entry
- **AND** `a1` receives the entry
- **AND** `a2` does NOT receive the entry
- **AND** the human receives the entry (human participates in every room)

#### Scenario: SSE layer skips removed or permanent agents

- **GIVEN** scope `{ kind: "broadcast" }` and agent `gone` was removed from the roster
- **WHEN** the SSE layer resolves the scope
- **THEN** `gone` is skipped (its queue no longer exists)
- **AND** the human (permanent) is not enqueued — the human reads via `/stream`

### Requirement: Kinds are statically registered

All kinds SHALL be imported and listed in `hub/kinds/index.ts` as a `readonly KindModule[]` array. Dynamic loading, config-driven plugin discovery, or runtime module resolution are prohibited.

**Core invariant:** All kinds are statically registered. No dynamic loading.

#### Scenario: KINDS array is the canonical registry

- **GIVEN** `hub/kinds/index.ts` exports `KINDS = [handoffKind, interruptKind, permissionKind]`
- **WHEN** the hub starts
- **THEN** exactly those three kinds are migrated, routed, and replayed
- **AND** no other kind can be added at runtime

#### Scenario: Bun compile inlines every kind statically

- **WHEN** `bun build --compile` produces `cubilot-bin`
- **THEN** the resulting binary contains all kind modules inline (verified by absence of dynamic `import()` calls in the kind-loading path)

### Requirement: Replay order across kinds is undefined

On `/agent-stream` reconnect, the orchestrator SHALL invoke `kind.pendingFor(agent, cap)` for each kind in registry order (sorted ascending by `priority ?? 0`). Kinds MUST NOT depend on any cross-kind ordering for correctness.

**Core invariant:** Replay order is undefined. Kinds must not depend on cross-kind ordering.

Within a kind, `pendingFor` SHALL order entries deterministically per the kind's own semantics (e.g., interrupts newest-first). Across kinds, no ordering is guaranteed.

#### Scenario: Reconnect replays every kind's pending entries

- **GIVEN** agent `alice` has one pending handoff, one pending interrupt, and two pending permissions
- **WHEN** `alice` reconnects to `/agent-stream`
- **THEN** the hub emits all four entries, each flagged `replay: true`
- **AND** the relative ordering between kinds is not guaranteed
- **AND** the relative ordering within a kind (e.g., the two permissions) is stable per that kind's documented semantics

### Requirement: Each kind owns its schema evolution

Every kind SHALL declare its schema as part of its `StateMachineDecl` (table name + column spec) consumed by `LedgerEntity`'s internal Store. The Store's `migrate(db)` hook SHALL contain idempotent DDL. Kind handler files (e.g. `hub/kinds/handoff.ts`) MUST NOT contain `CREATE TABLE`, `ALTER TABLE`, or `CREATE INDEX` statements directly; all schema knowledge resides in the `StateMachineDecl` passed to `createLedgerEntity`. Migrations MUST check for prior application (via `CREATE TABLE IF NOT EXISTS`, conditional schema-version checks, or equivalent) so that running the migration twice is a no-op.

**Core invariant:** Each kind owns its schema evolution via its `LedgerEntity`'s `migrate(db)` (which delegates to the internal `createSqliteStore`); migrations must be idempotent.

The orchestrator tracks schema versions via the existing `meta` table but does not itself contain any kind-specific DDL. If two kinds share a table (they should not), the one that owns the schema is documented in its module header and the other imports the owning kind's reader functions.

#### Scenario: Running migrate twice is idempotent

- **GIVEN** `handoffKind.entity.migrate(db)` has already applied the `handoffs` table on a previous hub start
- **WHEN** the hub restarts and `handoffKind.entity.migrate(db)` runs again
- **THEN** the migration observes its own prior application (e.g., via schema_version check or `CREATE TABLE IF NOT EXISTS`)
- **AND** no duplicate tables, indexes, or constraint violations arise
- **AND** no existing rows are modified

#### Scenario: Kind handler files contain no DDL

- **WHEN** the codebase is grepped for `CREATE TABLE` or `ALTER TABLE` inside `hub/kinds/*.ts`
- **THEN** zero matches are found
- **AND** all such DDL exists only inside `hub/core/store.ts` (the internal SQLite Store) or `hub/core/ledger.ts` (cross-kind migrations)

> The Webview-side requirement covering UI per-kind modules + `KindCard` factory + per-Kind CSS consolidation is scoped to `architecture-cycle-2b`'s `kind-rendering` capability. 2a's `kind-runtime` modifications are Hub-only.

### Requirement: UI per-kind modules own their slice end-to-end

Every persistent state-machine kind with UI surface SHALL ship as a module at `ui/kinds/<kind>.js` exporting `{ dispatch(event), bootstrap(cap) }`. Co-located CSS lives at `ui/kinds/<kind>.css`. `ui/main.js` SHALL delegate to the per-kind module when it sees an SSE event whose `kind` field starts with that module's prefix.

Layout, composer, header, and other non-kind UI concerns remain in `ui/main.js` and `ui/style.css`.

`ui/index.html` SHALL load per-kind modules via `<script type="module">`. No inline event handlers (`onclick=`, etc.) are permitted; all interaction uses `addEventListener`.

#### Scenario: SSE event routes to the matching UI module

- **GIVEN** the UI registry exposes `handoffUI`, `interruptUI`, `permissionUI`
- **WHEN** an SSE event arrives with `kind: "permission.new"`
- **THEN** `permissionUI.dispatch(event)` is invoked
- **AND** `handoffUI.dispatch` is not invoked

#### Scenario: Adding a UI kind requires no edits to main.js

- **WHEN** a developer adds `ui/kinds/foo.js` exporting the UI module contract, adds a `<script type="module">` entry in `index.html`, and registers it in the UI kind registry
- **THEN** `ui/main.js` requires zero edits
- **AND** `ui/style.css` requires zero edits (kind-specific CSS lives in `ui/kinds/foo.css`)

### Requirement: Contract conformance is enforced by test

A `tests/contract/has-required-hooks.test.ts` file SHALL iterate every module in `KINDS` and assert the presence and callable shape of `kind`, `migrate`, `routes`, `pendingFor`, `toolNames`. A second test SHALL assert no two kinds declare the same `kind` string or the same `(method, path)` tuple.

These tests fail the build; a kind that satisfies the TypeScript type but leaves a hook as an empty stub is caught at test time.

#### Scenario: Half-implemented kind fails the conformance test

- **GIVEN** a `KindModule` named `foo` declares `kind: "foo"` but leaves `migrate` as `() => { throw new Error("not implemented") }` or omits `routes`
- **WHEN** `bun test tests/contract` runs
- **THEN** the conformance test fails with a message identifying `foo` and the missing or stubbed hook

#### Scenario: Duplicate kind name fails the uniqueness test

- **GIVEN** two kinds both declare `kind: "handoff"`
- **WHEN** the uniqueness test runs
- **THEN** the test fails with a message listing the conflicting modules

### Requirement: Nutshell is not a kind

The nutshell single-row document SHALL NOT implement the `KindModule` contract. It remains an ad-hoc module at `hub/nutshell.ts` exposing `readNutshell`, `writeNutshellInTx`, and `broadcastNutshell`. Its write path continues to piggyback on the handoff primitive via the `[nutshell]` task prefix — no separate edit route.

Forcing nutshell into `KindModule` would require most hooks to be empty or faked, visibly wrong against the narrow "persistent state-machine entity" purpose of the contract. A sibling `Document` interface is deferred until a second document-like entity exists.

#### Scenario: Nutshell does not appear in the kind registry

- **GIVEN** v0.9.5 has shipped
- **WHEN** reading `hub/kinds/index.ts`
- **THEN** `nutshell` is not listed in `KINDS`
- **AND** the contract conformance test does not include it
- **AND** `hub/nutshell.ts` exists as a standalone module

### Requirement: `KindModule` extends `HubFeature`

`KindModule` SHALL be defined as a TypeScript subtype of `HubFeature` (the parent contract introduced in the new `route-modules` capability). `HubFeature` provides the `routes: RouteDef[]` baseline; `KindModule` adds kind-specific fields (`kind`, `store`, `stateMachine`, `pendingFor`, `toolNames`, `priority`). The dispatcher consumes `HubFeature[]` for route registration; the briefing aggregator filters for the `KindModule` shape (those with `toolNames`) for tool list aggregation.

#### Scenario: Mixed feature/kind array dispatches uniformly

- **GIVEN** the hub assembles `FEATURES = [chatFeature, transcriptFeature, handoffKind, interruptKind, permissionKind]` typed as `HubFeature[]`
- **WHEN** the dispatcher compiles routes from this array
- **THEN** all five contribute their routes to the dispatch table
- **AND** `requireAuth` / `requireJsonBody` / ledger-guard apply uniformly across kind and non-kind routes

#### Scenario: Briefing tool aggregation filters for KindModule

- **WHEN** the briefing builder assembles the tool list for an agent's briefing
- **THEN** it filters `FEATURES` for those satisfying the `KindModule` shape (those declaring `toolNames`)
- **AND** non-kind features (chat, transcript, sessions, usage, etc.) are excluded from the tool list

### Requirement: A kind may gate a transition on another kind's table without orchestrator changes

A `KindModule` SHALL be able to read another kind's derived table inside its own
transition decision, through the injected `HubCapabilities` DB handle, without the
orchestrator in `hub.ts` gaining any kind-specific branch. A kind MAY create another
kind's row only through that kind's exported create helper, with its own derived update as
a side effect in the same transaction, so the transaction still writes exactly one event.

#### Scenario: Ticket completion reads permission rows

- **WHEN** the `ticket` kind decides a transition to `done` for a high-blast-radius ticket
- **THEN** it reads the `permissions` table through `HubCapabilities` within the same transaction
- **AND** `hub.ts` contains no branch naming either kind
- **AND** `hub/kinds/permission.ts` changes only by exporting its create helper

#### Scenario: Registration remains a single array entry

- **WHEN** the `ticket` kind is added
- **THEN** the only orchestrator change is one additional entry in the `KINDS` array

### Requirement: Kinds may add lines to the Briefing through an optional hook

`KindModule` SHALL gain an optional `briefingLines(agent, cap)` hook that returns text
lines for that agent's Briefing. The Briefing assembly SHALL collect the lines of every
kind in `KINDS` order with no kind-specific branch, SHALL include them in the Briefing
signature, and the bridge core SHALL render them in the Briefing text for both runtimes.
`HubCapabilities` SHALL gain `briefing.refresh()`, which schedules the Briefing dispatcher's
debounced fan-out; a kind SHALL call it after a committed change that can alter its lines.

#### Scenario: A change to a kind's lines re-sends the Briefing

- **GIVEN** agent `alice` received a Briefing
- **WHEN** a kind commits a change that alters its `briefingLines` for `alice` and calls `briefing.refresh()`
- **THEN** the dispatcher rebuilds the Briefing and its signature for `alice` changes
- **AND** `alice` receives a new Briefing in `context` mode

#### Scenario: Kinds without the hook are unaffected

- **WHEN** a kind does not define `briefingLines`
- **THEN** it contributes no lines and the Briefing is otherwise unchanged
