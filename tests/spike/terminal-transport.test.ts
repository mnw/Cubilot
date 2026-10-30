// Spike for Part 12 group 1: which transport keeps colours, cursor, resize and input?
// Runs the same cases on tmux control mode (`tmux -C`, %output, send-keys -H) and on a raw PTY
// (Bun.Terminal on `tmux attach`), on a hermetic tmux socket, with @xterm/headless as the viewer.
// A failing case is recorded in the table, never thrown. No Claude or Pi login needed.
// Results land in the test log and in $TMPDIR/terminal-transport-results.json for docs/spikes/terminal-transport.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";

const BUNDLED_TMUX = "/Applications/Cubilot.app/Contents/Resources/resources/tmux";
const TMUX = process.env.CUBILOT_TMUX ?? (existsSync(BUNDLED_TMUX) ? BUNDLED_TMUX : Bun.which("tmux"));
const FIXTURE = join(import.meta.dir, "..", "fixtures", "fake-tui.ts");
const ENV = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (s: string) => s.trim().split(/\s+/).filter(Boolean);

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

let dir = "";
let sock = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "cubilot-tt-")); sock = join(dir, "tmux.sock"); });
afterAll(() => {
  if (TMUX && sock) Bun.spawnSync([TMUX, "-S", sock, "kill-server"]);
  rmSync(dir, { recursive: true, force: true });
});

const tmux = (...args: string[]) => {
  const r = Bun.spawnSync([TMUX!, "-S", sock, "-f", "/dev/null", ...args], { env: ENV });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
};

interface Files { hex: string; size: string; go: string }
function startSession(name: string): Files {
  const f = { hex: join(dir, `${name}.hex`), size: join(dir, `${name}.size`), go: join(dir, `${name}.go`) };
  writeFileSync(f.hex, ""); writeFileSync(f.size, "");
  const r = tmux("new-session", "-d", "-x", "80", "-y", "24", "-s", name, [process.execPath, FIXTURE, f.hex, f.size, f.go].map((a) => `'${a}'`).join(" "));
  if (!r.ok) throw new Error(`new-session: ${r.err}`);
  tmux("set-option", "-t", `=${name}:`, "status", "off"); // same options as pty.rs
  tmux("set-option", "-t", `=${name}:`, "allow-passthrough", "on");
  tmux("set-option", "-sa", "terminal-features", ",xterm-256color:RGB"); // pty.rs does not set this: without it tmux downsamples truecolor on attach
  tmux("set-option", "-w", "-t", `=${name}:`, "window-size", "latest");
  return f;
}

// A viewer: bytes in, @xterm/headless out. `feed` chains the writes so `settle` sees every byte.
function viewer() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon()); // headless defaults to Unicode 6: a 4-byte glyph would be one cell
  term.unicode.activeVersion = "11";
  let chain = Promise.resolve();
  let bytes = 0;
  return {
    term,
    get bytes() { return bytes; },
    feed(d: Uint8Array) { bytes += d.length; chain = chain.then(() => new Promise<void>((r) => term.write(d, r))); },
    settle: () => chain,
    text() {
      const b = term.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? "").join("\n");
    },
  };
}

interface Transport {
  name: "control mode" | "raw PTY";
  attach(session: string, v: ReturnType<typeof viewer>): void;
  send(session: string, bytes: number[]): void;
  resize(session: string, cols: number, rows: number): void;
  close(): void;
}

function controlMode(): Transport {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const cmd = (line: string) => (proc!.stdin as import("bun").FileSink).write(line + "\n");
  return {
    name: "control mode",
    attach(session, v) {
      proc = Bun.spawn([TMUX!, "-S", sock, "-f", "/dev/null", "-C", "attach", "-t", `=${session}`], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: ENV });
      let buf: number[] = [];
      (async () => {
        for await (const chunk of proc!.stdout as ReadableStream<Uint8Array>) {
          for (const b of chunk) {
            if (b !== 0x0a) { buf.push(b); continue; }
            const line = Uint8Array.from(buf); buf = [];
            const head = new TextDecoder().decode(line.subarray(0, 8));
            if (head !== "%output ") continue;
            let i = 8;
            while (line[i] !== 0x20) i++; // skip the pane id
            const out: number[] = [];
            for (i++; i < line.length; i++) {
              if (line[i] === 0x5c && i + 3 < line.length + 0 && /[0-7]/.test(String.fromCharCode(line[i + 1]))) {
                out.push(parseInt(String.fromCharCode(line[i + 1], line[i + 2], line[i + 3]), 8)); i += 3;
              } else out.push(line[i]);
            }
            v.feed(Uint8Array.from(out));
          }
        }
      })();
    },
    send: (session, bytes) => cmd(`send-keys -t =${session}: -H ${bytes.map((b) => b.toString(16)).join(" ")}`),
    resize: (_s, cols, rows) => cmd(`refresh-client -C ${cols}x${rows}`),
    close() { try { proc?.kill(); } catch {} },
  };
}

function rawPty(): Transport {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  return {
    name: "raw PTY",
    attach(session, v) {
      proc = Bun.spawn([TMUX!, "-S", sock, "-f", "/dev/null", "attach", "-t", `=${session}`], {
        env: ENV,
        terminal: { cols: 80, rows: 24, name: "xterm-256color", data: (_t, d) => v.feed(d) },
      });
    },
    send: (_s, bytes) => proc!.terminal!.write(Uint8Array.from(bytes)),
    resize: (_s, cols, rows) => proc!.terminal!.resize(cols, rows),
    close() { try { proc?.kill(); proc?.terminal?.close(); } catch {} },
  };
}

interface CaseResult { transport: string; case: string; pass: boolean; detail: string }

async function runTransport(t: Transport, results: CaseResult[], metrics: Record<string, number>) {
  const session = t.name === "raw PTY" ? "raw" : "ctl";
  const record = (c: string, pass: boolean, detail: string) => results.push({ transport: t.name, case: c, pass, detail });
  const check = async (c: string, fn: () => Promise<[boolean, string]> | [boolean, string]) => {
    try { const [p, d] = await fn(); record(c, p, d); } catch (e) { record(c, false, `error: ${(e as Error).message}`); }
  };
  const f = startSession(session);
  const v = viewer();
  t.attach(session, v);
  await sleep(500);
  writeFileSync(f.go, "");
  await waitFor(() => v.text().includes("SIZE"), 3000);
  await sleep(300);
  await v.settle();
  const cell = (row: number, col: number) => v.term.buffer.active.getLine(row)?.getCell(col);

  await check("SGR", () => {
    const a = cell(1, 0), b = cell(2, 0);
    const p256 = !!a && a.getChars() === "S" && a.isFgPalette() && a.getFgColor() === 196;
    const rgb = !!b && b.getChars() === "T" && b.isFgRGB() && b.getFgColor() === 0x0080ff;
    return [p256 && rgb, `256-colour ${p256 ? "ok" : `lost (${a?.getChars()} fg=${a?.getFgColor()} palette=${a?.isFgPalette()})`}; truecolor ${rgb ? "ok" : `lost (${b?.getChars()} fg=${b?.getFgColor()} rgb=${b?.isFgRGB()})`}`];
  });
  await check("Cursor", () => {
    const c = cell(4, 9);
    const ok = !!c && c.getChars() === "R" && c.isFgRGB() && c.getFgColor() === 0xff0000;
    return [ok, `row 5 col 10: '${c?.getChars()}' fg=${c?.getFgColor()?.toString(16)} rgb=${c?.isFgRGB()}`];
  });
  const alt = v.term.buffer.active.type === "alternate";
  await check("UTF-8", () => {
    const c = cell(6, 0);
    const ok = !!c && c.getChars() === "🦀" && c.getWidth() === 2;
    return [ok, `row 7 col 1: '${c?.getChars()}' width=${c?.getWidth()}`];
  });

  await check("Resize", async () => {
    const start = hex2(readFileSync(f.size, "utf8"));
    t.resize(session, 120, 40);
    v.term.resize(120, 40);
    const t0 = Date.now();
    const ok = await waitFor(() => readFileSync(f.size, "utf8").trim().split("\n").pop() === "120x40", 1000);
    return [start[0] === "80x24" && ok, `start ${start[0]}, then ${readFileSync(f.size, "utf8").trim().split("\n").pop()} after ${Date.now() - t0} ms`];
  });
  await sleep(300);

  await check("Input", async () => {
    const keys: number[][] = [[0x1b, 0x5b, 0x41], [0x1b], [0x03], [0x1b, 0x5b, 0x5a], [...Buffer.from("\x1b[200~a b\x1b[201~")]];
    for (const k of keys) { t.send(session, k); await sleep(k.length === 1 && k[0] === 0x1b ? 700 : 150); } // 700 ms > tmux escape-time
    const want = keys.flat().map((b) => b.toString(16).padStart(2, "0")).join(" ");
    await waitFor(() => hex(readFileSync(f.hex, "utf8")).join(" ").length >= want.length, 1500);
    const got = hex(readFileSync(f.hex, "utf8")).join(" ");
    return [got === want, got === want ? "Up, Esc, Ctrl+C, Shift+Tab, paste: all received in order" : `want ${want}; got ${got}`];
  });

  await check("Redraw", async () => {
    await v.settle();
    const b0 = v.bytes, t0 = performance.now();
    t.send(session, [0x52]); // 'R': 60 full-screen frames at 120x40
    const ok = await waitFor(() => v.text().includes("REDRAW-DONE"), 15000);
    await sleep(200); await v.settle();
    const s = (performance.now() - t0 - 200) / 1000;
    metrics[`${t.name}: bytes`] = v.bytes - b0;
    metrics[`${t.name}: bytes/s`] = Math.round((v.bytes - b0) / s);
    return [ok, `${v.bytes - b0} bytes in ${s.toFixed(2)} s`];
  });

  await check("Alternate", async () => {
    t.send(session, [0x78]); // 'x': the program leaves the alternate screen
    const back = await waitFor(() => v.text().includes("BACK-ON-MAIN"), 2000);
    return [alt && back, `alternate on enter: ${alt}; program's leave seen: ${back}; viewer buffer now ${v.term.buffer.active.type}`];
  });
  t.close();
}
const hex2 = (s: string) => s.trim().split("\n").filter(Boolean);

test.skipIf(!TMUX)("fake tui reports its size and logs input bytes", async () => {
  const f = startSession("ft");
  writeFileSync(f.go, "");
  expect(await waitFor(() => readFileSync(f.size, "utf8").includes("80x24"), 3000)).toBe(true);
  expect(tmux("resize-window", "-t", "=ft:", "-x", "120", "-y", "40").ok).toBe(true);
  expect(await waitFor(() => readFileSync(f.size, "utf8").trim().split("\n").pop() === "120x40", 1000)).toBe(true);
  tmux("send-keys", "-t", "=ft:", "-H", "1b", "5b", "41");
  expect(await waitFor(() => hex(readFileSync(f.hex, "utf8")).join(" ") === "1b 5b 41", 1000)).toBe(true);
  const screen = tmux("capture-pane", "-p", "-t", "=ft:").out;
  expect(screen).toContain("SGR256");
  expect(screen).toContain("TRUECOLOR");
});

test.skipIf(!TMUX)("each case on control mode and on a raw PTY", async () => {
  const results: CaseResult[] = [];
  const metrics: Record<string, number> = {};
  await runTransport(controlMode(), results, metrics);
  await runTransport(rawPty(), results, metrics);
  const order = ["SGR", "Cursor", "Alternate", "UTF-8", "Resize", "Input"];
  const lines = ["| Case | control mode | raw PTY |", "|---|---|---|"];
  for (const c of order) {
    const cell = (tn: string) => { const r = results.find((x) => x.transport === tn && x.case === c)!; return `${r.pass ? "pass" : "FAIL"} (${r.detail})`; };
    lines.push(`| ${c} | ${cell("control mode")} | ${cell("raw PTY")} |`);
  }
  console.log(lines.join("\n"));
  console.log(JSON.stringify(metrics));
  writeFileSync(join(tmpdir(), "terminal-transport-results.json"), JSON.stringify({ results, metrics }, null, 2));
  // Recorded, not thrown: only the shape of the run is asserted.
  for (const tn of ["control mode", "raw PTY"]) for (const c of order) expect(results.some((x) => x.transport === tn && x.case === c)).toBe(true);
}, 90000);

// Opt-in manual run: TT_REAL="claude" (or "pi") bun test tests/spike/terminal-transport.test.ts -t "real program"
// Starts the real program in a throw-away folder, attaches on each transport, resizes, sends paste, Shift+Tab, Up, Ctrl+C and Esc, and prints
// what the viewer shows. It sends no prompt, so it spends no model tokens. Needs the program installed.
test.skipIf(!TMUX || !process.env.TT_REAL)("real program on both transports", async () => {
  const cmd = process.env.TT_REAL!;
  const out: Record<string, unknown> = {};
  for (const t of [controlMode(), rawPty()]) {
    const session = t.name === "raw PTY" ? "rawr" : "ctlr";
    const work = mkdtempSync(join(dir, "work-"));
    tmux("new-session", "-d", "-x", "80", "-y", "24", "-s", session, "-c", work, `$SHELL -ic '${cmd}'`);
    tmux("set-option", "-t", `=${session}:`, "status", "off");
    tmux("set-option", "-sa", "terminal-features", ",xterm-256color:RGB");
    const v = viewer();
    t.attach(session, v);
    await sleep(9000); await v.settle();
    const stats = () => {
      const b = v.term.buffer.active; let coloured = 0, filled = 0, last = 0;
      for (let y = 0; y < v.term.rows; y++) {
        const l = b.getLine(y); if (!l) continue;
        const txt = l.translateToString(true); if (txt) { filled++; last = y + 1; }
        for (let x = 0; x < v.term.cols; x++) { const c = l.getCell(x); if (c && c.getChars() && !c.isFgDefault()) coloured++; }
      }
      return { cols: v.term.cols, rows: v.term.rows, filledRows: filled, lastRow: last, colouredCells: coloured, buffer: b.type };
    };
    const before = stats();
    t.resize(session, 120, 40); v.term.resize(120, 40);
    await sleep(2500); await v.settle();
    const tmuxSize = tmux("display", "-p", "-t", `=${session}:`, "#{pane_width}x#{pane_height}").out.trim();
    const after = stats();
    // Cursor and alternate screen: the viewer must agree with tmux's own pane state.
    const info = tmux("display", "-p", "-t", `=${session}:`, "#{cursor_x},#{cursor_y},#{alternate_on}").out.trim().split(",");
    const norm = (x: string) => x.split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
    const paneText = norm(tmux("capture-pane", "-p", "-t", `=${session}:`).out);
    const viewText = norm(Array.from({ length: v.term.rows }, (_, y) => v.term.buffer.active.getLine(y)?.translateToString(true) ?? "").join("\n"));
    const cursor = { tmux: `${info[0]},${info[1]}`, viewer: `${v.term.buffer.active.cursorX},${v.term.buffer.active.cursorY}`, textMatchesPane: paneText === viewText };
    const altScreen = { tmuxAlternateOn: info[2] === "1", viewerBuffer: v.term.buffer.active.type };
    // Keys one by one. Each step records whether the pane lives and whether the screen changed. No prompt is sent.
    // Claude Code is on its trust prompt, so Ctrl+C or Esc may close it: that is the program's reaction, not a lost key.
    const keys: [string, number[]][] = [["paste", [...Buffer.from("\x1b[200~a b\x1b[201~")]], ["Shift+Tab", [0x1b, 0x5b, 0x5a]], ["Up", [0x1b, 0x5b, 0x41]], ["Ctrl+C", [0x03]], ["Esc", [0x1b]]];
    const keyLog: Record<string, string> = {};
    for (const [name, bytes] of keys) {
      if (!tmux("has-session", "-t", `=${session}`).ok) { keyLog[name] = "not sent: program had exited"; continue; }
      const prev = v.text();
      t.send(session, bytes); await sleep(name === "Esc" ? 900 : 500); await v.settle();
      const alive = tmux("has-session", "-t", `=${session}`).ok;
      keyLog[name] = `${alive ? "alive" : "program exited"}, screen ${v.text() === prev ? "unchanged" : "changed"}`;
    }
    const alive = tmux("has-session", "-t", `=${session}`).ok;
    out[t.name] = { before, after, paneSizeAfterResize: tmuxSize, cursor, altScreen, keyLog, alive, head: v.text().split("\n").filter(Boolean).slice(0, 6) };
    t.close();
    tmux("kill-session", "-t", `=${session}`);
  }
  console.log(JSON.stringify({ program: cmd, ...out }, null, 2));
}, 60000);
