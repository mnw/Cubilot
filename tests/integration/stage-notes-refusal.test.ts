// context-pack 1.3 through the real hub: a result without context.notes is refused for every stage role and for a spec review.
// Refused: 400 with the field name, no handoff row, the stage stays running. The same result with valid notes passes.

import { describe, test, expect } from "bun:test";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { giveProjectHttp, projectRepo } from "../helpers/repo";
import { authedFetch, getJson, openSSE, postJson, registerAgent } from "../helpers/fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const REVIEW = new Set(["validator", "reviewer"]);

async function withHub(fn: (hub: HubHandle, open: Array<{ close: () => void }>) => Promise<void>) {
  const hub = await spawnHub();
  const open: Array<{ close: () => void }> = [];
  try {
    await giveProjectHttp(hub, "r1");
    if (Bun.spawnSync(["git", "-C", projectRepo(), "show-ref", "--verify", "--quiet", "refs/heads/staging"]).exitCode !== 0) git("branch", "staging");
    open.push(await registerAgent(hub, "Orchestrator", { room: "r1" }));
    await fn(hub, open);
  } finally {
    for (const c of open) c.close();
    await hub.kill();
  }
}

const handoffCount = async (hub: HubHandle) => ((await getJson(hub, "/handoffs?for=Orchestrator")).json as unknown[]).length;
const status = async (hub: HubHandle, id: string) => ((await getJson(hub, `/stages/${id}`)).json as { status: string }).status;
const over400 = Array.from({ length: 401 }, () => "w").join(" ");

describe("a stage result without context.notes is refused (every role)", () => {
  for (const role of ["worker", "tester", "validator", "writer", "editor", "reviewer"]) {
    test(`${role}: missing, empty and 401-word notes get 400 with the field name; no handoff; stage running; valid notes pass`, async () => {
      await withHub(async (hub, open) => {
        const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: null });
        const ticketId = (t.json as { snapshot: { id: string } }).snapshot.id;
        const newCommit = () => {
          const tip = git("rev-parse", `refs/heads/ticket/${ticketId}`);
          const sha = git("commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "work");
          git("update-ref", `refs/heads/ticket/${ticketId}`, sha);
          return sha;
        };
        // Starts a stage by a role handoff and returns its running session and stage id.
        // after: runs once the handoff is sent. The editor waits for the close ack of the writer session, so the
        // close request on the stream is acked too, and the loop ends at the launch of startRole.
        const start = async (startRole: string, after?: () => Promise<void>) => {
          const sse = openSSE(hub, "/launches/stream");
          expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: startRole, task: "start", context: { ticket_id: ticketId } })).status).toBe(201);
          await after?.();
          let name = "";
          for await (const req of sse.events) {
            expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
            if (req.kind === "close") continue;
            name = req.session;
            break;
          }
          sse.close();
          expect(name).toBe(`${startRole}-1`);
          open.push(await registerAgent(hub, name, { room: "r1" }));
          return name;
        };
        let writerTurnEnd: (() => Promise<void>) | undefined;
        // The writing roles cannot be set as a ticket role. An editor needs a passed writer result first.
        if (role === "editor") {
          const w = await start("writer");
          const wStage = ((await getJson(hub, "/stages?status=running")).json as Array<{ id: string }>)[0].id;
          const wr = await postJson(hub, "/handoffs", { from: w, to_role: "editor", task: "result", context: { stage_id: wStage, ticket_id: ticketId, notes: "Wrote X. Checked Y. Limit: none.", commit: newCommit() } });
          expect(wr.status).toBe(201);
          await sleep(200);
          writerTurnEnd = async () => { expect((await postJson(hub, `/stages/${wStage}/turn-end`, { agent: w })).status).toBe(200); };
        }
        const session = await start(role, writerTurnEnd);
        const stageId = ((await getJson(hub, "/stages?status=running")).json as Array<{ id: string; role: string }>).find((x) => x.role === role)!.id;

        const send = (notes: unknown, commit?: string) => {
          const context: Record<string, unknown> = { stage_id: stageId, ticket_id: ticketId };
          if (notes !== undefined) context.notes = notes;
          if (REVIEW.has(role)) Object.assign(context, { verdict: "PASS", findings: [] });
          if (commit) context.commit = commit;
          const toRole = role === "worker" ? "tester" : role === "writer" ? "editor" : role === "editor" ? "reviewer" : null;
          return postJson(hub, "/handoffs", toRole ? { from: session, to_role: toRole, task: "result", context } : { from: session, to: "Orchestrator", task: "result", context });
        };
        const commit = ["worker", "writer", "editor"].includes(role) ? newCommit() : role === "tester" ? "0123456789abcdef0123456789abcdef01234567" : undefined;

        const before = await handoffCount(hub);
        for (const notes of [undefined, "", over400]) {
          const r = await send(notes, commit);
          expect(r.status).toBe(400);
          expect(JSON.stringify(r.json)).toContain("context.notes");
          expect(await status(hub, stageId)).toBe("running");
        }
        expect(await handoffCount(hub)).toBe(before);

        const ok = await send("Changed X. Tested with Y. Limit: Z.", commit);
        expect(ok.status).toBe(201);
        await sleep(200);
        expect(await status(hub, stageId)).toBe("passed");
      });
    }, 30_000);
  }

  test("spec review: a result without notes gets 400 with the field name; no handoff; stage running; valid notes pass", async () => {
    await withHub(async (hub, open) => {
      const stream = openSSE(hub, "/launches/stream");
      const launches: any[] = [];
      void (async () => { try { for await (const e of stream.events) launches.push(e); } catch { /* closed */ } })();
      await sleep(200);
      const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "Plan item", acceptance_criteria: "It is planned.", blast_radius: "low", request_id: "req-9", status: "draft" });
      const ticketId = (t.json as any).snapshot.id;
      expect((await postJson(hub, "/handoffs", { from: "Orchestrator", to_role: "validator", review: "spec", request_id: "req-9", task: "review", context: { request_text: "Build", spec_paths: [] } })).status).toBe(201);
      await sleep(500);
      const req = launches.at(-1);
      open.push(await registerAgent(hub, req.session, { room: "r1" }));
      expect((await authedFetch(hub, `/launches/${req.id}/ack`, { method: "POST", body: JSON.stringify({ result: "spawned" }) })).status).toBe(200);
      const stageId = ((await getJson(hub, "/stages?status=all")).json as any[]).find((s) => s.review === "spec").id;
      const send = (notes?: unknown) =>
        postJson(hub, "/handoffs", {
          from: req.session, to: "Orchestrator", task: "result",
          context: { ...(notes === undefined ? {} : { notes }), stage_id: stageId, review: "spec", request_id: "req-9", verdict: "PASS", findings: [{ ticket_id: ticketId, severity: "suggestion", text: "ok" }], suggestions: [], questions_for_human: [] },
        });
      const before = await handoffCount(hub);
      for (const notes of [undefined, "", over400]) {
        const r = await send(notes);
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.json)).toContain("context.notes");
        expect(await status(hub, stageId)).toBe("running");
      }
      expect(await handoffCount(hub)).toBe(before);
      expect((await send("Scope checked. Open question none.")).status).toBe(201);
      await sleep(300);
      expect(await status(hub, stageId)).toBe("passed");
      stream.close();
    });
  }, 30_000);

  test("a post to the Orchestrator without stage_id needs no notes", async () => {
    await withHub(async (hub, open) => {
      const t = await postJson(hub, "/tickets", { by: "Orchestrator", title: "T", acceptance_criteria: "c", blast_radius: "low", priority: "medium", role: "tester" });
      expect(t.status).toBe(201);
      const sse = openSSE(hub, "/launches/stream");
      for await (const req of sse.events) {
        expect((await postJson(hub, `/launches/${req.id}/ack`, { result: "spawned" })).status).toBe(200);
        open.push(await registerAgent(hub, req.session, { room: "r1" }));
        const r = await postJson(hub, "/post", { from: req.session, to: "Orchestrator", text: "blocked: unclear criteria" });
        expect(r.status).toBe(200);
        break;
      }
      sse.close();
    });
  }, 30_000);
});
