// Factory feature — the per-agent hot-reload records. Three records per agent in `<dir>/agents/`:
//   <hex>          a link to the version folder the agent's files come from (the app creates it at launch)
//   <hex>.pending  "<version>": a reload relink ordered and nobody has completed yet. No time limit.
//   <hex>.applied  the version the runtime has loaded with success (the app writes the launch version, then the
//                  bridge writes it after each good reload)
// POST /factory/relink moves the link to the desired version (CUBILOT_FACTORY_VERSION) and says whether the
// runtime must reload, and writes `pending` when it does. POST /factory/applied records a good reload and deletes
// `pending`. There is no rollback: a failed reload leaves `applied` behind, so the next relink asks again.

import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HubCapabilities, HubFeature, RouteDef } from "../core/types";
import { hasSkillsRecords, publish, readPendingRecord, removePending, SkillsLockBusy, takeLock, writeApplied, writePending } from "./factory-skills";

export type FactoryDeps = {
  // CUBILOT_FACTORY_DIR and CUBILOT_FACTORY_VERSION; either empty means the app staged no factory.
  dir: string;
  version: string;
  // Whether the agent has an open stream (the registry's presence). Absent: reported offline.
  online?: (name: string) => boolean;
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
  const readBody = async (req: Request) => (await req.json().catch(() => ({}))) as { agent?: unknown; version?: unknown; failed?: unknown; force?: unknown; by?: unknown; reload_id?: unknown; attempt?: unknown };

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
  const lastPath = (dir: string, key: string) => join(dir, "agents", `${key}.last`);
  // The result of the newest reload the bridge reported, beside .applied. A failed force reload of the same version leaves
  // `applied` equal to the link, so only this record tells it from a success.
  // Throws on a write error: the callers answer 500 and keep `.pending`, so the same report can be sent again.
  const writeLast = (dir: string, key: string, result: "applied" | "failed", version: string, reloadId: string | null): void => {
    atomically(lastPath(dir, key), (tmp) => writeFileSync(tmp, JSON.stringify({ result, version, at: Date.now(), reload_id: reloadId })));
  };
  const readLast = (dir: string, key: string): { result: string; version: string; at: number; reload_id: string | null } | null => {
    try {
      const j = JSON.parse(readFileSync(lastPath(dir, key), "utf8"));
      return j && (j.result === "applied" || j.result === "failed") ? { ...j, reload_id: j.reload_id ?? null } : null;
    } catch {
      return null;
    }
  };
  // True while a reload that relink ordered has no completion. Elapsed time never clears it: a native reload that
  // outlives its bound is not stopped. Only /factory/applied (success or failed) or a new session (the app deletes
  // the agent's records) clears it.
  const reloadRunning = (dir: string, key: string): boolean => readPending(dir, key) !== null;
  // .pending holds three lines: the version, the reload id of the human's request (empty when the bridge started the
  // reload) and the attempt id that relink made for this one reload. Only a report with that attempt id is accepted.
  const readPending = (dir: string, key: string): { version: string; reloadId: string | null; attempt: string | null } | null => {
    try {
      const [version, id, attempt] = readFileSync(pendingPath(dir, key), "utf8").split("\n");
      return version?.trim() ? { version: version.trim(), reloadId: id || null, attempt: attempt || null } : null;
    } catch {
      return null;
    }
  };
  // A request id is an opaque token from the hub's own reload route: refuse anything else before it reaches a file.
  const idOf = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{16}$/.test(v) ? v : null);

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
      // `force` orders a reload for the version the agent already has: the choice of skills changed, not the version.
      if (b.force !== true && cur.target === want && readApplied(deps.dir, key) === want) return Response.json({ ok: true, reload: false, version: want });
      // A reload is still running (no completion yet): order no second one, for any version.
      if (reloadRunning(deps.dir, key)) return Response.json({ ok: true, reload: false, pending: true, version: want });
      // An agent with skills records publishes its prepared build here, under the lock (factory-skills.ts). The lock wait
      // is async, so the running-reload check is made again after it.
      let release: (() => void) | null = null;
      if (hasSkillsRecords(deps.dir, key)) {
        try {
          release = await takeLock(deps.dir, key);
        } catch (e) {
          if (e instanceof SkillsLockBusy) return Response.json({ error: "skills lock busy" }, { status: 503 });
          return Response.json({ error: `skills lock failed: ${(e as Error).message}` }, { status: 500 });
        }
        if (reloadRunning(deps.dir, key)) {
          release();
          return Response.json({ ok: true, reload: false, pending: true, version: want });
        }
      }
      try {
        if (cur.target !== want) {
          try {
            atomically(cur.link, (tmp) => symlinkSync(join(deps.dir, want), tmp)); // temp link, then rename over
          } catch (e) {
            return Response.json({ error: `relink failed: ${(e as Error).message}` }, { status: 500 });
          }
        }
        const attempt = randomBytes(8).toString("hex");
        let pub: { undo: () => string | null };
        try {
          pub = publish(deps.dir, key, want);
        } catch (e) {
          return Response.json({ error: `skills publish failed: ${(e as Error).message}` }, { status: 500 });
        }
        try {
          writePending(deps.dir, key, attempt);
        } catch (e) {
          try {
            removePending(deps.dir, key);
          } catch {} // the undo below must run whatever this does
          const rb = pub.undo();
          return Response.json({ error: `skills pending write failed: ${(e as Error).message}${rb ? `; rollback: ${rb}` : ""}` }, { status: 500 });
        }
        try {
          atomically(pendingPath(deps.dir, key), (tmp) => writeFileSync(tmp, `${want}\n${idOf(b.reload_id) ?? ""}\n${attempt}\n`));
        } catch (e) {
          try {
            removePending(deps.dir, key);
          } catch {} // the undo below must run whatever this does
          const rb = pub.undo();
          return Response.json({ error: `pending write failed: ${(e as Error).message}${rb ? `; rollback: ${rb}` : ""}` }, { status: 500 });
        }
        return Response.json({ ok: true, reload: true, version: want, attempt });
      } finally {
        release?.();
      }
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
      // A report of a reload that is not the one in .pending (a late, duplicate or unordered one) changes nothing.
      const order = readPending(deps.dir, key);
      if (!order || order.attempt === null || b.attempt !== order.attempt) return Response.json({ error: "stale or unknown attempt" }, { status: 409 });
      // A failed reload: forget the order so the next relink orders the reload again. Nothing else is written.
      if (failed) {
        try {
          writeLast(deps.dir, key, "failed", order.version, order.reloadId);
        } catch (e) {
          return Response.json({ error: `last write failed: ${(e as Error).message}` }, { status: 500 });
        }
        rmSync(pendingPath(deps.dir, key), { force: true });
        removePending(deps.dir, key); // .skills-published and .skills-applied stay: a retry copies the same selection
        return Response.json({ ok: true, failed: true });
      }
      // Only the version the link names can be recorded as applied.
      if (version !== cur.target) return Response.json({ error: `link names ${cur.target}, not ${version}` }, { status: 409 });
      // The skills record of this attempt (an agent with none has no .skills-pending). Another attempt: 409.
      const sp = readPendingRecord(deps.dir, key);
      if (sp && sp.attempt !== b.attempt) return Response.json({ error: "stale or unknown skills attempt" }, { status: 409 });
      if (sp) {
        try {
          writeApplied(deps.dir, key, sp);
        } catch (e) {
          return Response.json({ error: `skills applied write failed: ${(e as Error).message}` }, { status: 500 });
        }
      }
      try {
        atomically(join(deps.dir, "agents", `${key}.applied`), (tmp) => writeFileSync(tmp, `${version}\n`));
      } catch (e) {
        return Response.json({ error: `write failed: ${(e as Error).message}` }, { status: 500 });
      }
      try {
        writeLast(deps.dir, key, "applied", version, order.reloadId);
      } catch (e) {
        return Response.json({ error: `last write failed: ${(e as Error).message}` }, { status: 500 });
      }
      rmSync(pendingPath(deps.dir, key), { force: true });
      removePending(deps.dir, key);
      return Response.json({ ok: true, version });
    },
  };

  // The human's Reload button: one agent, never the hub. The request is a control entry for that agent's bridge (no
  // UI, no chat log). The answer is the status the row shows again: presence, pause, room and the factory record.
  // An agent with no link only gets its status read. (pty_roles, model and effort, is read by the app, not the hub.)
  // The status the row shows: presence, pause, room and the factory record. Both reload routes answer it.
  const statusOf = (name: string, a: { room: string | null }, cap: HubCapabilities, key: string, linked: string | null, online: boolean) => ({
    agent: name,
    online,
    paused: cap.agents.isPaused(name),
    room: a.room,
    factory: {
      desired: deps.version || null,
      linked,
      applied: deps.dir ? readApplied(deps.dir, key) : null,
      pending: (deps.dir && readPending(deps.dir, key)?.version) || null,
      pending_reload_id: (deps.dir && readPending(deps.dir, key)?.reloadId) || null,
      last: deps.dir ? readLast(deps.dir, key) : null,
    },
  });

  const reload: RouteDef = {
    method: "POST",
    path: /^\/agents\/([^/]+)\/reload$/,
    auth: "mutating",
    handler: async (req, cap, params) => {
      const name = decodeURIComponent(params.id);
      const a = cap.agents.get(name);
      if (!a || a.permanent) return Response.json({ error: `unknown agent: ${name}` }, { status: 400 });
      const b = await readBody(req);
      if (b.by !== cap.config.humanName) return Response.json({ error: "only the human may reload an agent" }, { status: 403 });
      const key = agentKey(name);
      const linked = deps.dir ? applied(deps.dir, key).target : null;
      // An offline agent gets nothing: its queue is kept across a reconnect, and a request that surfaced later would be
      // a surprise. The human clicks again when the agent is back.
      const online = deps.online?.(name) ?? false;
      const requested = linked !== null && online;
      const reloadId = requested ? randomBytes(8).toString("hex") : null;
      if (requested) {
        cap.sse.emit(
          { type: "agent.reload", from: "system", to: name, text: "", ts: new Date().toISOString(), image: null, room: a.room, force: b.force === true, reload_id: reloadId },
          { kind: "agents-ambient", agents: [name] },
        );
      }
      return Response.json({ ...statusOf(name, a, cap, key, linked, online), requested, reload_id: reloadId });
    },
  };

  // Read only: the same status, nothing sent to the agent.
  const reloadStatus: RouteDef = {
    method: "GET",
    path: /^\/agents\/([^/]+)\/reload-status$/,
    auth: "read",
    handler: async (_req, cap, params) => {
      const name = decodeURIComponent(params.id);
      const a = cap.agents.get(name);
      if (!a || a.permanent) return Response.json({ error: `unknown agent: ${name}` }, { status: 400 });
      const key = agentKey(name);
      return Response.json(statusOf(name, a, cap, key, deps.dir ? applied(deps.dir, key).target : null, deps.online?.(name) ?? false));
    },
  };

  return { routes: [relink, record, reload, reloadStatus] };
}
