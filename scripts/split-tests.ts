// Splits the test files under <root>/tests into N parts of about equal run time: `bun scripts/split-tests.ts <root> <report.xml> <parts>`.
// Prints one line "<part>\t<path relative to root>" for each file; part numbers start at 1. A part with no file prints nothing.
// Weights are the per-file seconds of the JUnit report (the sum of its test case times). A file that is not in the report
// weighs UNKNOWN_S seconds, so it goes to the part with the lowest sum. Files are placed longest first.
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";

export const UNKNOWN_S = 1;

export function fileSeconds(xml: string): Map<string, number> {
  const secs = new Map<string, number>();
  for (const m of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const tag = m[0];
    const file = /\bfile="([^"]*)"/.exec(tag)?.[1];
    const time = Number(/\btime="([^"]*)"/.exec(tag)?.[1]);
    if (file && Number.isFinite(time)) secs.set(file, (secs.get(file) ?? 0) + time);
  }
  return secs;
}

export function splitFiles(files: string[], seconds: Map<string, number>, parts: number): string[][] {
  const out: string[][] = Array.from({ length: parts }, () => []);
  const sums = new Array<number>(parts).fill(0);
  const weighted = files.map((f) => ({ f, w: seconds.get(f) ?? UNKNOWN_S }));
  weighted.sort((a, b) => b.w - a.w || (a.f < b.f ? -1 : 1));
  for (const { f, w } of weighted) {
    let lowest = 0;
    for (let i = 1; i < parts; i++) if (sums[i] < sums[lowest]) lowest = i;
    out[lowest].push(f);
    sums[lowest] += w;
  }
  return out.map((p) => p.sort());
}

if (import.meta.main) {
  const [root, report, partsArg] = process.argv.slice(2);
  const parts = Number(partsArg);
  if (!root || !report || !Number.isInteger(parts) || parts < 1) {
    console.error("usage: bun scripts/split-tests.ts <root> <report.xml> <parts>");
    process.exit(2);
  }
  const files = [...new Glob("tests/**/*.test.ts").scanSync({ cwd: root })];
  const seconds = existsSync(report) ? fileSeconds(readFileSync(report, "utf8")) : new Map<string, number>();
  splitFiles(files, seconds, parts).forEach((p, i) => p.forEach((f) => console.log(`${i + 1}\t${f}`)));
}
