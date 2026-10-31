// Creating a tmux session for an agent or the human's shell (hub-first-browser 8.1). Ported from pty.rs pty_spawn
// (the pill options after new-session) and pty_spawn_shell. The hub launch executor and the /sessions routes both
// start an agent session here, so a stage session and a session from the launch form carry the same records.

import type { LaunchPlan } from "./launch-role";
import { paneTarget, sessionTarget, type Tmux } from "./tmux";

export const SHELL_SESSION = "shell";
const DEFAULT_RECORD = "default";

/** The tmux options the roster pill reads (pty.rs role_options, plain_options, @cubilot_harness, @cubilot_skills). */
export function pillOptions(plan: LaunchPlan): Array<[string, string]> {
  const isPi = plan.harness === "pi";
  const spec = plan.spec;
  const c = plan.choice;
  const opts: Array<[string, string]> = [["@cubilot_harness", plan.harness]];
  if (spec) {
    // On the role's own harness the role default applies unless the choice changes it; on the other only the choice counts.
    const own = (spec.harness === "pi") === isPi;
    const model = c.model ?? (own ? spec.model : undefined) ?? DEFAULT_RECORD;
    const provider = isPi ? (c.provider ?? (own ? spec.provider : undefined) ?? "") : "";
    const effort = c.effort ?? (own ? (isPi ? spec.thinking : spec.effort) : undefined) ?? DEFAULT_RECORD;
    opts.push(["@cubilot_skills", plan.command.includes(".view/") ? "view" : "plain"]);
    opts.push(["@cubilot_role", spec.name], ["@cubilot_model", model], ["@cubilot_provider", provider], ["@cubilot_effort", effort]);
  } else {
    opts.push(["@cubilot_model", c.model ?? DEFAULT_RECORD], ["@cubilot_provider", isPi ? (c.provider ?? "") : ""], ["@cubilot_effort", c.effort ?? DEFAULT_RECORD]);
  }
  return opts;
}

/** new-session, then the pill records. A record that fails is logged: a missing pill must not fail a session that runs. */
export async function startAgentSession(tmux: Tmux, plan: LaunchPlan): Promise<void> {
  await tmux.newSession({ name: plan.name, cwd: plan.cwd, command: plan.command, env: plan.env });
  for (const [k, v] of pillOptions(plan)) {
    try {
      await tmux.run(["set-option", "-t", paneTarget(plan.name), k, v]);
    } catch (e) {
      console.error(`[session] ${plan.name} ${k} (pill only): ${(e as Error).message}`);
    }
  }
}

/** The human's scratch shell: no claude, no chatbridge, no room. true: it was created. false: it ran already. */
export async function ensureShellSession(tmux: Tmux, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const soft = async (args: string[]) => {
    try {
      await tmux.run(args);
    } catch (e) {
      console.error(`[session] shell ${args[0]} (best effort): ${(e as Error).message}`);
    }
  };
  if (await tmux.reconfigure(SHELL_SESSION)) {
    // allow-passthrough lets yazi's DA1/DSR probes reach xterm.js.
    await soft(["set-option", "-t", paneTarget(SHELL_SESSION), "allow-passthrough", "on"]);
    await soft(["set-environment", "-t", sessionTarget(SHELL_SESSION), "CUBILOT_SHELL", "1"]);
    return false;
  }
  const userShell = env.SHELL?.trim() || "/bin/zsh";
  const home = env.HOME?.trim() || "/tmp";
  // -il for parity with Terminal.app; explicit -i so plugin `[[ -o interactive ]]` guards fire.
  await tmux.newSession({ name: SHELL_SESSION, cwd: home, command: `'${userShell.replace(/'/g, `'\\''`)}' -il`, env: ["CUBILOT_SHELL=1"] });
  await soft(["set-option", "-t", paneTarget(SHELL_SESSION), "allow-passthrough", "on"]);
  return true;
}
