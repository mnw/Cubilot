// Code state of a ticket branch (Part 14 H2): branch, head, files and line totals, read from git. No model, no stored state.
// Read-only git (rev-parse, merge-base, log, diff --numstat), fixed arguments, no shell, a time limit. A git failure reads as "no code".

export type CodeFile = { path: string; added: number; removed: number };
export type CodeState = {
  branch: string;
  head: string | null;
  on_staging: boolean;
  files: CodeFile[];
  totals: { added: number; removed: number };
};

const SHA_RE = /^[0-9a-f]{40}$/;
const STAGING = "refs/heads/staging";

const git = (project: string, args: string[]): { code: number; out: string } => {
  try {
    const r = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: r.exitCode ?? 1, out: r.stdout.toString() };
  } catch {
    return { code: 1, out: "" };
  }
};

const sha = (project: string, args: string[]): string | null => {
  const r = git(project, args);
  const s = r.out.trim();
  return r.code === 0 && SHA_RE.test(s) ? s : null;
};

/** Files changed from `from` to `to`. A binary file counts 0 added and 0 removed. Renames show as delete plus add. */
function numstat(project: string, from: string, to: string): CodeFile[] {
  const r = git(project, ["diff", "--numstat", "--no-renames", "-z", from, to]);
  if (r.code !== 0) return [];
  const files: CodeFile[] = [];
  for (const rec of r.out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (m) files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

const withTotals = (branch: string, head: string | null, on_staging: boolean, files: CodeFile[]): CodeState => ({
  branch,
  head,
  on_staging,
  files,
  totals: { added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) },
});

type Merge = { first: string; second: string; sha: string };

/** `sha` as a merge commit on staging with two parents, or null. */
function mergeAt(project: string, sha: string): Merge | null {
  if (git(project, ["merge-base", "--is-ancestor", sha, STAGING]).code !== 0) return null;
  const r = git(project, ["rev-list", "--parents", "-n", "1", sha]);
  const [h, first, second, third] = r.out.trim().split(" ");
  return r.code === 0 && h === sha && SHA_RE.test(first ?? "") && SHA_RE.test(second ?? "") && !third ? { sha, first, second } : null;
}

/** The merge commit of the ticket: a commit that a ticket.done note names (newest note first), else the newest merge on staging whose subject starts `Merge ticket/<id>:`. */
function mergeOf(project: string, ticketId: string, doneNotes: string[]): Merge | null {
  for (const note of doneNotes) {
    for (const tok of note.match(/\b[0-9a-f]{7,40}\b/g) ?? []) {
      const full = tok.length === 40 ? tok : sha(project, ["rev-parse", "--verify", "--quiet", `${tok}^{commit}`]);
      const m = full ? mergeAt(project, full) : null;
      if (m) return m;
    }
  }
  const r = git(project, ["log", STAGING, "--merges", "--format=%H%x00%P%x00%s"]);
  if (r.code !== 0) return null;
  for (const line of r.out.split("\n")) {
    const [h, parents, subject] = line.split("\0");
    if (!subject?.startsWith(`Merge ticket/${ticketId}:`)) continue;
    const [first, second] = (parents ?? "").split(" ");
    if (SHA_RE.test(h) && SHA_RE.test(first ?? "") && SHA_RE.test(second ?? "")) return { sha: h, first, second };
  }
  return null;
}

export function ticketCodeState(project: string | null | undefined, ticketId: string, doneNotes: string[] = []): CodeState {
  const branch = `ticket/${ticketId}`;
  if (!project) return withTotals(branch, null, false, []);
  const head = sha(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (head) {
    const onStaging = git(project, ["merge-base", "--is-ancestor", head, STAGING]).code === 0;
    const base = sha(project, ["merge-base", STAGING, head]);
    return withTotals(branch, head, onStaging, base ? numstat(project, base, head) : []);
  }
  const merge = mergeOf(project, ticketId, doneNotes);
  if (!merge) return withTotals(branch, null, false, []);
  return withTotals(branch, merge.second, true, numstat(project, merge.first, merge.sha));
}
