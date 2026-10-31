// The human token: the shell writes it as the first line of the hub's stdin. It never goes in env or a file,
// because agents run as the same OS user and can read both (design decision 5 of hub-first-browser).

export const HUMAN_TOKEN_WAIT_MS = 5000;

/** Reads the first line of `stream`. Gives "" and logs one line when it has no line within `waitMs`. */
export async function readHumanToken(stream: ReadableStream<Uint8Array>, waitMs = HUMAN_TOKEN_WAIT_MS): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), waitMs); });
  const line = (async () => {
    while (!buf.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    return buf.split("\n")[0].trim();
  })();
  try {
    const got = await Promise.race([line, limit]);
    if (got === "timeout" || got === "") {
      console.error(`[hub] no human token on stdin (${got === "timeout" ? `none within ${waitMs} ms` : "empty"}) — no caller is the human`);
      return "";
    }
    return got;
  } catch (e) {
    console.error(`[hub] reading the human token failed: ${e} — no caller is the human`);
    return "";
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}
