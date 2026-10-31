// The test side of the shared fake launch executor (group 7b). It replaces the fake Rust shell that read
// /launches/stream. `openShell(hub)` attaches to the fake executor inside the hub (tests/helpers/fake-executor-module.ts):
// it collects the requests of the launch queue and sends the acks. `stop()` detaches, as a dropped stream did.

import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { HubHandle } from "./hub";

export type ShellReq = { id: string; kind: "launch" | "close" | "input"; stage_id?: string; session: string; cwd?: string | null; [k: string]: unknown };

export type Shell = {
  reqs: ShellReq[];
  closes: (session: string) => ShellReq[];
  launches: () => ShellReq[];
  inputs: () => ShellReq[];
  /** Answers one request. Returns the HTTP status the old ack route gave (200, 400, 404, 409, 500). */
  ack: (id: string, body: Record<string, unknown>) => Promise<number>;
  stop: () => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const executorPortFile = (hub: Pick<HubHandle, "ledgerPath">): string => join(dirname(hub.ledgerPath), "fake-executor.port");

async function controlUrl(hub: Pick<HubHandle, "ledgerPath">): Promise<string> {
  const file = executorPortFile(hub);
  for (let i = 0; i < 400; i++) {
    if (existsSync(file)) {
      const port = readFileSync(file, "utf8").trim();
      if (port) return `http://127.0.0.1:${port}`;
    }
    await sleep(25);
  }
  throw new Error(`the fake executor did not start: no ${file}`);
}

/** The requests of the launch queue as an async stream, like the removed GET /launches/stream. `close()` detaches. */
export function openLaunchStream(hub: Pick<HubHandle, "ledgerPath">, into?: ShellReq[]): { events: AsyncGenerator<any, void, void>; close: () => void } {
  const ac = new AbortController();
  const base = controlUrl(hub);
  async function* gen(): AsyncGenerator<any, void, void> {
    const r = await fetch(`${await base}/stream`, { signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`fake executor stream failed: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const req = JSON.parse(line.slice(6)) as ShellReq;
        into?.push(req);
        yield req;
      }
    }
  }
  return { events: gen(), close: () => ac.abort() };
}

/** Answers one request, like the removed POST /launches/<id>/ack: `{ status, json }`. */
export async function ackLaunch(hub: Pick<HubHandle, "ledgerPath">, id: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${await controlUrl(hub)}/ack/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

export function openShell(hub: Pick<HubHandle, "ledgerPath">): Shell {
  const reqs: ShellReq[] = [];
  const stream = openLaunchStream(hub, reqs);
  void (async () => { try { for await (const _ of stream.events) { /* collected in reqs */ } } catch { /* closed */ } })();
  return {
    reqs,
    closes: (session) => reqs.filter((r) => r.kind === "close" && r.session === session),
    launches: () => reqs.filter((r) => r.kind === "launch"),
    inputs: () => reqs.filter((r) => r.kind === "input"),
    ack: async (id, body) => (await ackLaunch(hub, id, body)).status,
    stop: stream.close,
  };
}
