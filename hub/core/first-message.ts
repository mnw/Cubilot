// The first message of a stage session (stage-sessions 4.3, design decision 9): the TICKET part only. The role prompt
// is not here: factory-roles passes it with --append-system-prompt-file, so it is the same file for every session of
// a role. The stable text comes first and the ticket facts last (brief 04-sessions, cost item 1); the agent reads
// files again from the worktree, so this gives facts and paths only.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FirstMessageInput = {
  stageId: string;
  role: string;
  ticket: { id: string; title: string; acceptance_criteria: string; blast_radius: string; request_id: string | null };
  /** `ticket/<id>`, or null for a detached worktree. */
  branch: string | null;
  worktree: string;
  /** A retry adds one line with the reason the earlier session stopped. */
  reason?: string;
  /** Who the result handoff goes to (the room lead); a template may name it with {{recipient}}. */
  recipient?: string;
  /** The to_role handoff that started this stage, if any: its sender, task and context follow the ticket part. */
  handoff?: { id: string; from: string; task: string; context: unknown };
};

/** The most the handoff section holds, in bytes. */
export const HANDOFF_SECTION_MAX = 64 * 1024;

function renderHandoffSection(h: NonNullable<FirstMessageInput["handoff"]>, stageId: string): string {
  const own = `The stage_id in this context is the sender's stage. Your stage id is ${stageId}. Use your own stage id in your result.`;
  const section = `\n## Handoff\n- From: ${h.from}\n- Task: ${oneLine(h.task)}\n- Context:\n${own}\n${JSON.stringify(h.context, null, 2)}\n`;
  const bytes = Buffer.from(section, "utf8");
  if (bytes.length <= HANDOFF_SECTION_MAX) return section;
  // The notice sits inside the cap: the whole section, notice included, is at most HANDOFF_SECTION_MAX bytes.
  const notice = `\n[The handoff context is cut at 64 KB. Handoff id: ${h.id}]\n`;
  const room = HANDOFF_SECTION_MAX - Buffer.byteLength(notice, "utf8");
  return bytes.subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "") + notice;
}

// One line: a reason from a log or an error may hold newlines.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The template of a role: `factory/<role>/first-message.md`, staged by the app to `<factory dir>/<version>/<role>/`.
 * `{{name}}` is replaced in ONE pass, so a value that holds `{{...}}` is never expanded again. A missing or unreadable
 * file falls back to DEFAULT_TEMPLATE (the same text as the six shipped files).
 */
export const DEFAULT_TEMPLATE = `You are the {{role}} for one ticket. Your role instructions are already loaded.
Work in the worktree below. Report with a result handoff that names the stage id and the ticket id.

## Ticket
- Ticket: {{ticket_id}}
- Title: {{title}}
- Blast radius: {{blast_radius}}
- Request: {{request}}
- Stage: {{stage_id}}
- Branch: {{branch}}
- Worktree: {{worktree}}

## Acceptance criteria
{{acceptance_criteria}}
`;

export function loadTemplate(role: string, factoryDir = process.env.CUBILOT_FACTORY_DIR, version = process.env.CUBILOT_FACTORY_VERSION): string {
  // The role comes from the stage table, but it names a path here: only a plain name is read.
  if (!factoryDir || !version || !/^[a-z][a-z0-9-]*$/.test(role)) return DEFAULT_TEMPLATE;
  try {
    const text = readFileSync(join(factoryDir.trim(), version.trim(), role, "first-message.md"), "utf8");
    return text.trim() ? text : DEFAULT_TEMPLATE;
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

export function renderFirstMessage(i: FirstMessageInput, template: string = loadTemplate(i.role)): string {
  const v: Record<string, string> = {
    role: i.role,
    ticket_id: i.ticket.id,
    title: oneLine(i.ticket.title),
    blast_radius: i.ticket.blast_radius,
    request: i.ticket.request_id ?? "none",
    stage_id: i.stageId,
    branch: i.branch ?? "none (detached worktree)",
    worktree: i.worktree,
    acceptance_criteria: i.ticket.acceptance_criteria.trim(),
    recipient: i.recipient ?? "Orchestrator",
  };
  // A name the template does not know stays as written.
  let text = template.replace(/\{\{([a-z_]+)\}\}/g, (m, k: string) => (k in v ? v[k] : m));
  if (!text.endsWith("\n")) text += "\n";
  if (i.handoff) text += renderHandoffSection(i.handoff, i.stageId);
  if (i.reason) text += `\nNote: the earlier session of this stage stopped: ${oneLine(i.reason)}\n`;
  return text;
}

export type SpecFirstMessageInput = {
  stageId: string;
  requestId: string;
  worktree: string;
  /** Who the result handoff goes to: the room lead. The hub refuses a spec result to anyone else. */
  recipient: string;
  /** From the spec handoff (context.request_text). */
  requestText: string;
  specPaths: string[];
  scope: Array<{ id: string; title: string; acceptance_criteria: string; role?: string | null; blast_radius?: string; blocked_by?: string[] }>;
  /** The commit the worktree is at. */
  commit?: string | null;
  /** The findings of the FAIL results of this request since its last PASS, oldest first (spec-review-stage 2.5). */
  earlierFindings?: Array<{ ticket_id: string; severity: string; text: string }>;
  reason?: string;
};

/** The first message of a spec-review stage (spec-review-stage 4.1b): the request, the tickets in scope and where the result goes. */
export function renderSpecFirstMessage(i: SpecFirstMessageInput): string {
  const lines = [
    "You are the validator for the spec review of one request. Your role instructions are already loaded.",
    `Review the plan below in the worktree. Send ONE result handoff to ${i.recipient}. The hub refuses a result to anyone else.`,
    "The result names context.stage_id, context.review (spec), context.request_id, context.verdict (PASS or FAIL), context.findings, context.questions_for_human and context.suggestions.",
    "",
    "## Request",
    `- Request: ${i.requestId}`,
    `- Stage: ${i.stageId}`,
    `- Worktree: ${i.worktree}`,
    ...(i.commit ? [`- Commit: ${i.commit}`] : []),
    `- Result goes to: ${i.recipient}`,
    ...(i.specPaths.length ? ["- Spec files:", ...i.specPaths.map((p) => `  - ${p}`)] : []),
    "",
    "## Request text",
    i.requestText.trim(),
    "",
    "## Tickets in scope",
    ...i.scope.flatMap((t) => [
      `### ${t.id}: ${oneLine(t.title)}`,
      `- Role: ${t.role ?? "none"}`,
      `- Blast radius: ${t.blast_radius ?? "unknown"}`,
      `- Blocked by: ${t.blocked_by?.length ? t.blocked_by.join(", ") : "none"}`,
      "",
      t.acceptance_criteria.trim(),
      "",
    ]),
    ...(i.earlierFindings?.length
      ? [
          "## Findings of earlier reviews of this request",
          "These came from FAIL results since the last PASS. Check each one first: is it fixed in the tickets above?",
          ...i.earlierFindings.map((f) => `- ${f.ticket_id} (${f.severity}): ${oneLine(f.text)}`),
          "",
        ]
      : []),
  ];
  let text = lines.join("\n").replace(/\n+$/, "\n");
  if (i.reason) text += `\nNote: the earlier session of this stage stopped: ${oneLine(i.reason)}\n`;
  return text;
}
