import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nodeHost } from "../../hub/channel/node-host";

// The pi host's hub stream: an HTTP error ends the stream silently for the core's retry loop.
// It must say why, once per failure streak.
let server: ReturnType<typeof Bun.serve>;
let mode: "401" | "data" = "401";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => (mode === "401" ? new Response("no", { status: 401 }) : new Response("data: {}\n\n")),
  });
});
afterAll(() => server.stop(true));

describe("nodeHost.stream failure logging", () => {
  test("a refused stream is logged once per streak and again after data flowed", async () => {
    const url = `http://127.0.0.1:${server.port}/agent-stream`;
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => logs.push(String(m));
    try {
      // One host instance carries the streak across reconnects, like the real bridge.
      const host = nodeHost(async () => {});
      const run = async () => { for await (const _ of host.stream(url, "tok", new AbortController().signal)) { /* drain */ } };
      mode = "401";
      await run(); await run(); await run();
      expect(logs.filter((l) => l.includes("hub stream refused: HTTP 401"))).toHaveLength(1);
      mode = "data";
      await run();                       // data arrives: the streak is over
      mode = "401";
      await run();
      expect(logs.filter((l) => l.includes("hub stream refused: HTTP 401"))).toHaveLength(2);
    } finally {
      console.error = orig;
    }
  });

  test("a refused connection is logged once per streak, and the stream ends without throwing", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}/agent-stream`;
    dead.stop(true);                       // nothing listens there now: connection refused
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => logs.push(String(m));
    try {
      const host = nodeHost(async () => {});
      const run = async () => { for await (const _ of host.stream(url, "tok", new AbortController().signal)) { /* drain */ } };
      await run(); await run(); await run();
    } finally {
      console.error = orig;
    }
    expect(logs.filter((l) => l.includes("hub stream failed"))).toHaveLength(1);
  });

  test("an aborted stream is not reported as a failure", async () => {
    const url = `http://127.0.0.1:${server.port}/agent-stream`;
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => logs.push(String(m));
    try {
      const ac = new AbortController();
      ac.abort();
      for await (const _ of nodeHost(async () => {}).stream(url, "tok", ac.signal)) { /* none */ }
    } finally {
      console.error = orig;
    }
    expect(logs).toEqual([]);
  });
});
