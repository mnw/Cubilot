import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHub, type HubHandle } from "../helpers/hub";
import { authedFetch, getJson } from "../helpers/fetch";
import { projectRepo } from "../helpers/repo";

let hub: HubHandle;
beforeAll(async () => { hub = await spawnHub(); });
afterAll(async () => { await hub.kill(); });

const put = (body: unknown) => authedFetch(hub, "/rooms/pf/settings", { method: "PUT", body: JSON.stringify(body) });
const folder = async () => ((await getJson(hub, "/rooms/pf/settings")).json as { settings: { project_folder: string | null } }).settings.project_folder;

describe("room project folder (4.5)", () => {
  test("a room starts with none; an absolute path to a git work tree is stored and can be cleared", async () => {
    expect(await folder()).toBeNull();
    expect((await put({ project_folder: projectRepo() })).status).toBe(200);
    expect(await folder()).toBe(projectRepo());
    expect((await put({ persist_transcript: false })).status).toBe(200);
    expect(await folder()).toBe(projectRepo()); // an absent key keeps it
    expect((await put({ project_folder: null })).status).toBe(200);
    expect(await folder()).toBeNull();
  });

  test.each([
    ["a relative path", "some/dir"],
    ["a missing folder", "/nonexistent/xyz"],
    ["a number", 5],
  ])("%s gets 400 and stores nothing", async (_n, v) => {
    expect((await put({ project_folder: v })).status).toBe(400);
    expect(await folder()).toBeNull();
  });

  test("a folder that is not a git work tree gets 400", async () => {
    const res = await put({ project_folder: mkdtempSync(join(tmpdir(), "nogit-")) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a git work tree");
  });
});
