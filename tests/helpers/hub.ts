// Test harness: boot the real hub (`bun run hub/hub.ts`) on an OS-assigned port
// against a temp ledger. Tests interact via HTTP + SSE exactly like the UI and
// channel-bin do in production — no mocks, no in-process imports.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HubHandle = {
  url: string;
  token: string;
  ledgerPath: string;
  attachmentsDir: string;
  /** Where this hub writes room transcripts: a temp folder, never the real app data. */
  transcriptsDir: string;
  humanName: string;
  kill: () => Promise<void>;
};

export async function spawnHub(opts?: {
  humanName?: string;
  defaultRoom?: string;
  token?: string;
  allowedExtensions?: string;
}): Promise<HubHandle> {
  const base = mkdtempSync(join(tmpdir(), "cubilot-hub-test-"));
  const ledgerPath = join(base, "ledger.db");
  const attachmentsDir = join(base, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  // The hub writes transcripts to ~/Library/Application Support/Cubilot unless told otherwise. A test that sets the
  // variable itself keeps its folder; every other hub gets one next to its ledger.
  const transcriptsDir = process.env.CUBILOT_TRANSCRIPTS_DIR || join(base, "transcripts");

  const token = opts?.token ?? `tst-${Math.random().toString(36).slice(2, 10)}`;
  const humanName = opts?.humanName ?? "human";
  const defaultRoom = opts?.defaultRoom ?? "default";

  const proc = Bun.spawn(["bun", "run", "hub/hub.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      CUBILOT_TOKEN: token,
      CUBILOT_LEDGER_DB: ledgerPath,
      CUBILOT_ATTACHMENTS_DIR: attachmentsDir,
      CUBILOT_TRANSCRIPTS_DIR: transcriptsDir,
      // Stage worktrees (4.5) go here, never to the real app data.
      CUBILOT_DATA_DIR: join(base, "data"),
      CUBILOT_HUMAN_NAME: humanName,
      CUBILOT_DEFAULT_ROOM: defaultRoom,
      CUBILOT_ALLOWED_EXTENSIONS: opts?.allowedExtensions ?? "jpg,jpeg,png,pdf,md,txt,json",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Tail stdout until the "listening on http://127.0.0.1:<port>" line appears,
  // then extract the port. 5-second wall-clock limit — if boot is slower than
  // that something is wrong.
  const url = await waitForListening(proc, 5000);

  return {
    url,
    token,
    ledgerPath,
    attachmentsDir,
    transcriptsDir,
    humanName,
    kill: async () => {
      try { proc.kill(); } catch {}
      await proc.exited;
    },
  };
}

async function waitForListening(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<string> {
  if (!proc.stdout) throw new Error("hub stdout unavailable");
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  const listenRe = /listening on (http:\/\/[^\s]+)/;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const race = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (race.done) break;
    buf += decoder.decode(race.value, { stream: true });
    const match = buf.match(listenRe);
    if (match) {
      // Drain remaining output in background so the pipe doesn't fill.
      void drainRest(reader);
      return match[1];
    }
  }
  try { proc.kill(); } catch {}
  throw new Error(`hub failed to boot within ${timeoutMs}ms. partial stdout:\n${buf}`);
}

async function drainRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {}
}
