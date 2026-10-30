// readContextPct rounds to a whole number; the agent row keeps the name visible when the context text is long.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextPct } from "../../hub/core/context-usage";

const dir = mkdtempSync(join(tmpdir(), "ctx-round-"));
const put = (agent: string, v: unknown) => writeFileSync(join(dir, `${agent}.json`), JSON.stringify({ context_window: { used_percentage: v } }));

test("a Pi value with decimals rounds to the nearest whole number", () => {
  put("pi-a", 28.69595588235294);
  expect(readContextPct("pi-a", dir)).toBe(29);
  put("pi-b", 28.4);
  expect(readContextPct("pi-b", dir)).toBe(28);
});

test("an integer value stays the same", () => {
  put("cc-a", 40);
  expect(readContextPct("cc-a", dir)).toBe(40);
  put("cc-b", 100);
  expect(readContextPct("cc-b", dir)).toBe(100);
});

test("a missing or non-number value stays null", () => {
  put("x", "12");
  expect(readContextPct("x", dir)).toBeNull();
  expect(readContextPct("absent", dir)).toBeNull();
});

const css = readFileSync(join(import.meta.dir, "../../ui/styles/terminal.css"), "utf8");
const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(`${sel} {`)) ?? "";

test(".row-ctx truncates with an ellipsis and can shrink", () => {
  const r = rule(".row-ctx");
  expect(r).toContain("text-overflow: ellipsis");
  expect(r).toContain("overflow: hidden");
  expect(r).toContain("white-space: nowrap");
  expect(r).toContain("min-width: 0");
  expect(r).toContain("flex: 0 1 auto");
});

test("the name label shrinks too and the context text does not use flex-shrink 0", () => {
  const label = css.slice(css.indexOf(".terminal-tab .tab-label {"), css.indexOf("}", css.indexOf(".terminal-tab .tab-label {")));
  expect(label).toContain("flex: 0 1 auto");
  expect(label).toContain("min-width: 0");
  expect(rule(".row-ctx")).not.toContain("flex: 0 0 auto");
});

// Real layout: headless Chromium renders the row markup of ui/terminal.js with the real stylesheets.
const home = process.env.HOME ?? "";
const browser = [
  `${home}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

test.skipIf(!browser)("a long context text keeps the agent name visible and truncates with an ellipsis", () => {
  const ui = join(import.meta.dir, "../../ui/styles");
  const page = join(dir, "layout.html");
  const row = (ctx: string) =>
    `<div class="terminal-tab" style="width:160px"><div class="row-main"><span class="state-dot"></span>` +
    `<button type="button" class="tab-label">worker-2</button><span class="row-ctx">${ctx}</span></div></div>`;
  writeFileSync(page, `<!doctype html><html><head>${["tokens", "reset", "layout", "terminal"].map((f) => `<link rel="stylesheet" href="file://${ui}/${f}.css">`).join("")}</head>` +
    `<body>${row("28.69595588235294%")}${row("100%")}<script>` +
    `document.body.insertAdjacentHTML("beforeend","<pre id=out></pre>");` +
    `document.getElementById("out").textContent=JSON.stringify([...document.querySelectorAll(".terminal-tab")].map(t=>{const l=t.querySelector(".tab-label"),c=t.querySelector(".row-ctx");` +
    `return{label:l.getBoundingClientRect().width,ctx:c.getBoundingClientRect().width,ctxOverflows:c.scrollWidth>c.clientWidth,ellipsis:getComputedStyle(c).textOverflow}}))</script></body></html>`);
  const r = Bun.spawnSync([browser!, "--headless=new", "--disable-gpu", "--allow-file-access-from-files", "--dump-dom", `file://${page}`]);
  const out = /<pre id="out">(.*?)<\/pre>/s.exec(r.stdout.toString());
  expect(out).not.toBeNull();
  const [long, short] = JSON.parse(out![1].replace(/&quot;/g, '"'));
  expect(long.label).toBeGreaterThan(0);
  expect(long.ellipsis).toBe("ellipsis");
  expect(long.ctxOverflows).toBe(true);
  expect(short.label).toBeGreaterThan(0);
  expect(short.ellipsis).toBe("ellipsis");
});
