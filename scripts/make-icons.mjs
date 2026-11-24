// Renders the extension icons (public/icon/*.png) from an inline SVG.
import { chromium } from '@playwright/test';
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs>
<rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
<path d="M30 36h44M30 54h30M30 72h22" stroke="#c7d2fe" stroke-width="8" stroke-linecap="round"/>
<path d="M90 40l14 14-38 38-18 4 4-18z" fill="#fff"/>
<path d="M84 46l14 14" stroke="#4338ca" stroke-width="5"/>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const s of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(s)}</body></html>`);
  await page.screenshot({ path: `public/icon/${s}.png`, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
await browser.close();
console.log('icons done');
