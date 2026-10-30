// font-size-map.js — maps the old 13-step --fs-* scale (9 to 18 px) onto the six sizes of design/system/README.md.
// Pure, so it runs in node. The six sizes are the only font sizes of the UI; each is multiplied by --ui-font-scale.
// The terminal (13 px desktop, 12 px phone) is outside the scale and the multiplier.

(function () {
  const SIZES = { 'fs-sm': 12, 'fs-base': 14, 'fs-md': 16, 'fs-lg': 18, 'fs-xl': 22, 'fs-2xl': 28 };

  // The old steps with the px each one had before the six-size scale.
  const OLD_STEPS = {
    'fs-3xs': 9, 'fs-2xs': 10, 'fs-xs': 10.5, 'fs-sm': 11, 'fs-md': 11.5, 'fs-base': 12, 'fs-lg': 12.5,
    'fs-xl': 13, 'fs-2xl': 13.5, 'fs-3xl': 14, 'fs-4xl': 16, 'fs-5xl': 17, 'fs-6xl': 18,
  };

  // The nearest of the six sizes; a tie goes to the larger size (13 px -> fs-base, 17 px -> fs-lg).
  function nearestSize(px) {
    let best = null;
    for (const [name, size] of Object.entries(SIZES)) {
      if (best === null || Math.abs(size - px) <= Math.abs(SIZES[best] - px)) best = name;
    }
    return best;
  }

  // The new step name for an old step name ('fs-xl' -> 'fs-base'), or undefined for a name that is not an old step.
  function mapOldStep(oldName) {
    const px = OLD_STEPS[oldName];
    return px === undefined ? undefined : nearestSize(px);
  }

  const api = { SIZES, OLD_STEPS, nearestSize, mapOldStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.fontSizeMap = api;
})();
