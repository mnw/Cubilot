// Factory feature — the per-agent hot-reload records. Three records per agent in `<dir>/agents/`:
//   <hex>          a link to the version folder the agent's files come from (the app creates it at launch)
//   <hex>.pending  "<version>": a reload relink ordered and nobody has completed yet. No time limit.
//   <hex>.applied  the version the runtime has loaded with success (the app writes the launch version, then the
//                  bridge writes it after each good reload)
// POST /factory/relink moves the link to the desired version (CUBILOT_FACTORY_VERSION) and says whether the
// runtime must reload, and writes `pending` when it does. POST /factory/applied records a good reload and deletes
// `pending`. There is no rollback: a failed reload leaves `applied` behind, so the next relink asks again.

import { lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HubFeature, RouteDef } from "../core/types";

export type FactoryDeps = {
  // CUBILOT_FACTORY_DIR and CUBILOT_FACTORY_VERSION; either empty means the app staged no factory.
  dir: string;
  version: string;
};

// Same key rule as pty_event: lowercase hex of the UTF-8 bytes.
export const agentKey = (name: string): string => Buffer.from(name, "utf8").toString("hex");

// A published version folder: v-<hash>. Nothing else (no "..", no "active", no path) is a version.
const VERSION_RE = /^v-[0-9a-f]{16}$/;

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory(); // lstat: a symlink alias is not a published version
  } catch {
    return false;
  }
};

export function createFactoryFeature(deps: FactoryDeps): HubFeature {
  const readBody = async (req: Request) => (await req.json().catch(() => ({}))) as { agent?: unknown; version?: unknown; failed?: unknown };

  // The agent's link target (a version name), or null when there is no link.
  function applied(dir: string, key: string): { link: string; target: string | null } {
    const link = join(dir, "agents", key);
    try {
      return { link, target: lstatSync(link).isSymbolicLink() ? basename(readlinkSync(link)) : null };
    } catch {
      return { link, target: null };
    }
  }

  const atomically = (path: string, write: (tmp: string) => void): void => {
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      rmSync(tmp, { force: true });
      write(tmp);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  };

  const readApplied = (dir: string, key: string): string | null => {
    try {
      return readFileSync(join(dir, "agents", `${key}.applied`), "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  const pendingPath = (dir: string, key: string) => join(dir, "agents", `${key}.pending`);
  // True while a reload that relink ordered has no completion. Elapsed time never clears it: a native reload that
  // outlives its bound is not stopped. Only /factory/applied (success or failed) or a new session (the app deletes
  // the agent's records) clears it.
  const reloadRunning = (dir: string, key: string): boolean => {
    try {
      return readFileSync(pendingPath(dir, key), "utf8").trim() !== "";
    } catch {
      return false;
    }
  };

  const relink: RouteDef = {
    method: "POST",
    path: "/factory/relink",
    auth: "mutating",
    handler: async (req) => {
      const b = await readBody(req);
      const agent = typeof b.agent === "string" ? b.agent.trim() : "";
      if (!agent) return Response.json({ error: "missing agent" }, { status: 400 });
      const key = agentKey(agent);
      const cur = deps.dir ? applied(deps.dir, key) : { link: "", target: null };
      // No link: no role, a launch before per-agent links, or a no-role relaunch. It cannot reload.
      if (cur.target === null) return Response.json({ error: `no factory link for ${agent}` }, { status: 404 });
      const want = deps.version;
      if (!VERSION_RE.test(want) || !isDir(join(deps.dir, want))) {
        return Response.json({ error: "no desired factory version" }, { status: 409 });
      }
      if (cur.target === want && readApplied(deps.dir, key) === want) return Response.json({ ok: true, reload: false, version: want });
      // A reload is still running (no completion yet): order no second one, for any version.
      if (reloadRunning(deps.dir, key)) return Response.json({ ok: true, reload: false, pending: true, version: want });
      if (cur.target !== want) {
        try {
          atomically(cur.link, (tmp) => symlinkSync(join(deps.dir, want), tmp)); // temp link, then rename over
        } catch (e) {
          return Response.json({ error: `relink failed: ${(e as Error).message}` }, { status: 500 });
        }
      }
      try {
        atomically(pendingPath(deps.dir, key), (tmp) => writeFileSync(tmp, `${want}\n`));
      } catch (e) {
        return Response.json({ error: `pending write failed: ${(e as Error).message}` }, { status: 500 });
      }
      return Response.json({ ok: true, reload: true, version: want });
    },
  };

  const record: RouteDef = {
    method: "POST",
    path: "/factory/applied",
    auth: "mutating",
    handler: async (req) => {
      const b = await readBody(req);
      const agent = typeof b.agent === "string" ? b.agent.trim() : "";
      const version = typeof b.version === "string" ? b.version : "";
      const failed = b.failed === true;
      if (!agent || (!version && !failed)) return Response.json({ error: "missing agent or version" }, { status: 400 });
      const key = agentKey(agent);
      const cur = deps.dir ? applied(deps.dir, key) : { link: "", target: null };
      if (cur.target === null) return Response.json({ error: `no factory link for ${agent}` }, { status: 404 });
      // A failed reload: forget the order so the next relink orders the reload again. Nothing else is written.
      if (failed) {
        rmSync(pendingPath(deps.dir, key), { force: true });
        return Response.json({ ok: true, failed: true });
      }
      // Only the version the link names can be recorded as applied.
      if (version !== cur.target) return Response.json({ error: `link names ${cur.target}, not ${version}` }, { status: 409 });
      try {
        atomically(join(deps.dir, "agents", `${key}.applied`), (tmp) => writeFileSync(tmp, `${version}\n`));
      } catch (e) {
        return Response.json({ error: `write failed: ${(e as Error).message}` }, { status: 500 });
      }
      rmSync(pendingPath(deps.dir, key), { force: true });
      return Response.json({ ok: true, version });
    },
  };

  return { routes: [relink, record] };
}
