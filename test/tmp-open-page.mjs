// Temporary, for one branch: Every try -> Look at it -> Open the page in a Firefox on GitHub's Mac, headful
// or headless, on a heavy page (videos the page made, videos by address, pictures), reporting any crashed
// tab and the crash notes Firefox leaves in the profile.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubInternet } from './helpers/browser.mjs';
import { launchFirefox } from './helpers/firefox.mjs';
import { extensionWithStandInClassifier, galleryPage, servePictures, serveVideos, videoPage } from './helpers/pictures.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stub = await startStubInternet();
servePictures(stub, ['cat', 'coffee', 'photo', 'nude', 'lingerie', 'drawn', 'nude2', 'nude3', 'lingerie2', 'photo2']);
serveVideos(stub);
stub.page('allowed.test/gallery', galleryPage(['photo', 'nude', 'lingerie', 'drawn']));
const made = (id) => `id="${id}" autoplay muted loop`;
stub.page(
  'allowed.test/heavy',
  videoPage(
    [made('made1'), made('made2'), made('made3'), 'id="red" src="/videos/red.webm" autoplay muted loop', 'id="blue" src="/videos/blue.webm" autoplay muted loop', 'id="turns" src="/videos/blue-then-red.webm" autoplay muted loop', 'id="foreign" src="http://videos.test/videos/red.webm" autoplay muted loop'],
    `<script>fetch('/videos/red.webm').then((r) => r.blob()).then((b) => { for (const id of ['made1', 'made2', 'made3']) document.getElementById(id).src = URL.createObjectURL(b); });</script>
     ${['nude', 'nude2', 'nude3', 'lingerie', 'lingerie2', 'photo', 'photo2', 'cat', 'coffee', 'drawn'].map((name) => `<img id="${name}" src="http://pics.test/pics/${name}.jpg" width="300">`).join('\n')}`,
  ),
);
const profile = mkdtempSync(join(tmpdir(), 'tmp-open-page-profile-'));
const standIn = extensionWithStandInClassifier();
const fx = await launchFirefox(stub, { extensionDir: standIn.dir, profile });
console.log('Firefox', fx.version, 'headful:', process.env.HEADFUL === '1');
const tabsNow = async () => {
  const tabs = await fx.tabs();
  for (const tab of tabs) {
    await fx.fx.send('WebDriver:SwitchToWindow', { handle: tab.handle });
    tab.state = await fx.run("return [document.readyState, document.title, document.documentURI.slice(0, 60)]").catch((e) => `ERROR ${e.message}`);
  }
  return tabs;
};
const crashNotes = () => {
  const dir = join(profile, 'minidumps');
  if (!existsSync(dir)) return 'no minidumps folder';
  return readdirSync(dir).map((name) => (name.endsWith('.extra') ? `${name}: ${readFileSync(join(dir, name), 'utf8').slice(0, 2000)}` : name));
};
try {
  const settings = (await fx.tabs()).find(({ url }) => url.endsWith('/options.html'));
  const base = `moz-extension://${new URL(settings.url).host}`;
  await fx.newTab();
  await fx.visit('http://allowed.test/gallery');
  await sleep(4000);
  await fx.newTab();
  await fx.visit('http://allowed.test/heavy');
  await sleep(8000);
  console.log('marks on heavy:', await fx.run("return [...document.querySelectorAll('img, video')].map((el) => [el.id, el.getAttribute('data-family-site-blocker')])"));
  await fx.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
  const stored = await fx.fx.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.storage.local.get(null).then((got) => done({ entries: (got.pictures ?? []).map((e) => [e.url, e.kind ?? 'picture']), copies: Object.keys(got).filter((key) => key.startsWith('pictureCopy:')).length }), (e) => done(String(e)));`,
    args: [],
  });
  console.log('record:', JSON.stringify(stored));
  const record = await fx.newTab();
  await fx.visit(`${base}/tries.html#pictures`);
  const which = 'http://allowed.test/heavy';
  const inRow = (script) => fx.run(`const row = [...document.querySelectorAll('.day tr.picture')].find((r) => r.querySelector('.picture-url')?.textContent === ${JSON.stringify(which)}); if (!row) return null; ${script}`);
  const waitInRow = async (script, ms = 15000) => {
    const until = Date.now() + ms;
    let got = await inRow(script);
    while (!got && Date.now() < until) {
      await sleep(200);
      got = await inRow(script);
    }
    if (!got) throw new Error(`timed out: ${script}`);
    return got;
  };
  await waitInRow('return true');
  await inRow("row.querySelector('button.look').click(); return true");
  await waitInRow("return !!row.querySelector('.look-why')");
  await inRow("const f = row.querySelector('.look-why'); f.value = 'checking'; f.dispatchEvent(new Event('input')); row.querySelector('button.look-go').click(); return true");
  const link = await waitInRow("const a = row.querySelector('.picture-look a'); return a ? { href: a.href, words: row.querySelector('.picture-look p').textContent } : null");
  console.log('link:', JSON.stringify(link));
  console.log('tabs before:', JSON.stringify(await tabsNow()));
  await fx.fx.send('WebDriver:SwitchToWindow', { handle: record });
  await inRow("row.querySelector('.picture-look a').click(); return true");
  for (const wait of [2000, 4000, 6000]) {
    await sleep(wait);
    console.log(`tabs after ${wait} more ms:`, JSON.stringify(await tabsNow()));
  }
  console.log('crash notes:', crashNotes());
} catch (error) {
  console.log('FAILED:', error.message);
  console.log('tabs:', JSON.stringify(await tabsNow().catch((e) => String(e))));
  console.log('crash notes:', crashNotes());
  process.exitCode = 1;
} finally {
  await fx.close().catch(() => {});
  await stub.close();
  standIn.remove();
}
