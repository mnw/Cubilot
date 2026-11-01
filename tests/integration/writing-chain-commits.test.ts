// Writing chain: a writer or editor hand-over needs new work on ticket/<id>. checkResult against a temp git repo and an in-memory ledger.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLedger, setRoomSettings } from "../../hub/core/ledger";
import { createTicketKind } from "../../hub/kinds/ticket";
import { trackedRuntime, disposeRuntimes } from "../helpers/stage-runtimes";

afterEach(disposeRuntimes);
import type { Entry, HubCapabilities, Scope } from "../../hub/core/types";

const TID = "t_0000000000000002";

function makeEnv(project?: string) {
  const dir = mkdtempSync(join(tmpdir(), "wcc-"));
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

  const db = new Database(":memory:");
  migrateLedger(db);
  createTicketKind(db).migrate(db);
  setRoomSettings(db, "r1", { project_folder: project ?? dir });
  const emitted: Array<{ e: Entry; s: Scope }> = [];
  const cap = { db, sse: { emit: (e: Entry, s: Scope) => emitted.push({ e, s }) }, briefing: { refresh: () => {} } } as unknown as HubCapabilities;
  db.run(
    `INSERT INTO tickets (id, room, title, acceptance_criteria, blast_radius, priority, creator, status, request_id, created_at_ms, updated_at_ms, version)
     VALUES (?, 'r1', 'T', 'c', 'low', 'medium', 'a', 'in_progress', 'req-1', 1, 1, 1)`,
    [TID],
  );
  const rt = trackedRuntime(db, { ackMs: 60_000 });
  rt.module.migrate(db);
  let sn = 0;
  const running = (role: string) => {
    const session = `${role}-${++sn}`;
    const s = rt.api.create({ ticket_id: TID, role: role as "writer" }, "system", cap);
    rt.api.move(s.id, { to: "launching", session }, "system", cap);
    rt.api.move(s.id, { to: "running" }, "system", cap);
    return { id: s.id, session };
  };
  let hn = 0;
  /** An earlier passed stage of `role` with a recorded result commit. */
  const earlier = (role: string, commit: string) => {
    const s = rt.api.create({ ticket_id: TID, role: role as "writer" }, "system", cap);
    db.run("UPDATE stage SET status = 'passed' WHERE id = ?", [s.id]);
    const id = `h_${String(++hn).padStart(16, "0")}`;
    db.run("INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'w', 'role:x', 'r', ?, 'pending', 1, 2)", [
      id,
      JSON.stringify({ ticket_id: TID, stage_id: s.id, commit }),
    ]);
    db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'created', 'w', '{}', 1)", [id]);
  };
  /** `start`: the ticket/<id> head recorded when the writer stage started (the hub records it at launch). */
  const send = (role: "writer" | "editor", commit: unknown, to: string, start: string = c0) => {
    const st = running(role);
    if (role === "writer") db.run("UPDATE stage SET start_commit = ? WHERE id = ?", [start, st.id]);
    return rt.hooks.checkResult(st.session, { notes: "n", stage_id: st.id, ticket_id: TID, ...(commit === undefined ? {} : { commit }) }, cap, to)!;
  };
  return { dir, git, c0, c1, c2, c3, x, earlier, send };
}

describe("writer without new commit refused", () => {
  test("a new commit passes", () => {
    const e = makeEnv();
    expect(e.send("writer", e.c1, "role:editor")).toEqual([]);
  });
  test("commits that exist before the stage are not new work", () => {
    const e = makeEnv();
    expect(e.send("writer", e.c1, "role:editor", e.c3)[0]).toContain("ancestor");
    expect(e.send("writer", e.c3, "role:editor", e.c3)[0]).toContain("equals the base");
  });
  test("a recorded base that is malformed or does not resolve refuses, never falls back", () => {
    const e = makeEnv();
    expect(e.send("writer", e.c1, "role:editor", "0".repeat(40))[0]).toContain("recorded writer base");
    expect(e.send("writer", e.c1, "role:editor", "abc")[0]).toContain("recorded writer base");
  });
  test("equal to the base is refused and says what is missing", () => {
    const e = makeEnv();
    expect(e.send("writer", e.c0, "role:editor")[0]).toContain("equals the base");
  });
  test("an ancestor of the base (earlier writer result) is refused", () => {
    const e = makeEnv();
    e.earlier("writer", e.c2);
    expect(e.send("writer", e.c1, "role:editor", e.c2)[0]).toContain("ancestor");
    expect(e.send("writer", e.c2, "role:editor", e.c2)[0]).toContain("equals the base");
    expect(e.send("writer", e.c3, "role:editor", e.c2)).toEqual([]);
  });
  test("malformed, unresolved and off-branch commits are refused", () => {
    const e = makeEnv();
    expect(e.send("writer", "abc", "role:editor")[0]).toContain("40-character");
    expect(e.send("writer", undefined, "role:editor")[0]).toContain("40-character");
    expect(e.send("writer", "f".repeat(40), "role:editor")[0]).toContain("does not resolve");
    expect(e.send("writer", e.x, "role:editor")[0]).toContain(`not on ticket/${TID}`);
  });
});

describe("editor without new work refused", () => {
  test("no passed writer commit is refused", () => {
    const e = makeEnv();
    expect(e.send("editor", e.c2, "role:reviewer")[0]).toContain("no passed writer result");
  });
  test("the same commit as the writer is refused", () => {
    const e = makeEnv();
    e.earlier("writer", e.c1);
    expect(e.send("editor", e.c1, "role:reviewer")[0]).toContain("equals the writer commit");
  });
  test("a commit that does not hold the writer commit is refused", () => {
    const e = makeEnv();
    e.earlier("writer", e.c2);
    expect(e.send("editor", e.c1, "role:reviewer")[0]).toContain("does not hold the writer commit");
  });
  test("a new commit that holds the writer commit passes", () => {
    const e = makeEnv();
    e.earlier("writer", e.c1);
    expect(e.send("editor", e.c3, "role:reviewer")).toEqual([]);
  });
});

describe("wrong next role refused", () => {
  test("a writer result to tester names editor", () => {
    const e = makeEnv();
    expect(e.send("writer", e.c1, "role:tester")[0]).toContain("to_role editor");
  });
  test("an editor result to editor names reviewer", () => {
    const e = makeEnv();
    e.earlier("writer", e.c1);
    expect(e.send("editor", e.c3, "role:editor")[0]).toContain("to_role reviewer");
  });
});

describe("git failure refuses", () => {
  test("a missing project repository refuses a writer and an editor result", () => {
    const e = makeEnv("/nonexistent/wcc-project");
    expect(e.send("writer", e.c1, "role:editor")[0]).toContain("Git:");
    e.earlier("writer", e.c1);
    expect(e.send("editor", e.c3, "role:reviewer")[0]).toContain("Git:");
  });
});

describe("PROTOCOL describes the writing-chain hand-over rule", () => {
  const text = readFileSync(join(import.meta.dir, "../../docs/PROTOCOL.md"), "utf8");
  test("it names the four checks", () => {
    const i = text.indexOf("Writing-chain hand-over");
    expect(i).toBeGreaterThan(-1);
    const sec = text.slice(i, i + 2500).toLowerCase();
    for (const w of ["new commit", "writer commit", "to_role editor", "to_role reviewer", "git failure refuses"]) expect(sec).toContain(w);
    expect(sec).toContain("refuse");
  });
});
