// Sessions feature (hub-first-browser 8.1): the human creates, lists and kills the agent sessions and the Shell tab
// session through the hub. They replace pty_spawn, pty_spawn_shell, pty_list, pty_shell_exists and pty_kill of the
// shell. All five routes are human-only. The command line comes from launch-role.ts (prepareLaunch); the session
// starts in session-create.ts. The old claude_sessions routes (resume_flag capture) had no caller and are removed.

import { readConfig } from "../core/config-file";
import { validName, validRoomLabel } from "../core/ids";
import { prepareLaunch, type LaunchDeps } from "../core/launch-role";
import { ensureShellSession, SHELL_SESSION, startAgentSession } from "../core/session-create";
import { paneTarget, type Tmux } from "../core/tmux";
import type { HubFeature } from "../core/types";
import { defaultRoomForCwd } from "./settings";

export type SessionsDeps = {
  /** null when CUBILOT_TMUX or CUBILOT_DATA_DIR is not set: every route answers 503. */
  tmux: Tmux | null;
  env?: Record<string, string | undefined>;
  launchDeps?: LaunchDeps;
};

const KILL_RE = /^\/sessions\/([^/]+)\/kill$/;
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** The session name of an agent: a valid agent name, not the Shell tab's name, no dot (tmux changes it). */
const agentNameError = (name: string): string | null =>
  !validName(name) || name === SHELL_SESSION ? `invalid agent name: ${name}` : name.includes(".") ? "a dot is not allowed in a terminal agent name: tmux changes it" : null;

export function createSessionsFeature({ tmux, env = process.env, launchDeps }: SessionsDeps): HubFeature {
  /** Names with a create in progress: a second create of the same name must not reach tmux. */
  const creating = new Set<string>();
  const noTmux = () => bad("terminal is not configured", 503);
  const fail = (e: unknown) => bad(e instanceof Error ? e.message : String(e), 500);

  return {
    routes: [
      {
        method: "POST",
        path: "/sessions",
        auth: "mutating",
        caller: "human",
        handler: async (req) => {
          if (!tmux) return noTmux();
          const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!b || typeof b !== "object" || Array.isArray(b)) return bad("the body must be a JSON object");
          const name = str(b.name) ?? str(b.agent) ?? "";
          const nameError = agentNameError(name);
          if (nameError) return bad(nameError);
          const harness = str(b.harness) ?? "claude";
          if (harness !== "claude" && harness !== "pi") return bad(`invalid harness: ${harness}`);
          const resume = str(b.resume);
          if (resume !== undefined && resume !== "resume" && resume !== "continue") return bad(`invalid resume: ${resume}`);
          const cwd = str(b.cwd);
          if (!cwd) return bad("cwd is required");
          const room = str(b.room);
          if (room !== undefined && !validRoomLabel(room)) return bad(`invalid room: ${room}`);
          const role = str(b.role) ?? null;
          if (creating.has(name)) return bad(`session ${name} is being created`, 409);
          creating.add(name);
          try {
            let exists: boolean;
            try { exists = await tmux.hasSession(name); } catch (e) { return fail(e); }
            if (exists) {
              // An existing session keeps the role it was launched with.
              const have = (await tmux.run(["show-options", "-v", "-t", paneTarget(name), "@cubilot_role"]).catch(() => "")).trim();
              if (role && have !== role) return bad(`session ${name} already runs with ${have ? `role ${have}` : "no role"}: close it first`, 409);
              return Response.json({ ok: true, name, created: false });
            }
            if (!role) return bad("a role is required");
            let plan;
            try {
              plan = await prepareLaunch(
                { agent: name, room: room ?? defaultRoomForCwd(cwd), role, cwd, harness, model: str(b.model), provider: str(b.provider), effort: str(b.effort), sessionMode: resume ?? null, apiKey: str(readConfig("sessions").anthropic_api_key) ?? null },
                env,
                launchDeps,
              );
            } catch (e) {
              return bad(e instanceof Error ? e.message : String(e));
            }
            try { await startAgentSession(tmux, plan); } catch (e) { return fail(e); }
            return Response.json({ ok: true, name, created: true });
          } finally {
            creating.delete(name);
          }
        },
      },
      {
        method: "GET",
        path: "/sessions",
        auth: "read",
        caller: "human",
        handler: async () => {
          if (!tmux) return noTmux();
          try {
            // Agent sessions only: the Shell tab session has its own check.
            return Response.json({ sessions: (await tmux.listSessions()).filter((n) => validName(n) && n !== SHELL_SESSION) });
          } catch (e) { return fail(e); }
        },
      },
      {
        method: "POST",
        path: "/sessions/shell",
        auth: "mutating",
        caller: "human",
        handler: async () => {
          if (!tmux) return noTmux();
          try { return Response.json({ ok: true, created: await ensureShellSession(tmux, env) }); } catch (e) { return fail(e); }
        },
      },
      {
        method: "GET",
        path: "/sessions/shell",
        auth: "read",
        caller: "human",
        handler: async () => {
          if (!tmux) return noTmux();
          try { return Response.json({ exists: await tmux.hasSession(SHELL_SESSION) }); } catch (e) { return fail(e); }
        },
      },
      {
        method: "POST",
        path: KILL_RE,
        auth: "mutating",
        caller: "human",
        handler: async (_req, _cap, params) => {
          if (!tmux) return noTmux();
          let name: string;
          try { name = decodeURIComponent(params.id); } catch { return bad("invalid agent name"); }
          if (!validName(name)) return bad(`invalid agent name: ${name}`);
          try {
            if (!(await tmux.killSession(name))) return bad(`no session: ${name}`, 404);
            return Response.json({ ok: true });
          } catch (e) { return fail(e); }
        },
      },
    ],
  };
}
