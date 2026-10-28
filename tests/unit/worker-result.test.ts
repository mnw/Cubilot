// G2: a worker stage passes only on a handoff to_role tester with a new commit on ticket/<id>.
// checkResult against a temp git repo and an in-memory ledger; the earlier results are rows in handoffs + events.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { createStageRuntime } from "../../hub/kinds/stage";
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const TID = "t_0000000000000001";
const TESTER = "role:tester";
const REFUSAL = `A worker result needs to_role tester and a new commit on ticket/${TID}. To report a block, post to the Orchestrator without stage_id.`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "g2-proj-"));
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "staging");
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git("config", k, v);
  let n = 0;
  const commit = () => {
    writeFileSync(join(dir, "f.txt"), String(++n));
    git("add", ".");
    git("commit", "-qm", `c${n}`);
    return git("rev-parse", "HEAD");
  };
  const c0 = commit();
  git("checkout", "-q", "-b", `ticket/${TID}`);
  const [c1, c2, c3] = [commit(), commit(), commit()];
  git("checkout", "-q", "-b", "other", c0);
  const x = commit();
  git("checkout", "-q", `ticket/${TID}`);
  return { dir, git, commit, c0, c1, c2, c3, x };
}

function makeEnv(project?: string, ledgerFile?: string) {
  const repo = makeRepo();
  let db = new Database(ledgerFile ?? ":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  setRoomSettings(db, "r1", { project_folder: project ?? repo.dir });
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const mkCap = () => ({ db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } }) as unknown as HubCapabilities;
  let cap = mkCap();
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'in_progress', 'req-1', 1, 1, 1)`,
    [TID],
  );
  const boot = () => {
    const rt = createStageRuntime(db, { ackMs: 60_000 });
    rt.module.migrate(db);
    return rt;
  };
  let rt = boot();
  let sn = 0;
  const running = (role: string, session: string) => {
    const s = rt.api.create({ ticket_id: TID, role: role as "worker" }, "system", cap);
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    return s.id;
  };
  let hn = 0;
  /** An earlier passed worker stage with a recorded result. `context` is the result context (stage_id is filled in). */
  const earlier = (context: Record<string, unknown>) => {
    const s = rt.api.create({ ticket_id: TID, role: "worker" }, "system", cap);
    db.run("UPDATE stage SET status = 'passed' WHERE id = ?", [s.id]);
    const id = `h_${String(++hn).padStart(16, "0")}`;
    db.run(
      "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'w', ?, 'r', ?, 'pending', 1, 2)",
      [id, TESTER, JSON.stringify({ ticket_id: TID, stage_id: s.id, ...context })],
    );
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'created', 'w', '{}', 1)", [id]);
    return id;
  };
  const touch = (handoff: string) => db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'accepted', 't', '{}', 2)", [handoff]);
  const work = () => {
    const stage = running("worker", `worker-${++sn}`);
    const check = (commit: unknown, to: string | undefined = TESTER) =>
      rt.hooks.checkResult(`worker-${sn}`, { notes: "n", stage_id: stage, ticket_id: TID, ...(commit === undefined ? {} : { commit }) }, cap, to);
    return { stage, check, load: () => rt.api.load(stage)! };
  };
  /** A new hub process on the same ledger file: close the database, open the file again, build a new runtime. */
  const reopen = () => {
    db.close();
    db = new Database(ledgerFile!);
    cap = mkCap();
    rt = boot();
  };
  return {
    repo,
    get db() {
      return db;
    },
    get cap() {
      return cap;
    },
    emitted,
    earlier,
    touch,
    work,
    running,
    restart: () => (rt = boot()),
    reopen,
    rt: () => rt,
  };
}

describe("first result: the base is the merge-base with staging", () => {
  test("a new commit passes the stage", () => {
    const e = makeEnv();
    const w = e.work();
    expect(w.check(e.repo.c1)).toEqual([]);
    e.rt().hooks.onResult("worker-1", { notes: "n", stage_id: w.stage, ticket_id: TID, commit: e.repo.c1 }, e.cap);
    expect(w.load().status).toBe("passed");
  });
  test("the tip of the ticket branch passes", () => {
    const e = makeEnv();
    expect(e.work().check(e.repo.c3)).toEqual([]);
  });
  test("the merge-base itself is refused", () => {
    const e = makeEnv();
    expect(e.work().check(e.repo.c0)).toEqual([expect.stringContaining(REFUSAL)]);
    expect(e.work().check(e.repo.c0)![0]).toContain("equals the base");
  });
});

describe("fix loop: the base is the newest earlier passed result", () => {
  test("a commit that descends from the last passed result passes", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c2 });
    expect(e.work().check(e.repo.c3)).toEqual([]);
  });
  test("equal to the last passed commit, or an older ancestor of the base: refused", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c2 });
    const w = e.work();
    expect(w.check(e.repo.c2)![0]).toContain("equals the base");
    expect(w.check(e.repo.c1)![0]).toContain("does not descend from the base");
    expect(w.load().status).toBe("running");
  });
  test("a branch reset: a commit that does not descend from the base is refused", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c2 });
    e.repo.git("reset", "-q", "--hard", e.repo.c0);
    const d1 = e.repo.commit();
    expect(e.work().check(d1)![0]).toContain("does not descend from the base");
  });
  test("an earlier result with no commit or an invalid commit is skipped", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c1 });
    e.earlier({}); // the G2 "blocked" handoff
    e.earlier({ commit: "not-a-hash" });
    e.earlier({ commit: "0".repeat(40) }); // well formed, resolves to nothing
    const w = e.work();
    expect(w.check(e.repo.c1)![0]).toContain("equals the base"); // c1 is the newest valid one
    expect(w.check(e.repo.c2)).toEqual([]);
  });
  test("with only invalid earlier results the base is the merge-base", () => {
    const e = makeEnv();
    e.earlier({});
    e.earlier({ commit: "XYZ" });
    expect(e.work().check(e.repo.c1)).toEqual([]);
  });
  test("a passed stage of another role or another ticket does not set the base", () => {
    const e = makeEnv();
    const id = e.earlier({ commit: e.repo.c3 });
    e.db.run("UPDATE stage SET role = 'tester' WHERE id = (SELECT json_extract(context_json, '$.stage_id') FROM handoffs WHERE id = ?)", [id]);
    expect(e.work().check(e.repo.c1)).toEqual([]);
  });
  test("the order is the creation event, not the highest event number", () => {
    const e = makeEnv();
    const first = e.earlier({ commit: e.repo.c3 });
    e.earlier({ commit: e.repo.c1 }); // created later: this is the base
    e.touch(first); // `first` now has the highest event number
    const w = e.work();
    expect(w.check(e.repo.c1)![0]).toContain("equals the base");
    expect(w.check(e.repo.c2)).toEqual([]);
  });
  test("a new hub process on the same ledger file gives the same base", () => {
    const e = makeEnv(undefined, join(mkdtempSync(join(tmpdir(), "g2-ledger-")), "ledger.db"));
    e.earlier({ commit: e.repo.c2 });
    e.reopen();
    const w = e.work();
    expect(w.check(e.repo.c2)![0]).toContain("equals the base");
    expect(w.check(e.repo.c3)).toEqual([]);
  });
  test("a rebooted runtime in one process gives the same base", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c2 });
    e.restart();
    const w = e.work();
    expect(w.check(e.repo.c2)![0]).toContain("equals the base");
    expect(w.check(e.repo.c3)).toEqual([]);
  });
});

describe("refusals", () => {
  test("a missing, unknown or foreign ticket_id gets the worker refusal and stage.rejected", () => {
    const e = makeEnv();
    const w = e.work();
    const send = (ctx: Record<string, unknown>) => e.rt().hooks.checkResult("worker-1", { notes: "n", stage_id: w.stage, ...ctx }, e.cap, TESTER);
    expect(send({ commit: e.repo.c1 })).toEqual([REFUSAL]);
    expect(send({ ticket_id: "t_ffffffffffffffff", commit: e.repo.c1 })).toEqual([REFUSAL]);
    expect(send({ ticket_id: "t_0000000000000002", commit: e.repo.c1 })).toEqual([REFUSAL]);
    expect(e.emitted.filter((x) => x.e.kind === "stage.rejected")).toHaveLength(3);
    expect(w.load().status).toBe("running");
  });
  test("a git exec error gives the git error text, not 'does not resolve'; an earlier result is not skipped", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c2 });
    const w = e.work();
    // Break the object database: the branch ref still resolves, rev-parse of an object fails with an error.
    const objs = join(e.repo.dir, ".git", "objects");
    Bun.spawnSync(["mv", objs, `${objs}.off`]);
    const r = w.check(e.repo.c3);
    Bun.spawnSync(["mv", `${objs}.off`, objs]);
    expect(r).toHaveLength(1);
    expect(r![0]).toContain(REFUSAL);
    expect(r![0]).toContain("Git:");
    expect(r![0]).not.toContain("does not resolve");
    expect(w.load().status).toBe("running");
  });
  test("a malformed hash is refused before any git call", () => {
    const e = makeEnv("/nonexistent/g2-project"); // any git call would add a detail to the message
    const w = e.work();
    for (const bad of [e.repo.c1.slice(0, 12), e.repo.c1.toUpperCase(), "g".repeat(40), `ticket/${TID}`, "staging", 5, undefined]) {
      expect(w.check(bad)).toEqual([REFUSAL]);
    }
    expect(w.load().status).toBe("running");
  });
  test("a handoff to the Orchestrator with the stage_id is refused; the session gets stage.rejected", () => {
    const e = makeEnv();
    const w = e.work();
    expect(w.check(e.repo.c1, "Orchestrator")).toEqual([REFUSAL]);
    expect(w.check(e.repo.c1, "role:validator")).toEqual([REFUSAL]);
    expect(w.load().status).toBe("running");
    const rej = e.emitted.filter((x) => x.e.kind === "stage.rejected");
    expect(rej).toHaveLength(2);
    expect(rej[0].s).toEqual({ kind: "to-agents", agents: ["worker-1"] });
  });
  test("a commit that does not resolve, or is not on the ticket branch, is refused", () => {
    const e = makeEnv();
    const w = e.work();
    expect(w.check("0".repeat(40))![0]).toContain("does not resolve");
    expect(w.check(e.repo.x)![0]).toContain(`not on ticket/${TID}`);
  });
  test("a missing ticket branch, a missing staging branch, a missing project folder: refused with the detail; stage running", () => {
    const a = makeEnv();
    a.repo.git("checkout", "-q", "other");
    a.repo.git("branch", "-D", `ticket/${TID}`);
    const wa = a.work();
    expect(wa.check(a.repo.c1)![0]).toContain(REFUSAL);
    expect(wa.check(a.repo.c1)![0]).toContain(`branch ticket/${TID} not found`);
    expect(wa.load().status).toBe("running");

    const b = makeEnv();
    b.repo.git("branch", "-m", "staging", "trunk");
    const wb = b.work();
    expect(wb.check(b.repo.c1)![0]).toContain("no merge-base with staging");
    expect(wb.load().status).toBe("running");

    const c = makeEnv();
    c.db.run("DELETE FROM room_settings");
    expect(c.work().check(c.repo.c1)![0]).toContain("no project folder");

    const d = makeEnv("/nonexistent/g2-project");
    expect(d.work().check(d.repo.c1)![0]).toContain(`branch ticket/${TID} not found`);
  });
  test("a missing staging branch does not matter once an earlier result gives the base", () => {
    const e = makeEnv();
    e.earlier({ commit: e.repo.c1 });
    e.repo.git("branch", "-m", "staging", "trunk");
    expect(e.work().check(e.repo.c2)).toEqual([]);
  });
});

describe("other roles are unchanged", () => {
  test("a writer and a validator result need no commit; a tester result needs the full commit sha", () => {
    const e = makeEnv();
    const w = e.running("writer", "writer-1");
    expect(e.rt().hooks.checkResult("writer-1", { notes: "n", stage_id: w, ticket_id: TID }, e.cap, "Orchestrator")).toEqual([]);
    const t = e.running("tester", "tester-1");
    expect(e.rt().hooks.checkResult("tester-1", { notes: "n", stage_id: t, ticket_id: TID }, e.cap, "role:validator")).toEqual([
      "context.commit must be the full 40-character commit sha",
    ]);
    expect(e.rt().hooks.checkResult("tester-1", { notes: "n", stage_id: t, ticket_id: TID, commit: "a".repeat(40) }, e.cap, "role:validator")).toEqual([]);
    const v = e.running("validator", "validator-1");
    expect(e.rt().hooks.checkResult("validator-1", { notes: "n", stage_id: v, ticket_id: TID, verdict: "PASS", findings: [] }, e.cap, "Orchestrator")).toEqual([]);
  });

});
