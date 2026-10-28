// Lead inbound measure (human-touchpoints-checkpoint 9.1): what reaches each room lead, by kind and bytes.
// A log, not state: one counter increment per entry, one JSONL line per lead per full UTC hour. Counts and
// sizes only, never message text. A write error is logged and changes nothing else.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry } from "./types";

export const LEAD_INBOUND_KINDS = ["briefing", "ticket", "handoff", "interrupt", "chat", "stage", "other"] as const;
export type LeadInboundKind = (typeof LEAD_INBOUND_KINDS)[number];
type Tally = Record<LeadInboundKind, { count: number; bytes: number }>;

export type LeadInboundOptions = {
  /** Path of lead-inbound.jsonl. */
  file: string;
  /** The room leads that are in the roster now. */
  leads: () => Array<{ room: string; lead: string }>;
  now?: () => number;
  log?: (msg: string) => void;
};

export type LeadInbound = {
  /** Count one entry queued for `name`. Ignored when `name` is not a room lead. */
  record(name: string, entry: Entry): void;
  /** Append the line of the hour that starts at `hourMs` for each room lead, then reset the counters. */
  flush(hourMs: number): void;
  start(): void;
  stop(): void;
};

const HOUR_MS = 3_600_000;

export function classifyEntry(entry: Entry): LeadInboundKind {
  if (entry.type === "briefing") return "briefing";
  const prefix = typeof entry.kind === "string" ? entry.kind.split(".")[0] : "";
  if (prefix === "ticket" || prefix === "handoff" || prefix === "interrupt" || prefix === "stage") return prefix;
  if (!entry.kind && !entry.type) return "chat";
  return "other";
}

const emptyTally = (): Tally =>
  Object.fromEntries(LEAD_INBOUND_KINDS.map((k) => [k, { count: 0, bytes: 0 }])) as Tally;

export function createLeadInbound(opts: LeadInboundOptions): LeadInbound {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m) => console.error(m));
  let tallies = new Map<string, Tally>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function record(name: string, entry: Entry): void {
    try {
      if (!opts.leads().some((l) => l.lead === name)) return;
      const t = tallies.get(name) ?? emptyTally();
      tallies.set(name, t);
      const slot = t[classifyEntry(entry)];
      slot.count += 1;
      slot.bytes += Buffer.byteLength(JSON.stringify(entry));
    } catch (e) {
      log(`[lead-inbound] count failed: ${(e as Error).message}`);
    }
  }

  function flush(hourMs: number): void {
    const done = tallies;
    tallies = new Map();
    try {
      const hour = new Date(hourMs).toISOString().replace(/\.\d{3}Z$/, "Z");
      const lines = opts.leads().map(({ room, lead }) => JSON.stringify({ hour, room, lead, ...(done.get(lead) ?? emptyTally()) }) + "\n");
      if (lines.length === 0) return;
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, lines.join(""));
    } catch (e) {
      log(`[lead-inbound] write failed: ${(e as Error).message}`);
    }
  }

  function arm(): void {
    const t = now();
    const next = Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
    timer = setTimeout(() => {
      flush(next - HOUR_MS);
      arm();
    }, next - t);
    timer.unref?.();
  }

  return {
    record,
    flush,
    start() { if (!timer) arm(); },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}
