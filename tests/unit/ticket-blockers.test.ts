import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { validateBlockedBy } from "../../hub/kinds/ticket-blockers";

const id = (n: number) => `t_${n.toString(16).padStart(16, "0")}`;

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tickets (id TEXT PRIMARY KEY, room TEXT NOT NULL)`);
  db.exec(`CREATE TABLE ticket_blockers (ticket_id TEXT, blocker_id TEXT, PRIMARY KEY (ticket_id, blocker_id))`);
  for (let n = 1; n <= 30; n++) db.query("INSERT INTO tickets VALUES (?, 'r')").run(id(n));
  db.query("INSERT INTO tickets VALUES (?, 'other')").run(id(99));
  return db;
}

describe("validateBlockedBy", () => {
  test("omitted changes nothing, null and [] clear", () => {
    const db = fixture();
    expect(validateBlockedBy(db, "r", id(1), undefined)).toEqual({ ids: undefined });
    expect(validateBlockedBy(db, "r", id(1), null)).toEqual({ ids: [] });
    expect(validateBlockedBy(db, "r", id(1), [])).toEqual({ ids: [] });
  });

  test("valid list passes", () => {
    expect(validateBlockedBy(fixture(), "r", id(1), [id(2), id(3)])).toEqual({ ids: [id(2), id(3)] });
  });

  test("each bad input returns an error naming the bad id", () => {
    const db = fixture();
    const err = (v: unknown, t: string | null = id(1)) => (validateBlockedBy(db, "r", t, v) as { error: string }).error;
    expect(err([id(1)])).toContain(id(1));
    expect(err([id(50)])).toContain(id(50));
    expect(err([id(99)])).toContain(id(99));
    expect(err([id(2), id(2)])).toContain(id(2));
    expect(err([42])).toContain("42");
    expect(err("nope")).toBeDefined();
    expect(err(Array.from({ length: 21 }, (_, i) => id(i + 2)))).toContain("20");
  });

  test("3-ticket cycle is refused", () => {
    const db = fixture();
    // 2 -> 3 -> 1 exists; making 1 blocked by 2 closes the loop.
    db.query("INSERT INTO ticket_blockers VALUES (?, ?)").run(id(2), id(3));
    db.query("INSERT INTO ticket_blockers VALUES (?, ?)").run(id(3), id(1));
    const r = validateBlockedBy(db, "r", id(1), [id(2)]);
    expect(r.error).toContain(id(2));
    expect(validateBlockedBy(db, "r", id(4), [id(2)]).error).toBeUndefined();
  });

  test("create (null ticket id) skips the cycle walk", () => {
    expect(validateBlockedBy(fixture(), "r", null, [id(2)])).toEqual({ ids: [id(2)] });
  });
});
