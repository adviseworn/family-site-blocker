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
import { webcrypto } from 'node:crypto';
import { EXTENSION_DIR, findPage, launchBrowser, startStubInternet, visit } from './helpers/browser.mjs';
import { BACKGROUND_MARKS, FAKE_CAMERA_ARGS, MARKS, STAND_IN_SCORES, backgroundsPage, cameraPage, extensionWithStandInClassifier, galleryPage, servePictures, serveVideos, videoPage } from './helpers/pictures.mjs';

globalThis.crypto ??= webcrypto; // Node 18 has Web Crypto, but not on globalThis
// What the waits know a box by (1.13.0), to check what the page stores.
const { boxKey } = await import('../extension/lib/lockbox.js');

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
  // Until the rule check has run: the line starts as "Checking…", and runChecks() empties it before it
  // fills it in, so a line that merely has text may be read in that moment (it was, on a slow Mac).
  await page.waitForFunction(() => {
    const text = document.querySelector('#check-note')?.textContent ?? '';
    return text.length > 0 && !text.startsWith('Checking');
  });
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

/** Starts unlocking, with the reason the page asks for before it begins (1.13.2); carrying on paused work isn't asked. */
async function startUnlocking(page, why = 'to try it') {
  if (await page.locator('#lockbox-why').isVisible()) await page.fill('#lockbox-why', why);
  await page.click('#lockbox-start');
}

const storedLockbox = (page) => page.evaluate(() => chrome.storage.local.get(null));

/** The record's entries in storage, oldest first, as event names. */
const recordedEvents = async (page) => ((await storedLockbox(page)).lockboxEvents ?? []).map(({ event }) => event);

/** The record as the password's page shows it: each row's words, newest first, and whether the row is shown. */
const shownRecord = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('#lockbox-events tbody tr'), (row) => ({ when: row.cells[0].textContent, what: row.cells[1].textContent, hidden: row.hidden })));

/** Waits until the page has saved some unlocking progress (progress that passes `reached`), and gives back what is stored. */
async function progressSaved(page, reached = (progress) => progress?.done > 0, what = 'no unlocking progress was saved') {
  const until = Date.now() + 15_000;
  let stored;
  while (!reached((stored = await storedLockbox(page)).lockboxProgress)) {
    if (Date.now() > until) throw new Error(what);
    await new Promise((done) => setTimeout(done, 100));
  }
  return stored;
}

/** Lengthens the wait of the password locked away on the page to `seconds`, which the tests add to the choices offered. */
async function lengthenTo(page, seconds) {
  await page.evaluate((wait) => document.getElementById('lockbox-longer').append(new Option(`${wait} seconds`, String(wait), true, true)), seconds);
  await page.click('#lockbox-lengthen');
  await page.waitForFunction(() => /^The wait is now/.test(document.getElementById('lockbox-status').textContent));
}

const lockboxStatus = (page) => page.locator('#lockbox-status').innerText();

/**
 * The share of a lengthened box's squarings that its outer layer takes, in whole points rounded down, as
 * the page counts progress (lib/lockbox.js fractionDone). Each layer's count comes from timing the machine
 * when that layer was made, so the share isn't the outer layer's share of the seconds asked for: a
 * machine timed slower while lengthening gives the outer layer fewer squarings (#119).
 */
const outerShare = (box) => Math.floor((box.steps / (box.steps + box.inside.reduce((sum, layer) => sum + layer.steps, 0))) * 100);

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
    // Over https, as a person's browser makes them: the engines are on Chromium's built-in HTTPS-only list, so a
    // recent Chromium would turn an http:// address into https:// before any request went out (#68).
    const searches = [
      ['https://www.google.com/search?q=test', 'safe', 'active'],
      ['https://www.google.co.uk/search?q=test&safe=off', 'safe', 'active'],
      ['https://www.bing.com/images/search?q=test', 'adlt', 'strict'],
      ['https://duckduckgo.com/?q=test&ia=web', 'kp', '1'],
      ['https://html.duckduckgo.com/html/?q=test', 'kp', '1'],
      ['https://search.yahoo.com/search?p=test', 'vm', 'r'],
      ['https://images.search.yahoo.com/search/images?p=test', 'vm', 'r'],
      ['https://search.brave.com/search?q=test', 'safesearch', 'strict'],
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
          assert.equal(sent[0].scheme, 'https', 'the search stays on https');
          assert.equal(new URL(`${sent[0].scheme}://${sent[0].host}${sent[0].path}${sent[0].search}`).searchParams.get(key), value, 'the engine sees the setting');
        } finally {
          await page.close();
        }
      });
    }

    test('a search already made strict, and pages that are not searches, are not redirected', async () => {
      const page = await browser.context.newPage();
      try {
        for (const url of ['https://www.google.com/search?q=test&safe=active', 'https://www.google.com/', 'https://www.google.com/maps?q=test', 'https://duckduckgo.com/', 'https://example.com/search?q=test']) {
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
        stub.page('www.youtube.com/results', '<img src="https://i.ytimg.com/x.gif"><script>fetch("https://www.youtube.com/youtubei/v1/search").catch(() => {})</script>');
        await page.goto('https://www.youtube.com/results?search_query=test', { waitUntil: 'load' });
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
          "This browser doesn't let extensions check the addresses automatically, so open the test site.",
        );
        assert.equal(await page.locator('#check-details').isVisible(), false, 'no list promising a check that cannot run');
        assert.equal(await page.locator('#results li').count(), 0);
        assert.ok(await page.evaluate(() => document.getElementById('check').classList.contains('ok')), 'nothing known to be wrong');
        assert.match(await page.locator('#summary').innerText(), new RegExp(`^${BUILT_IN} sites on the built-in list`));
      } finally {
        await page.close();
      }
    });

    test("the browser's own check agrees that every listed address is blocked or allowed as expected", async () => {
      const page = await openSettings();
      try {
        assert.match(await page.locator('#check-note').innerText(), /^All \d+ checks passed\.$/);
        assert.equal(await page.locator('#check-details').isVisible(), true, 'the checks can be opened');
        assert.equal(await page.locator('#check-details').evaluate((details) => details.open), false, 'but are folded away: six Passed rows say nothing new');
        assert.equal(await page.locator('#results li').count(), 6);
        assert.ok(await page.evaluate(() => document.getElementById('check').classList.contains('ok')), 'ticked');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('the board says whether anything stops the person switching the add-on off: nothing does, for an extension loaded unpacked', async () => {
      const page = await openSettings();
      try {
        await page.locator('#lock').waitFor({ state: 'visible' });
        assert.match(await page.locator('#lock-status').innerText(), /^Anyone who can open the extensions page can switch the add-on off or remove it; the lock covers Firefox only\. What to do about that\.$/);
        assert.ok(await page.evaluate(() => document.getElementById('lock').classList.contains('todo')), 'marked as something to do');
        assert.equal(await page.locator('#lock-status a').getAttribute('href'), 'https://github.com/adviseworn/family-site-blocker#limits');
        // The page is short again (#70): the explanations live in the README, linked from each section.
        const words = await page.evaluate(() => document.body.innerText.split(/\s+/).filter(Boolean).length);
        assert.ok(words < 450, `${words} words on the settings page`);
        assert.ok((await page.locator('a[href^="https://github.com/adviseworn/family-site-blocker#"]').count()) >= 4, 'links to the README');
        assert.equal(await page.locator('#lockbox-page').getAttribute('href'), 'lockbox.html');
        assert.equal(await page.locator('#lockbox-line').innerText(), 'No password is locked away.');
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
        assert.ok(await page.evaluate(() => document.getElementById('private').classList.contains('todo')), 'marked as something to do');

        // The button takes the person to this extension's page in the browser's extensions list. The new
        // tab can be reported before its address is set, so wait for that (#109).
        const [details] = await Promise.all([browser.context.waitForEvent('page'), page.click('#private-open')]);
        await details.waitForURL(/^chrome:\/\/extensions\//);
        assert.equal(details.url(), `chrome://extensions/?id=${browser.extensionId}`);
        await details.close();
      } finally {
        await page.close();
      }
    });

    test('the board says so when a policy installed the extension, as the Firefox lock does: no switch, no Remove (#69)', async () => {
      // Chromium can't be put under a policy here: stand in for what the browser then reports.
      const page = await browser.context.newPage();
      await page.addInitScript(() => {
        const real = chrome.management.getSelf;
        chrome.management.getSelf = async () => ({ ...(await real()), installType: 'admin', mayDisable: false });
      });
      try {
        await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
        await page.waitForFunction(() => document.getElementById('lock').classList.contains('ok'));
        assert.equal(await page.locator('#lock-status').innerText(), 'Installed by policy: the browser gives no way to switch the add-on off or remove it.');
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

    /** The record page, where the browser's history is looked through from (#70). */
    async function openRecord() {
      const record = await browser.context.newPage();
      record.errors = [];
      record.on('pageerror', (error) => record.errors.push(error.message));
      await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
      await record.waitForFunction(() => document.getElementById('history-scan').textContent.length > 0);
      return record;
    }

    test("visits found in this browser's history are added once, marked as such, with their own time, then taken out of the history with any bookmarks", async () => {
      const page = await freshRecord();
      const record = await openRecord();
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
        assert.equal(await page.locator('#history-scan-now').count(), 0, 'the look through the history is started from the record page now');
        await record.click('#history-scan-now');
        await record.waitForFunction(() => /^Looked through this browser's history on .+: found \d+ visits? to listed sites/.test(document.getElementById('history-scan').textContent));
        const list = await stored(page);
        const fromHistory = list.filter((entry) => entry.from === 'history');
        assert.ok(fromHistory.length >= 1, JSON.stringify(list));
        assert.ok(fromHistory.every((entry) => entry.site === SITE || entry.site === 'custom-blocked.test'), 'only listed sites');
        assert.equal(list.some((entry) => entry.site === 'allowed.test'), false);
        assert.ok(fromHistory.some((entry) => Date.now() - entry.at < 60_000), 'the visit just added');
        // Dated now, the visit falls in a time the extension was running, so the page says the site can't have been listed then (#69); the
        // Firefox tests, which can date a visit, see the wording for one from before the install.
        const rows = await shown(page);
        assert.ok(rows.some((row) => row[1] === SITE && row[2] === 'Visited before the site was listed'), JSON.stringify(rows.slice(0, 3)));
        assert.match(await page.locator('#attempts-summary').innerText(), / \d+ from this browser's history\.$/);

        // Once in the record, listed pages are taken out of the browser's history, and bookmarks to listed
        // sites removed, so the address bar has nothing to suggest; everything else is left alone.
        const line = await record.locator('#history-scan').innerText();
        assert.match(line, / Removed \d+ pages? from this browser's history and 1 bookmark\.$/, line);
        assert.deepEqual(await inHistory(SITE), []);
        assert.deepEqual(await bookmarked(SITE), []);
        assert.ok((await inHistory('allowed.test')).includes('http://allowed.test/not-listed'));
        assert.deepEqual(await bookmarked('allowed.test'), ['http://allowed.test/kept']);

        // Looking again finds nothing left, and adds nothing.
        const before = (await stored(page)).length;
        await record.click('#history-scan-now');
        await record.waitForFunction(() => /found no visits to listed sites\.$/.test(document.getElementById('history-scan').textContent));
        assert.equal((await stored(page)).length, before);
        assert.deepEqual(page.errors, []);
        assert.deepEqual(record.errors, []);
      } finally {
        await page.evaluate(() => chrome.bookmarks.search('allowed.test').then((items) => Promise.all(items.map((item) => chrome.bookmarks.remove(item.id))))).catch(() => {});
        await page.evaluate(() => chrome.storage.local.remove(['attempts', 'historyScan'])).catch(() => {});
        await record.close();
        await page.close();
      }
    });

    test('the latest 3 are shown, with a link to the whole record on a page of its own', async () => {
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
        await page.waitForFunction(() => document.querySelectorAll('#attempts-table tbody tr').length === 3);
        assert.equal((await shown(page))[0][1], 'site3.test', 'newest first');
        assert.equal(await page.locator('#attempts-table caption').innerText(), 'The latest 3');
        await page.locator('#attempts-all').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#attempts-all').innerText(), 'See the whole record (60)');

        // The link opens the record page in a tab of its own. The new tab can be reported before its
        // address is set, and its blank starting page has already loaded, so wait for the address (#109).
        [record] = await Promise.all([browser.context.waitForEvent('page'), page.click('#attempts-all')]);
        record.errors = [];
        record.on('pageerror', (error) => record.errors.push(error.message));
        await record.waitForURL(/\/attempts\.html$/);
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
        const rows = () => tries.evaluate(() => [...document.querySelectorAll('.day tbody tr:not(.band)')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr:not(.band)').length === 60);
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
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr:not(.band)').length === 8);
        assert.equal(await tries.locator('#filter').innerText(), 'Only site4.test. Show every site');
        assert.match(await tries.locator('#summary').innerText(), /^8 tries, the latest at /);
        assert.ok((await rows()).every((row) => row[1] === 'site4.test'));
        assert.equal(await tries.title(), 'Family Site Blocker record: site4.test');
        await tries.click('#filter-clear');
        await tries.waitForFunction(() => document.querySelectorAll('.day tbody tr:not(.band)').length === 60);
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
        await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
        await record.click('#history-scan-now');
        await page.waitForFunction(() => !document.getElementById('unlisted-note').hidden);
        assert.equal(await page.locator('#unlisted-note').innerText(), "1 site in this browser's history looks adult but isn't on either list: see which.");
        assert.equal(await page.locator('#unlisted-note a').getAttribute('href'), 'unlisted.html');

        // The record page sums them up in a line; the unlisted page lists them (#54).
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
        let list = await stored(page);
        assert.ok(list.some((entry) => entry.site === 'nsfw-pictures.test' && entry.from === 'history'), JSON.stringify(list));
        // The background script notes the try a moment after the page load, behind whatever it is writing.
        const noted = Date.now() + 10_000;
        while (!list.some((entry) => entry.site === 'nsfw-pictures.test' && !entry.from) && Date.now() < noted) {
          await pause(100);
          list = await stored(page);
        }
        assert.ok(list.some((entry) => entry.site === 'nsfw-pictures.test' && !entry.from), `the try just made: ${JSON.stringify(list.slice(-4))}`);
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
        await record.waitForFunction(() => /^Watching since /.test(document.getElementById('since').textContent));
        assert.equal(await record.locator('#off-summary').innerText(), "No time found when this browser was in use while the extension wasn't running.");
        assert.equal(await record.locator('#off-summary a').count(), 0, 'no time off to see among every try');
        for (const [name, text] of [['pictures.html', 'No picture hidden so far.'], ['tries.html', 'No attempts so far.']]) {
          await record.goto(`chrome-extension://${browser.extensionId}/${name}`);
          await record.waitForFunction((want) => document.getElementById('summary').textContent === want, text);
        }
      } finally {
        await record.close();
        await page.close();
      }
    });

    // --- Was it ever off? (#69) ---
    const watchingStored = (page) => page.evaluate(() => chrome.storage.local.get('watching').then((got) => got.watching));

    test('the extension keeps track of when it is running: the moment it was installed, and the stretch since, kept up by an alarm every minute', async () => {
      const page = await openSettings();
      try {
        const state = await watchingStored(page);
        assert.ok(state, 'a watching state is stored');
        const launched = Date.now() - 20 * 60_000;
        assert.ok(state.since > launched && state.since <= Date.now(), `since the install, earlier in this run: ${JSON.stringify(state)}`);
        assert.equal(state.atLeast, undefined, 'an install knows its moment exactly');
        assert.ok(state.periods.length >= 1, JSON.stringify(state.periods));
        assert.equal(state.periods[0].from, state.since, 'the first stretch starts with the install');
        const last = state.periods[state.periods.length - 1];
        assert.ok(Date.now() - last.to < 2 * 60_000, `the stretch is kept up to the minute: ${JSON.stringify(last)}`);
        assert.ok(state.periods.every((period) => period.from <= period.to));
        const alarms = await page.evaluate(() => chrome.alarms.getAll());
        assert.deepEqual(alarms.map(({ name, periodInMinutes }) => ({ name, periodInMinutes })), [{ name: 'heartbeat', periodInMinutes: 1 }]);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('a visit from the history is placed by when the extension was running: off, before the site was listed, or before it kept track; the times it was off are listed with the pages visited meanwhile', async () => {
      const page = await freshRecord();
      const original = await watchingStored(page);
      const record = await browser.context.newPage();
      record.errors = [];
      record.on('pageerror', (error) => record.errors.push(error.message));
      try {
        // A page visited now, then a stretch of running made to end just before it: the visit falls in a
        // silence, as it would had the extension been off. A visit to a listed site from that silence is in
        // the record (the extension takes those out of the history), one from before the install, and one
        // from after the install but before version 1.11.0 kept track of when it was running.
        const before = Date.now();
        assert.equal((await visit(browser.context, 'http://allowed.test/while-off')).outcome, 'site loaded');
        const after = Date.now();
        const hour = 3600_000;
        await page.evaluate(
          ([from, to, hour]) =>
            chrome.storage.local.set({
              watching: { since: from - 3 * hour, atLeast: true, periods: [{ from: from - hour, to: from - 5000 }, { from: to, to }], off: [] },
              attempts: [
                { at: from - 4 * hour, site: 'exampleadultsite.com', from: 'history' },
                { at: from - 2 * hour, site: 'exampleadultsite.com', from: 'history' },
                { at: from - 2000, site: 'exampleadultsite.com', from: 'history' },
                { at: to + 1, site: 'other.test' },
              ],
            }),
          [before, after, hour],
        );
        await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
        await record.waitForFunction(() => /^Off once/.test(document.getElementById('off-summary').textContent), null, { timeout: 15_000 });
        assert.equal(
          await record.locator('#since').innerText(),
          `Watching since at least ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(before - 3 * hour)}, the first try an earlier version noted as it happened; keeping track of when it is running since ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(before - hour)}, when version 1.11.0 or later arrived.`,
        );
        assert.match(
          await record.locator('#off-summary').innerText(),
          /^Off once, from .+ until .+: \d+ pages? visited meanwhile\. 1 visit to a listed site while the extension was off, the latest on .+\. See it among every try\. 1 visit to a listed site from after the extension was installed but before it kept track of when it was running, the latest on .+: it was off then, or the site wasn't on a list yet\.$/,
          'the time off with the page visited in the silence, the visit to the listed site from it, and the link to the timeline',
        );
        assert.equal(await record.locator('#off-summary a').getAttribute('href'), 'tries.html#off');
        assert.match(await record.locator('#summary').innerText(), /^4 attempts at 2 sites, .+\. 3 from this browser's history, 1 of them from times the extension was off\.$/);
        const site = await record.evaluate(() => [...document.querySelectorAll('#sites-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.innerText)));
        assert.equal(site[0][1], '3\n1 while off');
        const state = await watchingStored(page);
        assert.equal(state.off.length, 1, JSON.stringify(state));
        assert.ok(state.off[0].pages >= 1);
        assert.deepEqual([state.off[0].from, state.off[0].to], [before - 5000, after]);

        // Every try, and the file: each visit from the history is told from the others.
        await record.goto(`chrome-extension://${browser.extensionId}/tries.html`);
        await record.waitForFunction(() => document.querySelectorAll('.day tbody tr:not(.band)').length === 4);
        const labels = await record.evaluate(() => [...document.querySelectorAll('.day tbody tr:not(.band)')].map((row) => [row.className, row.cells[2].textContent]));
        assert.deepEqual(labels, [
          ['blocked', 'Blocked'],
          ['off within', 'Visited while the add-on was off'],
          ['unseen', 'Visited after the add-on was installed'],
          ['history', 'Visited (browser history)'],
        ]);
        // The time the extension was off is laid in as a band, before the visit from inside it.
        const laid = await record.evaluate(() => [...document.querySelectorAll('.day tbody tr')].map((row) => (row.classList.contains('band') ? row.textContent : row.className)));
        assert.deepEqual([laid[0], ...laid.slice(2)], ['blocked', 'off within', 'unseen', 'history'], JSON.stringify(laid));
        assert.match(laid[1], /^Add-on off from .+ until .+: \d+ pages? visited meanwhile\.$/, 'the band');
        assert.equal(await record.locator('#off-intro').isVisible(), true, 'the line that says what a band is');
        assert.match(await record.locator('#summary').innerText(), /3 from this browser's history, 1 of them from times the extension was off\. Off once, from .+ until .+: \d+ pages? visited meanwhile\.$/);

        // The times it was off alone, with the visits from then: where the record page's link leads.
        await record.goto(`chrome-extension://${browser.extensionId}/tries.html#off`);
        await record.waitForFunction(() => !document.getElementById('filter').hidden && document.querySelectorAll('.day tbody tr').length === 2);
        assert.equal(await record.locator('#filter').innerText(), 'Only the times the add-on was off. Show every try');
        assert.match(await record.locator('#summary').innerText(), /^Off once, from .+ until .+: \d+ pages? visited meanwhile\. 1 visit to a listed site while the extension was off, the latest on .+\.$/);
        assert.deepEqual(await record.evaluate(() => [...document.querySelectorAll('.day tbody tr')].map((row) => row.className)), ['band', 'off within']);
        assert.equal(await record.title(), 'Family Site Blocker record: while the add-on was off');
        await record.click('#filter-clear');
        await record.waitForFunction(() => document.getElementById('filter').hidden && document.querySelectorAll('.day tbody tr:not(.band)').length === 4);
        const [download] = await Promise.all([record.waitForEvent('download'), record.click('#save-file')]);
        const lines = readFileSync(await download.path(), 'utf8').split('\n');
        assert.deepEqual(lines.slice(1, 5).map((line) => line.split(',').slice(2).join(',')), ['Visited (browser history)', 'Visited after the add-on was installed', 'Visited while the add-on was off', 'Blocked']);

        // A visit the history holds from a time the extension was running (now), found by a look through
        // it: the extension noted no try, so the site can't have been listed then.
        const scannedBefore = await page.evaluate(() => chrome.storage.local.get('historyScan').then((got) => got.historyScan?.at ?? 0));
        await page.evaluate(() => chrome.history.addUrl({ url: 'http://exampleadultsite.com/listed-later' }));
        await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scan-history' })); // as the record page's button does
        await page.waitForFunction((at) => chrome.storage.local.get('historyScan').then((got) => got.historyScan?.at > at && got.historyScan.found >= 1), scannedBefore, { timeout: 15_000 });
        await record.waitForFunction(() => document.querySelectorAll('.day tbody tr:not(.band)').length === 5);
        assert.deepEqual(await record.evaluate(() => [...document.querySelectorAll('.day tbody tr:not(.band)')].slice(0, 1).map((row) => [row.className, row.cells[2].textContent])), [['unlisted', 'Visited before the site was listed']]);
        await record.goto(`chrome-extension://${browser.extensionId}/attempts.html`);
        await record.waitForFunction(() => /1 visit to a listed site from before the site was listed, while the extension was running\.$/.test(document.getElementById('off-summary').textContent));
        assert.deepEqual(record.errors, []);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.evaluate((state) => chrome.storage.local.set({ watching: state }).then(() => chrome.storage.local.remove(['attempts', 'historyScan'])), original).catch(() => {});
        await record.close();
        await page.close();
      }
    });

    test('when a silence ends, the history is looked through for what was missed meanwhile', async () => {
      const page = await freshRecord();
      const original = await watchingStored(page);
      try {
        // Make the last stretch end ten minutes ago, as if the extension had just come back on. Its next
        // note of running then starts a new stretch, and a look through the history follows.
        const scanBefore = await page.evaluate(() => chrome.storage.local.get('historyScan').then((got) => got.historyScan?.at ?? 0));
        await page.evaluate((state) => {
          const periods = [...state.periods];
          const last = periods[periods.length - 1];
          periods[periods.length - 1] = { from: Math.min(last.from, Date.now() - 20 * 60_000), to: Date.now() - 10 * 60_000 };
          return chrome.storage.local.set({ watching: { ...state, periods } });
        }, original);
        await pause(5100); // past the few seconds in which page loads don't look at the stored state again
        assert.equal((await visit(browser.context, 'http://allowed.test/back-on')).outcome, 'site loaded');
        await page.waitForFunction((at) => chrome.storage.local.get('historyScan').then((got) => (got.historyScan?.at ?? 0) > at), scanBefore, { timeout: 15_000 });
        const state = await watchingStored(page);
        assert.ok(state.periods.length >= 2, `a new stretch: ${JSON.stringify(state.periods)}`);
        assert.ok(Date.now() - state.periods[state.periods.length - 1].from < 15_000, 'started just now');
      } finally {
        await page.evaluate((state) => chrome.storage.local.set({ watching: state }).then(() => chrome.storage.local.remove(['attempts', 'historyScan'])), original).catch(() => {});
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
      stub.page('allowed.test/backgrounds', backgroundsPage());
      // Videos from the page's own site, whose frames it may read: red is "nude" to the stand-in, blue a photo.
      serveVideos(stub);
      stub.page(
        'allowed.test/videos',
        videoPage([
          'id="red" src="/videos/red.webm" autoplay muted loop',
          'id="blue" src="/videos/blue.webm" autoplay muted loop',
          'id="turns" src="/videos/blue-then-red.webm" autoplay muted loop',
          'id="poster-bad" src="/videos/blue.webm" poster="http://pics.test/pics/lingerie.jpg?poster" preload="none"',
          'id="poster-ok" src="/videos/blue.webm" poster="http://pics.test/pics/photo.jpg?poster" preload="none"',
          'id="metadata" src="/videos/blue.webm" preload="metadata" controls',
        ]),
      );
      // Videos from another site: the page may read their frames only when that site allows it (CORS).
      stub.page(
        'allowed.test/videos-elsewhere',
        videoPage([
          'id="foreign" src="http://videos.test/videos/red.webm" autoplay muted loop',
          'id="foreign-poster" src="http://videos.test/videos/red.webm" poster="http://pics.test/pics/lingerie.jpg?fp" preload="none"',
          'id="foreign-allowed" src="http://videos.test/videos/cors/red.webm" crossorigin="anonymous" autoplay muted loop',
        ]),
      );
      // A page that makes its own video (a blob: address, as players that stream do) from a red one.
      stub.page('allowed.test/video-blob', videoPage(['id="made" autoplay muted loop'], `<script>fetch('/videos/red.webm').then((r) => r.blob()).then((b) => { document.getElementById('made').src = URL.createObjectURL(b); });</script>`));
      // The device's own camera (Chromium's fake one, green: "lingerie" to the stand-in), alone and next
      // to the same picture as streams from elsewhere.
      stub.page('camera.test/camera', cameraPage());
      stub.page('camera.test/streams', cameraPage({ streams: true }));
      standIn = extensionWithStandInClassifier();
      judge = await launchBrowser(stub, { extensionDir: standIn.dir, args: FAKE_CAMERA_ARGS });
      // This copy opens its settings page on install too, and Chrome puts that page into the tab in front
      // when that tab is blank, which could be the first test's (#109): let it open, then close it, as the
      // main group does.
      await (await findPage(judge.context, (url) => url.endsWith('/options.html')))?.close();
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
        assert.match(await record.locator('#summary').innerText(), /^\d+ pictures hidden on \d+ sites?, the latest at .+\. \d+ of them (is|are) borderline\.$/);
        const sites = await record.evaluate(() => [...document.querySelectorAll('#hidden-sites-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        assert.ok(sites.some((row) => row[0] === 'allowed.test' && Number(row[1]) >= 3), JSON.stringify(sites));
        const rows = await record.evaluate(() => [...document.querySelectorAll('#hidden-pictures-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        const nude = rows.find((row) => row[2].endsWith('/nude.jpg'));
        assert.deepEqual(nude.slice(1), ['allowed.test', 'http://pics.test/pics/nude.jpg', 'Nudity', '0.92', '0.02', 'Copy address'], JSON.stringify(rows));
        assert.equal(rows.find((row) => row[2].endsWith('/lingerie.jpg'))[3], 'Suggestive');
        // The drawn picture was hidden on 0.53, a close call: marked borderline, the likelier mistake (#56).
        const drawn = rows.find((row) => row[2].endsWith('/drawn.jpg'));
        assert.equal(drawn[3], 'Nudityborderline');
        assert.equal(await record.locator('#hidden-pictures-table tr.borderline').count(), 1, 'only the close call is marked');
        // Copy address puts the picture's address on the clipboard, to be opened in a browser without the extension.
        await judge.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const drawnRow = record.locator('#hidden-pictures-table tbody tr', { hasText: 'drawn.jpg' });
        await drawnRow.locator('button').click();
        await record.waitForFunction(() => /Address copied/.test(document.getElementById('copy-status').textContent));
        assert.equal(await record.evaluate(() => navigator.clipboard.readText()), 'http://pics.test/pics/drawn.jpg');
        assert.equal(await drawnRow.locator('button').innerText(), 'Copied');

        await settings.waitForFunction(() => /pictures? judged, \d+ hidden/.test(document.getElementById('picture-status').textContent));
        assert.match(await settings.locator('#picture-status').innerText(), /^Pictures and videos are judged before they show: since the browser started, \d+ pictures judged, \d+ hidden \(stand-in\)\.$/);
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

    // A picture an element's own style sets as its background (#80): X shows a tweet's picture that way,
    // under a see-through <img>, so hiding the <img> alone left the picture in view.
    test('a picture set as a background in the element\'s own style is judged like an <img>: no background until judged, then shown or kept hidden', async () => {
      const page = await judge.context.newPage();
      const backgrounds = () => page.evaluate(`Object.fromEntries(${BACKGROUND_MARKS})`);
      try {
        await page.goto('http://allowed.test/backgrounds', { waitUntil: 'domcontentloaded' });
        const early = await backgrounds();
        for (const [id, [mark, background]] of Object.entries(early)) {
          if (mark === null || mark === 'checking') assert.equal(background, 'none', `${id}: no background while being judged`);
        }
        await settled(page, ['bg-nude', 'bg-photo', 'bg-layers', 'bg-icon', 'bg-thumb', 'bg-mask', 'x-bg', 'x-img']);
        const judgedMarks = await backgrounds();
        const pick = (id) => judgedMarks[id];
        assert.deepEqual(pick('bg-nude'), ['hidden', 'none']);
        assert.deepEqual(pick('bg-photo'), ['ok', 'url("http://pics.test/pics/photo.jpg?bg")'], 'a background: shorthand counts');
        assert.deepEqual(pick('bg-layers'), ['hidden', 'none'], 'one layer to hide hides them all');
        assert.deepEqual(pick('bg-icon'), ['small', 'url("http://pics.test/icon.gif")'], 'a small element showing a small picture is an icon');
        assert.deepEqual(pick('bg-thumb'), ['hidden', 'none'], 'a small element showing a big picture is judged');
        assert.deepEqual(pick('bg-mask'), ['ok', 'none'], 'a url( that is not a background gives nothing to judge');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('bg-mask')).backgroundColor), 'rgb(255, 0, 0)', 'only the background picture goes');
        // The X-like pair: the background and the see-through <img> carry the same address, and both are hidden.
        assert.deepEqual(pick('x-bg'), ['hidden', 'none']);
        assert.deepEqual((await marks(page))['x-img'], ['hidden', 'hidden']);
        // The element keeps its size, and what is in it stays in view.
        const box = await page.evaluate(() => { const r = document.getElementById('bg-nude').getBoundingClientRect(); return [r.width, r.height]; });
        assert.deepEqual(box, [300, 200]);
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('words')).visibility), 'visible');

        // Given a background later, or another one: judged again; a style change that keeps the address is not.
        await page.waitForFunction(() => document.getElementById('bg-late').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        await page.waitForFunction(() => document.getElementById('bg-photo').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('bg-nude')).transform !== 'none');
        const later = await backgrounds();
        assert.deepEqual([later['bg-late'], later['bg-photo'], later['bg-nude']], [['hidden', 'none'], ['hidden', 'none'], ['hidden', 'none']], JSON.stringify(later));

        // The record has each hidden picture once, under the page's site, the X pair's once between them.
        const settings = await openSettingsIn(judge);
        try {
          const stored = await settings.evaluate(() => chrome.storage.local.get('pictures').then((got) => got.pictures ?? []));
          const here = stored.filter((entry) => entry.site === 'allowed.test' && /\?(bg|layer|thumb|x|late-bg|swapped-bg)$/.test(entry.url)).map((entry) => entry.url.split('/').pop());
          assert.deepEqual(here.sort(), ['lingerie.jpg?layer', 'lingerie.jpg?x', 'nude.jpg?bg', 'nude.jpg?late-bg', 'nude.jpg?swapped-bg', 'nude.jpg?thumb'], JSON.stringify(stored));
        } finally {
          await settings.close();
        }

        // The page can't bring a hidden background back by taking the mark off: it is judged again at once.
        await page.evaluate(() => document.getElementById('bg-nude').removeAttribute('data-family-site-blocker'));
        await page.waitForFunction(() => document.getElementById('bg-nude').getAttribute('data-family-site-blocker') === 'hidden');
        assert.equal((await backgrounds())['bg-nude'][1], 'none');
        assert.deepEqual(page.errors ?? [], []);
      } finally {
        await page.close();
      }
    });

    const marksSeen = (page, id) => page.evaluate((i) => window.__marks[i] ?? [], id);
    const paused = (page, id) => page.evaluate((i) => document.getElementById(i).paused, id);

    test('a video is judged out of sight by its poster and first frame, then by a frame every moment as it plays; one that shows something is hidden and paused', async () => {
      const page = await judge.context.newPage();
      try {
        await page.goto('http://allowed.test/videos', { waitUntil: 'domcontentloaded' });
        // Every video is hidden from the start, before any frame could be seen.
        const early = await marks(page);
        for (const id of ['red', 'blue', 'turns', 'poster-bad', 'poster-ok']) {
          assert.ok(['checking', 'ok', 'hidden'].includes(early[id]?.[0]), `${id} is marked from the start: ${JSON.stringify(early[id])}`);
          if (early[id][0] === 'checking') assert.equal(early[id][1], 'hidden', `${id}: hidden while being judged`);
        }
        await settled(page, ['red', 'blue', 'poster-bad', 'poster-ok', 'metadata']);
        const after = await marks(page);
        assert.deepEqual(
          { red: after.red, blue: after.blue, posterBad: after['poster-bad'], posterOk: after['poster-ok'], metadata: after.metadata },
          { red: ['hidden', 'hidden'], blue: ['ok', 'visible'], posterBad: ['hidden', 'hidden'], posterOk: ['ok', 'visible'], metadata: ['ok', 'visible'] },
        );
        // The red video was never shown: hidden while judged, then kept hidden. The blue one was judged out
        // of sight too, then shown.
        assert.ok(!(await marksSeen(page, 'red')).includes('ok'), `red was shown at some point: ${JSON.stringify(await marksSeen(page, 'red'))}`);
        assert.deepEqual(await marksSeen(page, 'blue'), ['checking', 'ok']);
        // The hidden one is paused; the shown one plays on, and keeps being judged as it does.
        await page.waitForFunction(() => document.getElementById('red').paused);
        assert.equal(await paused(page, 'blue'), false, 'the blue video plays');
        const box = await page.evaluate(() => { const r = document.getElementById('red').getBoundingClientRect(); return [r.width, r.height]; });
        assert.ok(box[0] === 300 && box[1] > 0, `a hidden video keeps its place on the page: ${box}`);
        // One that starts fine and turns is shown first, then hidden within a moment and paused.
        await page.waitForFunction(() => document.getElementById('turns').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        const turns = await marksSeen(page, 'turns');
        assert.ok(turns.indexOf('ok') >= 0 && turns.indexOf('ok') < turns.lastIndexOf('hidden'), `shown, then hidden: ${JSON.stringify(turns)}`);
        await page.waitForFunction(() => document.getElementById('turns').paused);
        // The page starting a hidden video again finds it paused again, still hidden; and taking the mark
        // off doesn't bring it back.
        await page.evaluate(() => document.getElementById('red').play().catch(() => {}));
        await page.waitForFunction(() => document.getElementById('red').paused && getComputedStyle(document.getElementById('red')).visibility === 'hidden');
        await page.evaluate(() => document.getElementById('red').removeAttribute('data-family-site-blocker'));
        await page.waitForFunction(() => document.getElementById('red').getAttribute('data-family-site-blocker') === 'hidden');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('red')).visibility), 'hidden');
        // A new source starts over: the red video given the blue one is judged again and shown.
        await page.evaluate(() => { document.getElementById('red').src = '/videos/blue.webm'; });
        await page.waitForFunction(() => document.getElementById('red').getAttribute('data-family-site-blocker') === 'ok', null, { timeout: 20_000 });
      } finally {
        await page.close();
      }
    });

    test("a video from another site is judged by its frames only when that site allows the page to read them; otherwise by its poster alone, or shown as it is; a video the page made itself is judged", async () => {
      const page = await judge.context.newPage();
      try {
        await page.goto('http://allowed.test/videos-elsewhere', { waitUntil: 'domcontentloaded' });
        await settled(page, ['foreign', 'foreign-poster', 'foreign-allowed']);
        const after = await marks(page);
        assert.deepEqual(
          { foreign: after.foreign, foreignPoster: after['foreign-poster'], foreignAllowed: after['foreign-allowed'] },
          { foreign: ['ok', 'visible'], foreignPoster: ['hidden', 'hidden'], foreignAllowed: ['hidden', 'hidden'] },
        );
        assert.equal(await paused(page, 'foreign'), false, 'a video that could not be judged plays as it is');
        await page.waitForFunction(() => document.getElementById('foreign-allowed').paused);
        // Streaming players give a video a blob: address made from data the page fetched itself: those frames can be read.
        await page.goto('http://allowed.test/video-blob', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('made').getAttribute('data-family-site-blocker') === 'hidden', null, { timeout: 20_000 });
        assert.ok(!(await marksSeen(page, 'made')).includes('ok'), JSON.stringify(await marksSeen(page, 'made')));
      } finally {
        await page.close();
      }
    });

    test("a video of the device's own camera is shown as it is and never judged; the same picture as a stream the page made, or from another peer, is judged and hidden", async () => {
      const page = await judge.context.newPage();
      try {
        // The camera alone (#84): shown once the stream is known to be the camera's, and left alone after.
        await page.goto('http://camera.test/camera', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__ready || window.__error);
        assert.equal(await page.evaluate(() => window.__error), undefined);
        await settled(page, ['camera']);
        assert.deepEqual((await marks(page)).camera, ['ok', 'visible']);
        await page.waitForTimeout(3500); // long enough for two frames to have been judged, had it been judged
        assert.deepEqual(await marksSeen(page, 'camera'), ['checking', 'ok'], 'never hidden');
        assert.equal(await paused(page, 'camera'), false, 'the camera plays on');
        const seen = await page.evaluate(() => { const v = document.getElementById('camera'); return [v.videoWidth > 0, v.currentTime > 0]; });
        assert.deepEqual(seen, [true, true], `the camera's picture is there: ${seen}`);
        // The control: the picture the camera shows is one the stand-in hides. Copied through a canvas into
        // a stream the page made, it is judged by its frames (the first of which may be black, before the
        // camera's picture arrives), hidden and paused within a moment, and noted under the page's address;
        // so is a green picture arriving through a peer connection, as another person's camera does in a call.
        await page.goto('http://camera.test/streams', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__ready || window.__error);
        assert.equal(await page.evaluate(() => window.__error), undefined);
        const peerState = () => page.evaluate(() => { const v = document.getElementById('peer'); return { connection: window.__peer, readyState: v.readyState, width: v.videoWidth, time: v.currentTime }; });
        await page.waitForFunction(() => ['copy', 'peer'].every((id) => document.getElementById(id).getAttribute('data-family-site-blocker') === 'hidden'), null, { timeout: 20_000 }).catch(async (error) => {
          throw new Error(`${error.message}; marks ${JSON.stringify(await marks(page))}; the peer's video ${JSON.stringify(await peerState())}`);
        });
        const after = await marks(page);
        assert.deepEqual([after.camera, after.copy, after.peer], [['ok', 'visible'], ['hidden', 'hidden'], ['hidden', 'hidden']], JSON.stringify(after));
        await page.waitForFunction(() => document.getElementById('copy').paused && document.getElementById('peer').paused);
        assert.equal(await paused(page, 'camera'), false, 'the camera plays on');
        assert.deepEqual(await marksSeen(page, 'camera'), ['checking', 'ok'], 'the camera was never hidden');
        const settings = await openSettingsIn(judge);
        try {
          const record = await settings.evaluate(() => chrome.storage.local.get('pictures').then((got) => got.pictures ?? []));
          const here = record.filter((entry) => entry.site === 'camera.test');
          assert.ok(here.length >= 1 && here.every((entry) => entry.kind === 'video' && entry.url === 'http://camera.test/streams' && entry.reason === 'suggestive'), JSON.stringify(here));
        } finally {
          await settings.close();
        }
      } finally {
        await page.close();
      }
    });

    test("hidden videos go into the record as videos, under the video's address or, for one the page made, the page's; the pages and the settings page count them", async () => {
      const settings = await openSettingsIn(judge);
      const record = await judge.context.newPage();
      try {
        const stored = await settings.evaluate(() => chrome.storage.local.get('pictures').then((got) => got.pictures ?? []));
        const videos = stored.filter((entry) => entry.kind === 'video');
        assert.ok(videos.length >= 3, JSON.stringify(stored));
        const red = videos.find((entry) => entry.url === 'http://allowed.test/videos/red.webm');
        assert.deepEqual([red.site, red.reason, red.scores], ['allowed.test', 'nudity', { porn: 0.9, hentai: 0.02, sexy: 0.02 }], JSON.stringify(videos));
        assert.ok(videos.some((entry) => entry.url === 'http://allowed.test/videos/blue-then-red.webm'), 'the video that turned');
        assert.ok(videos.some((entry) => entry.url === 'http://videos.test/videos/cors/red.webm'), 'the video from the other site');
        assert.ok(videos.some((entry) => entry.url === 'http://allowed.test/video-blob'), "the video the page made is noted under the page's address");
        assert.ok(!stored.some((entry) => entry.url === 'http://allowed.test/videos/blue.webm'), 'shown videos are not recorded');
        assert.ok(stored.some((entry) => entry.url === 'http://pics.test/pics/lingerie.jpg?poster' && entry.kind === undefined), 'a video hidden by its poster is noted as that picture');
        assert.ok(stored.every((entry) => !entry.url.startsWith('data:') && !entry.url.startsWith('blob:')), 'no frame or blob: address is kept');

        await record.goto(`chrome-extension://${judge.extensionId}/attempts.html`);
        await record.waitForFunction(() => /^\d+ pictures and \d+ videos hidden on \d+ sites?, the latest at /.test(document.querySelector('#pictures-line span').textContent));
        await record.goto(`chrome-extension://${judge.extensionId}/pictures.html`);
        await record.waitForFunction(() => document.querySelectorAll('#hidden-pictures-table tbody tr').length >= 6);
        assert.match(await record.locator('#summary').innerText(), /^\d+ pictures and \d+ videos hidden on \d+ sites?, the latest at /);
        const rows = await record.evaluate(() => [...document.querySelectorAll('#hidden-pictures-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)));
        const redRow = rows.find((row) => row[2].endsWith('/videos/red.webm'));
        assert.deepEqual(redRow.slice(1), ['allowed.test', 'videohttp://allowed.test/videos/red.webm', 'Nudity', '0.92', '0.02', 'Copy address'], JSON.stringify(rows));
        assert.equal(await record.locator('#hidden-pictures-table tbody tr', { hasText: '/videos/red.webm' }).locator('.kind-mark').textContent(), 'video');
        assert.equal(await record.locator('#hidden-pictures-table tbody tr', { hasText: '/pics/nude.jpg' }).locator('.kind-mark').count(), 0, 'pictures carry no mark');

        await settings.waitForFunction(() => /video frames judged/.test(document.getElementById('picture-status').textContent));
        assert.match(await settings.locator('#picture-status').innerText(), /^Pictures and videos are judged before they show: since the browser started, \d+ pictures judged, \d+ hidden; \d+ video frames judged, \d+ videos hidden \(stand-in\)\.$/);
      } finally {
        await record.close();
        await settings.close();
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
    // A test that solves puzzles and seals the password again more than once needs longer on a GitHub machine.
    const slowTest = (name, fn) => it(name, { timeout: 60_000 }, fn);

    // The password has a page of its own since #70; the settings page shows one line on where it stands.
    async function freshSettings() {
      const page = await browser.context.newPage();
      page.errors = [];
      page.on('pageerror', (error) => page.errors.push(error.message));
      await page.goto(`chrome-extension://${browser.extensionId}/lockbox.html`);
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

    test('locking away clears the password from the clipboard when it was copied out of the box', async () => {
      const page = await freshSettings();
      try {
        await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.click('#lockbox-make');
        const made = await page.inputValue('#lockbox-secret');
        await page.keyboard.press('ControlOrMeta+C');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), made, 'copied by hand, as the page asks');
        await page.evaluate(() => document.getElementById('lockbox-delay').append(new Option('3 seconds', '3', true, true)));
        await page.click('#lockbox-lock');
        await page.locator('#lockbox-locked').waitFor({ state: 'visible', timeout: 15_000 });
        assert.equal(await lockboxStatus(page), 'Locked away. Cleared from the clipboard too. Save a backup file so it isn’t lost if the extension is removed.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '', 'nothing left to paste');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('locking a password away keeps only a puzzle: the password is nowhere in storage', async () => {
      const page = await freshSettings();
      try {
        assert.equal(await page.locator('#lockbox-record').isVisible(), false, 'no record yet');
        await lockAway(page, SECRET, 3);
        assert.equal(await page.inputValue('#lockbox-secret'), '', 'the typed password is cleared');
        assert.match(await page.locator('#lockbox-summary').innerText(), /^A password is locked away \(since .+\)\. Getting it back takes about [1-4] seconds of computing/);
        const stored = await storedLockbox(page);
        assert.ok(!JSON.stringify(stored).includes(SECRET));
        assert.equal(stored.lockbox.delay, 3);
        assert.ok(stored.lockbox.steps > 1000, `steps: ${stored.lockbox.steps}`);
        assert.match(await page.locator('#version').innerText(), /^Version \d+\.\d+\.\d+$/);
        // The record begins (#75): one entry, with the time, shown under the password.
        assert.equal(stored.lockboxEvents.length, 1);
        assert.equal(stored.lockboxEvents[0].event, 'locked');
        assert.equal(stored.lockboxEvents[0].delay, 3);
        assert.ok(Math.abs(Date.parse(stored.lockboxEvents[0].at) - Date.now()) < 60_000, stored.lockboxEvents[0].at);
        assert.equal(await page.locator('#lockbox-record').isVisible(), true);
        assert.deepEqual((await shownRecord(page)).map(({ what, hidden }) => [what, hidden]), [['Locked away, with a wait of 3 seconds.', false], ['The record began.', false]], 'the entry, and the beginning as the last row');
        assert.match((await shownRecord(page))[0].when, /\d{4}.*\d:\d\d/, 'the day and the time');
        assert.equal(await page.locator('#lockbox-events-more').isVisible(), false, 'nothing folded away');
        // And the table's last row says when the record began (1.11.4; a row from 1.13.1): now, kept for when the oldest entries go.
        assert.equal((await shownRecord(page)).at(-1).when, (await shownRecord(page))[0].when, "the beginning is the first entry's time");
        assert.equal(stored.lockboxEventsSince, stored.lockboxEvents[0].at);
        assert.deepEqual(page.errors, []);
        // The settings page says where it stands, and follows along.
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => /^A password is locked away/.test(document.getElementById('lockbox-line').textContent));
          assert.match(await settings.locator('#lockbox-line').innerText(), /^A password is locked away \(since .+\), never unlocked; getting it back takes about [1-4] seconds\.$/);
          await settings.evaluate(() => chrome.storage.local.remove(['lockbox', 'lockboxProgress']));
          await settings.waitForFunction(() => document.getElementById('lockbox-line').textContent === 'No password is locked away.');
        } finally {
          await settings.close();
        }
      } finally {
        await page.close();
      }
    });

    slowTest('unlocking takes the wait, shows the password, and locks it away again with a fresh puzzle', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 3);
        const before = (await storedLockbox(page)).lockbox;

        // Since 1.13.2 the page asks why first, and won't start without an answer, which goes into the record.
        await page.click('#lockbox-start');
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === 'Say why you’re unlocking it first. Your answer goes into the record.');
        assert.equal(await page.locator('#lockbox-progress-area').isVisible(), false, 'nothing started');
        assert.deepEqual(await recordedEvents(page), ['locked']);
        const started = Date.now();
        await startUnlocking(page, 'to set up the printer');
        await page.locator('#lockbox-progress-area').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#lockbox-why-area').isVisible(), false, 'not asked again while it unlocks');
        assert.equal(await page.locator('#lockbox-delete').isVisible(), false, 'no deleting while it unlocks');
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        const took = (Date.now() - started) / 1000;
        assert.ok(took >= 1.5, `opened after ${took} s, sooner than the 3-second wait allows`);
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);

        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '');
        const after = (await storedLockbox(page)).lockbox;
        assert.notEqual(after.n, before.n, 'a new puzzle');

        // Copy puts the password on the clipboard and says so right beside the button, on its line, rather
        // than on the status line at the foot of the panel, below the wait chooser, where it was easy to miss.
        assert.equal(await page.locator('#lockbox-copied').isVisible(), false, 'nothing copied yet');
        await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.click('#lockbox-copy');
        await page.locator('#lockbox-copied').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#lockbox-copied').innerText(), 'Copied');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SECRET);
        assert.equal(await lockboxStatus(page), '', 'the status line stays empty');
        const [copyButton, copied] = await Promise.all([page.locator('#lockbox-copy').boundingBox(), page.locator('#lockbox-copied').boundingBox()]);
        const gap = copied.x - (copyButton.x + copyButton.width);
        assert.ok(gap >= 0 && gap <= 24, `"Copied" is ${gap}px right of the Copy button`);
        assert.ok(Math.abs(copied.y + copied.height / 2 - (copyButton.y + copyButton.height / 2)) <= 4, 'on the button’s line');
        assert.equal(after.delay, 3, 'with the same wait');
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined, "no progress left behind");
        assert.ok(!JSON.stringify(await storedLockbox(page)).includes(SECRET));

        // The record has the unlock: started, shown (saying when it started) and locked away again (#75).
        assert.deepEqual(await recordedEvents(page), ['locked', 'started', 'shown', 'sealed']);
        const { lockboxEvents: events } = await storedLockbox(page);
        assert.equal(events[2].startedAt, events[1].at, 'the start the password was shown after');
        assert.equal(events[1].why, 'to set up the printer', 'the reason, with the start');
        assert.equal(events[2].why, 'to set up the printer', 'and with the password shown');
        assert.equal(events[3].delay, 3);
        const rows = await shownRecord(page);
        assert.equal(rows[0].what, 'Locked away again, with the same wait of 3 seconds.');
        assert.match(rows[1].what, /^The password was shown \(unlocking started .+\d:\d\d.*: “to set up the printer”\)\.$/);
        assert.equal(rows[2].what, 'Unlocking started: “to set up the printer”.');
        assert.equal(rows[3].what, 'Locked away, with a wait of 3 seconds.');
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => /unlocked once/.test(document.getElementById('lockbox-line').textContent));
          assert.match(await settings.locator('#lockbox-line').innerText(), /^A password is locked away \(since .+\), unlocked once, last on .+; getting it back takes about [1-4] seconds\.$/);
        } finally {
          await settings.close();
        }

        await page.click('#lockbox-hide');
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.equal(await page.inputValue('#lockbox-revealed'), '');
        // Hiding it clears the copy on the clipboard, and says so.
        await page.waitForFunction(() => /^Hidden/.test(document.getElementById('lockbox-status').textContent));
        assert.equal(await lockboxStatus(page), 'Hidden. Cleared from the clipboard too.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '', 'nothing left to paste');

        // The next time the password is shown, "Copied" isn't, until Copy is clicked again.
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        assert.equal(await page.locator('#lockbox-copied').isVisible(), false, '"Copied" was for the copy just made');
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '', null, { timeout: 15_000 });
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('closing the page pauses unlocking, and it carries on from there when reopened', async () => {
      let page = await freshSettings();
      try {
        await lockAway(page, SECRET, 6);
        await startUnlocking(page, 'to try it');
        await progressSaved(page);
        const { lockboxProgress: saved } = await storedLockbox(page);
        assert.equal(saved.why, 'to try it', 'the reason goes with the progress, for the page reopened');
        assert.ok(Math.abs(Date.parse(saved.startedAt) - Date.now()) < 60_000, `started at ${saved.startedAt}`);
        assert.ok(Date.parse(saved.workedAt) >= Date.parse(saved.startedAt), 'last worked on, at or after the start');
        await page.close();

        page = await browser.context.newPage();
        page.errors = [];
        page.on('pageerror', (error) => page.errors.push(error.message));
        await page.goto(`chrome-extension://${browser.extensionId}/lockbox.html`);
        await page.waitForFunction(() => document.getElementById('lockbox-start').textContent === 'Carry on unlocking');
        assert.equal(await page.locator('#lockbox-why-area').isVisible(), false, 'carrying on asks for no reason again');
        // Meanwhile the settings page says so in its line, with the day the work started.
        const settings = await openSettings();
        await settings.waitForFunction(() => /unlocking it is \d+% done, started .+\.$/.test(document.getElementById('lockbox-line').textContent));
        await settings.close();
        assert.match(await page.locator('#lockbox-progress-text').innerText(), /^\d+% done, about \d+ seconds? to go\.$/);
        assert.equal(await page.locator('#lockbox-stop').isVisible(), true);
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        // Carrying on went into the record, with how far it had got, and the start the password was shown after is the first one.
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '', null, { timeout: 15_000 });
        assert.deepEqual(await recordedEvents(page), ['locked', 'started', 'resumed', 'shown', 'sealed']);
        const { lockboxEvents: events } = await storedLockbox(page);
        assert.ok(events[2].done > 0 && events[2].done < events[2].steps, `carried on from ${events[2].done} of ${events[2].steps}`);
        assert.equal(events[3].startedAt, events[1].at);
        assert.equal(events[3].why, 'to try it', 'and the reason, from the progress');
        assert.match((await shownRecord(page))[2].what, /^Unlocking carried on, from \d+% done\.$/);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('stopping unlocking throws the work away, and the password stays locked', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 30);
        await startUnlocking(page);
        await progressSaved(page);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-stop');
        await page.waitForFunction(() => /^Unlocking stopped/.test(document.getElementById('lockbox-status').textContent));
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined);
        assert.equal(await page.locator('#lockbox-start').innerText(), 'Start unlocking');
        assert.equal(await page.locator('#lockbox-progress-area').isVisible(), false);
        assert.ok((await storedLockbox(page)).lockbox, 'still locked away');
        assert.deepEqual(await recordedEvents(page), ['locked', 'started', 'stopped']);
        const { lockboxEvents: events } = await storedLockbox(page);
        assert.ok(events[2].done > 0 && events[2].steps > events[2].done, `stopped at ${events[2].done} of ${events[2].steps}`);
        assert.match((await shownRecord(page))[0].what, /^Unlocking stopped at \d+% done; the work was thrown away\.$/);
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
        // The password and the progress are gone; the record stays, and says so (#75), and so do the waits set
        // for each password (1.13.0). Only the lockbox's own keys count: the background script's note of when it
        // is running can be written at any moment (#131).
        assert.deepEqual(Object.keys(await storedLockbox(page)).filter((key) => key.startsWith('lockbox')).sort(), ['lockboxEvents', 'lockboxEventsSince', 'lockboxWaits']);
        assert.deepEqual(await recordedEvents(page), ['locked', 'deleted']);
        assert.equal(await page.locator('#lockbox-record').isVisible(), true);
        assert.equal((await shownRecord(page))[0].what, 'Deleted.');
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => /deleted on/.test(document.getElementById('lockbox-line').textContent));
          assert.match(await settings.locator('#lockbox-line').innerText(), /^No password is locked away; the last one was deleted on .+\.$/);
        } finally {
          await settings.close();
        }

        await page.setInputFiles('#lockbox-restore', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
        await page.waitForFunction(() => /isn’t a backup/.test(document.getElementById('lockbox-status').textContent));
        assert.deepEqual(await recordedEvents(page), ['locked', 'deleted'], 'a file that is no backup is not recorded');

        await page.setInputFiles('#lockbox-restore', file);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.deepEqual(await recordedEvents(page), ['locked', 'deleted', 'restored']);
        const { lockboxEvents: events, lockbox: restored } = await storedLockbox(page);
        assert.equal(events[2].lockedAt, restored.lockedAt, 'when the backup was sealed');
        assert.match((await shownRecord(page))[0].what, /^Restored from a backup file, sealed .+\d:\d\d.*\.$/);
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '', null, { timeout: 15_000 });
        assert.deepEqual(await recordedEvents(page), ['locked', 'deleted', 'restored', 'started', 'shown', 'sealed']);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    // A backup file saved before the wait was lengthened can't be changed, but this profile notes the boxes that
    // have held each password and the wait set for it (lib/lockbox.js WAITS), and lengthens such a file's box to
    // that wait as it is restored, as Lengthen the wait does (1.13.0).
    slowTest('a backup file from before the wait was lengthened gets the longer wait as it is restored here', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 2);
        const first = (await storedLockbox(page)).lockbox;
        const [early] = await Promise.all([page.waitForEvent('download'), page.click('#lockbox-backup')]);
        const earlyFile = await early.path();
        await lengthenTo(page, 6);
        const longer = (await storedLockbox(page)).lockbox;
        const [late] = await Promise.all([page.waitForEvent('download'), page.click('#lockbox-backup')]);
        const lateFile = await late.path();
        // The password's boxes so far, each by its key, and the wait set for it.
        const { lockboxWaits: waits } = await storedLockbox(page);
        assert.deepEqual(waits, [{ delay: 6, boxes: [{ key: await boxKey(first), delay: 2 }, { key: await boxKey(longer), delay: 6 }] }]);

        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        assert.deepEqual((await storedLockbox(page)).lockboxWaits, waits, 'kept when the password is deleted: that is when a file comes back');

        // The file saved after lengthening is the box stored last, and restores as it is.
        await page.setInputFiles('#lockbox-restore', lateFile);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.equal(await lockboxStatus(page), 'Restored from the backup file. It is still locked away.');
        assert.deepEqual((await storedLockbox(page)).lockbox, longer);
        assert.deepEqual((await storedLockbox(page)).lockboxWaits, waits, 'nothing to add');
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });

        // The file saved before: its box goes inside a puzzle that takes the rest of the 6 seconds.
        await page.setInputFiles('#lockbox-restore', earlyFile);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible', timeout: 15_000 });
        assert.equal(
          await lockboxStatus(page),
          'Restored from the backup file, and the wait lengthened from 2 seconds to the 6 seconds set here since the file was saved. It is still locked away. The file itself still opens after 2 seconds anywhere else: delete it (and empty the Trash) and save a new one.',
        );
        const restored = (await storedLockbox(page)).lockbox;
        assert.equal(restored.version, 2);
        assert.equal(restored.holds, 'box');
        assert.equal(restored.delay, 6, 'the whole wait');
        assert.deepEqual(restored.inside, [{ steps: first.steps, rate: first.rate }], "the file's box inside");
        assert.equal(restored.lockedAt, first.lockedAt);
        assert.ok(restored.lengthenedAt, 'lengthened now');
        assert.ok(!JSON.stringify(await storedLockbox(page)).includes(first.data), 'the old box is inside the new puzzle, not beside it');
        assert.match(await page.locator('#lockbox-summary').innerText(), /^A password is locked away \(since .+, wait lengthened .+\)\. Getting it back takes about [5-7] seconds of computing/);
        assert.deepEqual(await recordedEvents(page), ['locked', 'lengthened', 'deleted', 'restored', 'deleted', 'restored']);
        const { lockboxEvents: events } = await storedLockbox(page);
        assert.deepEqual([events.at(-1).from, events.at(-1).to, events.at(-1).lockedAt], [2, 6, first.lockedAt]);
        assert.match((await shownRecord(page))[0].what, /^Restored from a backup file, sealed .+\d:\d\d.*, with the wait lengthened from 2 seconds to the 6 seconds set here after the file was saved\.$/);
        assert.deepEqual((await storedLockbox(page)).lockboxWaits, [{ delay: 6, boxes: [...waits[0].boxes, { key: await boxKey(restored), delay: 6 }] }], 'the box made joins the password');
        assert.ok(!JSON.stringify(await storedLockbox(page)).includes(first.n), 'the waits hold no piece of any box, not even its modulus');

        // Unlocking takes the puzzle added here, then the file's own, and ends in the password.
        const started = Date.now();
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 30_000 });
        const took = (Date.now() - started) / 1000;
        assert.ok(took >= 3, `opened after ${took} s, sooner than the 6-second wait allows`);
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '', null, { timeout: 15_000 });
        const again = (await storedLockbox(page)).lockbox;
        assert.equal(again.delay, 6, 'locked away again with the whole wait');
        assert.equal((await storedLockbox(page)).lockboxWaits[0].boxes.length, 4, 'the fresh box joins too');
        await page.click('#lockbox-hide');
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });

        // A new password locked away with a short wait has a wait of its own: the old file still gets the 6 seconds.
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        await lockAway(page, 'Another-Password', 2);
        assert.equal((await storedLockbox(page)).lockboxWaits.length, 2, 'a password of its own');
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        await page.setInputFiles('#lockbox-restore', earlyFile);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible', timeout: 15_000 });
        assert.match(await lockboxStatus(page), /^Restored from the backup file, and the wait lengthened from 2 seconds to the 6 seconds set here/);
        assert.equal((await storedLockbox(page)).lockbox.delay, 6);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('a long record shows its latest ten entries, newest first, and the rest on request', async () => {
      const page = await freshSettings();
      try {
        // A record of 14 entries, a minute apart, as the page would have written them.
        await page.evaluate(() => {
          const events = ['locked', 'started', 'stopped', 'started', 'resumed', 'shown', 'sealed', 'deleted', 'restored', 'started', 'shown', 'seal-failed', 'deleted', 'locked'].map((event, i) => ({
            at: new Date(Date.UTC(2026, 9, 11, 20, 40 + i)).toISOString(),
            event,
            ...(event === 'locked' || event === 'sealed' ? { delay: 172_800 } : {}),
            ...(event === 'stopped' || event === 'resumed' ? { done: 25 * (i + 1), steps: 1000 } : {}),
          }));
          return chrome.storage.local.set({ lockboxEvents: events });
        });
        await page.reload();
        await page.locator('#lockbox-record').waitFor({ state: 'visible' });
        const rows = await shownRecord(page);
        assert.equal(rows.length, 15, 'the 14 entries and the beginning');
        assert.deepEqual(rows.map(({ hidden }) => hidden), [...Array(10).fill(false), ...Array(4).fill(true), false], 'the beginning stays in view below the rows folded away');
        assert.deepEqual(rows.map(({ what }) => what).slice(0, 4), [
          'Locked away, with a wait of 2 days.',
          'Deleted.',
          'Couldn’t be locked away again with a fresh puzzle, so the old one was kept.',
          'The password was shown.',
        ]);
        assert.equal(rows.at(-2).what, 'Locked away, with a wait of 2 days.');
        assert.deepEqual([rows.at(-1).what, rows.at(-1).when], ['The record began.', rows.at(-2).when], 'a record from before 1.11.4 began at its oldest entry');
        assert.equal(rows.at(-4).what, 'Unlocking stopped at 7% done; the work was thrown away.');
        assert.notEqual(rows[0].when, rows.at(-2).when, 'each row has its own time');
        assert.equal(await page.locator('#lockbox-events-more').innerText(), 'Show all 14');
        await page.click('#lockbox-events-more');
        assert.deepEqual((await shownRecord(page)).map(({ hidden }) => hidden), Array(15).fill(false));
        assert.equal(await page.locator('#lockbox-events-more').isVisible(), false);
        // The settings page's line reads the record too: the password now locked away is the last one.
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => document.getElementById('lockbox-line').textContent === 'No password is locked away.');
        } finally {
          await settings.close();
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    // The wait can be lengthened without unlocking (#76): the stored box goes inside a longer puzzle.
    slowTest('lengthening the wait needs no unlocking: the box goes inside a longer puzzle, a backup of that restores, and unlocking takes both', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 2);
        const before = (await storedLockbox(page)).lockbox;
        assert.equal(await page.locator('#lockbox-lengthen-area').isVisible(), true);
        assert.deepEqual(await page.$$eval('#lockbox-longer option', (options) => options.filter((option) => option.disabled).map((option) => option.value)), [], 'every wait offered is longer than 2 seconds');

        await lengthenTo(page, 5);
        assert.match(await lockboxStatus(page), /^The wait is now [4-6] seconds\. Save a new backup file: one saved before this still opens after the old wait anywhere but here\.$/);
        const longer = (await storedLockbox(page)).lockbox;
        assert.equal(longer.version, 2);
        assert.equal(longer.holds, 'box');
        assert.notEqual(longer.n, before.n, 'a puzzle of its own');
        assert.deepEqual(longer.inside, [{ steps: before.steps, rate: before.rate }], 'says what the box inside takes');
        assert.equal(longer.delay, 5, 'the whole wait');
        assert.equal(longer.lockedAt, before.lockedAt, 'still says when the password was locked away');
        assert.ok(longer.lengthenedAt, 'and when the wait was lengthened');
        const text = JSON.stringify(await storedLockbox(page));
        assert.ok(!text.includes(before.n) && !text.includes(before.data), 'the old box is inside the new puzzle, not beside it');
        assert.ok(!text.includes(SECRET));
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined);
        assert.match(await page.locator('#lockbox-summary').innerText(), /^A password is locked away \(since .+, wait lengthened .+\)\. Getting it back takes about [4-6] seconds of computing/);
        // The record says so (#75), and lengthening is not an unlock.
        assert.deepEqual(await recordedEvents(page), ['locked', 'lengthened']);
        assert.equal((await shownRecord(page))[0].what, 'The wait was lengthened from 2 seconds to 5 seconds, without unlocking.');
        // The settings page's line says so too.
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => /wait lengthened/.test(document.getElementById('lockbox-line').textContent));
          assert.match(await settings.locator('#lockbox-line').innerText(), /^A password is locked away \(since .+, wait lengthened .+\), never unlocked; getting it back takes about [4-6] seconds\.$/);
        } finally {
          await settings.close();
        }

        // A backup file of the lengthened box is one too, and restores as one.
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#lockbox-backup')]);
        const file = await download.path();
        const { readFileSync } = await import('node:fs');
        const backup = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(backup.version, 2);
        assert.deepEqual(backup, longer);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        await page.setInputFiles('#lockbox-restore', file);
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.match(await page.locator('#lockbox-summary').innerText(), /wait lengthened .+\)\. Getting it back takes about [4-6] seconds of computing/);
        assert.deepEqual((await storedLockbox(page)).lockbox, longer);

        // Unlocking solves the outer puzzle, then the inner one, and ends in the password.
        const started = Date.now();
        await startUnlocking(page);
        await page.locator('#lockbox-progress-area').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#lockbox-lengthen-area').isVisible(), false, 'no lengthening while it unlocks');
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 30_000 });
        const took = (Date.now() - started) / 1000;
        assert.ok(took >= 2.5, `opened after ${took} s, sooner than the 5-second wait allows`);
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '');
        const after = (await storedLockbox(page)).lockbox;
        assert.equal(after.version, 1, 'locked away again as one puzzle');
        assert.equal(after.delay, 5, 'with the whole wait');
        assert.equal(after.inside, undefined);
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined);
        assert.match(await page.locator('#lockbox-again').innerText(), /^It’s already locked away again with the same wait \(5 seconds\)\. It stays on this page/);
        assert.deepEqual(await recordedEvents(page), ['locked', 'lengthened', 'deleted', 'restored', 'started', 'shown', 'sealed']);
        assert.equal((await shownRecord(page))[0].what, 'Locked away again, with the same wait of 5 seconds.');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    slowTest('closing the page once the outer puzzle is solved pauses in the inner one, and carries on from there', async () => {
      let page = await freshSettings();
      try {
        await lockAway(page, SECRET, 6);
        await lengthenTo(page, 8); // 2 seconds around the 6
        const { lockbox: box } = await storedLockbox(page);
        await startUnlocking(page);
        const stored = await progressSaved(page, (progress) => progress?.inner !== undefined, 'the work never reached the box inside');
        assert.equal(stored.lockboxProgress.n, box.n, 'progress on the stored box');
        assert.equal(stored.lockboxProgress.before, box.steps, 'the outer puzzle done');
        assert.equal(stored.lockboxProgress.inner.version, 1, 'now working on the box inside');
        assert.deepEqual(stored.lockbox, box, 'the stored box is untouched');
        await page.close();

        page = await browser.context.newPage();
        page.errors = [];
        page.on('pageerror', (error) => page.errors.push(error.message));
        await page.goto(`chrome-extension://${browser.extensionId}/lockbox.html`);
        await page.waitForFunction(() => document.getElementById('lockbox-start').textContent === 'Carry on unlocking');
        const [, percent] = /^(\d+)% done, about \d+ seconds? to go\.$/.exec(await page.locator('#lockbox-progress-text').innerText()) ?? [];
        assert.ok(Number(percent) >= outerShare(box) && Number(percent) < 100, `the outer puzzle (${outerShare(box)}% of the squarings) done: ${percent}%`);
        const settings = await openSettings();
        try {
          await settings.waitForFunction(() => /unlocking it is \d+% done, started .+\.$/.test(document.getElementById('lockbox-line').textContent));
        } finally {
          await settings.close();
        }
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    slowTest('stopping in the inner puzzle throws both away, and lengthening while paused asks first', async () => {
      let page = await freshSettings();
      try {
        await lockAway(page, SECRET, 30);
        await lengthenTo(page, 32);
        const { lockbox: box } = await storedLockbox(page);
        await startUnlocking(page);
        await progressSaved(page, (progress) => progress?.inner !== undefined, 'the work never reached the box inside');
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-stop');
        await page.waitForFunction(() => /^Unlocking stopped/.test(document.getElementById('lockbox-status').textContent));
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined, 'nothing of either layer kept');
        assert.deepEqual((await storedLockbox(page)).lockbox, box, 'still the lengthened box');
        assert.equal(await page.locator('#lockbox-start').innerText(), 'Start unlocking');
        // The outer puzzle, and a little of the inner one: the moments between the work reaching it and the stop.
        const [, stoppedAt] = /^Unlocking stopped at (\d+)% done; the work was thrown away\.$/.exec((await shownRecord(page))[0].what) ?? [];
        assert.ok(Number(stoppedAt) >= outerShare(box) && Number(stoppedAt) <= outerShare(box) + 10, `the outer puzzle (${outerShare(box)}% of the squarings) and a little more: ${stoppedAt}%`);

        // Paused with progress, lengthening asks, since it throws that progress away.
        await startUnlocking(page);
        await progressSaved(page, (progress) => progress !== undefined);
        await page.close();
        page = await browser.context.newPage();
        page.errors = [];
        page.on('pageerror', (error) => page.errors.push(error.message));
        await page.goto(`chrome-extension://${browser.extensionId}/lockbox.html`);
        await page.waitForFunction(() => document.getElementById('lockbox-start').textContent === 'Carry on unlocking');
        assert.equal(await page.locator('#lockbox-lengthen-area').isVisible(), true);
        await page.selectOption('#lockbox-longer', '600');
        // The dialog has to be answered as it appears, or the click never settles.
        const asked = new Promise((resolve) =>
          page.once('dialog', (dialog) => {
            resolve(dialog.message());
            dialog.dismiss();
          }),
        );
        await page.click('#lockbox-lengthen');
        assert.match(await asked, /throws away the unlocking done so far/);
        assert.ok((await storedLockbox(page)).lockboxProgress, 'Cancel keeps the progress');
        assert.deepEqual((await storedLockbox(page)).lockbox, box);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-lengthen');
        await page.waitForFunction(() => /^The wait is now 10 minutes\./.test(document.getElementById('lockbox-status').textContent));
        assert.equal((await storedLockbox(page)).lockboxProgress, undefined);
        const longer = (await storedLockbox(page)).lockbox;
        assert.deepEqual(longer.inside, [{ steps: box.steps, rate: box.rate }, ...box.inside], 'a third layer around the two');
        assert.equal(longer.delay, 600);
        assert.equal(await page.locator('#lockbox-start').innerText(), 'Start unlocking');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    test('only waits longer than the present one are offered for lengthening, and none at the longest', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 3600);
        const offered = () => page.$$eval('#lockbox-longer option', (options) => options.map((option) => [option.value, option.disabled, option.selected]));
        assert.deepEqual(await offered(), [
          ['600', true, false],
          ['3600', true, false],
          ['14400', false, true],
          ['43200', false, false],
          ['86400', false, false],
          ['172800', false, false],
        ]);
        assert.equal(await page.locator('#lockbox-longest').isVisible(), false);
        await page.selectOption('#lockbox-longer', '172800');
        await page.click('#lockbox-lengthen');
        await page.waitForFunction(() => /^The wait is now/.test(document.getElementById('lockbox-status').textContent));
        assert.match(await lockboxStatus(page), /^The wait is now 2 days\./);
        assert.match(await page.locator('#lockbox-summary').innerText(), /Getting it back takes about 2 days of computing/);
        const box = (await storedLockbox(page)).lockbox;
        assert.equal(box.delay, 172_800);
        const wait = box.steps / box.rate + box.inside[0].steps / box.inside[0].rate;
        assert.ok(Math.abs(wait - 172_800) < 2, `the layers add up to 2 days: ${wait} s`);
        assert.ok((await offered()).every(([, disabled]) => disabled), 'nothing longer left');
        assert.equal(await page.locator('#lockbox-longest').isVisible(), true);
        assert.equal(await page.locator('#lockbox-lengthen').isDisabled(), true);
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#lockbox-delete');
        await page.locator('#lockbox-empty').waitFor({ state: 'visible' });
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });

    slowTest('once unlocked, the password can be locked away again with a different wait, longer or shorter', async () => {
      const page = await freshSettings();
      try {
        await lockAway(page, SECRET, 2);
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => document.getElementById('lockbox-status').textContent === '');
        const same = (await storedLockbox(page)).lockbox;
        assert.equal(same.delay, 2);
        assert.deepEqual(await page.$$eval('#lockbox-new-wait option', (options) => options.map((option) => option.value)), ['60', '600', '3600', '14400', '43200', '86400', '172800'], 'the same waits as locking away offers');

        // Longer: the warning about older backup files comes with it. Copied first: locking it away again clears
        // the clipboard, so that the password isn't left there to paste, and the Copied note goes with it.
        await browser.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.click('#lockbox-copy');
        await page.locator('#lockbox-copied').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SECRET);
        await page.evaluate(() => document.getElementById('lockbox-new-wait').append(new Option('4 seconds', '4', true, true)));
        await page.click('#lockbox-relock');
        await page.waitForFunction(() => /^Locked away again/.test(document.getElementById('lockbox-status').textContent));
        assert.match(await lockboxStatus(page), /^Locked away again with a wait of 4 seconds\. Cleared from the clipboard too\. A backup file saved before this still opens after the old wait/);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '', 'nothing left to paste');
        assert.equal(await page.locator('#lockbox-copied').isVisible(), false, 'no longer copied');
        const longer = (await storedLockbox(page)).lockbox;
        assert.equal(longer.delay, 4);
        assert.equal(longer.version, 1);
        assert.notEqual(longer.n, same.n, 'a fresh puzzle');
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET, 'still shown');
        assert.match(await page.locator('#lockbox-again').innerText(), /^It’s locked away again with a wait of 4 seconds\. It stays on this page/);
        assert.deepEqual(await recordedEvents(page), ['locked', 'started', 'shown', 'sealed', 'sealed']);
        assert.equal((await shownRecord(page))[0].what, 'Locked away again, with a wait of 4 seconds in place of 2 seconds.');

        // Shorter: nothing to warn about. The clipboard holds something else now, which isn't the page's to clear.
        await page.evaluate(() => navigator.clipboard.writeText('a shopping list'));
        await page.evaluate(() => document.getElementById('lockbox-new-wait').append(new Option('3 seconds', '3', true, true)));
        await page.click('#lockbox-relock');
        await page.waitForFunction(() => /wait of 3 seconds/.test(document.getElementById('lockbox-status').textContent));
        assert.equal(await lockboxStatus(page), 'Locked away again with a wait of 3 seconds.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'a shopping list', 'left as it was');
        assert.equal((await storedLockbox(page)).lockbox.delay, 3);
        assert.equal((await shownRecord(page))[0].what, 'Locked away again, with a wait of 3 seconds in place of 4 seconds.');
        assert.ok(!JSON.stringify(await storedLockbox(page)).includes(SECRET));

        await page.click('#lockbox-hide');
        await page.locator('#lockbox-locked').waitFor({ state: 'visible' });
        assert.match(await page.locator('#lockbox-summary').innerText(), /^A password is locked away \(since .+\)\. Getting it back takes about [2-4] seconds of computing/);
        await startUnlocking(page);
        await page.locator('#lockbox-open').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.inputValue('#lockbox-revealed'), SECRET, 'the same password, after the new wait');
        assert.deepEqual(page.errors, []);
      } finally {
        await page.close();
      }
    });
  });
});
