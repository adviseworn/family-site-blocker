// Firefox tests. They load the extension the way about:debugging's "Load Temporary Add-on…" does and
// drive Firefox the way a person would. Run with:  npm run test:firefox
// Uses the Firefox installed on this computer, or the one in $FIREFOX. Skipped when there is none.
//
// As in the Chromium tests, no real website is contacted: Firefox sends every request to a small local
// server (set as its proxy), so a request that never reaches that server was stopped by the browser.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const SITE = 'exampleadultsite.com';
const BLOCKED_URL = `http://${SITE}/`;
const test = (name, fn) => it(name, { timeout: 60_000 }, fn);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

describe('Firefox', { skip: findFirefox() ? false : 'no Firefox found (set FIREFOX=/path/to/firefox)' }, () => {
  let stub;
  let browser;
  let tabsAfterInstall = [];

  before(async () => {
    stub = await startStubInternet();
    stub.page('allowed.test/links', `<a id="go" href="${BLOCKED_URL}">go</a>`);
    stub.page('allowed.test/embeds', `<img id="img" src="${BLOCKED_URL}pixel.gif"><iframe src="${BLOCKED_URL}frame"></iframe>`);
    browser = await launchFirefox(stub);
    tabsAfterInstall = await browser.tabs();
    await browser.newTab();
  });

  after(async () => {
    await browser?.close();
    await stub?.close();
  });

  /** Opens an address and checks the person lands on the "Site blocked" page without anything coming from the site. */
  async function assertBlocked(url) {
    stub.clear();
    const result = await browser.visit(url);
    const where = `${url} ended at ${result.finalUrl}${result.error ? ` (${result.error})` : ''}`;
    assert.equal(result.outcome, 'blocked page', where);
    assert.match(result.text, /This site is blocked/, where);
    assert.equal(stub.reached(SITE), false, `${url}: a request reached the site`);
  }

  describe('test case: navigate to exampleadultsite.com', () => {
    test('Actual, with no add-on: the website is allowed (so this test can see a failure)', async () => {
      const plain = await launchFirefox(stub, { extension: false });
      try {
        stub.clear();
        const result = await plain.visit(BLOCKED_URL);
        assert.equal(result.outcome, 'site loaded');
        assert.equal(stub.reached(SITE), true);
      } finally {
        await plain.close();
      }
    });

    test('Expected, with the add-on: the website is blocked (http)', () => assertBlocked(BLOCKED_URL));
    test('Expected, with the add-on: the website is blocked (https)', () => assertBlocked(`https://${SITE}/`));
  });

  describe('the same site, written in other ways, is blocked', () => {
    const variants = [
      ['www subdomain', 'http://www.exampleadultsite.com/'],
      ['deep subdomain with path, query and fragment', 'http://a.b.exampleadultsite.com/page?x=1#y'],
      ['upper case', 'http://EXAMPLEADULTSITE.COM/'],
      ['explicit port', 'http://exampleadultsite.com:8080/'],
      ['trailing dot (Firefox only matches it because it is listed too)', 'http://exampleadultsite.com./'],
      ['trailing dot on a subdomain', 'http://www.exampleadultsite.com./'],
    ];
    for (const [name, url] of variants) test(name, () => assertBlocked(url));
  });

  describe('other sites are left alone', () => {
    const others = ['http://allowed.test/', 'http://notexampleadultsite.com/', 'http://exampleadultsite.com.allowed.test/', 'http://exampleadultsite.co/'];
    for (const url of others) {
      test(url, async () => {
        const result = await browser.visit(url);
        assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.finalUrl}`);
      });
    }
  });

  describe('the site is blocked when other pages lead to it', () => {
    test('clicking a link', async () => {
      await browser.visit('http://allowed.test/links');
      stub.clear();
      await browser.run('document.getElementById("go").click()');
      const url = await browser.waitForUrl((address) => address.endsWith('/blocked.html'));
      assert.match(url, /^moz-extension:\/\/.+\/blocked\.html$/);
      assert.equal(stub.reached(SITE), false);
    });

    test('nothing from the site loads inside another page (image, frame, fetch)', async () => {
      stub.clear();
      await browser.visit('http://allowed.test/embeds');
      const image = await browser.run('return document.getElementById("img").naturalWidth > 0 ? "loaded" : "blocked"');
      const fetched = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1];
          fetch('${BLOCKED_URL}api', { mode: 'no-cors' }).then(() => done('loaded'), () => done('blocked'));`,
        args: [],
      });
      assert.deepEqual({ image, fetched }, { image: 'blocked', fetched: 'blocked' });
      assert.equal(stub.reached(SITE), false, 'a request reached the site');
    });
  });

  describe('install and settings page', () => {
    test('Firefox gives the temporary add-on access to websites, which the block page needs', async () => {
      const { origins } = await browser.grants();
      assert.ok(origins.includes('<all_urls>'), JSON.stringify(origins));
    });

    test('the settings page opens by itself after install', () => {
      assert.ok(tabsAfterInstall.some(({ url }) => url.endsWith('/options.html')), JSON.stringify(tabsAfterInstall));
    });

    test("the settings page uses Firefox's wording and skips what Firefox doesn't offer", async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      let state;
      const until = Date.now() + 10_000;
      do {
        state = await browser.run(`return {
          summary: document.getElementById('summary').textContent,
          note: document.getElementById('check-note').textContent,
          accessShown: !document.getElementById('access').hidden,
          privateStatus: document.getElementById('private-status').textContent,
          privateButtonShown: !document.getElementById('private-open').hidden,
        }`);
        if (state.note && state.privateStatus !== 'Checking…') break;
        await sleep(200);
      } while (Date.now() < until);

      assert.match(state.summary, /^20 sites on the built-in list/);
      assert.equal(state.note, "This browser doesn't let extensions run this check. Use the button above to open the test site instead.");
      assert.equal(state.accessShown, false, 'no website access warning, because Firefox granted access');
      assert.match(state.privateStatus, /^Private windows are not blocked yet, .*about:addons.*“Run in Private Windows”/);
      assert.equal(state.privateButtonShown, false, 'no "Open Details page" button: Firefox does not let extensions open about:addons');
    });
  });
});
