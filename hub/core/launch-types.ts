// The request and ack shapes of the launch queue (hub/core/launch-queue.ts), shared with the executor (launch-executor.ts).

export type LaunchRequest =
  | {
      id: string;
      kind: "launch";
      stage_id: string;
      session: string;
      role: string;
      room: string;
      harness: string;
      /** From role_models in config.yml (hub/core/role-models.ts). Present only when the role's entry sets them. */
      model?: string;
      provider?: string;
      effort?: string;
      cwd: string | null;
      prompt: string;
      env: Record<string, string>;
    }
  | { id: string; kind: "close"; session: string }
  /** Text for the PTY of one named session (the checkpoint `/clear`). The executor writes `text` and Enter to that session only. */
  | { id: string; kind: "input"; session: string; text: string };

/**
 * `spawned` means done: the session started (launch) or was closed (close). `error` for a launch ends the attempt. For a
 * close, `error` keeps the request pending (it is sent again on the next connection) unless `absent` is true: the executor
 * reports that the session does not exist, so there is nothing left to close.
 */
export type AckOutcome = { result: "spawned" } | { result: "error"; error: string; absent?: boolean };

export type AckStatus = "ok" | "idempotent" | "unknown" | "conflict" | "error" | "pending";
