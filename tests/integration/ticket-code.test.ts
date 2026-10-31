// GET /tickets/<id>/code through the real hub with a temp git repo (Part 14 H2).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { getJson, postJson, registerAgent } from "../helpers/fetch";

describe("GET /tickets/<id>/code", () => {
  let hub: HubHandle;
  let agent: { close: () => void };
  let repo: string;
  const sh = (...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
  const commit = (msg: string) => { sh("add", "."); sh("-c", "commit.gpgsign=false", "commit", "-qm", msg); };
  const newTicket = async (title: string) =>
    ((await postJson(hub, "/tickets", { by: "alice", title, acceptance_criteria: "x", blast_radius: "low" })).json as { snapshot: { id: string } }).snapshot.id;
  const code = (id: string) => getJson(hub, `/tickets/${id}/code?token=${hub.token}`);

  beforeAll(async () => {
    hub = await spawnHub();
    agent = await registerAgent(hub, "alice", { room: "rc" });
    repo = mkdtempSync(join(tmpdir(), "ticket-code-"));
    sh("init", "-q", "-b", "staging");
    sh("config", "user.email", "t@t");
    sh("config", "user.name", "t");
    write("base.txt", "one\ntwo\n");
    commit("base");
    const res = await fetch(`${hub.url}/rooms/rc/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${hub.humanToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project_folder: repo }),
    });
    expect(res.ok).toBe(true);
  });

  afterAll(async () => {
    agent.close();
    await hub.kill();
  });

  test("open branch: head, files and totals from merge-base", async () => {
    const id = await newTicket("open");
    sh("checkout", "-q", "-b", `ticket/${id}`);
    write("base.txt", "one\ntwo\nthree\n");
    write("new.txt", "a\nb\n");
    commit("work");
    const head = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "staging");
    write("other.txt", "staging only\n");
    commit("staging moves");

    const r = await code(id);
    expect(r.status).toBe(200);
    const body = r.json as { branch: string; head: string; on_staging: boolean; files: { path: string; added: number; removed: number }[]; totals: { added: number; removed: number } };
    expect(body.branch).toBe(`ticket/${id}`);
    expect(body.head).toBe(head);
    expect(body.on_staging).toBe(false);
    expect([...body.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "base.txt", added: 1, removed: 0 },
      { path: "new.txt", added: 2, removed: 0 },
    ]);
    expect(body.totals).toEqual({ added: 3, removed: 0 });
  });

  test("merged and deleted branch: second parent as head, files from the merge", async () => {
    const id = await newTicket("merged");
    sh("checkout", "-q", "-b", `ticket/${id}`);
    write("m1.txt", "x\ny\nz\n");
    write("base.txt", "one\n");
    commit("work");
    const head = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "staging");
    sh("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", `ticket/${id}`, "-m", `Merge ticket/${id}: merged (validator PASS h_1)`);
    sh("branch", "-q", "-D", `ticket/${id}`);

    const body = (await code(id)).json as { head: string; on_staging: boolean; files: { path: string; added: number; removed: number }[]; totals: { added: number; removed: number } };
    expect(body.head).toBe(head);
    expect(body.on_staging).toBe(true);
    expect([...body.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "base.txt", added: 0, removed: 1 },
      { path: "m1.txt", added: 3, removed: 0 },
    ]);
    expect(body.totals).toEqual({ added: 3, removed: 1 });
  });

  test("open branch already on staging: the diff is empty", async () => {
    const id = await newTicket("on staging");
    sh("checkout", "-q", "-b", `ticket/${id}`);
    write("os.txt", "x\n");
    commit("work");
    const head = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "staging");
    sh("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", `ticket/${id}`, "-m", `Merge ticket/${id}: on staging (validator PASS h_2)`);

    const body = (await code(id)).json as { head: string; on_staging: boolean; files: unknown[]; totals: { added: number; removed: number } };
    expect(body.head).toBe(head);
    expect(body.on_staging).toBe(true);
    expect(body.files).toEqual([]);
    expect(body.totals).toEqual({ added: 0, removed: 0 });
  });

  test("deleted branch: the ticket.done note names the merge commit, the subject does not", async () => {
    const id = await newTicket("by note");
    sh("checkout", "-q", "-b", `ticket/${id}`);
    write("n1.txt", "p\nq\n");
    commit("work");
    const head = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "staging");
    sh("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", `ticket/${id}`, "-m", "staging batch, no ticket name");
    const merge = sh("rev-parse", "HEAD");
    sh("branch", "-q", "-D", `ticket/${id}`);
    const done = await postJson(hub, `/tickets/${id}/transition`, { by: "human", to: "done", note: `merged as ${merge}` });
    expect(done.status).toBe(200);

    const body = (await code(id)).json as { head: string; on_staging: boolean; files: { path: string; added: number; removed: number }[] };
    expect(body.head).toBe(head);
    expect(body.on_staging).toBe(true);
    expect(body.files).toEqual([{ path: "n1.txt", added: 2, removed: 0 }]);
  });

  test("no branch and no merge: head null, empty files", async () => {
    const id = await newTicket("nothing");
    const r = await code(id);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ branch: `ticket/${id}`, head: null, on_staging: false, files: [], totals: { added: 0, removed: 0 } });
  });

  test("unknown ticket 404, bad id 400", async () => {
    expect((await code("t_0123456789abcdef")).status).toBe(404);
    expect((await code("nope")).status).toBe(400);
  });
});
