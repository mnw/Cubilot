// Runtime-neutral contract between the bridge core and an agent runtime
// (Claude Code mod or pi extension). The core owns
// policy; a Host only moves bytes and delivers text. Types only: no imports.

export type DeliveryMode = "context" | "steer" | "wake";

export type HttpResult = { status: number; text: string };

export type Host = {
  // Expands the path with expandPath() from hub-client.ts: a leading
  // "$CUBILOT_DATA_DIR/" and a leading "~/". Core code needs no node:os or env.
  // Returns null when the file is missing or unreadable.
  readText(path: string): Promise<string | null>;
  // Every request is bounded: timeoutMs defaults to 15 000.
  request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<HttpResult>;
  // Multipart, field "file"; 60 s bound. Rejects non-regular files and > 8 MiB.
  upload(url: string, token: string, filePath: string): Promise<HttpResult>;
  // Raw SSE text. The host authenticates with `token` (never in the URL).
  stream(url: string, token: string, signal: AbortSignal): AsyncIterable<string>;
  // Resolves once the delivery is handed to the runtime (started, never awaited to
  // acceptance: a submit queued behind a long turn must not hold back the next event).
  // The runtime's verdict comes later through the callbacks:
  //   onRead: the text entered the model's context, possibly much later.
  //   onFail: the runtime refused it for good (after any fallback); the core drops its check.
  // A delivery that cannot even be started rejects instead.
  deliver(d: {
    id: number | null;
    text: string;
    mode: DeliveryMode;
    onRead: () => void;
    onFail?: () => void;
  }): Promise<void>;
  // Reloads this runtime so it re-reads the staged factory files, then records `version` as applied
  // (POST /factory/applied). Resolves only when the reload succeeded; rejects when it failed. The core calls it
  // at the agent's idle point only. The adapter owns the record, because a replaced module cannot write it.
  // reloadId names the human's Reload request it answers (null for a reload the bridge starts itself): send it and `attempt` (the hub's id of this one reload) with /factory/applied.
  reload(version: string, reloadId: string | null, attempt: string | null): Promise<void>;
  // Runs `command` through /bin/sh -c with `stdin`. After timeoutMs it is killed: timedOut true, code null.
  // Rejects when it cannot be started.
  exec(command: string, stdin: string, timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }>;
  // CHATBRIDGE_HANDOFF_GATE of the agent's launch environment; null when unset or empty. Named, not generic:
  // the Claude mod's $.env.get takes a literal variable name.
  handoffGate(): Promise<string | null>;
  // CUBILOT_STAGE_ID of the launch environment (a session the hub started for a stage); null when unset or empty.
  stageId(): Promise<string | null>;
  log(msg: string): void;
};
