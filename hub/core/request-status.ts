// Request status for the Requests screen (Part 14 H1): one pure function over the facts of a request and its tickets.

export type RequestListStatus = "draft" | "waiting_for_approve" | "building" | "ready_for_test" | "merged" | "cancelled";

export type StatusTicket = { status: string; mergedIntoMain: boolean };
export type StatusFacts = { needsApprove: boolean; approved: boolean; tickets: StatusTicket[] };

const TERMINAL = new Set(["done", "cancelled"]);

export function requestListStatus(f: StatusFacts): RequestListStatus {
  const t = f.tickets;
  if (t.length === 0) return "draft";
  if (t.every((x) => x.status === "cancelled")) return "cancelled";
  if (f.needsApprove && !f.approved) return "waiting_for_approve";
  if (t.every((x) => TERMINAL.has(x.status))) {
    return t.filter((x) => x.status === "done").every((x) => x.mergedIntoMain) ? "merged" : "ready_for_test";
  }
  // An open ticket. A draft ticket of a request that needs no Approve stays a draft plan; an approved request builds.
  return !f.approved && t.some((x) => x.status === "draft") ? "draft" : "building";
}
