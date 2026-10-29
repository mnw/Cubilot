import type { Database } from "bun:sqlite";

// The hub's own record of the stage sessions it launched: bound when a launch is queued, released when the shell acks the
// close of the session (or the launch ends with an error). The stage table keeps the same facts (`session` and
// `session_released_at_ms`), so a restart loads them back. Only the hub writes it. Nothing a session sends
// (stream parameter, header, env value) counts as proof that it is a stage session.
export type LaunchRecord = {
  bind(session: string, stageId: string): void;
  release(session: string): void;
  /** Adds bindings read from the ledger (at start). */
  load(bindings: Iterable<[string, string]>): void;
  /** Names of the sessions the hub launched and has not seen closed. */
  sessions(): Set<string>;
};

/** The bindings the ledger holds: a launching, running or retrying stage whose session is not released. One read, at start. */
export function loadLaunchBindings(db: Database): Array<[string, string]> {
  return db
    .query<{ session: string; id: string }, []>(
      `SELECT session, id FROM stage
        WHERE session IS NOT NULL AND session_released_at_ms IS NULL AND status IN ('launching', 'running', 'retrying')
        ORDER BY rowid`,
    )
    .all()
    .map((r): [string, string] => [r.session, r.id]);
}

export function createLaunchRecord(initial: Iterable<[string, string]> = []): LaunchRecord {
  const bound = new Map<string, string>(initial);
  return {
    bind: (session, stageId) => void bound.set(session, stageId),
    release: (session) => void bound.delete(session),
    load: (bindings) => void [...bindings].forEach(([session, stageId]) => bound.set(session, stageId)),
    sessions: () => new Set(bound.keys()),
  };
}
