// check-tokens.ts — lists each colour, font size, spacing or radius value in ui/ outside ui/styles/tokens.css.
// A value written as var(--token) is fine. Every other value is a finding, unless an ALLOW line names it with a reason.
// Run: bun scripts/check-tokens.ts (exit 1 when a finding remains). Used by tests/unit/check-tokens.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding { file: string; line: number; kind: string; value: string; text: string }
export interface Allow { file: string; match: string; reason: string }

// Allow-list: a finding is skipped when its file is `file` and its line holds `match`. One line, one reason.
export const ALLOW: Allow[] = [];

const SKIP_FILES = new Set(["ui/styles/tokens.css", "ui/styles/fonts.css"]);   // fonts.css: inlined font data
const SKIP_DIRS = new Set(["vendor", "fonts"]);
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\((?!from\b)[^)]*\)/g;   // hsl(from var(--x) h s l) is relative colour, not a literal
const PX = /(?<![\w.#-])(-?\d*\.?\d+)(px|rem|em)\b/g;
const PROPS: Array<[string, RegExp]> = [
  ["font-size", /^font-size$/],
  ["spacing", /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/],
  ["radius", /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/],
];

// Blank /* comments */ and quoted strings with equal-length spaces, so columns and line numbers stay true.
function blank(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function scanCss(text: string, file: string, base: number, out: Finding[]) {
  const lines = blank(text).split("\n");
  const raw = text.split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(COLOR)) {
      out.push({ file, line: base + i, kind: "color", value: m[0], text: raw[i].trim() });
    }
    // declarations: split on ; and {, keep "prop: value" pairs
    for (const d of l.split(/[;{]/)) {
      const c = d.indexOf(":");
      if (c < 0) continue;
      const prop = d.slice(0, c).replace(/^[^a-zA-Z-]+/, "").trim().toLowerCase();   // drop a leading quote or bracket
      const val = d.slice(c + 1);
      const hit = PROPS.find(([, re]) => re.test(prop));
      if (!hit) continue;
      for (const m of val.matchAll(PX)) {   // also a px in the fallback of var(--token, 4px)
        if (parseFloat(m[1]) === 0) continue;
        out.push({ file, line: base + i, kind: hit[0], value: m[0], text: raw[i].trim() });
      }
    }
  });
}

function scanHtml(text: string, file: string, out: Finding[]) {
  // <style> blocks as CSS; style="..." attributes as a declaration list. Line numbers stay true.
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    scanCss(m[1], file, text.slice(0, m.index! + m[0].indexOf(m[1])).split("\n").length, out);
  }
  for (const m of text.matchAll(/\sstyle="([^"]*)"/g)) {
    scanCss(m[1], file, text.slice(0, m.index!).split("\n").length, out);
  }
}

function scanJs(text: string, file: string, out: Finding[]) {
  // Style written from JS: element.style.<prop> = '...' and cssText strings. Colour literals in other code are not style.
  text.split("\n").forEach((l, i) => {
    if (!/\.style\b|cssText|setProperty|style=/.test(l)) return;
    scanCss(l.replace(/^[^'"`]*/, ""), file, i + 1, out);
  });
}

function walk(dir: string, acc: string[]) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(n)) walk(p, acc); }
    else if (/\.(css|html|js)$/.test(n)) acc.push(p);
  }
}

export function checkTokens(root = "."): Finding[] {
  const files: string[] = [];
  walk(join(root, "ui"), files);
  const all: Finding[] = [];
  for (const f of files.sort()) {
    const rel = relative(root, f);
    if (SKIP_FILES.has(rel)) continue;
    const text = readFileSync(f, "utf8");
    if (rel.endsWith(".css")) scanCss(text, rel, 1, all);
    else if (rel.endsWith(".html")) scanHtml(text, rel, all);
    else scanJs(text, rel, all);
  }
  return all.filter((x) => !ALLOW.some((a) => a.file === x.file && x.text.includes(a.match)));
}

export function format(f: Finding): string {
  return `${f.file}:${f.line}  ${f.kind}  ${f.value}  | ${f.text.slice(0, 100)}`;
}

if (import.meta.main) {
  const found = checkTokens();
  for (const f of found) console.log(format(f));
  console.log(`${found.length} value(s) outside ui/styles/tokens.css`);
  process.exit(found.length ? 1 : 0);
}
