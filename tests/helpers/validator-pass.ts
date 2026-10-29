// L4: seeds what the lead's done gate reads, without running stage sessions: Validator PASS stages of a ticket and the
// Tester handoff commit that started them. The room needs a project folder (giveProject).
import type { Database } from "bun:sqlite";
import { projectRepo } from "./repo";

/** A commit on the `staging` branch of the shared test project (merged), and one that staging does not hold. */
export function stagingCommits(): { merged: string; unmerged: string } {
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", projectRepo(), ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git("branch", "-f", "staging", "main");
  const merged = git("rev-parse", "main");
  return { merged, unmerged: git("commit-tree", `${merged}^{tree}`, "-p", merged, "-m", "unmerged") };
}

let n = 0;
/** Records `count` passed Validator stages for the ticket, all started by one Tester handoff on `commit`. */
export function seedValidatorPasses(db: Database, ticketId: string, count: number, commit = stagingCommits().merged): void {
  const hid = `h_seed${++n}`;
  db.run(
    "INSERT INTO handoffs (id, from_agent, to_agent, task, context_json, status, created_at_ms, expires_at_ms) VALUES (?, 'tester-1', 'role:validator', 'validate', ?, 'accepted', 1, 9999999999999)",
    [hid, JSON.stringify({ ticket_id: ticketId, commit })],
  );
  db.run("INSERT INTO events (entity_id, kind, actor, payload_json, at_ms) VALUES (?, 'handoff.created', 'tester-1', '{}', 1)", [hid]);
  for (let i = 0; i < count; i++) {
    const seq = db.query<{ m: number }, []>("SELECT MAX(seq) AS m FROM events").get()!.m + 1 + i;
    db.run("INSERT INTO stage (id, ticket_id, role, status, verdict, created_seq) VALUES (?, ?, 'validator', 'passed', 'PASS', ?)", [`s_seed${n}_${i}`, ticketId, seq]);
  }
}
