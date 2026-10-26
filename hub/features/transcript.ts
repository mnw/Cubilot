// Transcript feature — per-room settings + transcript file mgmt + clear-transcript.
// Carved out of hub.ts inline routes in architecture-cycle-2a §4.

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { HubFeature, Entry } from "../core/types";
import { validRoomLabel } from "../core/ids";
import {
  DEFAULT_ROLE_LIMITS,
  DEFAULT_STAGE_TIMEOUT_MIN,
  STAGE_ROLES,
  getRoomSettings,
  setRoomSettings,
  type RoleLimits,
} from "../core/ledger";
import * as transcriptStore from "../core/transcript";
import type { RoomSummariser } from "../core/room-summariser";

export type TranscriptDeps = {
  db: Database;
  chatLog: Entry[];
  roomSummariser: RoomSummariser | null;
};

const ROOM_SETTINGS_RE = /^\/rooms\/([^/]+)\/settings$/;
const ROOM_TRANSCRIPTS_RE = /^\/rooms\/([^/]+)\/transcripts$/;
const ROOM_CLEAR_RE = /^\/rooms\/([^/]+)\/clear-transcript$/;

function decodeRoom(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  return validRoomLabel(decoded) ? decoded : null;
}

function projectFolderError(p: string): string | null {
  if (!isAbsolute(p)) return "project_folder must be an absolute path";
  if (!existsSync(p) || !statSync(p).isDirectory()) return "project_folder does not exist";
  const r = Bun.spawnSync(["git", "-C", p, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 && r.stdout.toString().trim() === "true" ? null : "project_folder is not a git work tree";
}

function getRoomSettingsResponse(deps: TranscriptDeps, room: string): Response {
  const settings = getRoomSettings(deps.db, room) ?? {
    room,
    persist_transcript: false,
    room_summary_enabled: false,
    worker_limit: null,
    tester_limit: null,
    role_limits: { ...DEFAULT_ROLE_LIMITS },
    stage_timeout_min: DEFAULT_STAGE_TIMEOUT_MIN,
    project_folder: null,
    updated_at: 0,
  };
  const stats = settings.persist_transcript ? transcriptStore.activeStats(room) : null;
  const chunks = settings.persist_transcript ? transcriptStore.listChunks(room) : [];
  let summary: { l1_count: number; l2_count: number; last_summarised_line: number; adapter_active: boolean } | null = null;
  if (settings.room_summary_enabled) {
    const l1 = deps.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM room_summary WHERE room=? AND level=1")
      .get(room);
    const l2 = deps.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM room_summary WHERE room=? AND level=2")
      .get(room);
    const last = deps.db
      .query<{ m: number | null }, [string]>("SELECT MAX(end_line) AS m FROM room_summary WHERE room=? AND level=1")
      .get(room);
    summary = {
      l1_count: l1?.c ?? 0,
      l2_count: l2?.c ?? 0,
      last_summarised_line: last?.m ?? 0,
      adapter_active: deps.roomSummariser !== null,
    };
  }
  return Response.json({ settings, active: stats, chunks, summary });
}

export function createTranscriptFeature(deps: TranscriptDeps): HubFeature {
  return {
    routes: [
      {
        method: "GET",
        path: ROOM_SETTINGS_RE,
        auth: "read",
        requiresLedger: true,
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          return getRoomSettingsResponse(deps, room);
        },
      },
      {
        method: "PUT",
        path: ROOM_SETTINGS_RE,
        auth: "mutating",
        requiresLedger: true,
        handler: async (req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          type Body = {
            persist_transcript?: unknown;
            room_summary_enabled?: unknown;
            worker_limit?: unknown;
            tester_limit?: unknown;
            role_limits?: unknown;
            stage_timeout_min?: unknown;
            project_folder?: unknown;
          };
          let body: Body;
          try {
            body = (await req.json()) as Body;
          } catch {
            return Response.json({ error: "invalid json" }, { status: 400 });
          }
          // `null`, a number, a string or an array is valid JSON but not a settings object: `in` would throw (500).
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            return Response.json({ error: "body must be a JSON object" }, { status: 400 });
          }
          const partial: {
            persist_transcript?: boolean;
            room_summary_enabled?: boolean;
            worker_limit?: number | null;
            tester_limit?: number | null;
            role_limits?: Partial<RoleLimits> | null;
            stage_timeout_min?: number | null;
            project_folder?: string | null;
          } = {};
          // Stage-session limits: an object of role -> whole number 0..10 (listed roles only), or null for the defaults.
          if ("role_limits" in body) {
            const v = body.role_limits;
            if (v !== null) {
              if (typeof v !== "object" || Array.isArray(v)) {
                return Response.json({ error: "role_limits must be an object or null" }, { status: 400 });
              }
              for (const [role, n] of Object.entries(v)) {
                if (!(STAGE_ROLES as readonly string[]).includes(role)) {
                  return Response.json({ error: `role_limits: unknown role ${role}` }, { status: 400 });
                }
                if (!(typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10)) {
                  return Response.json({ error: `role_limits.${role} must be a whole number 0 to 10` }, { status: 400 });
                }
              }
            }
            partial.role_limits = v as Partial<RoleLimits> | null;
          }
          if ("stage_timeout_min" in body) {
            const v = body.stage_timeout_min;
            if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1)) {
              return Response.json({ error: "stage_timeout_min must be a whole number of 1 or more, or null" }, { status: 400 });
            }
            partial.stage_timeout_min = v as number | null;
          }
          // The project folder: an absolute path to an existing git work tree, or null to clear.
          if ("project_folder" in body) {
            const v = body.project_folder;
            if (v !== null) {
              const err = typeof v === "string" ? projectFolderError(v) : "project_folder must be a string or null";
              if (err) return Response.json({ error: err }, { status: 400 });
            }
            partial.project_folder = v as string | null;
          }
          // Factory-room limits: a whole number 1..20, or null to clear. Anything else is a 400, nothing is written.
          for (const key of ["worker_limit", "tester_limit"] as const) {
            if (!(key in body)) continue;
            const v = body[key];
            if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20)) {
              return Response.json({ error: `${key} must be a whole number 1 to 20, or null` }, { status: 400 });
            }
            partial[key] = v as number | null;
          }
          if ("persist_transcript" in body) {
            if (typeof body.persist_transcript !== "boolean") {
              return Response.json({ error: "persist_transcript must be boolean" }, { status: 400 });
            }
            partial.persist_transcript = body.persist_transcript;
          }
          if ("room_summary_enabled" in body) {
            if (typeof body.room_summary_enabled !== "boolean") {
              return Response.json({ error: "room_summary_enabled must be boolean" }, { status: 400 });
            }
            partial.room_summary_enabled = body.room_summary_enabled;
          }
          setRoomSettings(deps.db, room, partial);
          if (partial.room_summary_enabled === true && deps.roomSummariser) {
            deps.roomSummariser
              .maybeBackfill(room)
              .catch((e) => console.error(`[summariser] backfill on opt-in failed for ${room}:`, e));
          }
          return getRoomSettingsResponse(deps, room);
        },
      },
      {
        method: "GET",
        path: ROOM_TRANSCRIPTS_RE,
        auth: "read",
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          const active = transcriptStore.activeStats(room);
          const chunks = transcriptStore.listChunks(room);
          const totalBytes = active.sizeBytes + chunks.reduce((s, c) => s + c.sizeBytes, 0);
          return Response.json({ active, chunks, totalBytes });
        },
      },
      {
        method: "POST",
        path: ROOM_CLEAR_RE,
        auth: "mutating",
        requiresLedger: true,
        handler: (_req, _cap, params) => {
          const room = decodeRoom(params.id);
          if (!room) return Response.json({ error: "invalid room label" }, { status: 400 });
          const settings = getRoomSettings(deps.db, room);
          const result = transcriptStore.rotateActive(room);
          for (let i = deps.chatLog.length - 1; i >= 0; i--) {
            if (deps.chatLog[i]!.room === room) deps.chatLog.splice(i, 1);
          }
          return Response.json({ archivedTo: result.archivedTo, persistence: settings?.persist_transcript ?? false });
        },
      },
    ],
  };
}
