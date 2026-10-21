// Host pieces for runtimes that have Node/Bun globals (pi).
// The caller supplies `deliver`; everything else is the same for both.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Host } from "./host";
import { expandPath } from "./hub-client";

const REQUEST_MS = 15_000;
const UPLOAD_MS = 60_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const nodeSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nodeHost(deliver: Host["deliver"]): Host {
  let streamFailing = false; // a failure was logged and no data has arrived since
  return {
    async readText(path) {
      try {
        return readFileSync(expandPath(path, homedir(), process.env.CUBILOT_DATA_DIR), "utf8");
      } catch {
        return null;
      }
    },
    async request(url, init) {
      const r = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_MS),
      });
      return { status: r.status, text: await r.text() };
    },
    async upload(url, token, filePath) {
      // stat() before read() so a huge file can't OOM the process just to be rejected.
      let bytes: Uint8Array;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
        if (stat.size > MAX_UPLOAD_BYTES) {
          throw new Error(`file too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`);
        }
        bytes = new Uint8Array(readFileSync(filePath));
      } catch (e) {
        throw new Error(`could not read ${filePath}: ${(e as Error).message ?? e}`);
      }
      const form = new FormData();
      form.append("file", new Blob([bytes as unknown as BlobPart]), basename(filePath));
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_MS),
      });
      return { status: r.status, text: await r.text() };
    },
    async *stream(url, token, signal) {
      let r: Response;
      try {
        r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
      } catch (e) {
        if (signal.aborted) return;
        // Connection refused or reset: same streak rule as an HTTP error, not a log line per retry.
        if (!streamFailing) {
          streamFailing = true;
          console.error(`[channel] hub stream failed: ${(e as Error)?.message ?? e}; retrying`);
        }
        return;
      }
      // 401 etc: end the stream; the core re-resolves the token and reconnects.
      if (!r.ok || !r.body) {
        if (!streamFailing) {
          streamFailing = true;
          console.error(`[channel] hub stream refused: HTTP ${r.status}; retrying`);
        }
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        streamFailing = false;
        yield dec.decode(value, { stream: true });
      }
    },
    deliver,
    log: (msg) => console.error(msg),
  };
}
