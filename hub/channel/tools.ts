// Chatbridge tool registry — schema + handler paired per tool. Each entry is the
// single source of truth for one tool: the JSON schema the runtime advertises AND
// the handler it dispatches to. Adding a tool is one entry in this file; the
// runtime adapters (pi extension, Claude Code mod) stay kind-agnostic.

import type { Host } from "./host";
import { runHandoffGate } from "./core";
import { authedGet, authedPost, authedUpload, PAUSED_LINE, toolError, type HubResponse } from "./hub-client";

export type ToolContext = {
  agent: string;
  hubEnv: string;
  host: Host;
  // The agent's room; list_tickets falls back to it when no `room` argument is given.
  room?: string;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export type ToolHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export type ToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly handler: ToolHandler;
};

// The hub keeps an attachment name to one line of at most 200 characters (a longer one is refused AFTER the
// upload, leaving an orphan file). Collapse whitespace, control and format characters (bidi overrides) to one
// space, and cut a long name in the middle of its stem so the extension survives.
const ATTACH_NAME_MAX = 200;
export function attachmentName(raw: string): string {
  const one = raw.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
  if (one.length <= ATTACH_NAME_MAX) return one;
  const dot = one.lastIndexOf(".");
  const ext = dot > 0 && one.length - dot <= 11 ? one.slice(dot) : "";   // ".jpeg" and the like
  return one.slice(0, ATTACH_NAME_MAX - ext.length).trimEnd() + ext;
}

const TICKET_ID_SCHEMA = { type: "string", pattern: "^t_[0-9a-f]{16}$" };
// The six stage roles. The hub validates them (STAGE_ROLES in hub/core/ledger.ts); this list only feeds the tool schema.
const TICKET_ROLES = ["worker", "tester", "validator", "writer", "editor", "reviewer"];

const errorText = (r: HubResponse): string =>
  r.json && typeof r.json === "object" && typeof (r.json as { error?: unknown }).error === "string"
    ? (r.json as { error: string }).error
    : r.body || `HTTP ${r.status}`;

// The tool says the handoff IS accepted, then names the claim outcome. Never throws:
// the accept stood, and the agent can retry claim_ticket.
async function claimAfterAccept(ctx: ToolContext, ticketId: string): Promise<string> {
  try {
    const r = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(ticketId)}/claim`, { by: ctx.agent });
    if (r.status === 200) return "claimed";
    if (r.status === 409) {
      const snap = (r.json as { snapshot?: { status?: string; assignee?: string | null } } | null)?.snapshot;
      // A cancelled or done ticket is not "claimed"; only name an owner for a live claim.
      if (snap?.status === "cancelled" || snap?.status === "done") return `ticket is ${snap.status}`;
      return snap?.assignee ? `already claimed by ${snap.assignee}` : "already claimed";
    }
    if (r.status === 403) return "ticket in another room";
    if (r.status === 423) return `claim failed: ${PAUSED_LINE}`;
    return `claim failed: ${r.status} ${errorText(r)}`;
  } catch (e) {
    return `claim failed: ${(e as Error)?.message ?? e}`;
  }
}

export const CHATBRIDGE_TOOLS: readonly ToolDef[] = [
  {
    name: "post",
    description: "Post a free-text message to the shared chat room.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body" },
        to: {
          type: "string",
          description:
            'Recipient: "you" (human), "<agent-name>" to address a specific peer, or "all" to broadcast.',
        },
      },
      required: ["text", "to"],
    },
    handler: async (ctx, args) => {
      const text = String(args.text ?? "");
      const to = String(args.to ?? "");
      const resp = await authedPost(ctx.host, ctx.hubEnv, "/post", { from: ctx.agent, to, text });
      if (resp.status < 200 || resp.status >= 300) toolError(resp, "post");
      return { content: [{ type: "text", text: "posted" }] };
    },
  },
  {
    name: "post_file",
    description:
      "Upload a file from your local filesystem and post it as a chat message. The file's extension must match the hub's allowlist (default: jpg, jpeg, png, pdf, md, txt). Returns the absolute filesystem path of the stored attachment (the same path recipients see via the [attachment: ...] marker) — safe to reference in a subsequent send_handoff.context.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path on your local filesystem to the file to upload.",
        },
        to: {
          type: "string",
          description: 'Recipient: "you" (human), "<agent-name>", or "all" (default).',
        },
        caption: {
          type: "string",
          maxLength: 1000,
          description: "Optional text body to accompany the file.",
        },
      },
      required: ["path"],
    },
    handler: async (ctx, args) => {
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("post_file: path is required");
      const to = String(args.to ?? "all");
      const caption = args.caption !== undefined ? String(args.caption) : "";

      const up = await authedUpload(ctx.host, ctx.hubEnv, path);
      if (up.status < 200 || up.status >= 300) toolError(up, "post_file upload");
      const upJson = (up.json ?? {}) as { url?: string; path?: string };
      const url = upJson.url ?? "";
      const fsPath = upJson.path ?? "";
      if (!url) throw new Error("post_file: hub returned no url");

      const send = await authedPost(ctx.host, ctx.hubEnv, "/post", {
        from: ctx.agent,
        to,
        text: caption,
        image: url,
      });
      if (send.status < 200 || send.status >= 300) toolError(send, "post_file send");
      // Return the absolute filesystem path (what the recipient sees via the
      // [attachment: ...] suffix). The virtual /image/ URL is for the UI viewer.
      return { content: [{ type: "text", text: `posted ${fsPath || url}` }] };
    },
  },
  {
    name: "send_handoff",
    description:
      "Transfer a bounded unit of work to another participant, or to a stage role. Name exactly one of to (an agent) and to_role (a stage role: the hub starts a session for it). A to_role handoff needs context.ticket_id, or review \"spec\" (to_role validator) with request_id and context.request_text. Returns a handoff_id the recipient will accept or decline.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient agent name (may be the human's configured name). Not with to_role.",
        },
        to_role: {
          type: "string",
          enum: TICKET_ROLES,
          description: "Recipient stage role. Not with to. Needs context.ticket_id, or review \"spec\" with request_id.",
        },
        review: {
          type: "string",
          enum: ["spec"],
          description: "A spec review of a request, not of a ticket. Only with to_role validator. Needs request_id and context.request_text.",
        },
        request_id: {
          type: "string",
          description: "The request label that the spec review covers. Only with review \"spec\".",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short description of the work being handed off.",
        },
        context: {
          type: "object",
          description:
            "Optional structured metadata (file refs, PR links, API contracts). Hub accepts up to ~1 MiB serialized, but the effective sender-side ceiling is ~200 KiB ASCII / ~50 KiB unicode-heavy JSON due to Read-tool + tool-call token caps. For larger payloads, post_file the artifact first and reference the returned absolute path here.",
        },
        ttl_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Time until auto-expiry. Defaults to 3600 (1 hour).",
        },
      },
      required: ["task"],
    },
    handler: async (ctx, args) => {
      // Exactly one target. The hub checks it too; refusing here saves the gate and the request.
      const hasTo = args.to !== undefined && args.to !== null && args.to !== "";
      const hasRole = args.to_role !== undefined && args.to_role !== null && args.to_role !== "";
      if (hasTo === hasRole) throw new Error("send_handoff: name exactly one of to and to_role");
      await runHandoffGate(ctx.host, args);
      const body: Record<string, unknown> = {
        from: ctx.agent,
        task: args.task,
      };
      if (hasTo) body.to = args.to;
      else body.to_role = args.to_role;
      if (args.review !== undefined) body.review = args.review;
      if (args.request_id !== undefined) body.request_id = args.request_id;
      if (args.context !== undefined) body.context = args.context;
      if (args.ttl_seconds !== undefined) body.ttl_seconds = args.ttl_seconds;
      const resp = await authedPost(ctx.host, ctx.hubEnv, "/handoffs", body);
      if (resp.status !== 201) toolError(resp, "send_handoff");
      const id =
        resp.json && typeof resp.json === "object" && "id" in resp.json
          ? String((resp.json as { id: string }).id)
          : "";
      return { content: [{ type: "text", text: `handoff_id=${id}` }] };
    },
  },
  {
    name: "accept_handoff",
    description: "Accept a pending handoff addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        comment: {
          type: "string",
          maxLength: 500,
          description: "Optional note for the sender.",
        },
      },
      required: ["handoff_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const body: Record<string, unknown> = { by: ctx.agent };
      if (args.comment !== undefined) body.comment = args.comment;
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/handoffs/${id}/accept`, body);
      if (resp.status !== 200) toolError(resp, "accept_handoff");
      const handoffCtx = (resp.json as { snapshot?: { context?: { ticket_id?: unknown } | null } } | null)
        ?.snapshot?.context;
      const ticketId = handoffCtx && typeof handoffCtx.ticket_id === "string" ? handoffCtx.ticket_id : "";
      if (!ticketId) return { content: [{ type: "text", text: "accepted" }] };
      const outcome = await claimAfterAccept(ctx, ticketId);
      return { content: [{ type: "text", text: `accepted. ticket ${ticketId}: ${outcome}` }] };
    },
  },
  {
    name: "decline_handoff",
    description:
      "Decline a pending handoff addressed to you. A reason is required so the sender can re-route.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Why you're declining.",
        },
      },
      required: ["handoff_id", "reason"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const reason = String(args.reason ?? "");
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/handoffs/${id}/decline`, { by: ctx.agent, reason });
      if (resp.status !== 200) toolError(resp, "decline_handoff");
      return { content: [{ type: "text", text: "declined" }] };
    },
  },
  {
    name: "cancel_handoff",
    description:
      "Withdraw a pending handoff you created. Reason optional. Only the sender (or the human) may cancel.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string", pattern: "^h_[0-9a-f]{16}$" },
        reason: { type: "string", maxLength: 500 },
      },
      required: ["handoff_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.handoff_id ?? "");
      const body: Record<string, unknown> = { by: ctx.agent };
      if (args.reason !== undefined) body.reason = args.reason;
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/handoffs/${id}/cancel`, body);
      if (resp.status !== 200) toolError(resp, "cancel_handoff");
      return { content: [{ type: "text", text: "cancelled" }] };
    },
  },
  {
    name: "send_interrupt",
    description:
      "Send a high-visibility attention flag to another participant. The recipient's channel surfaces it prominently; they acknowledge via ack_interrupt when they've read it. Use sparingly — reserve for 'wait, re-read this before continuing' moments, not for regular chat.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient name." },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short explanation of what the recipient should re-read or reconsider.",
        },
      },
      required: ["to", "text"],
    },
    handler: async (ctx, args) => {
      const to = String(args.to ?? "");
      const text = String(args.text ?? "");
      const resp = await authedPost(ctx.host, ctx.hubEnv, "/interrupts", { from: ctx.agent, to, text });
      if (resp.status !== 201) toolError(resp, "send_interrupt");
      const id =
        resp.json && typeof resp.json === "object" && "id" in resp.json
          ? String((resp.json as { id: string }).id)
          : "";
      return { content: [{ type: "text", text: `interrupt_id=${id}` }] };
    },
  },
  {
    name: "ack_interrupt",
    description: "Acknowledge a pending interrupt addressed to you.",
    inputSchema: {
      type: "object",
      properties: {
        interrupt_id: { type: "string", pattern: "^i_[0-9a-f]{16}$" },
      },
      required: ["interrupt_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.interrupt_id ?? "");
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/interrupts/${id}/ack`, { by: ctx.agent });
      if (resp.status !== 200) toolError(resp, "ack_interrupt");
      return { content: [{ type: "text", text: "acknowledged" }] };
    },
  },
  {
    name: "ack_permission",
    description:
      "Submit a verdict on a pending Claude Code permission request. Any agent may ack any request (the hub accepts the first verdict; later ones are idempotent or rejected with 409). Returns 'verdict_applied=<allow|deny> resolved_by=<agent> your_verdict_won=<true|false>' so delegation logic can tell whether the caller's verdict transitioned the state or arrived after peer/human resolution. In Claude Code this tool runs without a prompt in default mode; a user ask or deny rule on it refuses the call, because the mod has no approval dialog.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          pattern: "^[a-km-zA-KM-Z]{5}$",
          description: "The claude-assigned request_id (5 letters a-z excluding l).",
        },
        behavior: {
          type: "string",
          enum: ["allow", "deny"],
          description: "Verdict. 'allow' lets claude proceed; 'deny' blocks the tool call.",
        },
      },
      required: ["request_id", "behavior"],
    },
    handler: async (ctx, args) => {
      const id = String(args.request_id ?? "");
      const behavior = String(args.behavior ?? "");
      if (!/^[a-km-z]{5}$/i.test(id)) throw new Error("ack_permission: invalid request_id");
      if (behavior !== "allow" && behavior !== "deny") {
        throw new Error("ack_permission: behavior must be 'allow' or 'deny'");
      }
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/permissions/${id}/verdict`, { by: ctx.agent, behavior });
      if (resp.status !== 200) toolError(resp, "ack_permission");
      // Distinguish "my verdict won" from "already resolved by peer/human".
      // Hub returns { snapshot, idempotent?: true }. If idempotent, resolved_by
      // is whoever got there first; if absent, this caller transitioned the state.
      const body = (resp.json ?? {}) as {
        snapshot?: { resolved_by?: string | null; behavior?: string | null; status?: string };
        idempotent?: boolean;
      };
      const snap = body.snapshot ?? {};
      const resolvedBy = snap.resolved_by ?? "unknown";
      const finalBehavior = snap.behavior ?? behavior;
      const yourVerdictWon = !body.idempotent && resolvedBy === ctx.agent;
      const text = yourVerdictWon
        ? `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=true`
        : `verdict_applied=${finalBehavior} resolved_by=${resolvedBy} your_verdict_won=false already_resolved=true`;
      return { content: [{ type: "text", text }] };
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a work ticket in your room. Acceptance criteria are required: state what done means. A high blast_radius ticket needs the human's approval to reach done. Use status draft to hold a ticket back: a draft cannot be claimed and wakes no one until it moves to queued. Use request_id to group the tickets of one request, and blocked_by to list ticket ids that must be done before this ticket can be claimed. Use role to name the stage role that works the ticket first. Returns ticket_id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        acceptance_criteria: { type: "string", minLength: 1, description: "What done means, checkable." },
        blast_radius: { type: "string", enum: ["low", "high"] },
        priority: {
          type: "string",
          enum: ["highest", "high", "medium", "low", "lowest"],
          description: "Default medium. Higher priority is listed first.",
        },
        external_ref: { type: "string", description: "Optional opaque key from an outside tracker." },
        assignee: { type: "string", description: "Optional agent of your room that owns the ticket; it is woken once. Omit it to leave the ticket in the queue." },
        status: { type: "string", enum: ["draft", "queued"], description: "Default queued. A draft cannot be claimed and wakes no one." },
        request_id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$", description: "Optional label that groups the tickets of one request." },
        role: { type: "string", enum: TICKET_ROLES, description: "Optional stage role that works the ticket first." },
        blocked_by: { type: "array", items: TICKET_ID_SCHEMA, maxItems: 20, description: "Optional ids of tickets of your room that must be done before this ticket can be claimed." },
      },
      required: ["title", "acceptance_criteria", "blast_radius"],
    },
    handler: async (ctx, args) => {
      const body: Record<string, unknown> = {
        by: ctx.agent,
        title: args.title,
        acceptance_criteria: args.acceptance_criteria,
        blast_radius: args.blast_radius,
      };
      if (args.priority !== undefined) body.priority = args.priority;
      if (args.external_ref !== undefined) body.external_ref = args.external_ref;
      if (args.assignee !== undefined) body.assignee = args.assignee;
      for (const k of ["status", "request_id", "role", "blocked_by"]) if (args[k] !== undefined) body[k] = args[k];
      const resp = await authedPost(ctx.host, ctx.hubEnv, "/tickets", body);
      if (resp.status !== 201) toolError(resp, "create_ticket");
      const id = (resp.json as { snapshot?: { id?: string } } | null)?.snapshot?.id ?? "";
      return { content: [{ type: "text", text: `ticket_id=${id}` }] };
    },
  },
  {
    name: "claim_ticket",
    description: "Claim a queued ticket in your room. The first claim wins; a later claim gets 409.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: TICKET_ID_SCHEMA },
      required: ["ticket_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.ticket_id ?? "");
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/claim`, { by: ctx.agent });
      if (resp.status !== 200) toolError(resp, "claim_ticket");
      return { content: [{ type: "text", text: "claimed" }] };
    },
  },
  {
    name: "transition_ticket",
    description:
      "Move your ticket to in_progress, in_review, done or cancelled. Only the assignee moves a claimed ticket. Move a ticket to draft or queued only as the human or the room lead: queued promotes a draft, and the hub refuses any other actor. A done move on a high blast_radius ticket needs the human's Allow: the tool then requests approval and returns the request id. Moving to in_review REQUIRES `note`: say how you implemented it and how you tested it. The note goes into the ticket's audit trail; it does not replace your chatbridge messages, so still post what the room needs to know.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_ID_SCHEMA,
        to: { type: "string", enum: ["draft", "queued", "in_progress", "in_review", "done", "cancelled"] },
        note: {
          type: "string",
          maxLength: 4096,
          description: "Required when to = in_review: how it was implemented and how it was tested. For the audit trail; it does not replace chatbridge messages.",
        },
      },
      required: ["ticket_id", "to"],
    },
    handler: async (ctx, args) => {
      const id = String(args.ticket_id ?? "");
      const to = String(args.to ?? "");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      // The hub refuses an agent's move to in_review without a note; say why before the round trip.
      if (to === "in_review" && !note) {
        throw new Error("transition_ticket: a move to in_review needs `note`: say how you implemented it and how you tested it");
      }
      const move = { by: ctx.agent, to, ...(note ? { note } : {}) };
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/transition`, move);
      if (resp.status === 200) return { content: [{ type: "text", text: `ticket ${id} is now ${to}` }] };
      const blocked = resp.status === 409 && to === "done" && resp.json && typeof resp.json === "object" &&
        "approval_request_id" in resp.json;
      if (!blocked) toolError(resp, "transition_ticket");
      const ap = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/approval`, { by: ctx.agent });
      if (ap.status < 200 || ap.status >= 300) toolError(ap, "transition_ticket approval");
      const apj = ap.json as { request_id?: string; created?: boolean; status?: string } | null;
      const reqId = apj?.request_id ?? "";
      // The human allowed the request between the blocked move and this call: nothing is left to
      // wait for. Retry the move once and report what it did.
      if (apj?.created === false && apj.status === "allowed") {
        const retry = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/transition`, move);
        if (retry.status === 200) return { content: [{ type: "text", text: `ticket ${id} is now ${to} (the human had already allowed approval_request_id=${reqId})` }] };
        toolError(retry, "transition_ticket retry after the human's approval");
      }
      return {
        content: [{
          type: "text",
          text: `ticket ${id} is not done. It needs the human's approval. approval_request_id=${reqId}. Wait for the human to Allow, then call transition_ticket again.`,
        }],
      };
    },
  },
  {
    name: "assign_ticket",
    description:
      "Assign a ticket of your room to an agent, or pass null to unassign it. Only the human, the ticket's creator and the room lead may assign. The new assignee is woken; an unassigned ticket goes back to the room lead.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_ID_SCHEMA,
        assignee: { type: ["string", "null"], description: "An agent of your room, or null to unassign." },
      },
      required: ["ticket_id", "assignee"],
    },
    handler: async (ctx, args) => {
      const id = String(args.ticket_id ?? "");
      const assignee = args.assignee === null || args.assignee === undefined || args.assignee === "" ? null : String(args.assignee);
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/assign`, { by: ctx.agent, assignee });
      if (resp.status !== 200) toolError(resp, "assign_ticket");
      return { content: [{ type: "text", text: assignee ? `ticket ${id} is assigned to ${assignee}` : `ticket ${id} is unassigned` }] };
    },
  },
  {
    name: "edit_ticket",
    description:
      "Edit an open ticket's title or acceptance criteria. Only the human, the ticket's creator and its assignee may edit. Only the human may change blast_radius: an agent that sends it is refused. A done or cancelled ticket cannot be edited. Pass only the fields you change. The human, the ticket's creator and the room lead change request_id, role and blocked_by, not the assignee, and only while the ticket is draft or queued (the human may change them at any time). blocked_by replaces the whole list, and null or [] clears it.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_ID_SCHEMA,
        title: { type: "string", maxLength: 200, description: "The new title." },
        acceptance_criteria: { type: "string", maxLength: 4000, description: "The new acceptance criteria." },
        blast_radius: { type: "string", enum: ["low", "high"], description: "The human only." },
        request_id: { type: ["string", "null"], pattern: "^[A-Za-z0-9._-]{1,64}$", description: "The label that groups the tickets of one request." },
        role: { type: ["string", "null"], enum: [...TICKET_ROLES, null], description: "The stage role that works the ticket first. null clears it." },
        blocked_by: { type: ["array", "null"], items: TICKET_ID_SCHEMA, maxItems: 20, description: "Replaces the whole blocker list. null or [] clears it." },
      },
      required: ["ticket_id"],
    },
    handler: async (ctx, args) => {
      const id = String(args.ticket_id ?? "");
      const body: Record<string, unknown> = { by: ctx.agent };
      for (const k of ["title", "acceptance_criteria", "blast_radius", "request_id", "role", "blocked_by"]) if (args[k] !== undefined) body[k] = args[k];
      const resp = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/edit`, body);
      if (resp.status !== 200) toolError(resp, "edit_ticket");
      const unchanged = (resp.json as { idempotent?: boolean } | undefined)?.idempotent;
      return { content: [{ type: "text", text: unchanged ? `ticket ${id} is unchanged` : `ticket ${id} is edited` }] };
    },
  },
  {
    name: "attach_ticket_file",
    description:
      "Attach a file from your local filesystem to a ticket (pdf, md, txt, png, jpg or jpeg; the hub's allowlist and 8 MiB cap apply). Only the human, the ticket's creator and its assignee may attach. It uploads the file and links it to the ticket, like post_file does for chat. A file is no chat message: post to the room if people need to know. Returns the absolute path of the stored file.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_ID_SCHEMA,
        path: { type: "string", description: "Absolute path on your local filesystem to the file to attach." },
        caption: {
          type: "string",
          maxLength: 200,
          description: "Optional name shown on the ticket. Default: the file's own name.",
        },
      },
      required: ["ticket_id", "path"],
    },
    handler: async (ctx, args) => {
      const id = String(args.ticket_id ?? "");
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("attach_ticket_file: path is required");
      const caption = typeof args.caption === "string" ? attachmentName(args.caption) : "";
      const name = caption || attachmentName(path.slice(path.lastIndexOf("/") + 1)) || "file";

      const up = await authedUpload(ctx.host, ctx.hubEnv, path);
      if (up.status < 200 || up.status >= 300) toolError(up, "attach_ticket_file upload");
      const upJson = (up.json ?? {}) as { url?: string; path?: string };
      if (!upJson.url) throw new Error("attach_ticket_file: hub returned no url");

      const resp = await authedPost(ctx.host, ctx.hubEnv, `/tickets/${encodeURIComponent(id)}/attachments`, {
        by: ctx.agent,
        url: upJson.url,
        name,
      });
      if (resp.status !== 200 && resp.status !== 201) toolError(resp, "attach_ticket_file link");
      const again = resp.status === 200 ? " (it was already attached)" : "";
      return { content: [{ type: "text", text: `attached ${name} to ${id}${again}: ${upJson.path || upJson.url}` }] };
    },
  },
  {
    name: "list_tickets",
    description: "List the tickets of your own room, highest priority first. You cannot read another room's tickets. status open (default) hides done and cancelled; all shows every ticket. request_id lists only the tickets of one request. Each line shows the request label and the ids of the open blockers (blockers not done).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "all"] },
        request_id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$", description: "Only the tickets with this request label." },
      },
    },
    handler: async (ctx, args) => {
      // Always the caller's own room: an argument cannot name another one.
      const room = ctx.room ?? "";
      if (!room) throw new Error("list_tickets: room is required");
      const status = args.status === "all" ? "all" : "open";
      const requestId = typeof args.request_id === "string" && args.request_id ? `&request_id=${encodeURIComponent(args.request_id)}` : "";
      const resp = await authedGet(
        ctx.host,
        ctx.hubEnv,
        `/tickets?room=${encodeURIComponent(room)}&status=${status}${requestId}`,
      );
      if (resp.status !== 200) toolError(resp, "list_tickets");
      type T = {
        id: string; title: string; status: string; priority: string; blast_radius: string;
        assignee: string | null; acceptance_criteria: string; notes_count?: number; attachments_count?: number;
        request_id?: string | null; open_blockers?: string[];
      };
      const items = Array.isArray(resp.json) ? (resp.json as T[]) : [];
      const text = items.length
        ? items
            .map((t) =>
              `${t.id} [${t.status}] priority ${t.priority}, ${t.blast_radius} radius, ${t.assignee ?? "unassigned"}: ${t.title}\n  done when: ${t.acceptance_criteria}`
              + (t.request_id ? `\n  request ${t.request_id}` : "")
              + (t.open_blockers?.length ? `\n  blocked by ${t.open_blockers.join(", ")}` : "")
              // Counts only when there is something: notes are in the audit trail, files are read at their stored path.
              + (t.notes_count || t.attachments_count ? `\n  ${t.notes_count ?? 0} notes, ${t.attachments_count ?? 0} files` : ""),
            )
            .join("\n")
        : "no tickets";
      return { content: [{ type: "text", text }] };
    },
  },
] as const;

// O(1) lookup; built once at module load.
const _byName = new Map<string, ToolDef>(CHATBRIDGE_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | null {
  return _byName.get(name) ?? null;
}
