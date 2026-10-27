// The stable block of a first message (context-pack 2.1, 2.2): the project primer.
// It is docs/PRIMER.md of the project folder plus the Nutshell of the room. CONTEXT.md is never read.
// No stage, time, session or worktree field is here: two sessions of one room get the same bytes while
// docs/PRIMER.md and the Nutshell do not change.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The cap on docs/PRIMER.md in tokens; tokens are estimated as ceil(bytes / 4). */
export const PRIMER_CAP_TOKENS = 2000;
export const PRIMER_CAP_BYTES = PRIMER_CAP_TOKENS * 4;
export const PRIMER_CUT_LINE = `[PRIMER.md cut at ${PRIMER_CAP_TOKENS} tokens]`;
export const PRIMER_MISSING_LINE = "primer missing";

const decode = (b: Buffer) => b.toString("utf8").replace(/�+$/, "");

/** Cuts text to the cap at a heading boundary when one leaves text, else at a line, else at the byte. */
export function cutPrimerFile(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PRIMER_CAP_BYTES) return text;
  const head = decode(Buffer.from(text, "utf8").subarray(0, PRIMER_CAP_BYTES));
  // The cap may fall inside a line: keep whole lines, unless the first line alone is over the cap.
  const atLineEnd = text.slice(head.length).startsWith("\n");
  const whole = atLineEnd || head.indexOf("\n") < 0 ? head : head.slice(0, head.lastIndexOf("\n"));
  const heading = whole.lastIndexOf("\n#");
  const kept = heading > 0 ? whole.slice(0, heading) : whole;
  return `${kept.trimEnd()}\n${PRIMER_CUT_LINE}`;
}

function readPrimerFile(projectFolder: string | null): string | null {
  if (!projectFolder) return null;
  try {
    const text = readFileSync(join(projectFolder, "docs", "PRIMER.md"), "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The stable block: the primer file (or "primer missing") and the Nutshell. Ends with a newline. */
export function renderStable(room: { projectFolder: string | null; nutshell: string }): string {
  const file = readPrimerFile(room.projectFolder);
  const parts = [file === null ? PRIMER_MISSING_LINE : cutPrimerFile(file.trimEnd())];
  const nutshell = room.nutshell.trim();
  if (nutshell) parts.push(`## Nutshell\n${nutshell}`);
  return parts.join("\n\n") + "\n\n";
}
