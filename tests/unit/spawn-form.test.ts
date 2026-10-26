// ui/terminal/spawn-form.js: which required fields are missing, the exact line texts, the roles loader.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/terminal/spawn-form.js", "utf8"))(win);
const sf = win.__CUBILOT_TERM__.spawnForm;

const ok = { agent: "worker-1", role: "worker", harness: "claude", cell: true, cwd: "/p", room: "proj" };
const names: Record<string, string> = { agent: "Agent name", role: "Role", cell: "Model and effort", cwd: "Project folder", room: "Room" };

describe("missingFields", () => {
  test("all valid: empty list", () => expect(sf.missingFields(ok)).toEqual([]));
  test("each field missing alone gives its name", () => {
    expect(sf.missingFields({ ...ok, agent: "" })).toEqual(["Agent name"]);
    expect(sf.missingFields({ ...ok, role: "" })).toEqual(["Role"]);
    expect(sf.missingFields({ ...ok, harness: "bogus" })).toEqual(["Harness"]);
    expect(sf.missingFields({ ...ok, harness: "" })).toEqual(["Harness", ]);
    expect(sf.missingFields({ ...ok, cell: false })).toEqual(["Model and effort"]);
    expect(sf.missingFields({ ...ok, cwd: "  " })).toEqual(["Project folder"]);
    expect(sf.missingFields({ ...ok, room: "" })).toEqual(["Room"]);
  });
  test("the cell is named for the harness: effort on Claude, thinking on Pi", () => {
    expect(sf.missingFields({ ...ok, cell: false, harness: "pi" })).toEqual(["Model and thinking"]);
  });
  test("all missing: the full list in form order", () => {
    expect(sf.missingFields({ agent: "", role: "", harness: "", cell: false, cwd: "", room: "" }))
      .toEqual(["Agent name", "Role", "Harness", "Model and effort", "Project folder", "Room"]);
  });
  test("agent name: dot, shell, reserved (any case), too long, bad char, inner spaces", () => {
    for (const bad of ["a.b", "shell", "you", "You", "ALL", "all", "System", "x".repeat(65), "a/b", "a;b", " "]) {
      expect(sf.missingFields({ ...ok, agent: bad })).toEqual(["Agent name"]);
    }
    for (const good of ["x".repeat(64), "a b", "a_b-c", "Shell1", "yousef"]) expect(sf.missingFields({ ...ok, agent: good })).toEqual([]);
  });
  test("room: a bad character is missing; a valid label is not", () => {
    expect(sf.missingFields({ ...ok, room: "a/b" })).toEqual(["Room"]);
    expect(sf.missingFields({ ...ok, room: "x".repeat(65) })).toEqual(["Room"]);
    expect(sf.missingFields({ ...ok, room: "my room.2" })).toEqual([]);
  });
});

describe("fillInText", () => {
  test("exact texts", () => {
    expect(sf.fillInText(["Role"])).toBe("Fill in: Role.");
    expect(sf.fillInText(["Role", "Project folder"])).toBe("Fill in: Role, Project folder.");
    expect(sf.fillInText(["Agent name", "Role", "Project folder"])).toBe("Fill in: Agent name, Role, Project folder.");
    expect(sf.fillInText([])).toBe("");
  });
});

describe("launchState", () => {
  const ready = { status: "ready", roles: [], error: "" };
  test("missing fields: Launch off with the line; none: on with an empty line", () => {
    expect(sf.launchState(ready, { ...ok, role: "", cwd: "" })).toEqual({ disabled: true, line: "Fill in: Role, Project folder.", missing: ["Role", "Project folder"] });
    expect(sf.launchState(ready, ok)).toEqual({ disabled: false, line: "", missing: [] });
  });
  test("loading and failed: Launch off with their texts, whatever the values", () => {
    expect(sf.launchState({ status: "loading", roles: [], error: "" }, ok)).toMatchObject({ disabled: true, line: "Loading roles…" });
    expect(sf.launchState({ status: "failed", roles: [], error: "boom" }, ok))
      .toMatchObject({ disabled: true, line: "Could not load the roles: boom. Close and open the form again." });
    expect(sf.launchState({ status: "idle", roles: [], error: "" }, ok).disabled).toBe(true);
  });
  test("tryLaunch calls launch only when allowed", () => {
    let n = 0;
    expect(sf.tryLaunch({ status: "loading", roles: [], error: "" }, ok, () => n++)).toBe(false);
    expect(sf.tryLaunch(ready, { ...ok, cell: false }, () => n++)).toBe(false);
    expect(n).toBe(0);
    expect(sf.tryLaunch(ready, ok, () => n++)).toBe(true);
    expect(n).toBe(1);
  });
});

describe("createRolesLoader", () => {
  test("ready, then close and reopen: the earlier roles are gone while loading, a late answer of the old opening is dropped", async () => {
    const answers: Array<(v: any) => void> = [];
    const loader = sf.createRolesLoader(() => new Promise((r) => answers.push(r)));
    const first = loader.open();
    expect(loader.state().status).toBe("loading");
    answers[0]([{ name: "worker" }]);
    await first;
    expect(loader.state()).toMatchObject({ status: "ready", roles: [{ name: "worker" }] });
    loader.close();
    const second = loader.open();
    expect(loader.state()).toEqual({ status: "loading", roles: [], error: "" });
    const third = loader.open();   // reopened again before the second answered
    answers[2]([{ name: "tester" }]);
    await third;
    answers[1]([{ name: "stale" }]);
    await second;
    expect(loader.state().roles).toEqual([{ name: "tester" }]);
  });
  test("a rejection (also a synchronous throw) is failed with the message", async () => {
    const a = sf.createRolesLoader(async () => { throw new Error("nope"); });
    await a.open();
    expect(a.state()).toEqual({ status: "failed", roles: [], error: "nope" });
    const b = sf.createRolesLoader(() => { throw "plain"; });
    await b.open();
    expect(b.state().error).toBe("plain");
  });
});
