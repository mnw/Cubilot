// Search feature — GET /search?q=: tickets, requests and agents by id prefix or name. Read-only.

import type { Database } from "bun:sqlite";
import type { HubFeature } from "../core/types";
import type { AgentRegistry } from "../core/agents";
import { validName } from "../core/ids";

export const SEARCH_LIMIT = 20;
export const SEARCH_MIN_CHARS = 2;
const SEARCH_Q_MAX_CHARS = 200;
const SEARCH_MAX_WORDS = 8;

export type SearchResult = {
  kind: "ticket" | "request" | "agent";
  id: string;
  title: string;
  room: string | null;
  status: string;
};

// exact: the query is the whole id or name. open: a ticket not done or cancelled, a request, an agent.
type Ranked = SearchResult & { exact: boolean; open: boolean; at: number };

export type SearchDeps = {
  db: Database | null;
  agents: AgentRegistry;
  humanName: string;
};

export function createSearchFeature(deps: SearchDeps): HubFeature {
  const { db, agents, humanName } = deps;

  function tickets(q: string, words: string[], room: string | null): Ranked[] {
    if (!db) return [];
    // "t_ab12" and "ab12" both match the id prefix. Ids are lower-case hex after "t_".
    const idPart = q.startsWith("t_") ? q.slice(2) : q;
    const clauses = ["substr(lower(id), 3, ?) = ?"];
    const params: (string | number)[] = [idPart.length, idPart];
    const wordSql = words.map(() => "instr(lower(title), ?) > 0").join(" AND ");
    clauses.push(`(${wordSql})`);
    params.push(...words);
    const roomSql = room === null ? "" : " AND room = ?";
    if (room !== null) params.push(room);
    params.push(SEARCH_LIMIT * 3);
    return db
      .query<Record<string, unknown>, (string | number)[]>(
        `SELECT id, title, room, status, created_at_ms FROM tickets
          WHERE archived_at_ms IS NULL AND (${clauses.join(" OR ")})${roomSql}
          ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .all(...params)
      .map((r) => {
        const id = r.id as string;
        const status = r.status as string;
        return {
          kind: "ticket" as const,
          id,
          title: r.title as string,
          room: r.room as string,
          status,
          exact: id.toLowerCase() === (q.startsWith("t_") ? q : `t_${q}`),
          open: status !== "done" && status !== "cancelled",
          at: Number(r.created_at_ms),
        };
      });
  }

  function requests(q: string, room: string | null): Ranked[] {
    if (!db) return [];
    const params: (string | number)[] = [q.length, q];
    if (room !== null) params.push(room);
    params.push(SEARCH_LIMIT * 3);
    return db
      .query<Record<string, unknown>, (string | number)[]>(
        `SELECT request_id, room, status, created_at_ms FROM requests
          WHERE substr(lower(request_id), 1, ?) = ?${room === null ? "" : " AND room = ?"}
          ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .all(...params)
      .map((r) => {
        const id = r.request_id as string;
        return {
          kind: "request" as const,
          id,
          title: id,
          room: r.room as string,
          status: r.status as string,
          exact: id.toLowerCase() === q,
          open: true,
          at: Number(r.created_at_ms),
        };
      });
  }

  function agentHits(q: string, room: string | null): Ranked[] {
    const online = (agents.presenceSnapshot() as { agents?: Record<string, boolean> }).agents ?? {};
    const out: Ranked[] = [];
    for (const a of agents.values()) {
      if (!a.name.toLowerCase().startsWith(q)) continue;
      // The human has no room: every room sees it.
      if (room !== null && a.room !== null && a.room !== room) continue;
      out.push({
        kind: "agent",
        id: a.name,
        title: a.name,
        room: a.room,
        status: online[a.name] === true ? "online" : "offline",
        exact: a.name.toLowerCase() === q,
        open: true,
        at: 0,
      });
    }
    return out;
  }

  return {
    routes: [
      {
        method: "GET",
        path: "/search",
        auth: "read",
        handler: (req) => {
          const url = new URL(req.url);
          // Hub tokens carry no identity: an agent names itself with ?agent=. No name is the human's UI.
          const who = (url.searchParams.get("agent") ?? "").trim();
          let room: string | null = null;
          if (who !== "" && who !== humanName) {
            const a = validName(who) ? agents.get(who) : null;
            if (!a) return Response.json({ error: `unknown agent: ${who}` }, { status: 400 });
            room = a.room;
            if (room === null) return Response.json({ error: "agent has no room" }, { status: 400 });
          }
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, SEARCH_Q_MAX_CHARS);
          if (q.length < SEARCH_MIN_CHARS) return Response.json([]);
          const words = q.split(/\s+/).filter(Boolean).slice(0, SEARCH_MAX_WORDS);
          const all = [...tickets(q, words, room), ...requests(q, room), ...agentHits(q, room)];
          all.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.open) - Number(a.open) || b.at - a.at);
          const results: SearchResult[] = all
            .slice(0, SEARCH_LIMIT)
            .map(({ kind, id, title, room: r, status }) => ({ kind, id, title, room: r, status }));
          return Response.json(results);
        },
      },
    ],
  };
}
