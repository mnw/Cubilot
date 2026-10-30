// The old --fs-* steps map onto the six sizes (ui/features/font-size-map.js, design/system/README.md).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const win: any = {};
new Function("window", "module", readFileSync("ui/features/font-size-map.js", "utf8"))(win, undefined);
const { SIZES, OLD_STEPS, nearestSize, mapOldStep } = win.fontSizeMap;

describe("font-size-map", () => {
  test("the six sizes are 12, 14, 16, 18, 22 and 28 px", () => {
    expect(SIZES).toEqual({ "fs-sm": 12, "fs-base": 14, "fs-md": 16, "fs-lg": 18, "fs-xl": 22, "fs-2xl": 28 });
  });

  test("each of the 13 old steps maps to one of the six sizes", () => {
    expect(Object.keys(OLD_STEPS)).toHaveLength(13);
    for (const old of Object.keys(OLD_STEPS)) expect(Object.keys(SIZES)).toContain(mapOldStep(old));
  });

  test("the mapping of every old step", () => {
    const want: Record<string, string> = {
      "fs-3xs": "fs-sm", "fs-2xs": "fs-sm", "fs-xs": "fs-sm", "fs-sm": "fs-sm", "fs-md": "fs-sm", "fs-base": "fs-sm",
      "fs-lg": "fs-sm", "fs-xl": "fs-base", "fs-2xl": "fs-base", "fs-3xl": "fs-base",
      "fs-4xl": "fs-md", "fs-5xl": "fs-lg", "fs-6xl": "fs-lg",
    };
    for (const [old, now] of Object.entries(want)) expect(mapOldStep(old)).toBe(now);
  });

  test("README ranges: 9-12.5 px small, 13-14 px base, 18 px large", () => {
    for (const px of [9, 10, 10.5, 11, 11.5, 12, 12.5]) expect(nearestSize(px)).toBe("fs-sm");
    for (const px of [13, 13.5, 14]) expect(nearestSize(px)).toBe("fs-base");
    expect(nearestSize(18)).toBe("fs-lg");
  });

  test("an exact size maps to itself; a name that is not an old step gives undefined", () => {
    expect(nearestSize(22)).toBe("fs-xl");
    expect(nearestSize(28)).toBe("fs-2xl");
    expect(mapOldStep("fs-terminal")).toBeUndefined();
    expect(mapOldStep("nope")).toBeUndefined();
  });
});
