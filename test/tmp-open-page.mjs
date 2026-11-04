// Temporary, for one branch: Every try -> Look at it -> Open the page in a Firefox on GitHub's Mac, with
// the real internet and the real classifier, on the pages Brian's record names (YouTube, TikTok),
// reporting any crashed tab and the crash notes Firefox leaves in the profile. A control opens the same
// page from the address bar.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubInternet } from './helpers/browser.mjs';
import { launchFirefox } from './helpers/firefox.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const SITES = process.argv.slice(2).length ? process.argv.slice(2) : ['https://www.youtube.com/', 'https://www.youtube.com/shorts', 'https://www.tiktok.com/explore'];
const stub = await startStubInternet();

for (const site of SITES) {
  const profile = mkdtempSync(join(tmpdir(), 'tmp-open-page-profile-'));
  const crashNotes = () => {
    const dir = join(profile, 'minidumps');
    if (!existsSync(dir)) return 'no minidumps folder';
    return readdirSync(dir).map((name) => (name.endsWith('.extra') ? `${name}: ${readFileSync(join(dir, name), 'utf8').slice(0, 3000)}` : name));
  };
  const fx = await launchFirefox(stub, { profile, prefs: { 'network.proxy.type': 0 } });
  console.log(`\n===== ${site} ===== Firefox ${fx.version} headful: ${process.env.HEADFUL === '1'}`);
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
    await fx.fx.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1]; browser.storage.local.set({ pictures: [{ at: Date.now() - 60000, site: new URL(arguments[0]).host, url: arguments[0], reason: 'nudity', scores: { porn: 0.9, hentai: 0, sexy: 0 }, kind: 'video' }] }).then(() => done('ok'), (e) => done(String(e)));`,
      args: [site],
    });
    const record = await fx.newTab();
    await fx.visit(`${base}/tries.html#pictures`);
    const inRow = (script) => fx.run(`const row = [...document.querySelectorAll('.day tr.picture')].find((r) => r.querySelector('.picture-url')?.textContent === ${JSON.stringify(site)}); if (!row) return null; ${script}`);
    const waitInRow = async (script, ms = 30000) => {
      const until = Date.now() + ms;
      let got = await inRow(script);
      while (!got && Date.now() < until) {
        await sleep(250);
        got = await inRow(script);
      }
      if (!got) throw new Error(`timed out: ${script}`);
      return got;
    };
    await waitInRow('return true');
    await inRow("row.querySelector('button.look').click(); return true");
    await waitInRow("return !!row.querySelector('.look-why')");
    await inRow("const f = row.querySelector('.look-why'); f.value = 'checking'; f.dispatchEvent(new Event('input')); row.querySelector('button.look-go').click(); return true");
    const box = await waitInRow("const p = row.querySelector('.picture-look p'); const a = row.querySelector('.picture-look a'); return p && !/Fetching/.test(p.textContent) ? { words: p.textContent, href: a ? a.href : null } : (row.querySelector('.picture-look video') ? { words: 'VIDEO' } : null)");
    console.log('box:', JSON.stringify(box));
    if (box.href) {
      await fx.fx.send('WebDriver:SwitchToWindow', { handle: record });
      await inRow("row.querySelector('.picture-look a').click(); return true");
      for (const wait of [5000, 10000]) {
        await sleep(wait);
        console.log(`tabs ${wait} ms after the link:`, JSON.stringify(await tabsNow()));
        console.log('crash notes:', crashNotes());
      }
    }
    // The control: the same page from the address bar, in a tab of its own.
    await fx.newTab();
    await fx.fx.send('WebDriver:Navigate', { url: site }).catch((e) => console.log('navigate:', e.message));
    await sleep(12000);
    console.log('tabs after the control:', JSON.stringify(await tabsNow()));
    console.log('crash notes:', crashNotes());
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
  }
}
await stub.close();
