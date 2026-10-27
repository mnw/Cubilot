// Context pack depth by role (context-pack design decision 6, spec "The pack depth follows the role").
// One table decides which parts of the ticket block fill. A template names a part with {{notes}}, {{pack}} or {{diff}},
// but the renderer fills only the parts the table allows for the role, so a template cannot widen a role.

export type PackPart = "notes" | "graph" | "signatures" | "diffStat" | "changedFiles";

const ALL: readonly PackPart[] = ["notes", "graph", "signatures", "diffStat", "changedFiles"];

/** A spec-review stage has review "spec"; its role is validator, but its depth is not the code Validator's. */
const DEPTH: Record<string, readonly PackPart[]> = {
  worker: ["notes", "graph", "signatures"],
  writer: ["notes", "graph", "signatures"],
  // The Tester gets the Worker's notes and the changed files, and no graph or signatures.
  tester: ["notes", "changedFiles"],
  validator: ["notes", "diffStat", "changedFiles"],
  // The document and the style guide come with the ticket; no notes and no pack.
  editor: [],
  reviewer: ["notes", "graph", "signatures"],
  // The request, the draft tickets and the spec are in the message; the graph query is the only pack part.
  spec: ["graph"],
};

export function packDepth(role: string, review?: string | null): ReadonlySet<PackPart> {
  const key = review === "spec" ? "spec" : role;
  return new Set(Object.prototype.hasOwnProperty.call(DEPTH, key) ? DEPTH[key] : []);
}

export const PACK_PARTS = ALL;
