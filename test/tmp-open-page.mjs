// Temporary, for one branch: Brian's flow as nearly as GitHub's Mac allows: the Firefox lock's policies in
// force (LOCK=1), a record as full as his (500 tries, 500 hidden pictures and videos, 60 copies kept),
// looks at videos and pictures first (whole videos held as object URLs, pictures copied now), then
// Every try -> Look at it -> Open the page on YouTube and TikTok pages, with the real internet and the
// real classifier; any crashed tab and the crash notes Firefox leaves in the profile are reported.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyKey, hashOf } from '../extension/lib/pictures.js';
import { filterEntries, lockSettings } from '../scripts/firefox-lock.mjs';
import { startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MAC = process.platform === 'darwin';
const FIREFOX = findFirefox();
const POLICIES_PATH = MAC ? join(dirname(dirname(FIREFOX)), 'Resources', 'distribution', 'policies.json') : join(dirname(FIREFOX), 'distribution', 'policies.json');
const sudo = (...args) => spawnSync('sudo', ['-n', ...args], { stdio: 'inherit' }).status === 0;

function writePolicies() {
  if (process.env.LOCK !== '1') return () => {};
  const folder = dirname(POLICIES_PATH);
  const staged = join(tmpdir(), `tmp-policies-${process.pid}.json`);
  writeFileSync(staged, JSON.stringify({ policies: lockSettings(filterEntries()) }));
  const ok = sudo('mkdir', '-p', folder) && sudo('cp', staged, POLICIES_PATH);
  rmSync(staged, { force: true });
  console.log('lock policies written:', ok, POLICIES_PATH);
  return () => sudo('rm', '-rf', folder);
}

const PAGES = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.tiktok.com/@tiktok', 'https://www.youtube.com/shorts', 'https://www.youtube.com/'];
const VIDEOS = ['https://www.w3schools.com/html/mov_bbb.mp4', 'https://www.w3schools.com/html/movie.mp4', 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4'];
const IMAGES = ['https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg', 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=1200'];

/** A record like Brian's: 500 tries, 500 hidden pictures and videos (the videos noted under YouTube and TikTok pages), 60 copies kept. */
function seed() {
  const now = Date.now();
  const cat = `data:image/jpeg;base64,${readFileSync(join(FIXTURES, 'cat.jpg')).toString('base64')}`;
  const attempts = Array.from({ length: 500 }, (_, i) => ({ at: now - (500 - i) * 3_600_000, site: i % 3 ? 'exampleadultsite.com' : 'internetbadguys.com', ...(i % 7 === 0 ? { opened: true } : {}) }));
  const pictures = [];
  const index = [];
  const stored = {};
  for (let i = 0; i < 495; i += 1) {
    const at = now - (500 - i) * 420_000;
    if (i % 3 === 0) {
      const url = PAGES[i % PAGES.length];
      pictures.push({ at, site: new URL(url).host, url, reason: i % 2 ? 'nudity' : 'suggestive', scores: { porn: 0.5, hentai: 0, sexy: 0.3 }, kind: 'video' });
      continue;
    }
    const url = `https://i.ytimg.com/vi/id${i}/hqdefault.jpg`;
    pictures.push({ at, site: 'www.youtube.com', url, reason: 'suggestive', scores: { porn: 0.1, hentai: 0, sexy: 0.5 }, ...(i % 5 === 0 ? { looks: [{ at: at + 1000, why: 'checking' }], mark: { at: at + 2000, mistake: true } } : {}) });
    if (i >= 405) {
      const copy = cat + 'AAAA'.repeat(i % 7);
      index.push({ at, url, length: copy.length, hash: hashOf(copy) });
      stored[copyKey({ at, url })] = copy;
    }
  }
  for (const [n, url] of [...VIDEOS, ...IMAGES].entries()) {
    const at = now - (5 - n) * 60_000;
    pictures.push({ at, site: new URL(url).host, url, reason: 'nudity', scores: { porn: 0.9, hentai: 0, sexy: 0 }, ...(VIDEOS.includes(url) ? { kind: 'video' } : {}) });
  }
  return { attempts, pictures, pictureCopies: index, ...stored };
}

const removePolicies = writePolicies();
const stub = await startStubInternet();
const profile = mkdtempSync(join(tmpdir(), 'tmp-open-page-profile-'));
const crashNotes = () => {
  const dir = join(profile, 'minidumps');
  if (!existsSync(dir)) return 'no minidumps folder';
  return readdirSync(dir).map((name) => (name.endsWith('.extra') ? `${name}: ${readFileSync(join(dir, name), 'utf8').slice(0, 3000)}` : name));
};
const fx = await launchFirefox(stub, { profile, prefs: { 'network.proxy.type': 0 } });
console.log(`Firefox ${fx.version} headful: ${process.env.HEADFUL === '1'} lock: ${process.env.LOCK === '1'}`);
const tabsNow = async () => {
  const tabs = await fx.tabs();
  for (const tab of tabs) {
    await fx.fx.send('WebDriver:SwitchToWindow', { handle: tab.handle });
    tab.state = await fx.run("return [document.readyState, document.title.slice(0, 40), document.documentURI.slice(0, 60), document.querySelectorAll('img, video').length, document.querySelectorAll('[data-family-site-blocker=\"hidden\"]').length]").catch((e) => `ERROR ${e.message}`);
  }
  return tabs.map(({ url, state }) => [url.slice(0, 70), state]);
};
try {
  const settings = (await fx.tabs()).find(({ url }) => url.endsWith('/options.html'));
  const base = `moz-extension://${new URL(settings.url).host}`;
  await fx.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
  const data = seed();
  console.log('seeding', Object.keys(data).length, 'keys,', JSON.stringify(data).length, 'characters');
  const seeded = await fx.fx.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.storage.local.set(arguments[0]).then(() => done('ok'), (e) => done(String(e)));`,
    args: [data],
  });
  console.log('seeded:', seeded);
  const record = await fx.newTab();
  await fx.visit(`${base}/tries.html`);
  const inRow = (url, script) => fx.run(`const row = [...document.querySelectorAll('.day tr.picture')].find((r) => r.querySelector('.picture-url')?.textContent === ${JSON.stringify(url)}); if (!row) return null; ${script}`);
  const waitInRow = async (url, script, ms = 30000) => {
    const until = Date.now() + ms;
    let got = await inRow(url, script);
    while (!got && Date.now() < until) {
      await sleep(250);
      got = await inRow(url, script);
    }
    if (!got) throw new Error(`timed out on ${url}: ${script}`);
    return got;
  };
  await waitInRow(PAGES[0], 'return true', 60000);
  console.log('rows:', await fx.run("return [document.querySelectorAll('.day tr').length, document.querySelectorAll('.day tr.picture').length]"));
  const look = async (url) => {
    await fx.fx.send('WebDriver:SwitchToWindow', { handle: record });
    await inRow(url, "row.querySelector('button.look').click(); return true");
    const asked = await inRow(url, "return !!row.querySelector('.look-why')");
    if (asked) await inRow(url, "const f = row.querySelector('.look-why'); f.value = 'checking'; f.dispatchEvent(new Event('input')); row.querySelector('button.look-go').click(); return true");
    return waitInRow(url, "const p = row.querySelector('.picture-look p'); const a = row.querySelector('.picture-look a'); const v = row.querySelector('.picture-look video, .picture-look img'); return v ? { shows: v.tagName, src: v.getAttribute('src').slice(0, 30) } : p && !/Fetching/.test(p.textContent) ? { words: p.textContent, href: a ? a.href : null } : null");
  };
  for (const url of [...VIDEOS, ...IMAGES]) console.log('look at', url, '->', JSON.stringify(await look(url)));
  for (const url of PAGES) {
    const box = await look(url);
    console.log('look at', url, '->', JSON.stringify(box));
    if (!box.href) continue;
    await inRow(url, "row.querySelector('.picture-look a').click(); return true");
    await sleep(8000);
    console.log('tabs 8 s after the link:', JSON.stringify(await tabsNow()));
    console.log('crash notes:', crashNotes());
  }
  await fx.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
  const status = await fx.fx.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.runtime.sendMessage({ type: 'picture-status' }).then(done, (e) => done({ error: String(e) }));`,
    args: [],
  });
  console.log('picture status:', JSON.stringify(status));
} catch (error) {
  console.log('FAILED:', error.message);
  console.log('tabs:', JSON.stringify(await tabsNow().catch((e) => String(e))));
  console.log('crash notes:', crashNotes());
} finally {
  await fx.close().catch(() => {});
  await stub.close();
  removePolicies();
}
