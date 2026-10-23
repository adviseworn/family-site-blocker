// Real-browser tests. They load the extension into Chromium, exactly like "Load unpacked" does, and
// drive it the way a person would. Run with:  npm run test:browser
// (needs `npm install` once, and `npx playwright install chromium` if Playwright has no browser yet)
//
// No real website is contacted: every hostname is mapped to a small local server (see helpers/browser.mjs).
// A request that never reaches that server was stopped by the browser.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR, findPage, launchBrowser, startStubInternet, visit } from './helpers/browser.mjs';
import { MARKS, STAND_IN_SCORES, extensionWithStandInClassifier, galleryPage, servePictures } from './helpers/pictures.mjs';

const VERSION = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
const BUILT_IN = JSON.parse(readFileSync(join(EXTENSION_DIR, 'rules', 'domains.json'), 'utf8')).length;
const SITE = 'exampleadultsite.com';
const BLOCKED_URL = `http://${SITE}/`;
const BLOCK_PAGE = /\/blocked\.html$/;

let stub;
let browser;
let openedOnInstall = false;

const test = (name, fn) => it(name, { timeout: 30_000 }, fn);

/** Opens an address and checks the person lands on the "Site blocked" page without anything coming from the site. */
async function assertBlocked(url, domain = SITE) {
  stub.clear();
  const result = await visit(browser.context, url);
  const where = `${url} ended at ${result.finalUrl}${result.error ? ` (${result.error})` : ''}`;
  assert.equal(result.outcome, 'blocked page', where);
  assert.equal(result.heading, 'This site is blocked', where);
  assert.equal(stub.reached(domain), false, `${url}: a request reached the site`);
}

/** Opens a page on an allowed site, lets "act" follow a link/redirect to the blocked site, and checks the result. */
async function assertBlockedFromAllowedPage(path, act = async (page) => page) {
  stub.clear();
  const page = await browser.context.newPage();
  try {
    await page.goto(`http://allowed.test${path}`);
    const landing = await act(page);
    await landing.waitForURL(BLOCK_PAGE, { timeout: 10_000 });
    assert.equal(stub.reached(SITE), false, `${path}: a request reached the site`);
    if (landing !== page) await landing.close();
  } finally {
    await page.close();
  }
}

async function openSettings() {
  const page = await browser.context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForFunction(() => document.querySelector('#check-note')?.textContent.length > 0);
  return page;
}

async function saveList(page, text) {
  await page.evaluate((value) => {
    document.getElementById('custom').value = value;
    document.getElementById('status').textContent = '';
  }, text);
  await page.click('#save');
  await page.waitForFunction(() => /Saved|Couldn/.test(document.getElementById('status').textContent));
  return page.locator('#status').innerText();
}

// Pages on an allowed site that try to reach the blocked one in different ways.
function embedPage(host) {
  return `<!doctype html><meta charset="utf-8">
    <img id="img" src="http://${host}/pixel.gif">
    <script src="http://${host}/x.js"></script>
    <link rel="stylesheet" href="http://${host}/s.css">
    <iframe src="http://${host}/frame"></iframe>`;
}

async function probeEmbeds(page, host) {
  return page.evaluate(async (target) => {
    const result = {};
    result.image = document.getElementById('img').naturalWidth > 0 ? 'loaded' : 'blocked';
    result.script = window.__loadedFromBlockedSite ? 'loaded' : 'blocked';
    result.fetch = await fetch(`http://${target}/api`, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked');
    result.xhr = await new Promise((done) => {
      const request = new XMLHttpRequest();
      request.open('GET', `http://${target}/api`);
      request.onload = () => done('loaded');
      request.onerror = () => done('blocked');
      request.send();
    });
    await new Promise((done) => {
      const socket = new WebSocket(`ws://${target}/socket`);
      socket.onerror = () => {};
      socket.onclose = done;
    });
    return result;
  }, host);
}

// The settings page offers waits of a minute and up. The tests add a few-second one alongside them.
async function lockAway(page, secret, seconds) {
  await page.evaluate((wait) => {
    const option = new Option(`${wait} seconds`, String(wait), true, true);
    document.getElementById('lockbox-delay').append(option);
  }, seconds);
  await page.fill('#lockbox-secret', secret);
  await page.click('#lockbox-lock');
  await page.locator('#lockbox-locked').waitFor({ state: 'visible', timeout: 15_000 });
}

const storedLockbox = (page) => page.evaluate(() => chrome.storage.local.get(null));

/** Waits until the settings page has saved some unlocking progress. */
async function progressSaved(page) {
  const until = Date.now() + 10_000;
  while (!((await storedLockbox(page)).lockboxProgress?.done > 0)) {
    if (Date.now() > until) throw new Error('no unlocking progress was saved');
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('real browser', () => {
  before(async () => {
    stub = await startStubInternet();
    browser = await launchBrowser(stub);

    // Installing the extension opens its settings page by itself. Note that, then close it.
    const settings = await findPage(browser.context, (url) => url.endsWith('/options.html'));
    openedOnInstall = settings !== null;
    await settings?.close();

    stub.page('allowed.test/links', `<a id="go" href="${BLOCKED_URL}">go</a>`);
    stub.page('allowed.test/popup', `<button id="go" onclick="window.open('${BLOCKED_URL}')">open</button>`);
    stub.page('allowed.test/blank-popup', `<button id="go" onclick="const w = window.open('about:blank'); w.location = '${BLOCKED_URL}'">open</button>`);
    stub.page('allowed.test/redirect', '', { status: 302, headers: { location: BLOCKED_URL } });
    stub.page('allowed.test/meta-refresh', `<meta http-equiv="refresh" content="0;url=${BLOCKED_URL}">`);
    stub.page('allowed.test/script-redirect', `<script>location.href = '${BLOCKED_URL}'</script>`);
    stub.page('allowed.test/form-post', `<form id="f" method="post" action="${BLOCKED_URL}submit"></form><script>f.submit()</script>`);
    stub.page('allowed.test/sandboxed-frame', `<iframe sandbox="allow-scripts allow-top-navigation" srcdoc='<a id="go" target="_top" href="${BLOCKED_URL}">go</a>'></iframe>`);
    stub.page('allowed.test/embeds-blocked', embedPage(SITE));
    stub.page('allowed.test/embeds-allowed', embedPage('cdn.allowed.test'));

    // Opening the settings page proves the extension has loaded before any test depends on it.
    const warmUp = await visit(browser.context, `chrome-extension://${browser.extensionId}/options.html`);
    assert.equal(warmUp.error, null, 'the extension did not load');
  });

  after(async () => {
    await browser?.close();
    await stub?.close();
  });

  describe('test case: navigate to exampleadultsite.com', () => {
    test('Actual, with no blocker installed: the website is allowed (so this test can see a failure)', async () => {
      const plain = await launchBrowser(stub, { extension: false });
      try {
        stub.clear();
        const result = await visit(plain.context, BLOCKED_URL);
        assert.equal(result.outcome, 'site loaded');
        assert.equal(stub.reached(SITE), true);
      } finally {
        await plain.close();
      }
    });

    test('Expected, with the blocker installed: the website is blocked (http)', () => assertBlocked(BLOCKED_URL));
    test('Expected, with the blocker installed: the website is blocked (https)', () => assertBlocked(`https://${SITE}/`));
  });

  describe('the same site, written in other ways, is blocked', () => {
    const variants = [
      ['www subdomain', 'http://www.exampleadultsite.com/'],
      ['deep subdomain with path, query and fragment', 'http://a.b.exampleadultsite.com/page?x=1#y'],
      ['upper case', 'http://EXAMPLEADULTSITE.COM/'],
      ['explicit port', 'http://exampleadultsite.com:8080/'],
      ['trailing dot', 'http://exampleadultsite.com./'],
      ['trailing dot on a subdomain', 'http://www.exampleadultsite.com./'],
      ['user name and password in the address', 'http://user:pw@exampleadultsite.com/'],
      ['percent-encoded dot', 'http://exampleadultsite.com%2e/'],
      ['full-width letters', 'http://ｅｘａｍｐｌｅａｄｕｌｔｓｉｔｅ.com/'],
      ['ideographic full stop', 'http://exampleadultsite。com/'],
      ['https with a long path', 'https://exampleadultsite.com/some/long/path.html?q=1'],
    ];
    for (const [name, url] of variants) test(name, () => assertBlocked(url));
  });

  describe('other sites are left alone', () => {
    const others = [
      'http://allowed.test/',
      'http://notexampleadultsite.com/',
      'http://exampleadultsite.com.allowed.test/',
      'http://exampleadultsite.co/',
      'http://allowed.test/?next=exampleadultsite.com',
      'http://allowed.test/exampleadultsite.com',
    ];
    for (const url of others) {
      test(url, async () => {
        const result = await visit(browser.context, url);
        assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.finalUrl}`);
      });
    }
  });

  describe('the site is blocked when other pages lead to it', () => {
    test('clicking a link', () => assertBlockedFromAllowedPage('/links', async (page) => (await page.click('#go'), page)));

    test('window.open', () =>
      assertBlockedFromAllowedPage('/popup', async (page) => {
        const [popup] = await Promise.all([browser.context.waitForEvent('page'), page.click('#go')]);
        return popup;
      }));

    test('a popup opened blank and then sent to the site', () =>
      assertBlockedFromAllowedPage('/blank-popup', async (page) => {
        const [popup] = await Promise.all([browser.context.waitForEvent('page'), page.click('#go')]);
        return popup;
      }));

    test('a link inside a sandboxed frame that targets the whole tab', () =>
      assertBlockedFromAllowedPage('/sandboxed-frame', async (page) => {
        await page.frameLocator('iframe').locator('#go').click();
        return page;
      }));

    test('a server redirect', () => assertBlockedFromAllowedPage('/redirect'));
    test('a meta refresh', () => assertBlockedFromAllowedPage('/meta-refresh'));
    test('a script redirect', () => assertBlockedFromAllowedPage('/script-redirect'));
    test('a form post', () => assertBlockedFromAllowedPage('/form-post'));
  });

  describe('nothing from the site is loaded into other pages', () => {
    test('control: the same kinds of requests to an allowed site do load', async () => {
      stub.clear();
      const page = await browser.context.newPage();
      try {
        await page.goto('http://allowed.test/embeds-allowed', { waitUntil: 'load' });
        const results = await probeEmbeds(page, 'cdn.allowed.test');
        assert.deepEqual(results, { image: 'loaded', script: 'loaded', fetch: 'loaded', xhr: 'loaded' });
        assert.equal(stub.reached('cdn.allowed.test'), true);
      } finally {
        await page.close();
      }
    });

    test('images, scripts, styles, frames, fetch, XHR and WebSockets are blocked', async () => {
      stub.clear();
      const page = await browser.context.newPage();
      try {
        await page.goto('http://allowed.test/embeds-blocked', { waitUntil: 'load' });
        const results = await probeEmbeds(page, SITE);
        assert.deepEqual(results, { image: 'blocked', script: 'blocked', fetch: 'blocked', xhr: 'blocked' });
        assert.equal(stub.reached(SITE), false, 'a request reached the site');
      } finally {
        await page.close();
      }
    });
  });

  describe('block page', () => {
    test('"Go back" returns to the page the person came from', async () => {
      const page = await browser.context.newPage();
      try {
        await page.goto('http://allowed.test/links');
        await page.click('#go');
        await page.waitForURL(BLOCK_PAGE);
        await page.click('#back');
        await page.waitForURL('http://allowed.test/links');
      } finally {
        await page.close();
      }
    });
  });

  describe('safe search', () => {
    // Each search goes out once, with the engine's strict setting added; the engine's other pages are left alone.
    const searches = [
      ['http://www.google.com/search?q=test', 'safe', 'active'],
      ['http://www.google.co.uk/search?q=test&safe=off', 'safe', 'active'],
      ['http://www.bing.com/images/search?q=test', 'adlt', 'strict'],
      ['http://duckduckgo.com/?q=test&ia=web', 'kp', '1'],
      ['http://html.duckduckgo.com/html/?q=test', 'kp', '1'],
      ['http://search.yahoo.com/search?p=test', 'vm', 'r'],
      ['http://images.search.yahoo.com/search/images?p=test', 'vm', 'r'],
      ['http://search.brave.com/search?q=test', 'safesearch', 'strict'],
    ];
    for (const [url, key, value] of searches) {
      test(`${url} goes out with ${key}=${value}`, async () => {
        const page = await browser.context.newPage();
        try {
          stub.clear();
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          const final = new URL(page.url());
          assert.equal(final.searchParams.get(key), value, `ended at ${page.url()}`);
          assert.equal(final.searchParams.get(new URL(url).searchParams.has('q') ? 'q' : 'p'), 'test', 'the search itself is kept');
          // The page itself was asked for once, with the setting (the browser may ask for other things, such
          // as the site's icon, on its own).
          const sent = stub.requests.filter((r) => r.path === new URL(url).pathname);
          assert.equal(sent.length, 1, `one request for the page, not a loop: ${JSON.stringify(stub.requests.map((r) => r.host + r.path + r.search))}`);
          assert.equal(new URL(`http://${sent[0].host}${sent[0].path}${sent[0].search}`).searchParams.get(key), value, 'the engine sees the setting');
        } finally {
          await page.close();
        }
      });
    }

    test('a search already made strict, and pages that are not searches, are not redirected', async () => {
      const page = await browser.context.newPage();
      try {
        for (const url of ['http://www.google.com/search?q=test&safe=active', 'http://www.google.com/', 'http://www.google.com/maps?q=test', 'http://duckduckgo.com/', 'http://example.com/search?q=test']) {
          stub.clear();
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          assert.equal(page.url(), url);
          const sent = stub.requests.filter((r) => r.path === new URL(url).pathname);
          assert.deepEqual(sent.map((r) => r.search), [new URL(url).search], `${url}: asked for once, unchanged`);
        }
      } finally {
        await page.close();
      }
    });

    test('every request to YouTube carries the header that keeps it in Restricted Mode; other sites get no such header', async () => {
      const page = await browser.context.newPage();
      try {
        stub.clear();
        stub.page('www.youtube.com/results', '<img src="http://i.ytimg.com/x.gif"><script>fetch("http://www.youtube.com/youtubei/v1/search").catch(() => {})</script>');
        await page.goto('http://www.youtube.com/results?search_query=test', { waitUntil: 'load' });
        await new Promise((done) => setTimeout(done, 500));
        const toYouTube = stub.requests.filter((r) => r.host === 'www.youtube.com');
        assert.ok(toYouTube.length >= 2, JSON.stringify(stub.requests.map((r) => r.host + r.path)));
        assert.ok(toYouTube.every((r) => r.headers['youtube-restrict'] === 'Strict'), JSON.stringify(toYouTube.map((r) => [r.path, r.headers['youtube-restrict']])));
        stub.clear();
        await page.goto('http://allowed.test/', { waitUntil: 'domcontentloaded' });
        assert.equal(stub.requests.find((r) => r.host === 'allowed.test').headers['youtube-restrict'], undefined);
      } finally {
        await page.close();
      }
    });

    test('the settings page names the engines and offers a Google search to try', async () => {
      const page = await openSettings();
      try {
        assert.equal(await page.locator('#engines').innerText(), 'Google, Bing, DuckDuckGo, Yahoo and Brave Search');
        assert.equal(await page.locator('#safe-search a.button').getAttribute('href'), 'https://www.google.com/search?q=test');
        // It points at what can be seen, the address, and promises nothing from Google's own page (#46).
        const note = await page.locator('#safe-search-note').innerText();
        assert.match(note, /^The address should gain safe=active, /);
        assert.doesNotMatch(note, /should say SafeSearch is on/);
        // Google's own words above filtered Google Images results, as seen on the test account (#46).
        assert.match(note, /“SafeSearch is locked to filter by safety settings applied to this browser\.”/);
      } finally {
        await page.close();
      }
    });
  });

  describe('settings page', () => {
    test('opens by itself right after the extension is installed', () => {
      assert.equal(openedOnInstall, true);
    });

    test('shows the installed version next to the title', async () => {
      const page = await openSettings();
      try {
        assert.equal(await page.locator('#version').innerText(), `Version ${VERSION}`);
        assert.equal(await page.locator('h1').innerText(), `Family Site Blocker Version ${VERSION}`);
      } finally {
        await page.close();
      }
    });

    test('if the browser has not given the extension access to websites, as Firefox can, it says so and asks for it', async () => {
      const page = await browser.context.newPage();
      // Chromium always grants it, so stand in for a browser that hasn't yet.
      await page.addInitScript(() => {
        let granted = false;
        chrome.permissions.contains = async () => granted;
        chrome.permissions.request = async () => {
          granted = true;
          return true;
        };
      });
      try {
        await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
        await page.locator('#access').waitFor({ state: 'visible' });
        assert.match(await page.locator('#access').innerText(), /hasn’t given Family Site Blocker access to websites yet/);
        await page.click('#access-allow');
        await page.locator('#access').waitFor({ state: 'hidden' });
      } finally {
        await page.close();
      }
    });

    test('the website access warning stays hidden when access has been given', async () => {
      const page = await openSettings();
      try {
        assert.equal(await page.locator('#access').isVisible(), false);
      } finally {
        await page.close();
      }
    });

    test("if the browser won't run the rule check, as in Firefox, it says so plainly and points to the test site", async () => {
      const page = await browser.context.newPage();
      await page.addInitScript(() => {
        chrome.declarativeNetRequest.testMatchOutcome = undefined;
      });
      try {
        await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
        await page.waitForFunction(() => document.querySelector('#check-note')?.textContent.length > 0);
        assert.equal(
          await page.locator('#check-note').innerText(),
          "This browser doesn't let extensions run this check automatically, so use the button above.",
        );
        assert.equal(await page.locator('#check-intro').isVisible(), false, 'no sentence promising a check that cannot run');
        assert.equal(await page.locator('#results li').count(), 0);
        assert.match(await page.locator('#summary').innerText(), new RegExp(`^${BUILT_IN} sites on the built-in list`));
      } finally {
        await page.close();
      }
    });

    test("the browser's own check agrees that every listed address is blocked or allowed as expected", async () => {
      const page = await openSettings();
      try {
        assert.match(await page.locator('#check-note').innerText(), /^All \d+ checks passed\.$/);
        assert.equal(await page.locator('#check-intro').isVisible(), true, 'the sentence introducing the results is shown');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('a site added to "Your blocked sites" is blocked straight away, with its subdomains, and unblocked again when removed', async () => {
      const page = await openSettings();
      try {
        const saved = await saveList(page, 'custom-blocked.test\nhttps://www.Another-Blocked.test/some/path\nnot a domain');
        assert.match(saved, /^Saved\. 2 sites on your list\. Skipped because they aren't domain names: not a domain/);

        await assertBlocked('http://custom-blocked.test/', 'custom-blocked.test');
        await assertBlocked('http://another-blocked.test/', 'another-blocked.test');
        await assertBlocked('http://deeper.sub.another-blocked.test/page', 'another-blocked.test');
        assert.equal((await visit(browser.context, 'http://allowed.test/')).outcome, 'site loaded');

        assert.match(await saveList(page, ''), /^Saved\. 0 sites on your list\./);
        assert.equal((await visit(browser.context, 'http://custom-blocked.test/')).outcome, 'site loaded');
        assert.deepEqual(page.errors, []);
      } finally {
        await saveList(page, '').catch(() => {});
        await page.close();
      }
    });

    test('emptying "Your blocked sites" does not unblock the built-in list', async () => {
      const page = await openSettings();
      try {
        await saveList(page, '');
        await assertBlocked(BLOCKED_URL);
      } finally {
        await page.close();
      }
    });

    test('it says that private windows are not blocked until the person allows the extension there', async () => {
      const page = await openSettings();
      try {
        await page.waitForFunction(() => document.getElementById('private-status').textContent !== 'Checking…');
        assert.match(await page.locator('#private-status').innerText(), /Private \(Incognito\) windows are not blocked yet/);
        assert.equal(await page.locator('#private-open').isVisible(), true);

        // The button takes the person to this extension's page in the browser's extensions list.
        const [details] = await Promise.all([browser.context.waitForEvent('page'), page.click('#private-open')]);
        assert.equal(details.url(), `chrome://extensions/?id=${browser.extensionId}`);
        await details.close();
      } finally {
        await page.close();
      }
    });
  });

  describe('blocked attempts', () => {
    const stored = (page) => page.evaluate(() => chrome.storage.local.get('attempts').then((got) => got.attempts ?? []));
    const shown = (page) =>
      page.evaluate(() => [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));

    /** Waits until the record holds `count` notes; the background script writes them a moment after a visit. */
    async function recorded(page, count) {
      const until = Date.now() + 10_000;
      let list = await stored(page);
      while (list.length !== count && Date.now() < until) {
        await new Promise((done) => setTimeout(done, 100));
        list = await stored(page);
      }
      assert.equal(list.length, count, `recorded: ${JSON.stringify(list)}`);
      return list;
    }

    async function freshRecord() {
      const page = await openSettings();
      await page.evaluate(() => chrome.storage.local.remove('attempts'));
      await page.reload();
      await page.waitForFunction(() => document.getElementById('attempts-summary').textContent === 'No attempts so far.');
      return page;
    }

    const pause = (ms) => new Promise((done) => setTimeout(done, ms));

    test('each try at a listed site is noted with the time and the site, however the address is written', async () => {
      const page = await freshRecord();
      try {
        const before = Date.now();
        await assertBlocked(BLOCKED_URL);
        await assertBlocked('http://www.exampleadultsite.com/some/page?x=1'); // straight after: the same try
        let list = await recorded(page, 1);
        assert.equal(list[0].site, SITE);
        assert.ok(list[0].at >= before - 1000 && list[0].at <= Date.now() + 1000, `at: ${list[0].at}`);
        assert.equal(list[0].opened, undefined);

        await pause(2100); // more than the two seconds that make two notes one try
        await assertBlocked('https://A.B.EXAMPLEADULTSITE.COM./');
        list = await recorded(page, 2);
        assert.equal(list[1].site, SITE, 'the listed domain, not the subdomain');

        await page.waitForFunction(() => document.querySelectorAll('#attempts-table tbody tr').length === 2);
        assert.match(await page.locator('#attempts-summary').innerText(), /^2 attempts, the latest at .+\.$/);
        const rows = await shown(page);
        assert.deepEqual(rows.map((row) => row.slice(1)), [[SITE, 'Blocked'], [SITE, 'Blocked']], 'newest first');
        assert.match(rows[0][0], /\d/, 'a date and time');
        assert.equal(await page.locator('#attempts-more').isVisible(), false);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('other sites, and pages that merely embed or lead to a listed site, are not noted', async () => {
      const page = await freshRecord();
      try {
        for (const url of ['http://allowed.test/', 'http://notexampleadultsite.com/', 'http://exampleadultsite.com.allowed.test/', 'http://allowed.test/?next=exampleadultsite.com']) {
          assert.equal((await visit(browser.context, url)).outcome, 'site loaded', url);
        }
        const embeds = await browser.context.newPage();
        await embeds.goto('http://allowed.test/embeds-blocked', { waitUntil: 'load' });
        await embeds.close();
        await pause(500);
        assert.deepEqual(await stored(page), [], 'nothing noted: no page of a listed site was opened in a tab');

        // Following a link to the site is a try, noted once.
        await assertBlockedFromAllowedPage('/links', async (allowed) => (await allowed.click('#go'), allowed));
        const list = await recorded(page, 1);
        assert.equal(list[0].site, SITE);
      } finally {
        await page.close();
      }
    });

    test('a site from "Your blocked sites" is noted under its listed name, and no longer once it is removed', async () => {
      const page = await freshRecord();
      try {
        await saveList(page, 'custom-blocked.test');
        await assertBlocked('http://deeper.sub.custom-blocked.test/page', 'custom-blocked.test');
        const list = await recorded(page, 1);
        assert.equal(list[0].site, 'custom-blocked.test');

        await saveList(page, '');
        assert.equal((await visit(browser.context, 'http://custom-blocked.test/')).outcome, 'site loaded');
        await pause(500);
        assert.equal((await stored(page)).length, 1, 'a site that is no longer listed is not noted');
        assert.deepEqual(page.errors, []);
      } finally {
        await saveList(page, '').catch(() => {});
        await page.close();
      }
    });

    test('the settings page shows a new note while it is open', async () => {
      const page = await freshRecord();
      try {
        await assertBlocked(BLOCKED_URL);
        await page.waitForFunction(() => document.querySelectorAll('#attempts-table tbody tr').length === 1);
        assert.match(await page.locator('#attempts-summary').innerText(), /^1 attempt, the latest at /);
      } finally {
        await page.close();
      }
    });

    test('a listed site that gets through is marked as opened, not blocked', async () => {
      const page = await freshRecord();
      // Stand in for a browser where the blocking is off: switch the built-in rules off for a moment.
      const builtInRules = (enabled) =>
        page.evaluate(async (on) => {
          const ids = chrome.runtime.getManifest().declarative_net_request.rule_resources.map(({ id }) => id);
          await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ids } : { disableRulesetIds: ids });
        }, enabled);
      try {
        await builtInRules(false);
        assert.equal((await visit(browser.context, BLOCKED_URL)).outcome, 'site loaded');
        let list = await recorded(page, 1);
        const until = Date.now() + 10_000;
        while (!list[0].opened && Date.now() < until) {
          await pause(100);
          list = await stored(page);
        }
        assert.deepEqual(list.map(({ site, opened }) => ({ site, opened })), [{ site: SITE, opened: true }]);
        await page.waitForFunction(() => /opened/.test(document.getElementById('attempts-summary').textContent));
        assert.match(await page.locator('#attempts-summary').innerText(), /^1 attempt, the latest at .+\. 1 page opened instead of being blocked\.$/);
        assert.deepEqual((await shown(page)).map((row) => row.slice(1)), [[SITE, 'Opened, not blocked']]);

        await builtInRules(true);
        await pause(2100);
        await assertBlocked(BLOCKED_URL);
        list = await recorded(page, 2);
        assert.equal(list[1].opened, undefined, 'blocked again');
        assert.deepEqual(page.errors, []);
      } finally {
        await builtInRules(true).catch(() => {});
        await page.close();
      }
    });

    test("visits found in this browser's history are added once, marked as such, with their own time, then taken out of the history with any bookmarks", async () => {
      const page = await freshRecord();
      // Pages of a site (or its subdomains) in the browser's history and bookmarks; look-alikes such as
      // exampleadultsite.co, which earlier tests opened, are not its pages and stay.
      const ofSite = (site) => (urls) => urls.filter((url) => new URL(url).hostname === site || new URL(url).hostname.endsWith(`.${site}`));
      const inHistory = (site) =>
        page.evaluate((t) => chrome.history.search({ text: t, startTime: 0, maxResults: 1000 }).then((items) => items.map((item) => item.url)), site).then(ofSite(site));
      const bookmarked = (site) => page.evaluate((t) => chrome.bookmarks.search(t).then((items) => items.map((item) => item.url)), site).then(ofSite(site));
      try {
        // A visit the extension never saw and a bookmark: put straight into the browser (Chrome dates the visit now).
        await page.evaluate(() => chrome.history.addUrl({ url: 'http://exampleadultsite.com/from-before' }));
        await page.evaluate(() => chrome.history.addUrl({ url: 'http://allowed.test/not-listed' }));
        await page.evaluate(() => chrome.bookmarks.create({ title: 'saved', url: 'https://www.exampleadultsite.com/saved' }));
        await page.evaluate(() => chrome.bookmarks.create({ title: 'kept', url: 'http://allowed.test/kept' }));
        await page.click('#history-scan-now');
        await page.waitForFunction(() => /^Looked through this browser's history on .+: found \d+ visits? to listed sites/.test(document.getElementById('history-scan').textContent));
        const list = await stored(page);
        const fromHistory = list.filter((entry) => entry.from === 'history');
        assert.ok(fromHistory.length >= 1, JSON.stringify(list));
        assert.ok(fromHistory.every((entry) => entry.site === SITE || entry.site === 'custom-blocked.test'), 'only listed sites');
        assert.equal(list.some((entry) => entry.site === 'allowed.test'), false);
        assert.ok(fromHistory.some((entry) => Date.now() - entry.at < 60_000), 'the visit just added');
        const rows = await shown(page);
        assert.ok(rows.some((row) => row[1] === SITE && row[2] === 'Visited (browser history)'), JSON.stringify(rows.slice(0, 3)));
        assert.match(await page.locator('#attempts-summary').innerText(), / \d+ from this browser's history\.$/);

        // Once in the record, listed pages are taken out of the browser's history, and bookmarks to listed
        // sites removed, so the address bar has nothing to suggest; everything else is left alone.
        const line = await page.locator('#history-scan').innerText();
        assert.match(line, / Removed \d+ pages? from this browser's history and 1 bookmark\.$/, line);
        assert.deepEqual(await inHistory(SITE), []);
        assert.deepEqual(await bookmarked(SITE), []);
        assert.ok((await inHistory('allowed.test')).includes('http://allowed.test/not-listed'));
        assert.deepEqual(await bookmarked('allowed.test'), ['http://allowed.test/kept']);

        // Looking again finds nothing left, and adds nothing.
        const before = (await stored(page)).length;
        await page.click('#history-scan-now');
        await page.waitForFunction(() => /found no visits to listed sites\.$/.test(document.getElementById('history-scan').textContent));
        assert.equal((await stored(page)).length, before);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.evaluate(() => chrome.bookmarks.search('allowed.test').then((items) => Promise.all(items.map((item) => chrome.bookmarks.remove(item.id))))).catch(() => {});
        await page.evaluate(() => chrome.storage.local.remove(['attempts', 'historyScan'])).catch(() => {});
        await page.close();
      }
    });

    test('the latest 10 are shown, with a link to the whole record on a page of its own', async () => {
      const page = await freshRecord();
      let record = null;
      try {
        assert.equal(await page.locator('#attempts-all').isVisible(), false, 'no link while the record is empty');
        await page.evaluate(() => {
          const now = Date.now();
          const attempts = Array.from({ length: 60 }, (_, i) => ({ at: now - (60 - i) * 60_000, site: `site${i % 7}.test` }));
          attempts[0].from = 'history';
          attempts[59].opened = true;
          return chrome.storage.local.set({ attempts });
        });
        await page.waitForFunction(() => document.querySelectorAll('#attempts-table tbody tr').length === 10);
        assert.equal((await shown(page))[0][1], 'site3.test', 'newest first');
        assert.equal(await page.locator('#attempts-table caption').innerText(), 'The latest 10');
        await page.locator('#attempts-all').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#attempts-all').innerText(), 'See the whole record (60)');

        // The link opens the record page in a tab of its own.
        [record] = await Promise.all([browser.context.waitForEvent('page'), page.click('#attempts-all')]);
        record.errors = [];
        record.on('pageerror', (error) => record.errors.push(error.message));
        await record.waitForLoadState('domcontentloaded');
        assert.equal(record.url(), `chrome-extension://${browser.extensionId}/attempts.html`);
        await record.waitForFunction(() => document.querySelectorAll('#sites-table tbody tr').length === 7);
        assert.match(await record.locator('#version').innerText(), /^Version \d+\.\d+\.\d+$/);
        assert.match(
          await record.locator('#summary').innerText(),
          /^60 attempts at 7 sites, the latest at .+\. 1 page opened instead of being blocked\. 1 from this browser's history\.$/,
        );

        // By site: most tries first, then the site tried most recently; how many got through is noted.
        const sites = () => record.evaluate(() => [...document.querySelectorAll('#sites-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.innerText)));
        const table = await sites();
        assert.deepEqual(
          table.map(([site, tries]) => [site, tries]),
          [['site3.test', '9\n1 opened'], ['site2.test', '9'], ['site1.test', '9'], ['site0.test', '9'], ['site6.test', '8'], ['site5.test', '8'], ['site4.test', '8']],
        );
        assert.ok(table.every((row) => row.length === 4 && row[2] && row[3]), 'first and latest times');
        assert.equal(await record.locator('.day').count(), 0, 'the tries themselves are on a page of their own (#52)');

        // Every try has a page of its own, by day, newest first, reached from the record page.
        assert.equal(await record.locator('#every-try').innerText(), 'See every try (60)');
        const tries = await browser.context.newPage();
        tries.errors = [];
        tries.on('pageerror', (error) => tries.errors.push(error.message));
        await tries.goto(`chrome-extension://${browser.extensionId}/tries.html`);
        const rows = () => tries.evaluate(() => [...document.querySelectorAll('.day tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr').length === 60);
        assert.match(await tries.locator('#summary').innerText(), /^60 tries at 7 sites, the latest at .+\. 1 page opened instead of being blocked\. 1 from this browser's history\.$/);
        const dayHeadings = await tries.evaluate(() => [...document.querySelectorAll('.day h3')].map((h) => h.textContent));
        assert.ok(dayHeadings.length >= 1 && dayHeadings.length <= 2, `an hour of tries spans one day, or two at midnight: ${dayHeadings}`);
        assert.match(dayHeadings[0], /^Today, .+ \d+ tr(y|ies)$/);
        const all = await rows();
        assert.deepEqual(all[0].slice(1), ['site3.test', 'Opened, not blocked']);
        assert.deepEqual(all[59].slice(1), ['site0.test', 'Visited (browser history)']);
        assert.match(all[0][0], /^\d{1,2}:\d\d [AP]M$/, 'a time only; the day is in the heading');
        assert.equal(await tries.locator('#filter').isVisible(), false);

        // A site in the by-site table leads to that site's tries alone; "Show every site" to all of them.
        assert.equal(await record.locator('#sites-table tr[data-site="site4.test"] a').getAttribute('href'), 'tries.html#site=site4.test');
        await tries.goto(`chrome-extension://${browser.extensionId}/tries.html#site=site4.test`);
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr').length === 8);
        assert.equal(await tries.locator('#filter').innerText(), 'Only site4.test. Show every site');
        assert.match(await tries.locator('#summary').innerText(), /^8 tries, the latest at /);
        assert.ok((await rows()).every((row) => row[1] === 'site4.test'));
        assert.equal(await tries.title(), 'Family Site Blocker record: site4.test');
        await tries.click('#filter-clear');
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr').length === 60);
        assert.equal(await tries.locator('#filter').isVisible(), false);
        assert.deepEqual(tries.errors, []);
        await tries.close();

        // "Save as a file" downloads the whole record as CSV, oldest first.
        const [download] = await Promise.all([record.waitForEvent('download'), record.click('#save-file')]);
        assert.match(download.suggestedFilename(), /^family-site-blocker-record-\d{4}-\d\d-\d\d\.csv$/);
        const lines = readFileSync(await download.path(), 'utf8').split('\n');
        assert.equal(lines[0], 'when,site,result');
        assert.equal(lines.length, 62, '60 rows, a heading and a final newline');
        assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d,site0\.test,Visited \(browser history\)$/);
        assert.match(lines[60], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d,site3\.test,"Opened, not blocked"$/);
        assert.match(await record.locator('#save-status').innerText(), /^Saved family-site-blocker-record-.+\.csv to your downloads/);

        // Both pages keep up with the record while they are open.
        await page.evaluate(() => chrome.storage.local.get('attempts').then(({ attempts }) => chrome.storage.local.set({ attempts: [...attempts, { at: Date.now(), site: 'site7.test' }] })));
        await record.waitForFunction(() => document.getElementById('summary').textContent.startsWith('61 attempts at 8 sites'));
        await page.waitForFunction(() => document.getElementById('attempts-all').textContent === 'See the whole record (61)');
        assert.deepEqual(record.errors, []);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.evaluate(() => chrome.storage.local.remove('attempts')).catch(() => {});
        await record?.close();
        await page.close();
      }
    });

    test('sites that look adult by name but are not listed are noted on the record page, where one click adds them to the list', async () => {
      const page = await freshRecord();
      const record = await browser.context.newPage();
      record.errors = [];
      record.on('pageerror', (error) => record.errors.push(error.message));
      const unlistedRows = () =>
        record.evaluate(() => [...document.querySelectorAll('#unlisted-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.innerText)));
      const listBefore = await page.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      try {
        // Visits the extension never recorded: two pages of a site whose name gives it away, one of a site
        // whose name only looks like it, and one of a listed site.
        await page.evaluate(() =>
          Promise.all([
            chrome.history.addUrl({ url: 'http://www.nsfw-pictures.test/gallery' }),
            chrome.history.addUrl({ url: 'http://nsfw-pictures.test/' }),
            chrome.history.addUrl({ url: 'http://essex.test/council' }),
            chrome.history.addUrl({ url: 'http://exampleadultsite.com/listed-already' }),
          ]),
        );
        await page.click('#history-scan-now');
        await page.waitForFunction(() => !document.getElementById('unlisted-note').hidden);
        assert.equal(await page.locator('#unlisted-note').innerText(), "1 site in this browser's history looks adult but isn't on either list: see which.");
        assert.equal(await page.locator('#unlisted-note a').getAttribute('href'), 'unlisted.html');

        // The record page sums them up in a line; the unlisted page lists them (#54).
        await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
        await record.waitForFunction(() => /^1 site in this browser's history looks adult but isn't on either list\./.test(document.querySelector('#unlisted-line span').textContent));
        assert.equal(await record.locator('#unlisted-line a').getAttribute('href'), 'unlisted.html');
        await record.goto(`chrome-extension://${browser.extensionId}/unlisted.html`);
        await record.waitForFunction(() => document.querySelectorAll('#unlisted-table tbody tr').length === 1);
        assert.match(await record.locator('#summary').innerText(), /^1 site, as of .+\.$/);
        const [row] = await unlistedRows();
        assert.deepEqual(row.slice(0, 2), ['nsfw-pictures.test', '2'], 'both pages, one site');
        assert.equal(row[3], 'Add to your list');
        assert.equal((await visit(browser.context, 'http://nsfw-pictures.test/page')).outcome, 'site loaded', 'not blocked yet');

        // Adding it: the settings page's box shows it, it is blocked from then on, its earlier visits join
        // the record, and it leaves this table (the look through the history runs again by itself).
        await record.click('#unlisted-table button');
        await record.waitForFunction(() => document.getElementById('summary').textContent.startsWith('None found'), null, { timeout: 15_000 });
        assert.deepEqual(await unlistedRows(), []);
        await page.waitForFunction(() => document.getElementById('custom').value === 'nsfw-pictures.test');
        assert.match(await page.locator('#summary').innerText(), / 1 on yours\.$/);
        await page.waitForFunction(() => document.getElementById('unlisted-note').hidden);
        assert.equal((await visit(browser.context, 'http://nsfw-pictures.test/page')).outcome, 'blocked page');
        const list = await stored(page);
        assert.ok(list.some((entry) => entry.site === 'nsfw-pictures.test' && entry.from === 'history'), JSON.stringify(list));
        assert.ok(list.some((entry) => entry.site === 'nsfw-pictures.test' && !entry.from), 'the try just made');
        assert.deepEqual(record.errors, []);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.evaluate(() => chrome.storage.local.remove(['attempts', 'historyScan', 'unlisted', 'myListChanged'])).catch(() => {});
        // The person's list as it was before this test.
        await page
          .evaluate(
            (before) =>
              chrome.declarativeNetRequest
                .getDynamicRules()
                .then((rules) => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id), addRules: before })),
            listBefore,
          )
          .catch(() => {});
        await record.close();
        await page.close();
      }
    });

    test('the record page says so when the record is empty', async () => {
      const page = await freshRecord();
      const record = await browser.context.newPage();
      try {
        await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
        await record.waitForFunction(() => document.getElementById('summary').textContent === 'No attempts so far.');
        assert.equal(await record.locator('#save-file').isVisible(), false);
        assert.equal(await record.locator('#every-try').isVisible(), false);
        assert.equal(await record.locator('#sites').isVisible(), false);
        assert.equal(await record.locator('#pictures-line span').innerText(), 'No picture hidden so far.');
        for (const [name, text] of [['pictures.html', 'No picture hidden so far.'], ['tries.html', 'No attempts so far.']]) {
          await record.goto(`chrome-extension://${browser.extensionId}/${name}`);
          await record.waitForFunction((want) => document.getElementById('summary').textContent === want, text);
        }
      } finally {
        await record.close();
        await page.close();
      }
    });
  });

  describe('pictures', () => {
    // Pictures the page shows are judged by the background script and kept hidden until then. Most of
    // these tests use a copy of the extension whose classifier judges by the picture's address (no
    // explicit picture is needed); the last one uses the real classifier on two ordinary photos.
    let standIn;
    let judge; // Chromium with the stand-in classifier
    const marks = (page) => page.evaluate(`Object.fromEntries(${MARKS})`);
    const settled = (page, ids, timeout = 20_000) =>
      page.waitForFunction((want) => want.every((id) => ['ok', 'hidden', 'small'].includes(document.getElementById(id)?.getAttribute('data-family-site-blocker'))), ids, { timeout });

    before(async () => {
      servePictures(stub, ['photo', 'nude', 'lingerie', 'drawn', 'photo2', 'nude2', 'coffee', 'cat']);
      stub.page('allowed.test/gallery', galleryPage(['photo', 'nude', 'lingerie', 'drawn']));
      stub.page('allowed.test/framed', `<!doctype html><h1>Framed</h1><iframe id="frame" src="http://frames.test/inner" width="400" height="300"></iframe>`);
      stub.page('frames.test/inner', galleryPage(['nude2', 'photo2']));
      stub.page('allowed.test/later', galleryPage(['photo'], `<img id="late" width="300"><script>setTimeout(() => { document.getElementById('late').src = 'http://pics.test/pics/nude.jpg?late'; }, 300);
        setTimeout(() => { document.getElementById('photo').src = 'http://pics.test/pics/lingerie.jpg?swapped'; }, 600);</script>`));
      stub.page('allowed.test/blob', `<!doctype html><img id="made" width="300"><script>fetch('/pics/nude.jpg?blob').then((r) => r.blob()).then((b) => { document.getElementById('made').src = URL.createObjectURL(b); });</script>`);
      stub.page('allowed.test/real', galleryPage(['cat', 'coffee']));
      standIn = extensionWithStandInClassifier();
      judge = await launchBrowser(stub, { extensionDir: standIn.dir });
    });

    after(async () => {
      await judge?.close();
      standIn?.remove();
    });

    async function openSettingsIn(browserToUse) {
      const page = await browserToUse.context.newPage();
      await page.goto(`chrome-extension://${browserToUse.extensionId}/options.html`);
      return page;
    }

    test('a picture stays hidden until judged, then is shown or kept hidden; icons are shown at once; the layout is kept', async () => {
      const page = await judge.context.newPage();
      try {
        await page.evaluate(() => chrome.storage.local.remove('pictures')).catch(() => {}); // not an extension page: ignored
        await page.goto('http://allowed.test/gallery', { waitUntil: 'domcontentloaded' });
        const early = await marks(page);
        for (const [id, [mark, visibility]] of Object.entries(early)) {
          assert.ok(['checking', 'small', 'ok', 'hidden'].includes(mark), `${id} is marked from the start: ${mark}`);
          if (mark === 'checking') assert.equal(visibility, 'hidden', `${id}: hidden while being judged`);
        }
        // The icon is shown as soon as it has loaded, without being judged; the pictures once judged.
        await page.waitForFunction(() => document.getElementById('icon').getAttribute('data-family-site-blocker') === 'small');
        await settled(page, ['photo', 'nude', 'lingerie', 'drawn']);
        const after = await marks(page);
        assert.deepEqual(
          { photo: after.photo, nude: after.nude, lingerie: after.lingerie, drawn: after.drawn, icon: after.icon },
          { photo: ['ok', 'visible'], nude: ['hidden', 'hidden'], lingerie: ['hidden', 'hidden'], drawn: ['hidden', 'hidden'], icon: ['small', 'visible'] },
        );
        const box = await page.evaluate(() => { const r = document.getElementById('nude').getBoundingClientRect(); return [r.width, r.height]; });
        assert.ok(box[0] === 300 && box[1] > 0, `a hidden picture keeps its place on the page: ${box}`);
        // The page can't bring a hidden picture back by taking the mark off: it is judged again at once.
        await page.evaluate(() => document.getElementById('nude').removeAttribute('data-family-site-blocker'));
        await page.waitForFunction(() => document.getElementById('nude').getAttribute('data-family-site-blocker') === 'hidden');
      } finally {
        await page.close();
      }
    });

    test("hidden pictures go into the record with the page's site, why, and the scores; the record page and the settings page show them", async () => {
      const settings = await openSettingsIn(judge);
      const record = await judge.context.newPage();
      try {
        const stored = await settings.evaluate(() => chrome.storage.local.get('pictures').then((got) => got.pictures ?? []));
        const fromGallery = stored.filter((entry) => entry.site === 'allowed.test');
        assert.ok(fromGallery.length >= 3, JSON.stringify(stored));
        const byUrl = Object.fromEntries(fromGallery.map((entry) => [entry.url.split('/').pop(), entry]));
        assert.equal(byUrl['nude.jpg'].reason, 'nudity');
        assert.deepEqual(byUrl['nude.jpg'].scores, { porn: 0.9, hentai: 0.02, sexy: 0.02 });
        assert.equal(byUrl['lingerie.jpg'].reason, 'suggestive');
        assert.equal(byUrl['drawn.jpg'].reason, 'nudity', 'hentai counts as nudity');
        assert.equal(byUrl['photo.jpg'], undefined, 'shown pictures are not recorded');

        // The record page sums them up in a line; the pictures page lists them (#54).
        await record.goto(`chrome-extension://${judge.extensionId}/attempts.html`);
        await record.waitForFunction(() => /^\d+ pictures hidden on \d+ sites?, the latest at /.test(document.querySelector('#pictures-line span').textContent));
        assert.equal(await record.locator('#pictures-line a').getAttribute('href'), 'pictures.html');
        assert.equal(await record.locator('#hidden-pictures-table').count(), 0, 'no picture tables on the record page');
        await record.goto(`chrome-extension://${judge.extensionId}/pictures.html`);
        await record.waitForFunction(() => document.querySelectorAll('#hidden-pictures-table tbody tr').length >= 3);
        assert.match(await record.locator('#summary').innerText(), /^\d+ pictures hidden on \d+ sites?, the latest at /);
        const sites = await record.evaluate(() => [...document.querySelectorAll('#hidden-sites-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        assert.ok(sites.some((row) => row[0] === 'allowed.test' && Number(row[1]) >= 3), JSON.stringify(sites));
        const rows = await record.evaluate(() => [...document.querySelectorAll('#hidden-pictures-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        const nude = rows.find((row) => row[2].endsWith('/nude.jpg'));
        assert.deepEqual(nude.slice(1), ['allowed.test', 'http://pics.test/pics/nude.jpg', 'Nudity', '0.92', '0.02'], JSON.stringify(rows));
        assert.equal(rows.find((row) => row[2].endsWith('/lingerie.jpg'))[3], 'Suggestive');

        await settings.waitForFunction(() => /pictures? judged, \d+ hidden/.test(document.getElementById('picture-status').textContent));
        assert.match(await settings.locator('#picture-status').innerText(), /^Since the browser started: \d+ pictures judged, \d+ hidden; judging runs stand-in\.$/);
        assert.equal(await settings.locator('#picture-strictness').inputValue(), 'strict', 'the default');
        assert.deepEqual(await settings.evaluate(() => [...document.getElementById('picture-strictness').options].map((o) => o.value)), ['strict', 'nudity']);
      } finally {
        await record.close();
        await settings.close();
      }
    });

    test('under "Nudity only", a suggestive picture is shown and nudity still hidden; the setting takes effect at once', async () => {
      const settings = await openSettingsIn(judge);
      const page = await judge.context.newPage();
      try {
        await settings.selectOption('#picture-strictness', 'nudity');
        await settings.waitForFunction(() => chrome.storage.local.get('pictureStrictness').then((got) => got.pictureStrictness === 'nudity'));
        await page.goto('http://allowed.test/gallery', { waitUntil: 'domcontentloaded' });
        await settled(page, ['photo', 'nude', 'lingerie', 'drawn']);
        const after = await marks(page);
        assert.deepEqual([after.photo[0], after.nude[0], after.lingerie[0], after.drawn[0]], ['ok', 'hidden', 'ok', 'hidden'], JSON.stringify(after));
      } finally {
        await settings.selectOption('#picture-strictness', 'strict').catch(() => {});
        await settings.waitForFunction(() => chrome.storage.local.get('pictureStrictness').then((got) => got.pictureStrictness === 'strict')).catch(() => {});
        await page.close();
        await settings.close();
      }
    });

    test('pictures in frames, pictures added or changed after the page loaded, and pictures the page makes itself', async () => {
      const page = await judge.context.newPage();
      try {
        await page.goto('http://allowed.test/framed', { waitUntil: 'domcontentloaded' });
        const inner = await (await page.waitForSelector('#frame')).contentFrame();
        await inner.waitForFunction(() => ['nude2', 'photo2'].every((id) => ['ok', 'hidden'].includes(document.getElementById(id)?.getAttribute('data-family-site-blocker'))), null, { timeout: 20_000 });
        const framed = await inner.evaluate(`Object.fromEntries(${MARKS})`);
        assert.deepEqual([framed.nude2[0], framed.photo2[0]], ['hidden', 'ok'], JSON.stringify(framed));

        await page.goto('http://allowed.test/later', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('late').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        await page.waitForFunction(() => document.getElementById('photo').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        assert.deepEqual((await marks(page)).photo, ['hidden', 'hidden'], 'the photo whose address changed to a suggestive picture is hidden now');

        // A picture the page made itself (a blob: address) can't be fetched by the background script: shown as it is.
        await page.goto('http://allowed.test/blob', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('made').getAttribute('data-family-site-blocker') === 'ok', null, { timeout: 20_000 });
      } finally {
        await page.close();
      }
    });

    test('the real classifier, through WebAssembly, finds two ordinary photos neutral and shows them', async () => {
      const page = await browser.context.newPage();
      const settings = await openSettings();
      try {
        await page.goto('http://allowed.test/real', { waitUntil: 'domcontentloaded' });
        await settled(page, ['cat', 'coffee'], 60_000);
        const after = await marks(page);
        assert.deepEqual([after.cat, after.coffee, after.icon], [['ok', 'visible'], ['ok', 'visible'], ['small', 'visible']], JSON.stringify(after));
        const status = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'picture-status' }));
        assert.equal(status.backend, 'wasm', JSON.stringify(status));
        assert.ok(status.judged >= 2 && status.failed === 0, JSON.stringify(status));
        assert.deepEqual(page.errors ?? [], []);
      } finally {
        await settings.close();
        await page.close();
      }
    });
  });

  describe('locked-away password', () => {
    const SECRET = 'Admin-Password-4-Tests';

    async function freshSettings() {
      const page = await openSettings();
      await page.evaluate(() => chrome.storage.local.clear());
      await page.reload();
      await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
      return page;
    }

    test('"Make one up" fills in a long random password, and asks before replacing one', async () => {
      const page = await freshSettings();
      try {
        await page.click('#lockbox-make');
        const first = await page.inputValue('#lockbox-secret');
        assert.match(first, /^[a-hjkmnp-zA-HJ-NP-Z2-9]{4}(-[a-hjkmnp-zA-HJ-NP-Z2-9]{4}){4}$/);
        // With something already in the box it asks first, and Cancel keeps it.
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.click('#lockbox-make');
        assert.equal(await page.inputValue('#lockbox-secret'), first);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-make');
        assert.notEqual(await page.inputValue('#lockbox-secret'), first);
        assert.match(await page.locator('#lockbox-status').innerText(), /administrator password first/);
      } finally {
        await page.close();
      }
    });

    test('locking a password away keeps only a puzzle: the password is nowhere in storage', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 3);
        assert.equal(await page.inputValue('#lockbox-secret'), '', 'the typed password is cleared');
        assert.match(await page.locator('#lockbox-summary').innerText(), /^A password is locked away \(since .+\)\. Getting it back takes about [1-4] seconds of computing/);
        const stored = await storedLockbox(page);
        assert.ok(!JSON.stringify(stored).includes(SECRET));
        assert.equal(stored.lockbox.delay, 3);
        assert.ok(stored.lockbox.steps > 1000, `steps: ${stored.lockbox.steps}`);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('unlocking takes the wait, shows the password, and locks it away again with a fresh puzzle', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 3);
        const before = (await storedLockbox(page)).lockbox;

        const started = Date.now();
        await page.click('#lockbox-start');
        await page.locator('#lockbox-progress-area').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#lockbox-delete').isVisible(), false, 'no deleting while it unlocks');
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        const took = (Date.now() - started) / 1000;
        assert.ok(took >= 1.5, `opened after ${took} s, sooner than the 3-second wait allows`);
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);

        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '');
        const after = (await storedLockbox(page)).lockbox;
        assert.notEqual(after.n, before.n, 'a new puzzle');
        assert.equal(after.delay, 3, 'with the same wait');
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined, "no progress left behind");
        assert.ok(!JSON.stringify(await storedLockbox(page)).includes(SECRET));

        await page.click('#lockbox-hide');
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.equal(await page.inputValue('#lockbox-revealed'), '');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('closing the page pauses unlocking, and it carries on from there when reopened', async () => {
      let page = await freshSettings();
      try {
        await lockAway(page, SECRET, 6);
        await page.click('#lockbox-start');
        await progressSaved(page);
        await page.close();

        page = await openSettings();
        await page.waitForFunction(() => document.getElementById('lockbox-start').textContent === 'Carry on unlocking');
        assert.match(await page.locator('#lockbox-progress-text').innerText(), /^\d+% done, about \d+ seconds? to go\.$/);
        assert.equal(await page.locator('#lockbox-stop').isVisible(), true);
        await page.click('#lockbox-start');
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('stopping unlocking throws the work away, and the password stays locked', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 30);
        await page.click('#lockbox-start');
        await progressSaved(page);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-stop');
        await page.waitForFunction(() => /^Unlocking stopped/.test(document.getElementById('lockbox-status').textContent));
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined);
        assert.equal(await page.locator('#lockbox-start').innerText(), 'Start unlocking');
        assert.equal(await page.locator('#lockbox-progress-area').isVisible(), false);
        assert.ok((await storedLockbox(page)).lockbox, 'still locked away');
      } finally {
        await page.close();
      }
    });

    test('a backup file stays locked, and restoring it brings the same password back after the wait', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 3);
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#lockbox-backup')]);
        assert.equal(download.suggestedFilename(), 'locked-away-password.json');
        const file = await download.path();
        const { readFileSync } = await import('node:fs');
        const backup = readFileSync(file, 'utf8');
        assert.ok(!backup.includes(SECRET), 'the backup file does not hold the password');

        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        assert.deepEqual(await storedLockbox(page), {});

        await page.setInputFiles('#lockbox-restore', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
        await page.waitForFunction(() => /isn’t a backup/.test(document.getElementById('lockbox-status').textContent));

        await page.setInputFiles('#lockbox-restore', file);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        await page.click('#lockbox-start');
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });
  });
});
