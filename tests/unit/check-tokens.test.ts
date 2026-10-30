// T01: ui/styles/tokens.css holds every token of design/system/tokens.json, the UI uses only tokens,
// every text token reaches 4.5:1 in the three themes, and the terminal font stays outside the scale.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTokens, format } from "../../scripts/check-tokens";

const css = readFileSync("ui/styles/tokens.css", "utf8");
const json = JSON.parse(readFileSync("design/system/tokens.json", "utf8"));
const THEMES = ["default", "rose-pine-dawn", "rose-pine-moon"] as const;

// The declarations of one block of tokens.css: ":root" or a [data-theme] block.
function block(sel: string): Record<string, string> {
  const start = css.indexOf(sel + " {");
  const open = css.indexOf("{", start);
  const end = css.indexOf("\n}", open);
  const out: Record<string, string> = {};
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  return out;
}
const blocks: Record<string, Record<string, string>> = {
  default: block(":root"),
  "rose-pine-dawn": block('[data-theme="rose-pine-dawn"]'),
  "rose-pine-moon": block('[data-theme="rose-pine-moon"]'),
};
const norm = (v: string) => v.replace(/\{([\w-]+)\}/g, "var(--$1)").replace(/\s+/g, "").replace(/,\s*/g, ",");
const cssValue = (theme: string, name: string) => blocks[theme][name] ?? blocks.default[name];

describe("tokens.css holds tokens.json", () => {
  test("every colour token, in each of the three themes", () => {
    for (const t of json.color.tokens) {
      for (const theme of THEMES) {
        const want = t.value[theme] ?? t.value.default;
        expect(`${t.name}/${theme}/${norm(cssValue(theme, t.name) ?? "MISSING")}`).toBe(`${t.name}/${theme}/${norm(want)}`);
      }
    }
  });

  test("every spacing, radius, shadow, size, border, z-index and glow token", () => {
    for (const sec of ["spacing", "radius", "shadow", "size", "border", "zIndex", "glow"]) {
      for (const t of json[sec].tokens) {
        expect(`${t.name}=${norm(blocks.default[t.name] ?? "MISSING")}`).toBe(`${t.name}=${norm(t.value)}`);
      }
    }
  });

  test("the structural layer is not overridden by a theme block", () => {
    const structural = ["spacing", "radius", "shadow", "size", "border", "zIndex", "glow"]
      .flatMap((s) => json[s].tokens.map((t: any) => t.name));
    for (const theme of ["rose-pine-dawn", "rose-pine-moon"]) {
      for (const n of structural) expect(blocks[theme][n]).toBeUndefined();
      for (const n of Object.keys(blocks[theme])) expect(n).not.toMatch(/^(fs-|sp-|size-|radius-|z-|motion-)/);
    }
  });

  test("the six font sizes multiply by --ui-font-scale; the old 13 steps are gone", () => {
    const want: Record<string, number> = { "fs-sm": 12, "fs-base": 14, "fs-md": 16, "fs-lg": 18, "fs-xl": 22, "fs-2xl": 28 };
    for (const [n, px] of Object.entries(want)) expect(blocks.default[n]).toBe(`calc(${px}px * var(--ui-font-scale))`);
    for (const old of ["fs-3xs", "fs-2xs", "fs-xs", "fs-3xl", "fs-4xl", "fs-5xl", "fs-6xl"]) expect(blocks.default[old]).toBeUndefined();
  });

  test("the terminal font is 13px on desktop and 12px on a phone, with no scale and no step", () => {
    expect(blocks.default["fs-terminal"]).toBe("13px");
    const phone = css.match(/@media \(max-width: (\d+)px\)\s*\{\s*:root\s*\{\s*--fs-terminal:\s*12px;\s*\}\s*\}/);
    expect(phone).not.toBeNull();
    expect(Number(phone![1])).toBeLessThan(768);
  });

  test("ui/index.html loads tokens.css before every other stylesheet", () => {
    const links = [...readFileSync("ui/index.html", "utf8").matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(links[0]).toBe("styles/tokens.css");
  });
});

// WCAG relative luminance and contrast ratio.
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function resolve(theme: string, name: string): string {
  let v = cssValue(theme, name);
  for (let i = 0; i < 5 && v?.startsWith("var("); i++) v = cssValue(theme, v.slice(6, -1));
  return v;
}

describe("contrast of the text tokens (design/system/README.md)", () => {
  const SURFACES = ["bg", "bg-raised", "bg-inset", "bg-elev"];
  for (const theme of THEMES) {
    test(`${theme}: text, text-muted and text-meta reach 4.5:1 on every surface`, () => {
      for (const tok of ["text", "text-muted", "text-meta"]) {
        for (const s of SURFACES) {
          const r = ratio(resolve(theme, tok), resolve(theme, s));
          expect(`${tok} on ${s}: ${r >= 4.5}`).toBe(`${tok} on ${s}: true`);
        }
      }
    });
    test(`${theme}: orange-text reaches 4.5:1 on bg and bg-raised; text reaches 6:1`, () => {
      for (const s of ["bg", "bg-raised"]) {
        expect(ratio(resolve(theme, "orange-text"), resolve(theme, s))).toBeGreaterThanOrEqual(4.5);
        expect(ratio(resolve(theme, "text"), resolve(theme, s))).toBeGreaterThanOrEqual(6);
      }
    });
  }
  for (const theme of THEMES) {
    test(`${theme}: the terminal foreground is the theme text colour and reaches 4.5:1 on the terminal background`, () => {
      // xterm-themes.js reads --xterm-* from body, so a theme block must set its own foreground.
      if (theme !== "default") expect(blocks[theme]["xterm-fg"]).toBe("var(--text)");
      expect(resolve(theme, "xterm-fg")).toBe(resolve(theme, "text"));
      expect(ratio(resolve(theme, "xterm-fg"), resolve(theme, "xterm-bg"))).toBeGreaterThanOrEqual(4.5);
    });
  }
  test("text-meta equals text-muted in both Rosé Pine themes", () => {
    for (const th of ["rose-pine-dawn", "rose-pine-moon"]) expect(blocks[th]["text-meta"]).toBe(blocks[th]["text-muted"]);
  });
});

describe("check-tokens script", () => {
  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "check-tokens-"));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    return root;
  }

  test("the UI has no colour, font size, spacing or radius outside tokens.css", () => {
    const found = checkTokens(".");
    expect(found.map(format)).toEqual([]);
  });

  test("lists a font size in an HTML style attribute inside a JS string", () => {
    const root = project({
      "ui/x.js": "el.innerHTML = '<div style=\"font-size:11px; color:var(--text-dim);\">x</div>';\nel.innerHTML = '<b style=\"font-size:var(--fs-sm)\">y</b>';",
    });
    expect(checkTokens(root).map((f) => `${f.file}:${f.line}:${f.value}`)).toEqual(["ui/x.js:1:11px"]);
  });

  test("lists a colour, font size, spacing and radius with file and line", () => {
    const root = project({
      "ui/styles/a.css": ".a { color: #abc; }\n.b {\n  font-size: 13px;\n  padding: 4px 0;\n  border-radius: 5px;\n}\n.c { background: rgba(0,0,0,.5); }",
    });
    const got = checkTokens(root).map((f) => `${f.file}:${f.line}:${f.kind}:${f.value}`);
    expect(got).toEqual([
      "ui/styles/a.css:1:color:#abc",
      "ui/styles/a.css:3:font-size:13px",
      "ui/styles/a.css:4:spacing:4px",
      "ui/styles/a.css:5:radius:5px",
      "ui/styles/a.css:7:color:rgba(0,0,0,.5)",
    ]);
  });

  test("a var() token, zero, a comment and tokens.css itself are not findings", () => {
    const root = project({
      "ui/styles/tokens.css": ":root { --x: #fff; --sp-4: 4px; }",
      "ui/styles/a.css": ".a { color: var(--text); padding: 0; margin: 0 var(--sp-4); /* #fff 4px */ font-size: var(--fs-sm); }",
    });
    expect(checkTokens(root)).toEqual([]);
  });

  test("a literal in a var() fallback is a finding", () => {
    const root = project({ "ui/styles/a.css": ".a { padding: var(--sp-4, 8px); }" });
    expect(checkTokens(root).map((f) => f.value)).toEqual(["8px"]);
  });

  test("finds literals in <style>, in style attributes and in style written from JS", () => {
    const root = project({
      "ui/index.html": '<style>\n.a { color: #fff; }\n</style>\n<div style="gap:6px; color:var(--text)"></div>\n',
      "ui/x.js": "el.style.cssText = 'font-size:16px; color:#123456';\nconst keep = '#ffffff';",
    });
    expect(checkTokens(root).map((f) => `${f.file}:${f.line}:${f.value}`)).toEqual([
      "ui/index.html:2:#fff",
      "ui/index.html:4:6px",
      "ui/x.js:1:#123456",
      "ui/x.js:1:16px",
    ]);
  });

  test("vendor and font folders are skipped", () => {
    const root = project({ "ui/vendor/a.css": ".a{color:#fff}", "ui/fonts/b.css": ".a{color:#fff}" });
    expect(checkTokens(root)).toEqual([]);
  });
});
