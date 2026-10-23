// Safe search against the real Google (#46), which the tests can't do: they never contact a real website.
// With the extension loaded in Chromium and in Firefox, it searches Google for "test" and Google Images for
// "weather", both written without the strict setting, the way a person types them, and reports:
//
// - whether the address still holds safe=active once Google's own page script has run (the settings page
//   tells people to look for it there);
// - anything on the page that mentions SafeSearch;
// - in Chromium, the requests Google's page makes in the background while Google Images is scrolled (more
//   results), and whether they carry safe=active too, since the rules only redirect page loads;
// - a screenshot of each page, in ./google-check/.
//
// Only harmless searches are made. If Google answers with its "unusual traffic" page, nothing can be
// checked from that connection, and the check says so rather than trying to get past it.
// Run with:  npm run check:google   (GitHub: "Real Google check" in the Actions tab)
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EXTENSION_DIR } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const OUT = 'google-check';
const SEARCH = 'https://www.google.com/search?q=test';
const IMAGES = 'https://www.google.com/search?q=weather&udm=2';
const SETTLE_MS = 5000; // time for Google's page script to run after the page has loaded
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const github = !!process.env.GITHUB_ACTIONS;
const note = (level, title, text) => (github ? console.log(`::${level} title=${title}::${text}`) : console.log(`${level}: ${title}: ${text}`));

const findings = []; // { browser, page, kept, refused, address, mentions }

/** Leaf texts and labels on the page that mention SafeSearch; runs in the page. */
const MENTIONS = `return [...document.querySelectorAll('body *')]
  .flatMap((el) => [el.children.length === 0 ? el.textContent : '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''])
  .map((text) => text.trim().replace(/\\s+/g, ' '))
  .filter((text) => text && text.length < 200 && /safe ?search/i.test(text))
  .filter((text, i, all) => all.indexOf(text) === i)
  .slice(0, 12);`;

/** What a page is, for judge(); runs in the page. */
const PROBE = `return {
  documentURI: document.documentURI,
  title: document.title,
  query: document.querySelector('[name="q"]')?.value ?? null,
  text: document.body ? document.body.innerText.slice(0, 3000) : '',
};`;

/**
 * Whether the page is Google's results for `query` and the address kept safe=active; or why nothing could be
 * checked: Google's "unusual traffic" or consent page, a browser error page, or some other page. Only a page
 * showing the query in Google's own search box counts as the results page.
 */
function judge(address, probe, query) {
  const url = new URL(address);
  if (url.pathname.startsWith('/sorry/') || /unusual traffic/i.test(probe.text)) return { refused: 'Google answered with its "unusual traffic" page' };
  if (url.hostname.startsWith('consent.')) return { refused: 'Google answered with its cookie consent page' };
  if (!probe.documentURI.startsWith('https://')) return { refused: `the browser showed an error page instead (${probe.documentURI.split('?')[0]}: ${probe.title})` };
  if (probe.query !== query) return { refused: `the page isn't Google's results for "${query}" (title "${probe.title}")` };
  return { kept: url.searchParams.get('safe') === 'active' };
}

function report(browser, pageName, address, mentions, verdict) {
  findings.push({ browser, page: pageName, address, mentions, ...verdict });
  console.log(`\n${browser}, ${pageName}`);
  console.log(`  address after ${SETTLE_MS / 1000} s: ${address}`);
  if (verdict.refused) {
    console.log(`  ${verdict.refused}: nothing checked`);
    return;
  }
  console.log(`  keeps safe=active: ${verdict.kept ? 'yes' : 'NO'}`);
  console.log(`  mentions of SafeSearch on the page: ${mentions.length ? mentions.map((m) => JSON.stringify(m)).join(', ') : 'none'}`);
}

async function chromiumCheck() {
  const { chromium } = await import('playwright');
  const profile = mkdtempSync(join(tmpdir(), 'family-site-blocker-google-'));
  const extension = join(profile, 'extension');
  cpSync(EXTENSION_DIR, extension, { recursive: true, filter: (source) => basename(source) !== '_metadata' });
  const context = await chromium.launchPersistentContext(join(profile, 'user'), {
    channel: 'chromium',
    headless: process.env.HEADFUL !== '1',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    if (!context.serviceWorkers().some((w) => w.url().startsWith('chrome-extension://'))) {
      await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const page = await context.newPage();
    const browser = `Chromium ${(await page.evaluate(() => navigator.userAgent)).match(/Chrome\/([\d.]+)/)?.[1] ?? ''}`.trim();
    const requests = [];
    page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType() }));

    // A web search, typed without the setting.
    const probe = () => page.evaluate(`(() => { ${PROBE} })()`).catch((error) => ({ documentURI: page.url(), title: String(error.message).split('\n')[0], query: null, text: '' }));
    await page.goto(SEARCH, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    await sleep(SETTLE_MS);
    let address = page.url();
    let verdict = judge(address, await probe(), 'test');
    report(browser, `Google search for "test"`, address, verdict.refused ? [] : await page.evaluate(`(() => { ${MENTIONS} })()`), verdict);
    await page.screenshot({ path: join(OUT, 'chromium-search.png') });
    if (verdict.refused) return;
    const pageLoads = requests.filter((r) => r.type === 'document').map((r) => r.url);
    console.log(`  page loads: ${pageLoads.map((u) => u.replace('https://www.google.com', '')).join(' → ')}`);

    // Google Images, then scrolled so more results load in the background.
    await page.goto(IMAGES, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    await sleep(SETTLE_MS);
    address = page.url();
    verdict = judge(address, await probe(), 'weather');
    report(browser, 'Google Images for "weather"', address, verdict.refused ? [] : await page.evaluate(`(() => { ${MENTIONS} })()`), verdict);
    await page.screenshot({ path: join(OUT, 'chromium-images.png') });
    if (verdict.refused) return;
    const images = () => page.evaluate(() => document.querySelectorAll('img').length);
    const imagesBefore = await images();
    const mark = requests.length;
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 2500);
      await sleep(1200);
    }
    const imagesAfter = await images();
    const background = requests
      .slice(mark)
      .filter((r) => /(^|\.)google\.com$/.test(new URL(r.url).hostname) && ['xhr', 'fetch', 'document'].includes(r.type));
    const byPath = new Map();
    for (const r of background) {
      const url = new URL(r.url);
      const key = `${r.type} ${url.pathname}`;
      const row = byPath.get(key) ?? { key, count: 0, safe: 0, example: url.search.slice(0, 160) };
      row.count += 1;
      if (url.searchParams.get('safe') === 'active') row.safe += 1;
      byPath.set(key, row);
    }
    console.log(`  after scrolling: ${imagesBefore} → ${imagesAfter} images on the page`);
    console.log(`  background requests to Google while scrolling: ${background.length}`);
    for (const row of byPath.values()) console.log(`    ${row.key}: ${row.count}, with safe=active: ${row.safe}  e.g. ${row.example}`);
    const searches = background.filter((r) => new URL(r.url).pathname === '/search');
    findings.push({ browser, page: 'Google Images, scrolled', background: background.length, searches: searches.length, searchesWithSafe: searches.filter((r) => new URL(r.url).searchParams.get('safe') === 'active').length, more: imagesAfter > imagesBefore });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

async function firefoxCheck() {
  if (!findFirefox()) {
    console.log('\nFirefox: not found (set FIREFOX=/path/to/firefox); skipped');
    return;
  }
  // The helper points Firefox at the tests' stand-in internet; switching the proxy off lets it reach the real one.
  const browser = await launchFirefox({ port: 1 }, { prefs: { 'network.proxy.type': 0 } });
  try {
    const name = `Firefox ${browser.version}`;
    for (const [url, pageName, file, query] of [
      [SEARCH, 'Google search for "test"', 'firefox-search.png', 'test'],
      [IMAGES, 'Google Images for "weather"', 'firefox-images.png', 'weather'],
    ]) {
      await browser.newTab();
      await browser.visit(url);
      await sleep(SETTLE_MS);
      const address = await browser.currentUrl();
      const probe = await browser.run(PROBE).catch((error) => ({ documentURI: address, title: error.message, query: null, text: '' }));
      const verdict = judge(address, probe, query);
      report(name, pageName, address, verdict.refused ? [] : await browser.run(MENTIONS).catch(() => []), verdict);
      writeFileSync(join(OUT, file), Buffer.from(await browser.fx.send('WebDriver:TakeScreenshot', { full: false }), 'base64'));
      if (verdict.refused) return;
    }
  } finally {
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });
for (const check of [chromiumCheck, firefoxCheck]) {
  try {
    await check();
  } catch (error) {
    console.log(`\n${check.name} failed: ${error.message}`);
    findings.push({ browser: check.name, failed: error.message });
  }
}

// The verdict.
console.log('\nSummary');
let status = 0;
for (const f of findings) {
  if (f.failed) {
    note('error', f.browser, `could not run: ${f.failed}`);
    status = 1;
  } else if (f.refused) {
    note('warning', `${f.browser}: ${f.page}`, `${f.refused}, so nothing was checked from this connection`);
    status = status || 2;
  } else if ('kept' in f) {
    note(f.kept ? 'notice' : 'error', `${f.browser}: ${f.page}`, f.kept ? `the address keeps safe=active` : `the address lost safe=active: ${f.address}`);
    if (!f.kept) status = 1;
  } else if ('background' in f) {
    const text = `${f.more ? 'more results loaded' : 'no more results loaded'}; ${f.background} background requests to Google, ${f.searches} of them to /search, ${f.searchesWithSafe} of those with safe=active`;
    note(f.searches > f.searchesWithSafe ? 'warning' : 'notice', `${f.browser}: ${f.page}`, text);
  }
}
console.log(status === 2 ? 'Inconclusive: nothing could be checked from this connection.' : status ? 'Failed.' : 'Done.');
process.exit(status);
