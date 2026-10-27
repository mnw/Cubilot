// stage-sessions 2.5: the route list is derived, not written by hand. It is every `auth: "mutating"` route of the feature
// and kind modules that hub/hub.ts mounts (buildKinds plus the feature factories), read from their `routes` arrays.
// Each route gets the actor `system` in each of the dispatcher's actor fields (hub/core/dispatcher.ts ACTOR_FIELDS) on a real
// hub: 400 and no write. The hand list in tests/integration/system-actor.test.ts stays as a second check.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch } from "../helpers/fetch";
import { buildKinds } from "../../hub/kinds/index";
import { createUsageFeature } from "../../hub/features/usage";
import { createFactoryFeature } from "../../hub/features/factory";
import { createSessionsFeature } from "../../hub/features/sessions";
import { createAttachmentsFeature } from "../../hub/features/attachments";
import { createRosterFeature } from "../../hub/features/roster";
import { createTranscriptFeature } from "../../hub/features/transcript";
import { createChatFeature } from "../../hub/features/chat";
import type { HubFeature } from "../../hub/core/types";

const FIELDS = ["by", "from", "actor", "voter", "requester", "agent", "creator"] as const;

/** The features of hub/hub.ts FEATURES. Route tables are built from the factory arguments; handlers never run here. */
function features(): HubFeature[] {
  const db = new Database(":memory:");
  const unused: any = {};
  return [
    ...buildKinds(db),
    createUsageFeature(),
    createFactoryFeature({ dir: "", version: "", online: () => false }),
    createSessionsFeature(db),
    createAttachmentsFeature(unused),
    createRosterFeature(unused),
    createTranscriptFeature(unused),
    createChatFeature(unused),
  ];
}

/** A concrete path for a route: a string path as is, a RegExp with each capture group filled. */
function concrete(path: string | RegExp): string {
  if (typeof path === "string") return path;
  return path.source
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\(\\d\+\)/g, "1")
    .replace(/\(\[\^\/\]\+\)/g, "x1")
    .replace(/\\\//g, "/");
}

const ROUTES = features()
  .flatMap((f) => f.routes)
  .filter((r) => r.auth === "mutating")
  .map((r) => ({ method: r.method, path: concrete(r.path) }));

describe("every mutating route refuses the actor system", () => {
  let hub: HubHandle;
  beforeAll(async () => { hub = await spawnHub(); });
  afterAll(async () => { await hub.kill(); });

  const counts = () => {
    const db = new Database(hub.ledgerPath, { readonly: true });
    try {
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return Object.fromEntries(tables.map((t) => [t.name, (db.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n]));
    } finally {
      db.close();
    }
  };

  test("the derived list is not empty and holds every verb family", () => {
    expect(ROUTES.length).toBeGreaterThan(25);
    for (const p of ["/handoffs", "/interrupts", "/permissions", "/tickets", "/launches/x1/ack", "/stages/x1/turn-end", "/rooms/x1/settings", "/send"]) {
      expect(ROUTES.map((r) => r.path)).toContain(p);
    }
  });

  test.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s: 400 and no write for each actor field", async (_n, r) => {
    const before = counts();
    for (const field of FIELDS) {
      const res = await authedFetch(hub, r.path, { method: r.method, body: JSON.stringify({ [field]: "system" }) });
      expect(res.status, `${field}: ${await res.text()}`).toBe(400);
    }
    expect(counts()).toEqual(before);
  });
});
