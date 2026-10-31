// The rows of the model x effort grid in the launch form (ported from src-tauri/src/models.rs).
// Claude: the four fixed models. Pi: ALL models of `pi --list-models`, each with whether its provider is signed in
// (`pi auth check`), so the form can mark a provider that is not ready instead of hiding its models.

export type ModelRow = {
  provider: string; // "" for Claude
  model: string;
  thinking: boolean; // Pi's own "thinking" column; Claude: true
  ready: boolean; // provider signed in; Claude: true
};

export const LIST_LIMIT_MS = 10_000;
export const AUTH_CHECK_LIMIT_MS = 20_000;
const READY_TTL_MS = 300_000;

export const validProvider = (p: string) => p !== "" && p.length <= 40 && /^[a-z0-9._-]+$/.test(p);
export const validModel = (m: string) => m !== "" && m.length <= 80 && /^[A-Za-z0-9._:/-]+$/.test(m);

export function claudeModels(): ModelRow[] {
  return ["haiku", "sonnet", "opus", "fable"].map((model) => ({ provider: "", model, thinking: true, ready: true }));
}

// stdout of `pi --list-models`: a header line, then `provider model context max-out thinking images` in columns.
// Only stdout is parsed: pi prints "Could not refresh <provider>; showing cached models" on stderr.
export function parsePiModels(stdout: string): { provider: string; model: string; thinking: boolean }[] {
  const out: { provider: string; model: string; thinking: boolean }[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || (f[0] === "provider" && f[1] === "model")) continue;
    if (!validProvider(f[0]) || !validModel(f[1])) continue; // a row the launch would refuse anyway
    out.push({ provider: f[0], model: f[1], thinking: f[4] === "yes" });
  }
  return out;
}

// The PATH of the user's login shell. A hub started from the Dock inherits the launchd PATH, so a Pi shim that runs
// `node` fails with "node: not found". Resolved once; any failure keeps the inherited PATH (undefined).
const MARKER = "__CUBILOT_PATH__";
let loginPathCache: Promise<string | undefined> | null = null;

export function parseMarker(stdout: string): string | undefined {
  const i = stdout.lastIndexOf(MARKER);
  if (i < 0) return undefined;
  return stdout.slice(i + MARKER.length).split("\n")[0].trim() || undefined;
}

// CUBILOT_LOGIN_PATH skips the shell: tests set it, and a launcher that already knows the PATH may too.
export function loginPath(): Promise<string | undefined> {
  if (process.env.CUBILOT_LOGIN_PATH) return Promise.resolve(process.env.CUBILOT_LOGIN_PATH);
  loginPathCache ??= (async () => {
    const sh = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/zsh";
    try {
      const p = Bun.spawn([sh, "-l", "-i", "-c", `printf "${MARKER}%s\\n" "$PATH"`], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 5_000);
      const text = await new Response(p.stdout).text();
      clearTimeout(timer);
      return parseMarker(text);
    } catch {
      return undefined;
    }
  })();
  return loginPathCache;
}

// Runs `pi <args>`: its stdout and exit code, or null when it did not end within `limitMs` (the process is killed).
// A shim may leave a child that holds the pipe open, so the wait ends at the limit, not at end of file.
async function runPi(pi: string, args: string[], limitMs: number, path?: string): Promise<{ stdout: string; code: number } | null> {
  const env = path ? { ...process.env, PATH: path } : process.env;
  const p = Bun.spawn([pi, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const done = (async () => ({ stdout: await new Response(p.stdout).text(), code: await p.exited }))();
  done.catch(() => {}); // a read that fails after the limit is not an error of the caller
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(null);
    }, limitMs);
  });
  try {
    return await Promise.race([done, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export class PiListError extends Error {}

// Provider -> signed in, one `pi auth check` for each provider, all at once. Never --credentials.
async function piReady(pi: string, providers: string[], path?: string): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    providers.map(async (p) => {
      try {
        const r = await runPi(pi, ["auth", "check", "--provider", p, "--json"], AUTH_CHECK_LIMIT_MS, path);
        return [p, r !== null && r.code === 0] as const;
      } catch {
        return [p, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

// Cached for 5 minutes: the form opens often and `pi auth check` may refresh a token over the network.
let readyCache: { at: number; map: Record<string, boolean> } | null = null;
export const resetReadyCache = () => {
  readyCache = null;
};

// Throws PiListError when `pi --list-models` cannot start or does not end in `limitMs`.
export async function piModels(pi: string, opts: { path?: string; limitMs?: number } = {}): Promise<ModelRow[]> {
  let listed: Awaited<ReturnType<typeof runPi>>;
  try {
    listed = await runPi(pi, ["--list-models"], opts.limitMs ?? LIST_LIMIT_MS, opts.path);
  } catch (e) {
    throw new PiListError(`could not run \`pi --list-models\`: ${(e as Error).message}`);
  }
  if (listed === null) throw new PiListError(`\`pi --list-models\` took more than ${(opts.limitMs ?? LIST_LIMIT_MS) / 1000} seconds`);
  const parsed = parsePiModels(listed.stdout);
  const providers = [...new Set(parsed.map((r) => r.provider))].sort();
  let map = readyCache && Date.now() - readyCache.at < READY_TTL_MS ? readyCache.map : null;
  if (!map || !providers.every((p) => p in map!)) {
    map = await piReady(pi, providers, opts.path);
    readyCache = { at: Date.now(), map };
  }
  return parsed.map((r) => ({ ...r, ready: map![r.provider] ?? false }));
}
