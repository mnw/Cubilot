// Models (Part 12 group 3): the models.rs cases ported to hub/core/models.ts, plus GET /models on a real hub with a fake pi.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeModels, parseMarker, parsePiModels, piModels, PiListError, resetReadyCache } from "../../hub/core/models";
import { spawnHub, type HubHandle } from "../helpers/hub";

const SAMPLE =
  "provider          model                       context  max-out  thinking  images\n" +
  "anthropic         claude-fable-5              1M       128K     yes       yes   \n" +
  "openai            gpt-4                       8.2K     8.2K     no        no    \n" +
  "openai-codex      gpt-5.6-sol                 272K     128K     yes       yes   \n" +
  "\n" +
  "broken line\n" +
  "bad/provider      gpt-x                       1K       1K       yes       yes   \n";

const fx = mkdtempSync(join(tmpdir(), "cubilot-models-"));
const put = (p: string, body: string) => {
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};
// `--list-models` prints rows on stdout and a warning on stderr; `auth check` is ready for openai-codex only.
const fakePi = (name: string) => {
  const pi = join(fx, name);
  put(
    pi,
    `if [ "$1" = "--list-models" ]; then echo 'Could not refresh anthropic; showing cached models' >&2; printf '%s' '${SAMPLE.replace(/'/g, "")}'; exit 0; fi
if [ "$1" = "auth" ] && [ "$4" = "openai-codex" ]; then echo '{"status":"ready"}'; exit 0; fi
echo '{"status":"not_ready"}'; exit 1`,
  );
  return pi;
};

afterAll(() => rmSync(fx, { recursive: true, force: true }));

describe("models core", () => {
  test("claude has the four models, all ready", () => {
    const r = claudeModels();
    expect(r.map((m) => m.model)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(r.every((m) => m.ready && m.provider === "")).toBe(true);
  });

  test("pi models are parsed from stdout and bad rows are dropped", () => {
    expect(parsePiModels(SAMPLE)).toEqual([
      { provider: "anthropic", model: "claude-fable-5", thinking: true },
      { provider: "openai", model: "gpt-4", thinking: false },
      { provider: "openai-codex", model: "gpt-5.6-sol", thinking: true },
    ]);
    expect(parsePiModels("Could not refresh anthropic; showing cached models\n")).toEqual([]);
    expect(parsePiModels("")).toEqual([]);
  });

  test("a fake pi gives rows with ready marks and stderr is ignored", async () => {
    resetReadyCache();
    const rows = await piModels(fakePi("pi-a"));
    expect(rows).toHaveLength(3);
    const by = (m: string) => rows.find((r) => r.model === m)!;
    expect(by("gpt-5.6-sol")).toMatchObject({ ready: true, thinking: true });
    expect(by("gpt-4")).toMatchObject({ ready: false, thinking: false }); // kept and marked, not hidden
    expect(by("claude-fable-5").ready).toBe(false);
  });

  test("readiness checks run in parallel", async () => {
    resetReadyCache();
    const pi = join(fx, "pi-slow");
    put(
      pi,
      `if [ "$1" = "--list-models" ]; then printf 'a m1 1K 1K yes yes\\nb m2 1K 1K yes yes\\nc m3 1K 1K yes yes\\nd m4 1K 1K yes yes\\n'; exit 0; fi
sleep 0.4; exit 0`,
    );
    const t0 = Date.now();
    const rows = await piModels(pi);
    expect(rows.every((r) => r.ready)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  test("a pi shim that needs a tool lists models only with the resolved path", async () => {
    const tools = join(fx, "tools");
    mkdirSync(tools, { recursive: true });
    put(join(tools, "cubilot-fake-node"), `if [ "$1" = "--list-models" ]; then echo 'zzprov  zz-model  1K  1K  yes  yes'; exit 0; fi\necho '{"status":"ready"}'`);
    const shim = join(fx, "pi-shim");
    put(shim, 'exec cubilot-fake-node "$@"');
    const minimal = "/usr/bin:/bin";
    resetReadyCache();
    expect(await piModels(shim, { path: minimal })).toEqual([]);
    resetReadyCache();
    const rows = await piModels(shim, { path: `${tools}:${minimal}` });
    expect(rows).toEqual([{ provider: "zzprov", model: "zz-model", thinking: true, ready: true }]);
  });

  test("pi that does not end within the limit is killed and reported", async () => {
    const pi = join(fx, "pi-hang");
    put(pi, "sleep 30");
    const t0 = Date.now();
    await expect(piModels(pi, { limitMs: 300 })).rejects.toBeInstanceOf(PiListError);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("login path marker: the value after the last marker", () => {
    expect(parseMarker("noise\n__CUBILOT_PATH__/a:/b\n")).toBe("/a:/b");
    expect(parseMarker("__CUBILOT_PATH__/x\n__CUBILOT_PATH__/y\n")).toBe("/y");
    expect(parseMarker("nothing")).toBeUndefined();
  });
});

describe("GET /models", () => {
  let hub: HubHandle;
  const get = (q: string) => fetch(`${hub.url}/models${q}`, { headers: { Authorization: `Bearer ${hub.token}` } });
  beforeAll(async () => {
    hub = await spawnHub({ env: { CUBILOT_LOGIN_PATH: "/usr/bin:/bin", CUBILOT_PI_LIST_LIMIT_MS: "400" } });
    mkdirSync(hub.dataDir, { recursive: true });
  });
  afterAll(() => hub.kill());

  test("claude rows at once, also without a harness", async () => {
    for (const q of ["?harness=claude", ""]) {
      const body = await (await get(q)).json();
      expect(body.models.map((m: { model: string }) => m.model)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    }
  });

  test("Unknown harness: 400 invalid harness: foo", async () => {
    const res = await get("?harness=foo");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid harness: foo");
  });

  test("pi rows come from the pi of config.yml", async () => {
    resetReadyCache(); // same process only; the hub has its own cache and starts empty
    // Own hub with a wide pi limit: this test does not check the limit, and a loaded machine starts the stub late.
    const wide = await spawnHub({ env: { CUBILOT_LOGIN_PATH: "/usr/bin:/bin", CUBILOT_PI_LIST_LIMIT_MS: "60000" } });
    try {
      mkdirSync(wide.dataDir, { recursive: true });
      writeFileSync(join(wide.dataDir, "config.yml"), `pi_path: ${fakePi("pi-hub")}\n`);
      const body = await (await fetch(`${wide.url}/models?harness=pi`, { headers: { Authorization: `Bearer ${wide.token}` } })).json();
      expect(body.warning).toBeUndefined();
      expect(body.models.map((m: { model: string; ready: boolean }) => [m.model, m.ready])).toEqual([
        ["claude-fable-5", false],
        ["gpt-4", false],
        ["gpt-5.6-sol", true],
      ]);
    } finally {
      await wide.kill();
    }
  }, 60000);

  test("Pi does not answer: empty list with a warning", async () => {
    const pi = join(fx, "pi-hub-hang");
    put(pi, "sleep 30");
    writeFileSync(join(hub.dataDir, "config.yml"), `pi_path: ${pi}\n`);
    const res = await get("?harness=pi");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.warning).toContain("took more than");
  });

  test("a pi that cannot start: empty list with a warning", async () => {
    writeFileSync(join(hub.dataDir, "config.yml"), `pi_path: ${join(fx, "no-such-pi")}\n`);
    const body = await (await get("?harness=pi")).json();
    expect(body.models).toEqual([]);
    expect(body.warning).toContain("could not run");
  });

  test("a read route needs the bearer token", async () => {
    expect((await fetch(`${hub.url}/models`)).status).toBe(401);
  });
});
