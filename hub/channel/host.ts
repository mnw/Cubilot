// Runtime-neutral contract between the bridge core and an agent runtime
// (Claude Code mod or pi extension). The core owns
// policy; a Host only moves bytes and delivers text. Types only: no imports.

export type DeliveryMode = "context" | "steer" | "wake";

export type HttpResult = { status: number; text: string };

export type Host = {
  // Leading "~/" expands to the user's home dir, so core code needs no node:os.
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
  log(msg: string): void;
};
