// The hub's own record of the stage sessions it launched: bound when a launch is queued, released when the shell acks the
// close of the session (or the launch ends with an error). Memory only. Only the hub writes it. Nothing a session sends
// (stream parameter, header, env value) counts as proof that it is a stage session.
export type LaunchRecord = {
  bind(session: string, stageId: string): void;
  release(session: string): void;
  /** Names of the sessions the hub launched and has not seen closed. */
  sessions(): Set<string>;
};

export function createLaunchRecord(): LaunchRecord {
  const bound = new Map<string, string>();
  return {
    bind: (session, stageId) => void bound.set(session, stageId),
    release: (session) => void bound.delete(session),
    sessions: () => new Set(bound.keys()),
  };
}
