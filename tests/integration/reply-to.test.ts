// Integration tests for chat reply_to (Part 14 H5): /send and /post keep reply_to, the hub
// refuses an unknown id or an id of another room, and a restart keeps replies valid only
// when the message came back through the hydrated transcript.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { postJson, registerAgent, authedFetch, openSSE } from "../helpers/fetch";

type Seen = { id?: number; from?: string; text?: string; reply_to?: number; replay?: boolean };

// Collects /stream or /agent-stream events until `want` returns a match, or fails after ms.
async function waitFor(
  events: AsyncGenerator<any, void, void>,
  want: (e: Seen) => boolean,
  ms = 3000,
): Promise<Seen> {
  const deadline = Date.now() + ms;
  const it = events[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const next = await Promise.race([
      it.next(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
    ]);
    if (!next || next.done) break;
    if (want(next.value as Seen)) return next.value as Seen;
  }
  throw new Error("event not seen");
}

async function putSettings(hub: HubHandle, room: string, persist: boolean): Promise<void> {
  const r = await authedFetch(hub, `/rooms/${room}/settings`, {
    method: "PUT",
    body: JSON.stringify({ persist_transcript: persist }),
  });
  expect(r.status).toBe(200);
}

describe("reply_to", () => {
  const hubs: HubHandle[] = [];
  afterAll(async () => { for (const h of hubs) await h.kill(); });

  test("send and post keep reply_to; bad ids give 400; no reply_to is unchanged", async () => {
    const hub = await spawnHub();
    hubs.push(hub);
    const ui = openSSE(hub, "/stream?lastSeenId=0");
    // Agent streams are primed (briefing read) so the agent is registered before any send.
    const aStream = openSSE(hub, "/agent-stream?agent=rt-a&room=rt-room");
    await aStream.events.next();
    const bStream = openSSE(hub, "/agent-stream?agent=rt-b&room=rt-room");
    await bStream.events.next();
    const other = await registerAgent(hub, "rt-o", { room: "rt-other" });

    const first = await postJson(hub, "/post", { from: "rt-a", to: "rt-b", text: "question" });
    expect(first.status).toBe(200);
    const q = await waitFor(ui.events, (e) => e.text === "question");
    expect(typeof q.id).toBe("number");
    expect(q.reply_to).toBeUndefined();

    // /post reply, delivered to the stream with reply_to.
    const r1 = await postJson(hub, "/post", { from: "rt-b", to: "rt-a", text: "answer", reply_to: q.id });
    expect(r1.status).toBe(200);
    const ans = await waitFor(ui.events, (e) => e.text === "answer");
    expect(ans.reply_to).toBe(q.id);

    // /send reply from the human reaches the agent stream with reply_to.
    const s1 = await postJson(hub, "/send", { target: "rt-a", text: "thanks", room: "rt-room", reply_to: ans.id });
    expect(s1.status).toBe(200);
    const got = await waitFor(aStream.events, (e) => e.text === "thanks");
    expect(got.reply_to).toBe(ans.id);

    // Unknown id, other room, wrong type.
    const unknown = await postJson(hub, "/send", { target: "rt-a", text: "x", room: "rt-room", reply_to: 999999 });
    expect(unknown.status).toBe(400);
    const wrongRoom = await postJson(hub, "/post", { from: "rt-o", to: "all", text: "x", reply_to: q.id });
    expect(wrongRoom.status).toBe(400);
    const wrongRoomSend = await postJson(hub, "/send", { target: "rt-o", text: "x", room: "rt-other", reply_to: q.id });
    expect(wrongRoomSend.status).toBe(400);
    const badType = await postJson(hub, "/send", { target: "rt-a", text: "x", room: "rt-room", reply_to: "1" });
    expect(badType.status).toBe(400);

    // No reply_to: no field on the message.
    const plain = await postJson(hub, "/send", { target: "rt-a", text: "plain", room: "rt-room" });
    expect(plain.status).toBe(200);
    const p = await waitFor(aStream.events, (e) => e.text === "plain");
    expect("reply_to" in p).toBe(false);

    for (const c of [ui, bStream, aStream, other]) c.close();
  });

  for (const persist of [true, false]) {
    test(`after a restart a reply to an old message is ${persist ? "accepted" : "refused"} (persist_transcript ${persist})`, async () => {
      const base = mkdtempSync(join(tmpdir(), "cubilot-replyto-"));
      mkdirSync(join(base, "transcripts"), { recursive: true });
      const prev = process.env.CUBILOT_TRANSCRIPTS_DIR;
      process.env.CUBILOT_TRANSCRIPTS_DIR = join(base, "transcripts");
      let hub: HubHandle;
      try {
        hub = await spawnHub();
        const room = `rt-restart-${persist}`;
        await putSettings(hub, room, persist);
        const ag = await registerAgent(hub, "rt-r", { room });
        await postJson(hub, "/post", { from: "rt-r", to: "human", text: "before restart" });
        await new Promise((r) => setTimeout(r, 200));
        ag.close();
        await hub.kill();

        hub = await spawnHub({ restartOf: hub });
        hubs.push(hub);
        const ui = openSSE(hub, "/stream?lastSeenId=0");
        // First agent reconnect triggers the lazy hydration.
        const re = await registerAgent(hub, "rt-r", { room });
        let oldId: number | undefined;
        try {
          oldId = (await waitFor(ui.events, (e) => e.text === "before restart", 1500)).id;
        } catch { /* not replayed when persist is off */ }
        if (persist) expect(typeof oldId).toBe("number");
        else expect(oldId).toBeUndefined();

        const res = await postJson(hub, "/post", { from: "rt-r", to: "human", text: "reply", reply_to: oldId ?? 1 });
        expect(res.status).toBe(persist ? 200 : 400);
        ui.close();
        re.close();
      } finally {
        if (prev === undefined) delete process.env.CUBILOT_TRANSCRIPTS_DIR;
        else process.env.CUBILOT_TRANSCRIPTS_DIR = prev;
      }
    }, 15000);
  }
});
