// The picture filter against real pictures (#50), which the tests can't do: they never contact a real
// website. With the extension loaded in Chromium and the real classifier, each picture listed in
// test/real-pictures.txt (and any in $PICTURE_URLS, space-separated) is judged exactly as a page's
// picture would be, through the background script, and its scores and verdicts under both settings are
// printed, against what the list expects. The run fails when a picture comes out the wrong way.
// Run with:  npm run check:pictures   (GitHub: "Real pictures check" in the Actions tab)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';
import { THRESHOLD, verdict } from '../extension/lib/pictures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const github = !!process.env.GITHUB_ACTIONS;
const note = (level, title, text) => (github ? console.log(`::${level} title=${title}::${text}`) : console.log(`${level}: ${title}: ${text}`));

const listed = readFileSync(join(HERE, 'real-pictures.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [expect, url, label] = line.split('\t');
    return { expect, url, label: label ?? url };
  });
const extra = (process.env.PICTURE_URLS ?? '').split(/\s+/).filter(Boolean).map((url) => ({ expect: 'either', url, label: url }));
const pictures = [...listed, ...extra];

const browser = await launchBrowser(null, { internet: true });
let failures = 0;
try {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  console.log(`Threshold ${THRESHOLD}. nudity = porn + hentai; suggestive = that + sexy.\n`);
  for (const { expect, url, label } of pictures) {
    const started = Date.now();
    const result = await page.evaluate((u) => chrome.runtime.sendMessage({ type: 'judge-picture', url: u }), url);
    const took = Date.now() - started;
    if (!result || result.error || !result.scores) {
      note(expect === 'either' ? 'warning' : 'error', label, `couldn't be judged: ${result?.error ?? 'no answer'} (${url})`);
      if (expect !== 'either') failures += 1;
      continue;
    }
    const s = result.scores;
    const nudity = s.porn + s.hentai;
    const strict = verdict(s, 'strict');
    const nudityOnly = verdict(s, 'nudity');
    const line = `nudity ${nudity.toFixed(2)} (porn ${s.porn.toFixed(2)}, hentai ${s.hentai.toFixed(2)}), sexy ${s.sexy.toFixed(2)}, neutral ${s.neutral.toFixed(2)}, drawing ${s.drawing.toFixed(2)} → strict: ${strict.hide ? `hidden (${strict.reason})` : 'shown'}; nudity only: ${nudityOnly.hide ? 'hidden' : 'shown'}; ${took} ms`;
    const wrong = (expect === 'hide' && !strict.hide) || (expect === 'show' && (strict.hide || nudityOnly.hide));
    if (wrong) failures += 1;
    note(wrong ? 'error' : 'notice', `${expect}: ${label}`, line);
    console.log(`  ${url}`);
  }
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'picture-status' }));
  console.log(`\nJudging ran through ${status.backend}; ${status.judged} judged, ${status.failed} failed.`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} came out the wrong way.` : '\nAll as expected.');
process.exit(failures ? 1 : 0);
