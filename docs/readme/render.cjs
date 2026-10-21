// Make the README images from docs/factory-map.html: one image per section, light and dark.
// Run from the repo root: see docs/readme/README.md.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const src = path.resolve('docs/factory-map.html');
  let html = fs.readFileSync(src, 'utf8')
    .replace(' Click a status to highlight it.', '')
    .replace('<span class="lab">Highlight:</span>', '<span class="lab">Status:</span>')
    .replace(/\s*<button class="lg clear"[^>]*>Show all<\/button>/, '');
  const tmp = path.resolve('docs/readme/.render.html');
  fs.writeFileSync(tmp, html);
  const names = ['00-header', '01-system-map', '02-roles', '03-workflows', '04-mutation-testing', '05-jev', '06-build-order'];
  const pad = 20;
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await page.goto('file://' + tmp);
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const els = [await page.$('header'), ...(await page.$$('section.sec'))];
    for (let i = 0; i < els.length; i++) {
      const b = await els[i].boundingBox();
      await page.screenshot({
        path: `docs/readme/${names[i]}-${theme}.png`, fullPage: true,
        clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad },
      });
    }
    await page.close();
  }
  await browser.close();
  fs.unlinkSync(tmp);
})();
