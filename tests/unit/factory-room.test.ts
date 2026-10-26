// New factory room: required fields, the orchestrator role values, the status line, and the Launch gate.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", readFileSync("ui/terminal/spawn-form.js", "utf8"))(win);
new Function("window", readFileSync("ui/terminal/factory-room.js", "utf8"))(win);
const { buildFactoryRoom, terminalNameError, missingFields, orchestratorRole, formState, submitFactoryRoom } = win.__CUBILOT_TERM__.factoryRoom;
const { createRolesLoader } = win.__CUBILOT_TERM__.spawnForm;

const base = { room: "r1", cwd: "/p", workers: "2", testers: "1" };
const orch = { name: "orchestrator", harness: "claude", provider: null, model: "opus", thinking: null, effort: "medium" };
const role = { harness: "claude", model: "opus", provider: null, effort: "medium" };
const ready = { status: "ready", roles: [orch], error: "" };

describe("missingFields", () => {
  test("all valid: empty", () => expect(missingFields(base)).toEqual([]));
  test("each field missing alone gives its name", () => {
    expect(missingFields({ ...base, room: "" })).toEqual(["Room name"]);
    expect(missingFields({ ...base, cwd: " " })).toEqual(["Project folder"]);
    expect(missingFields({ ...base, workers: "" })).toEqual(["Worker limit"]);
    expect(missingFields({ ...base, testers: "" })).toEqual(["Tester limit"]);
  });
  test("all missing: the ordered list", () => {
    expect(missingFields({ room: "", cwd: "", workers: "", testers: "" })).toEqual(["Room name", "Project folder", "Worker limit", "Tester limit"]);
  });
  test("limit 0, 21, 1.5, empty, text are missing; 1 and 20 are fine", () => {
    for (const bad of ["0", "21", "1.5", "", "abc", "-1"]) {
      expect(missingFields({ ...base, workers: bad })).toEqual(["Worker limit"]);
      expect(missingFields({ ...base, testers: bad })).toEqual(["Tester limit"]);
    }
    for (const good of ["1", "20", " 7 "]) expect(missingFields({ ...base, workers: good, testers: good })).toEqual([]);
  });
  test("an invalid room name (bad char, too long) is missing", () => {
    for (const bad of ["a/b", "a;b", "x".repeat(65)]) expect(missingFields({ ...base, room: bad })).toEqual(["Room name"]);
  });
});

describe("orchestratorRole", () => {
  test("the role values: Claude, opus, medium", () => expect(orchestratorRole([orch])).toEqual({ role }));
  test("no role, no model, no effort, unknown harness: an error", () => {
    expect(orchestratorRole([]).error).toMatch(/no orchestrator role/);
    expect(orchestratorRole([{ ...orch, model: null }]).error).toMatch(/no model/);
    expect(orchestratorRole([{ ...orch, effort: null }]).error).toMatch(/no effort/);
    expect(orchestratorRole([{ ...orch, harness: "x" }]).error).toMatch(/unknown harness/);
  });
});

describe("formState: the Orchestrator line and the status line", () => {
  test("loading: Launch off, loading text, line not loaded, even with missing fields", () => {
    const st = formState({ status: "loading", roles: [], error: "" }, { room: "", cwd: "", workers: "", testers: "" });
    expect(st).toMatchObject({ disabled: true, line: "Loading the orchestrator role…", orchestrator: "Orchestrator: not loaded" });
  });
  test("failure beats Fill in: rejected, no role, no model, no effort", () => {
    const empty = { room: "", cwd: "", workers: "", testers: "" };
    expect(formState({ status: "failed", roles: [], error: "boom" }, empty))
      .toMatchObject({ disabled: true, line: "Could not load the orchestrator role: boom.", orchestrator: "Orchestrator: not loaded" });
    expect(formState({ status: "ready", roles: [], error: "" }, base).line).toBe("Could not load the orchestrator role: no orchestrator role is staged.");
    expect(formState({ status: "ready", roles: [{ ...orch, model: null }], error: "" }, base)).toMatchObject({ disabled: true, orchestrator: "Orchestrator: not loaded" });
    expect(formState({ status: "ready", roles: [{ ...orch, effort: "" }], error: "" }, base).disabled).toBe(true);
  });
  test("ready: Fill in text, else empty; the line shows the role values", () => {
    expect(formState(ready, { ...base, cwd: "", workers: "0" }))
      .toMatchObject({ disabled: true, line: "Fill in: Project folder, Worker limit.", orchestrator: "Orchestrator: opus, effort medium (from role)" });
    expect(formState(ready, base)).toMatchObject({ disabled: false, line: "", role });
  });
  test("idle (window closed): Launch off, empty line", () => {
    expect(formState({ status: "idle", roles: [], error: "" }, base)).toMatchObject({ disabled: true, line: "" });
  });
});

describe("buildFactoryRoom", () => {
  test("launch values come from the role: Claude, opus, medium", () => {
    const r = buildFactoryRoom({ ...base, role }, []);
    expect(r.launch).toEqual({ agent: "orchestrator", cwd: "/p", room: "r1", role: "orchestrator", harness: "claude", model: "opus", provider: null, effort: "medium" });
    expect(r.limits).toEqual({ workers: 2, testers: 1 });
  });
  test("no role: an error, no launch", () => {
    expect(buildFactoryRoom(base, []).launch).toBeUndefined();
    expect(buildFactoryRoom({ ...base, role: { ...role, effort: null } }, []).error).toMatch(/not loaded/);
  });
});

describe("submitFactoryRoom: stale state across openings", () => {
  const calls: string[] = [];
  const io = () => ({
    alert: (t: string) => calls.push(`alert:${t}`),
    putSettings: async () => { calls.push("put"); },
    close: () => calls.push("close"),
    seedNutshell: async () => { calls.push("seed"); },
    launch: async (l: any) => { calls.push(`launch:${l.model}:${l.effort}`); },
  });
  test("open OK: PUT, close, seed, launch with the role values in order", async () => {
    calls.length = 0;
    const loader = createRolesLoader(async () => [orch]);
    await loader.open();
    expect(await submitFactoryRoom(io(), loader.state(), base, [])).toBe(true);
    expect(calls).toEqual(["put", "close", "seed", "launch:opus:medium"]);
  });
  test("open OK, close, reopen with listRoles pending then rejected: Launch off, nothing called", async () => {
    calls.length = 0;
    let n = 0;
    let rejectSecond: (e: Error) => void = () => {};
    const loader = createRolesLoader(() => (n++ === 0 ? Promise.resolve([orch]) : new Promise((_, rej) => { rejectSecond = rej; })));
    await loader.open();
    expect(formState(loader.state(), base).disabled).toBe(false);
    loader.close();
    const pending = loader.open();
    expect(formState(loader.state(), base)).toMatchObject({ disabled: true, line: "Loading the orchestrator role…" });
    expect(await submitFactoryRoom(io(), loader.state(), base, [])).toBe(false);
    rejectSecond(new Error("boom"));
    await pending;
    expect(formState(loader.state(), base)).toMatchObject({ disabled: true, line: "Could not load the orchestrator role: boom." });
    expect(await submitFactoryRoom(io(), loader.state(), base, [])).toBe(false);
    expect(calls).toEqual([]);   // no settings PUT, no Nutshell write, no launch
  });
  test("a missing field: nothing is called", async () => {
    calls.length = 0;
    expect(await submitFactoryRoom(io(), ready, { ...base, room: "" }, [])).toBe(false);
    expect(calls).toEqual([]);
  });
  test("a failed settings PUT: alert, no close, no seed, no launch", async () => {
    calls.length = 0;
    const bad = { ...io(), putSettings: async () => { throw new Error("hub answered 500"); } };
    expect(await submitFactoryRoom(bad, ready, base, [])).toBe(false);
    expect(calls).toEqual(["alert:Could not store the room settings: hub answered 500"]);
  });
});

// tmux changes a '.' in a session name, so a terminal agent cannot have one (same text as pty.rs).
describe("terminal agent names: no dot", () => {
  test("terminalNameError", () => {
    expect(terminalNameError("t a.b")).toBe("a dot is not allowed in a terminal agent name: tmux changes it");
    for (const ok of ["t a-b", "orchestrator-Test room", "alice", "a_b"]) expect(terminalNameError(ok)).toBeNull();
  });
  test("a dotted room is fine while the generated agent name has no dot; refused when it would", () => {
    const ok = buildFactoryRoom({ ...base, room: "release.1", role }, []);
    expect(ok.error).toBeUndefined();
    expect(ok.launch).toMatchObject({ agent: "orchestrator", room: "release.1" });
    const bad = buildFactoryRoom({ ...base, room: "release.1", role }, ["orchestrator"]);
    expect(bad.launch).toBeUndefined();
    expect(bad.error).toMatch(/orchestrator-release\.1.*a dot is not allowed in a terminal agent name/);
    expect(buildFactoryRoom({ ...base, room: "my room", role }, ["orchestrator"]).launch.agent).toBe("orchestrator-my room");
  });
});
