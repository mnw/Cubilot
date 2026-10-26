// Kind registry — adding a Kind = one import + one array entry HERE.
// hub.ts calls `buildKinds` to construct the `KINDS` array; no edit to hub.ts
// is required for new Kinds (per kind-runtime/spec.md "Adding a kind is a single-file
// change").

import type { Database } from "bun:sqlite";
import type { KindModule } from "../core/types";
import { createHandoffKind, createSystemHandoff } from "./handoff";
import { createInterruptKind } from "./interrupt";
import { createPermissionKind } from "./permission";
import { createStageRuntime } from "./stage";
import { createTicketKind } from "./ticket";

export type KindFactory = (db: Database) => KindModule;

/** Construct all Kinds against the live ledger db. Empty array when ledger disabled. */
export function buildKinds(db: Database | null): readonly KindModule[] {
  if (!db) return [];
  // The handoff kind calls the stage runtime when a handoff names a role, so the two share one runtime.
  const stage = createStageRuntime(db, {
    ackMs: Number(process.env.CUBILOT_LAUNCH_ACK_MS) || undefined,
    // A stage that failed twice goes to the room's Orchestrator (its lead) as a handoff from the hub (stage-sessions 5.3).
    onFinalFailure({ stage: s, room, reason }, cap) {
      if (!room) return;
      const lead = db.query<{ agent: string }, [string]>("SELECT agent FROM ticket_room_lead WHERE room = ?").get(room)?.agent ?? "Orchestrator";
      if (!cap.agents.get(lead)) {
        console.error(`[stage] stage ${s.id} failed for good (${reason}); no Orchestrator "${lead}" in the roster to tell`);
        return;
      }
      createSystemHandoff(db, cap, {
        to: lead,
        room,
        task: `Stage ${s.id} (${s.role}${s.ticket_id ? `, ticket ${s.ticket_id}` : `, request ${s.request_id}`}) failed twice. Last reason: ${reason}. The stage is failed and no session is left. Decide what to do.`,
        context: { stage_id: s.id, ticket_id: s.ticket_id, request_id: s.request_id, role: s.role, reason },
      });
    },
  });
  return [
    createHandoffKind(db, stage.hooks),
    createInterruptKind(db),
    createPermissionKind(db),
    createTicketKind(db, stage.hooks),
    stage.module,
  ];
}
