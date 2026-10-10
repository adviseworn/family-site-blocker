#!/usr/bin/env node
// Renders extension/icons/icon{16,32,48,128}.png from the gate drawing below (same colours as the block page).
// Run with `npm run icons`. Needs Playwright, like the browser tests; the PNGs are checked in.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="26" fill="#2c5a4b"/>
  <g fill="#ffffff">
    <rect x="20" y="24" width="14" height="80" rx="3.5"/>
    <rect x="94" y="24" width="14" height="80" rx="3.5"/>
    <rect x="30" y="40" width="68" height="10" rx="2.5"/>
    <rect x="30" y="78" width="68" height="10" rx="2.5"/>
    <rect x="46" y="46" width="9" height="36" rx="2"/>
    <rect x="60" y="46" width="9" height="36" rx="2"/>
    <rect x="74" y="46" width="9" height="36" rx="2"/>
  </g>
  <rect x="78" y="58" width="36" height="13" rx="6.5" fill="#e0b45c"/>
  <circle cx="104" cy="64.5" r="3" fill="#2c5a4b"/>
</svg>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(SVG)}">`);
    await page.screenshot({ path: join(OUT, `icon${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${SIZES.map((size) => `icon${size}.png`).join(', ')} to ${OUT}`);
