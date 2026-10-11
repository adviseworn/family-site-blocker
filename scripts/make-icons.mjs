#!/usr/bin/env node
// Renders extension/icons/icon{16,32,48,128}.png and assets/finder-icon.icns (the icon that
// `npm run package:signed` gives the signed .xpi in Finder) from the gate drawing below (same colours as the
// block page). Run with `npm run icons`. Needs Playwright, like the browser tests; the results are checked in.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const ICNS = join(ROOT, 'assets', 'finder-icon.icns');
// PNG-based icns entries and the pixel size each holds: 16 to 512 points, at 1x and 2x.
const ICNS_ENTRIES = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];

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

/** An icns file: a header, then each entry as type, length and PNG data. */
function icns(entries) {
  const parts = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(dirname(ICNS), { recursive: true });
const browser = await chromium.launch();
try {
  const render = async (size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(SVG)}">`);
    const png = await page.screenshot({ omitBackground: true });
    await page.close();
    return png;
  };
  for (const size of SIZES) writeFileSync(join(OUT, `icon${size}.png`), await render(size));
  const pngs = new Map();
  for (const [, size] of ICNS_ENTRIES) if (!pngs.has(size)) pngs.set(size, await render(size));
  writeFileSync(ICNS, icns(ICNS_ENTRIES.map(([type, size]) => [type, pngs.get(size)])));
} finally {
  await browser.close();
}
console.log(`Wrote ${SIZES.map((size) => `icon${size}.png`).join(', ')} to ${OUT}, and ${ICNS}`);
