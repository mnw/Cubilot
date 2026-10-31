import { describe, test, expect, spyOn } from "bun:test";
import crypto from "node:crypto";
import { makeAuthHelpers, ctEquals } from "../../hub/core/auth";
import { readHumanToken } from "../../hub/core/human-token";

const req = (token: string) => new Request("http://x/p", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

describe("makeAuthHelpers", () => {
  const auth = makeAuthHelpers("agent-token-0000", "human-token-1111");

  test("each token gives its caller; another token gives 401", async () => {
    expect(auth.requireAuth(req("agent-token-0000"))).toBe("agent");
    expect(auth.requireAuth(req("human-token-1111"))).toBe("human");
    const bad = auth.requireAuth(req("nope")) as Response;
    expect(bad.status).toBe(401);
  });

  test("read auth takes a header or ?token= and returns the caller", () => {
    expect(auth.requireReadAuth(new Request("http://x/p"), new URL("http://x/p?token=human-token-1111"))).toBe("human");
    expect(auth.requireReadAuth(req("agent-token-0000"), new URL("http://x/p"))).toBe("agent");
    expect((auth.requireReadAuth(new Request("http://x/p"), new URL("http://x/p")) as Response).status).toBe(401);
  });

  test("the check calls the constant-time compare for both tokens", () => {
    const spy = spyOn(crypto, "timingSafeEqual");
    auth.requireAuth(req("agent-token-0000"));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    auth.requireReadAuth(req("zzzzzzzzzzzzzzzz"), new URL("http://x/p"));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("a token of a different length gets 401 without a throw", () => {
    for (const t of ["a", "x".repeat(500)]) {
      const r = auth.requireAuth(req(t)) as Response;
      expect(r.status).toBe(401);
    }
    expect(ctEquals("abc", "abcd")).toBe(false);
    expect(ctEquals("abc", "abc")).toBe(true);
  });

  test("without a human token nobody is the human, and an empty token is never a caller", () => {
    const solo = makeAuthHelpers("agent-token-0000");
    expect(solo.requireAuth(req("agent-token-0000"))).toBe("agent");
    expect((solo.requireReadAuth(new Request("http://x/p"), new URL("http://x/p?token="))as Response).status).toBe(401);
  });
});

describe("readHumanToken", () => {
  const stream = (chunks: string[], closeAfter = true) =>
    new ReadableStream<Uint8Array>({
      start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); if (closeAfter) c.close(); },
    });

  test("gives the first line, also when it arrives in pieces", async () => {
    expect(await readHumanToken(stream(["tok-", "en\nrest"]))).toBe("tok-en");
  });

  test("gives an empty token for an empty or closed stdin", async () => {
    expect(await readHumanToken(stream([]))).toBe("");
  });

  test("gives an empty token after the time limit when no line comes", async () => {
    const t0 = Date.now();
    expect(await readHumanToken(stream(["no newline"], false), 150)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
