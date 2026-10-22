// briefing.ts — Briefing assembly for new-agent reconnect (Concern B).
//
// Replaces the inline buildBriefing() in hub.ts. Composes layers:
//   1. Nutshell (existing — hand-curated)
//   2. L2 rollups (Phase 3 — auto, deepest history compressed)
//   3. Unrolled L1 entries (Phase 3 — auto, recent granular)
//   4. Peers + tool list + dirs (existing infrastructure)
//
// Lazy-hydrate trigger and maybeBackfill are NOT inside this module — the
// Briefing path stays read-only. hub.ts kicks them off fire-and-forget AFTER
// Briefing is sent (Concern F).

import type { Database } from "bun:sqlite";

import type { AgentRegistry } from "./agents";
import type { HubCapabilities, KindModule } from "./types";
import type { RoomSummariser, SummaryRow } from "./room-summariser";
import { readNutshell } from "../nutshell";
import { ts } from "./ids";

export type BriefingPayload = {
  type: "briefing";
  ts: string;
  room: string | null;
  tools: string[];
  peers: Array<{ name: string; online: boolean; room: string | null }>;
  attachments_dir: string;
  human_name: string;
  nutshell: string | null;
  // Version folder of the staged factory files (null when the hub got none): a change makes bridges reload.
  factory_version: string | null;
  // Lines contributed by kinds' optional briefingLines hook, in KINDS order.
  kind_lines: string[];
  // Phase 3 layers — null when summariser is disabled.
  room_summary: {
    rollups: Array<{ start_line: number; end_line: number; model: string; summary: string }>;
    recent_blocks: Array<{ start_line: number; end_line: number; model: string; summary: string }>;
  } | null;
};

export type BriefingBuilderOptions = {
  agents: AgentRegistry;
  kinds: readonly KindModule[];
  ledgerDb: Database | null;
  ledgerEnabled: boolean;
  roomSummariser: RoomSummariser | null;
  defaultRoom: string;
  attachmentsDir: string;
  humanName: string;
  factoryVersion?: string | null;
  // Needed only for kinds' briefingLines; omitted → no kind lines.
  buildCap?: () => HubCapabilities;
};

export type BriefingBuilder = {
  build(agent: string): BriefingPayload;
};

export function createBriefingBuilder(opts: BriefingBuilderOptions): BriefingBuilder {
  function build(agent: string): BriefingPayload {
    const me = opts.agents.get(agent);
    const myRoom = me?.room ?? opts.defaultRoom;

    const peers: Array<{ name: string; online: boolean; room: string | null }> = [];
    for (const [name, a] of opts.agents.entries()) {
      if (name === agent) continue;
      // Same-room peers + cross-room permanent members (human = room null).
      if (a.room !== null && a.room !== myRoom) continue;
      peers.push({
        name,
        online: opts.agents.isPermanent(name) ? true : opts.agents.connectionCount(name) > 0,
        room: a.room,
      });
    }

    const nutshell = opts.ledgerEnabled ? readNutshell(opts.ledgerDb, myRoom).text : "";

    const kind_lines: string[] = [];
    if (opts.ledgerEnabled && opts.buildCap && me) {
      const cap = opts.buildCap();
      const ctx = { name: me.name, room: me.room, permanent: opts.agents.isPermanent(agent) };
      for (const k of opts.kinds) {
        if (!k.briefingLines) continue;
        try {
          kind_lines.push(...k.briefingLines(ctx, cap));
        } catch (e) {
          console.error(`[briefing] ${k.kind} briefingLines failed:`, e);
        }
      }
    }

    let room_summary: BriefingPayload["room_summary"] = null;
    if (opts.roomSummariser && myRoom) {
      const rollups = opts.roomSummariser.listL2(myRoom).map(toBriefingRow);
      const recent_blocks = opts.roomSummariser.listUnrolledL1(myRoom).map(toBriefingRow);
      if (rollups.length > 0 || recent_blocks.length > 0) {
        room_summary = { rollups, recent_blocks };
      }
    }

    return {
      type: "briefing",
      ts: ts(),
      room: myRoom,
      tools: ["post", "post_file", ...opts.kinds.flatMap((k) => k.toolNames)],
      peers,
      attachments_dir: opts.attachmentsDir,
      human_name: opts.humanName,
      nutshell: nutshell || null,
      factory_version: opts.factoryVersion || null,
      kind_lines,
      room_summary,
    };
  }

  return { build };
}

function toBriefingRow(
  r: SummaryRow,
): { start_line: number; end_line: number; model: string; summary: string } {
  return {
    start_line: r.start_line,
    end_line: r.end_line,
    model: r.model,
    summary: r.summary,
  };
}

// Lightweight signature for briefing dedup. It covers what the bridge's renderBriefing
// shows an agent and changes at runtime: room, peers, nutshell and kind lines. It must
// NOT cover anything the bridge does not render: a changed signature re-sends the
// briefing, and a re-send of identical text only wakes nothing but wastes context. The
// Phase 3 room summary is in the payload but is not rendered yet, so its layer counts are
// out. If renderBriefing starts to render it, add the counts back (the signature test
// compares signature equality with rendered-text equality and will say so).
export function briefingSignature(b: BriefingPayload): string {
  const peers = b.peers
    .map((p) => `${p.name}:${p.online ? 1 : 0}:${p.room ?? ""}`)
    .sort()
    .join(",");
  return `${b.room ?? ""}|${peers}|${b.nutshell ?? ""}|${b.factory_version ?? ""}|${(b.kind_lines ?? []).join("\n")}`;
}
