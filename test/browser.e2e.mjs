// Real-browser tests. They load the extension into Chromium, exactly like "Load unpacked" does, and
// drive it the way a person would. Run with:  npm run test:browser
// (needs `npm install` once, and `npx playwright install chromium` if Playwright has no browser yet)
//
// No real website is contacted: every hostname is mapped to a small local server (see helpers/browser.mjs).
// A request that never reaches that server was stopped by the browser.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPage, launchBrowser, startStubInternet, visit } from './helpers/browser.mjs';

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

  describe('settings page', () => {
    test('opens by itself right after the extension is installed', () => {
      assert.equal(openedOnInstall, true);
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

    test("if the browser won't run the rule check, as in Firefox, it says to open the test site instead", async () => {
      const page = await browser.context.newPage();
      await page.addInitScript(() => {
        chrome.declarativeNetRequest.testMatchOutcome = undefined;
      });
      try {
        await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
        await page.waitForFunction(() => document.querySelector('#check-note')?.textContent.length > 0);
        assert.equal(
          await page.locator('#check-note').innerText(),
          "This browser doesn't let extensions run this check. Use the button above to open the test site instead.",
        );
        assert.equal(await page.locator('#results li').count(), 0);
        assert.match(await page.locator('#summary').innerText(), /^20 sites on the built-in list/);
      } finally {
        await page.close();
      }
    });

    test("the browser's own check agrees that every listed address is blocked or allowed as expected", async () => {
      const page = await openSettings();
      try {
        assert.match(await page.locator('#check-note').innerText(), /^All \d+ checks passed\.$/);
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
});
