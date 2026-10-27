// hub/kinds/<kind>.ts
//
// Starter skeleton for a new persistent state-machine kind.
// Replace every <kind> / <Kind> with the actual name (e.g. "signoff" / "Signoff").
// Every hook here corresponds to an integration point in the KindModule contract (design.md §1).
// Delete any comment you don't need before committing.

import type { Database } from "bun:sqlite";
import type {
  KindModule,
  RouteDef,
  HubCapabilities,
  AgentCtx,
  Entry,
  Scope,
} from "../core/types";
// ^ Post-v0.9.5 path. Pre-v0.9.5 these types don't exist as a module — they're
// implicit in hub.ts. When landing inline into hub.ts, drop this import and use
// the ambient types (the existing handoff/interrupt/permission code is the
// de-facto spec). See SKILL.md "Pre-extraction reality".

// ---------------------------------------------------------------------------
// 1. Schema migration — idempotent, additive. Runs once at hub boot.
//    Bump the ledger schema version in hub.ts when adding new tables (the
//    migrations are guarded by `if (current < N)` blocks; add yours at the end).
// ---------------------------------------------------------------------------
function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS <kind>s (
      id          TEXT PRIMARY KEY,
      -- state fields go here. Pick your own state machine shape; don't try
      -- to conform to handoff/interrupt/permission — they diverge on purpose.
      created_ms  INTEGER NOT NULL,
      resolved_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_<kind>s_unresolved
      ON <kind>s(resolved_ms) WHERE resolved_ms IS NULL;
  `);
}

// ---------------------------------------------------------------------------
// 2. ID source decision (READ FIRST)
//
// Kinds diverge on where the id comes from:
//   - handoff / interrupt: hub mints (`h_<16 hex>` / `i_<16 hex>`)
//   - permission:          caller supplies (claude's request_id, 5 letters a-km-z)
//
// Pick one and commit to it; don't try to support both. For hub-minted:
//     const id = cap.ids.mint("<short-prefix>");
// For caller-supplied, validate with a regex and reject on conflict:
//     if (!/^<your-pattern>$/.test(body.id)) return json({ error: "invalid id" }, 400);
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Routes — static declaration. Hub registers these; handlers receive `cap` per request.
//    Auth levels: "mutating" = requireAuth + body cap; "read" = requireReadAuth.
//    Body cap is kind-specific — 16 KiB is a reasonable default for structured
//    metadata; go higher only if you have real justification (handoff uses 1 MiB
//    to carry diffs/contracts in `context`).
// ---------------------------------------------------------------------------
const routes: RouteDef[] = [
  {
    method: "POST",
    path: "/<kind>s",
    auth: "mutating",
    bodyMax: 16_384,
    handler: async (req, cap, _params) => {
      const body = (await req.json().catch(() => ({}))) as { /* ... */ };
      const id = cap.ids.mint("<short-prefix>"); // or caller-supplied — see §2
      const now = Date.now();

      // Single transaction: ledger event + derived row. Matches handoff/interrupt/permission.
      cap.db.transaction(() => {
        cap.events.insert(cap.db, id, "<kind>.new", /* actor */ "system", body, now);
        cap.db.run(
          `INSERT INTO <kind>s (id, created_ms) VALUES (?, ?)`,
          [id, now],
        );
      })();

      // Build the snapshot, then the Entry. Entry shape mirrors handoffEntry /
      // interruptEntry / permissionEntry in hub.ts — from, to, text, ts, image,
      // kind, <kind>_id, version, replay, snapshot. UI dispatch + chat log
      // both key off this shape.
      const snapshot = loadSnapshot(cap.db, id);
      const entry = buildEntry(snapshot, "<kind>.new", /* replay */ false);

      // Pick the scope deliberately per verb (design.md §4):
      //   { kind: "broadcast" }                        UI + all non-permanent agents
      //   { kind: "to-agents", agents: [...] }         UI + specific agents
      //   { kind: "ui-only" }                          UI only (no agent notification)
      //   { kind: "room", room: "..." }                room-filtered (v0.9)
      cap.sse.emit(entry, { kind: "broadcast" });

      return new Response(JSON.stringify({ id, snapshot }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
  {
    method: "GET",
    path: "/<kind>s",
    auth: "read",
    handler: (_req, cap) => {
      const rows = cap.db.query(`SELECT * FROM <kind>s ORDER BY created_ms DESC`).all();
      return new Response(JSON.stringify(rows), {
        headers: { "Content-Type": "application/json" },
      });
    },
  },
  // Transition verbs (resolve, cancel, etc.) go here — one RouteDef per verb.
  // Terminal-state policy: same-status retry → 200 idempotent; different-status
  // retry → 409 conflict. Matches handoff/interrupt/permission exactly.
];

// ---------------------------------------------------------------------------
// 4. pendingFor — on agent reconnect (/agent-stream), return the entries this
//    agent needs to catch up on. The orchestrator flips `replay = true` on each
//    entry (the `buildEntry` helper takes a `replay` arg; pass `true` here).
//    Order is this kind's choice (e.g. newest-first). Do NOT rely on ordering
//    between kinds (design.md §6).
// ---------------------------------------------------------------------------
function pendingFor(agent: AgentCtx, cap: HubCapabilities): Entry[] {
  const rows = cap.db.query(`
    SELECT * FROM <kind>s
    WHERE resolved_ms IS NULL
    ORDER BY created_ms DESC
  `).all() as Array<{ id: string; created_ms: number }>;

  return rows.map((r) => {
    const snapshot = loadSnapshot(cap.db, r.id);
    return buildEntry(snapshot, "<kind>.new", /* replay */ true);
  });
}

// ---------------------------------------------------------------------------
// 5. toolNames — which MCP tools this kind exposes via channel.ts. The briefing
//    aggregates across kinds. Keep names namespaced by kind (e.g. "<kind>_create",
//    "<kind>_resolve"). The tool schemas + dispatcher branches live in
//    hub/channel.ts — see SKILL.md "Chatbridge wiring" for the channel-side
//    additions that pair with this field.
// ---------------------------------------------------------------------------
const toolNames = ["<kind>_create", "<kind>_resolve"];

// ---------------------------------------------------------------------------
// 6. priority (optional) — leave undefined unless this kind MUST replay before
//    others (rare; design.md §6 describes the escape-hatch intent).
// ---------------------------------------------------------------------------

export const <kind>Kind: KindModule = {
  kind: "<kind>",
  migrate,
  routes,
  pendingFor,
  toolNames,
  // priority: 0,
};

// ---------------------------------------------------------------------------
// Helpers (keep private to this module)
// ---------------------------------------------------------------------------

type <Kind>Snapshot = {
  id: string;
  created_ms: number;
  resolved_ms: number | null;
  version: number;
};

function loadSnapshot(db: Database, id: string): <Kind>Snapshot {
  const row = db.query<any, [string]>("SELECT * FROM <kind>s WHERE id = ?").get(id);
  const verRow = db.query<{ max_seq: number | null }, [string]>(
    "SELECT MAX(seq) AS max_seq FROM events WHERE entity_id = ?", // pre-v0.9.5: handoff_id
  ).get(id);
  return { ...row, version: verRow?.max_seq ?? 0 };
}

function buildEntry(
  snapshot: <Kind>Snapshot,
  eventKind: string,
  replay: boolean,
): Entry {
  // Shape mirrors handoffEntry (hub.ts:~1740) / interruptEntry / permissionEntry.
  // UI dispatch keys off `kind` prefix; card version-reconcile uses `version`;
  // replay banner uses `replay`; card body uses `snapshot`.
  return {
    from: /* agent or "all" */ "all",
    to: "all",
    text: JSON.stringify(snapshot),
    ts: new Date().toTimeString().slice(0, 8),
    image: null,
    kind: eventKind,
    // The per-kind id field is conventional — handoff uses `handoff_id`,
    // interrupt uses `interrupt_id`, permission uses `permission_id`.
    // Use `<kind>_id` for consistency.
    ["<kind>_id"]: snapshot.id,
    version: snapshot.version,
    replay,
    snapshot,
  } as unknown as Entry;
}
