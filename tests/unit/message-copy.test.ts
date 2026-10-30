// Copy button on an agent message (ui/features/messages.js): clipboard API first, hidden textarea + execCommand second.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync("ui/features/messages.js", "utf8");
const slice = (name: string) => {
  const m = SRC.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  if (!m) throw new Error(`${name} not found in messages.js`);
  return m[0];
};

let toasts: string[];
let written: string[];
let execResults: Array<boolean | "throw">;
let execCalls: number;
let execText: string[];
let attached: any[];
let ctx: any;

const setup = (clipboard: any) => {
  toasts = []; written = []; execCalls = 0; execText = []; attached = [];
  const document = {
    body: {
      appendChild: (el: any) => { attached.push(el); },
      removeChild: (el: any) => { attached.splice(attached.indexOf(el), 1); },
    },
    createElement: () => ({ style: {}, value: "", select() {}, remove() { const i = attached.indexOf(this); if (i >= 0) attached.splice(i, 1); } }),
    execCommand: (cmd: string) => {
      execCalls++;
      execText.push(attached.map((a) => a.value).join(""));
      const r = execResults.shift();
      if (r === "throw") throw new Error("denied");
      return cmd === "copy" && r === true;
    },
  };
  ctx = vm.createContext({ document, navigator: { clipboard }, showCopyToast: (m: string) => toasts.push(m) });
  vm.runInContext(slice("copyToClipboard") + slice("copyMessage"), ctx);
};

const resolves = { writeText: async (t: string) => { written.push(t); } };
const rejects = { writeText: async () => { throw new Error("NotAllowedError"); } };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { execResults = []; });

describe("message copy", () => {
  test("writeText resolves", async () => {
    setup(resolves);
    ctx.copyMessage("hello **x**");
    await flush();
    expect(written).toEqual(["hello **x**"]);
    expect(toasts).toEqual(["Copied"]);
    expect(execCalls).toBe(0);
  });
  test("writeText rejects, execCommand copies", async () => {
    setup(rejects); execResults = [true];
    ctx.copyMessage("abc");
    await flush();
    expect(execText).toEqual(["abc"]);
    expect(toasts).toEqual(["Copied"]);
  });
  test("writeText missing, execCommand copies", async () => {
    setup(undefined); execResults = [true];
    ctx.copyMessage("abc");
    await flush();
    expect(execText).toEqual(["abc"]);
    expect(toasts).toEqual(["Copied"]);
  });
  test("execCommand false shows Copy failed", async () => {
    setup(rejects); execResults = [false];
    ctx.copyMessage("abc");
    await flush();
    expect(toasts).toEqual(["Copy failed"]);
    execResults = ["throw"];
    ctx.copyMessage("abc");
    await flush();
    expect(toasts).toEqual(["Copy failed", "Copy failed"]);
  });
  test("textarea removed", async () => {
    for (const r of [true, false, "throw"] as const) {
      setup(undefined); execResults = [r];
      ctx.copyMessage("abc");
      await flush();
      expect(attached).toEqual([]);
    }
  });
  test("the button copies data.text, not the rendered HTML", () => {
    expect(SRC).toContain("const copyText = data.text || '';");
    expect(SRC).toMatch(/copyMessage\(copyText\)/);
  });
});
