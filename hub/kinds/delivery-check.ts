// Delivery-check kind (Part 14 H3): the human's mark on one check of a delivery. A check is a numbered criterion of a
// ticket of the request (check_id `<ticket_id>#<n>`, hub/core/delivery-report.ts). Status = the mark: works | problem.
// A new mark for the same check replaces the row and writes a new event. A problem mark also writes the ticket note, the
// ticket attachments and the move done -> queued in the same transaction (the fourth cross-kind transaction).

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Decision, Entry, HubCapabilities, KindModule, RouteDef, StateMachineDecl, VerbDecl } from "../core/types";
import { LedgerConflict } from "../core/types";
import { createLedgerEntity, ledgerConflictResponse, withLedgerRequired } from "../core/ledger-entity";
import { ts, validName, validRoomLabel } from "../core/ids";
import { pausedRefusal } from "../core/auth";
import { IMAGE_URL_RE, imageUrlToPath } from "../core/attachments";
import { checkRows } from "../core/delivery-report";
import { reopenDoneInTx } from "./ticket";
import type { StageHooks } from "./stage";

export type DeliveryMark = "works" | "problem";
export type MarkAttachment = { url: string; name: string };

export type DeliveryCheckSnapshot = {
  id: string;
  room: string;
  request_id: string;
  check_id: string;
  ticket_id: string;
  status: DeliveryMark;
  note: string;
  attachments: MarkAttachment[];
  marked_by: string;
  marked_at_ms: number;
  version: number;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CHECK_ID_RE = /^(t_[0-9a-f]{16})#([1-9]\d{0,2})$/;
const NOTE_MAX_BYTES = 3_500; // room for the prefix inside the ticket note cap of 4096 bytes
const ATTACHMENTS_MAX = 10;
const BODY_MAX = 16_384;

const checkDecl: StateMachineDecl<DeliveryCheckSnapshot> = {
  kind: "delivery_check",
  table: "delivery_checks",
  columns: {
    id: "TEXT",
    room: "TEXT",
    request_id: "TEXT",
    check_id: "TEXT",
    ticket_id: "TEXT",
    status: "TEXT",
    note: "TEXT",
    attachments: "JSON",
    marked_by: "TEXT",
    marked_at_ms: "INTEGER",
  },
  terminalStatuses: new Set(),
  rowToSnapshot: (row) => ({
    id: row.id as string,
    room: row.room as string,
    request_id: row.request_id as string,
    check_id: row.check_id as string,
    ticket_id: row.ticket_id as string,
    status: row.status as DeliveryMark,
    note: row.note as string,
    attachments: JSON.parse((row.attachments as string | null) ?? "[]") as MarkAttachment[],
    marked_by: row.marked_by as string,
    marked_at_ms: Number(row.marked_at_ms),
    version: Number(row.version ?? 0),
  }),
  snapshotToRow: (snap) => {
    const out: Record<string, unknown> = {};
    for (const k of ["id", "room", "request_id", "check_id", "ticket_id", "status", "note", "marked_by", "marked_at_ms"] as const) {
      if (snap[k] !== undefined) out[k] = snap[k];
    }
    if (snap.attachments !== undefined) out.attachments = JSON.stringify(snap.attachments);
    return out;
  },
};

/** One row for each check: the id is a hash of room, request and check, so a second mark finds the first. */
export const checkRowId = (room: string, requestId: string, checkId: string): string =>
  `dc_${new Bun.CryptoHasher("sha256").update(`${room}\0${requestId}\0${checkId}`).digest("hex").slice(0, 16)}`;

function checkEntry(snapshot: DeliveryCheckSnapshot): Entry {
  return { from: snapshot.marked_by, to: "all", text: `[delivery check ${snapshot.check_id} ${snapshot.status}]`, ts: ts(), image: null, room: snapshot.room, kind: "delivery_check.marked", version: snapshot.version, snapshot };
}

type MarkInput = { room: string; request_id: string; check_id: string; ticket_id: string; mark: DeliveryMark; note: string; attachments: MarkAttachment[] };

const markVerb: VerbDecl<DeliveryCheckSnapshot, MarkInput> = {
  decide(prior, p, actor): Decision<DeliveryCheckSnapshot> {
    const at = Date.now();
    const fields = { status: p.mark, note: p.note, attachments: p.attachments, marked_by: actor, marked_at_ms: at };
    const payload = () => ({ actor, check_id: p.check_id, ticket_id: p.ticket_id, mark: p.mark, note: p.note, attachments: p.attachments });
    if (!prior) {
      const initial: DeliveryCheckSnapshot = { id: checkRowId(p.room, p.request_id, p.check_id), room: p.room, request_id: p.request_id, check_id: p.check_id, ticket_id: p.ticket_id, ...fields, version: 0 };
      return { kind: "create", initial, eventKind: "delivery_check.marked", payload, entry: checkEntry };
    }
    // Always a new event: the second mark replaces the first, also with the same content.
    return { kind: "transition", next: fields, eventKind: "delivery_check.marked", payload, entry: checkEntry };
  },
  scope: (post) => ({ kind: "room", room: post.room }),
};

const baseName = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

export function createDeliveryCheckKind(db: Database, stage?: Pick<StageHooks, "onTicketChanged">): KindModule {
  const entity = createLedgerEntity({ decl: checkDecl, db });

  /** The attachment ids of the body as /image/<id>.<ext> URLs, or why they are refused. */
  function parseAttachments(raw: unknown, cap: HubCapabilities): MarkAttachment[] | string {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > ATTACHMENTS_MAX) return `attachment_ids must be a list of up to ${ATTACHMENTS_MAX} uploaded files`;
    const out: MarkAttachment[] = [];
    for (const v of raw) {
      if (typeof v !== "string") return "each attachment id must be text";
      const id = v.trim();
      const url = id.startsWith("/image/") ? id : `/image/${id}`;
      if (!IMAGE_URL_RE.test(url)) return "each attachment id must be an uploaded file: <id>.<ext>";
      const ext = url.slice(url.lastIndexOf(".") + 1).toLowerCase();
      if (!cap.config.allowedExtensions.has(ext)) return `file type .${ext} is not allowed`;
      if (!existsSync(imageUrlToPath(url, cap.config.attachmentsDir))) return "no such uploaded file";
      if (!out.some((a) => a.url === url)) out.push({ url, name: baseName(url) });
    }
    return out;
  }

  const routes: RouteDef[] = [
    {
      // Human only. One transaction: the mark and, for a problem, the ticket note, files and the move back to queued.
      method: "POST",
      path: /^\/requests\/([^/]+)\/([^/]+)\/delivery\/checks$/,
      auth: "mutating",
      caller: "human",
      bodyMax: BODY_MAX,
      handler: async (req, cap) => {
        const parts = new URL(req.url).pathname.split("/");
        const room = decodeURIComponent(parts[2] ?? "");
        const requestId = decodeURIComponent(parts[3] ?? "");
        if (!validRoomLabel(room)) return Response.json({ error: "invalid room" }, { status: 400 });
        if (!REQUEST_ID_RE.test(requestId)) return Response.json({ error: "invalid request id" }, { status: 400 });
        const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
        // The route is human-only (dispatcher gate), so an absent by means the human.
        const by = body.by === undefined ? cap.config.humanName : typeof body.by === "string" ? body.by.trim() : "";
        if (!validName(by)) return Response.json({ error: "invalid by" }, { status: 400 });
        if (cap.agents.isPaused(by)) return pausedRefusal();
        if (by !== cap.config.humanName) return Response.json({ error: "only the human may mark a delivery check" }, { status: 403 });
        const mark = body.mark;
        if (mark !== "works" && mark !== "problem") return Response.json({ error: "mark must be works or problem" }, { status: 400 });
        if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return Response.json({ error: "note must be text" }, { status: 400 });
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (new TextEncoder().encode(note).length > NOTE_MAX_BYTES) return Response.json({ error: `note too long (max ${NOTE_MAX_BYTES} bytes)` }, { status: 400 });
        if (mark === "problem" && !note) return Response.json({ error: "a problem mark needs a note" }, { status: 400 });
        const m = typeof body.check_id === "string" ? CHECK_ID_RE.exec(body.check_id) : null;
        if (!m) return Response.json({ error: "check_id must be <ticket_id>#<n>" }, { status: 400 });
        const checkId = body.check_id as string;
        const ticketId = m[1];
        const attachments = parseAttachments(body.attachment_ids, cap);
        if (typeof attachments === "string") return Response.json({ error: attachments }, { status: 400 });

        const request = db.query("SELECT 1 FROM requests WHERE room = ? AND request_id = ?").get(room, requestId);
        if (!request) return Response.json({ error: `no request ${requestId} in room ${room}` }, { status: 404 });
        const ticket = db
          .query<{ status: string; acceptance_criteria: string }, [string, string, string]>("SELECT status, acceptance_criteria FROM tickets WHERE id = ? AND room = ? AND request_id = ?")
          .get(ticketId, room, requestId);
        if (!ticket || !checkRows(ticketId, ticket.acceptance_criteria).some((c) => c.check_id === checkId)) {
          return Response.json({ error: `no check ${checkId} in request ${requestId}` }, { status: 404 });
        }
        if (mark === "works" && ticket.status !== "done") return Response.json({ error: `the ticket is ${ticket.status}: a works mark needs a done ticket` }, { status: 409 });
        if (ticket.status === "cancelled") return Response.json({ error: "the ticket is cancelled" }, { status: 409 });

        const id = checkRowId(room, requestId, checkId);
        const input: MarkInput = { room, request_id: requestId, check_id: checkId, ticket_id: ticketId, mark, note, attachments };
        try {
          const r = entity.applyWithSideEffect(id, markVerb, input, by, cap, () => {
            if (mark !== "problem") return null;
            const at = Date.now();
            const text = `Delivery check ${checkId} problem: ${note}`;
            const noteId = cap.events.insert(db, ticketId, "ticket.noted", by, { text }, at);
            db.run("INSERT INTO ticket_notes (id, ticket_id, author, text, created_at_ms) VALUES (?, ?, ?, ?, ?)", [noteId, ticketId, by, text, at]);
            const files: { id: number; author: string; name: string; url: string; created_at_ms: number }[] = [];
            for (const a of attachments) {
              if (db.query("SELECT 1 FROM ticket_attachments WHERE ticket_id = ? AND url = ?").get(ticketId, a.url)) continue;
              const fid = cap.events.insert(db, ticketId, "ticket.attached", by, { url: a.url, name: a.name }, at);
              db.run("INSERT INTO ticket_attachments (id, ticket_id, author, name, url, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)", [fid, ticketId, by, a.name, a.url, at]);
              files.push({ id: fid, author: by, name: a.name, url: a.url, created_at_ms: at });
            }
            return { note: { id: noteId, author: by, text, created_at_ms: at }, files, reopened: reopenDoneInTx(db, ticketId, by) };
          });
          const effect = r.sideEffectResult;
          let ticketStatus = ticket.status;
          if (effect) {
            const count = (table: string) => db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`).get(ticketId)!.n;
            cap.sse.emit(
              { kind: "ticket.noted", ticket_id: ticketId, room, version: effect.note.id, notes_count: count("ticket_notes"), note: effect.note, from: by, to: "all", text: `[note on ${ticketId}]`, ts: ts(), image: null },
              { kind: "ui-only-ambient" },
            );
            for (const f of effect.files) {
              cap.sse.emit(
                { kind: "ticket.attached", ticket_id: ticketId, room, version: f.id, attachments_count: count("ticket_attachments"), attachment: f, from: by, to: "all", text: `[attachment on ${ticketId}]`, ts: ts(), image: null },
                { kind: "ui-only-ambient" },
              );
            }
            if (effect.reopened) {
              ticketStatus = effect.reopened.snapshot.status;
              cap.sse.emit(effect.reopened.entry, { kind: "room", room });
              cap.briefing.refresh();
              stage?.onTicketChanged(ticketId, cap);
            }
          }
          return Response.json({ snapshot: r.snapshot, ticket: { id: ticketId, status: ticketStatus }, reopened: !!effect?.reopened }, { status: 200 });
        } catch (e) {
          if (e instanceof LedgerConflict) return ledgerConflictResponse(e);
          throw e;
        }
      },
    },
  ];

  return {
    kind: "delivery_check",
    migrate: (d: Database) => {
      entity.migrate(d);
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_delivery_checks_check" ON "delivery_checks" ("room", "request_id", "check_id")`);
    },
    routes: withLedgerRequired(routes),
    pendingFor: () => [],
    toolNames: [],
  };
}
