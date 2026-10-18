// Firefox tests. They build the zip that `npm run package:firefox` makes (the file Mozilla signs), load
// it the way about:debugging's "Load Temporary Add-on…" does and drive Firefox the way a person would.
// The last group loads the extension folder itself, as the README's "Try it" steps do.
// Run with:  npm run test:firefox
// Uses the Firefox installed on this computer, or the one in $FIREFOX. Skipped when there is none.
//
// As in the Chromium tests, no real website is contacted: Firefox sends every request to a small local
// server (set as its proxy), so a request that never reaches that server was stopped by the browser.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR, startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const VERSION = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
const BUILT_IN = JSON.parse(readFileSync(join(EXTENSION_DIR, 'rules', 'domains.json'), 'utf8')).length;
const SITE = 'exampleadultsite.com';
const BLOCKED_URL = `http://${SITE}/`;
const test = (name, fn) => it(name, { timeout: 60_000 }, fn);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Firefox before 140 doesn't know data_collection_permissions and says so. Such a Firefox only runs these
// tests with ALLOW_OLD_FIREFOX=1, so that one warning is let through there.
const unexpected = (warnings, version) =>
  warnings.filter((warning) => !(parseFloat(version) < 140 && warning.includes('data_collection_permissions')));

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
  async function assertBlocked(url, target = browser) {
    stub.clear();
    const result = await target.visit(url);
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
    test("Firefox reads the zip's manifest without warnings and runs background.js from background.scripts", async () => {
      const { background, warnings, errors } = await browser.manifestReport();
      assert.deepEqual({ warnings: unexpected(warnings, browser.version), errors }, { warnings: [], errors: [] });
      assert.equal(background.service_worker ?? null, null, 'the zip leaves out the line only Chrome, Edge and Brave use');
      assert.equal(background.scripts.length, 1);
      assert.match(background.scripts[0], /^moz-extension:\/\/.+\/background\.js$/);
    });

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
          version: document.getElementById('version').textContent,
          summary: document.getElementById('summary').textContent,
          note: document.getElementById('check-note').textContent,
          introShown: !document.getElementById('check-intro').hidden,
          results: document.querySelectorAll('#results li').length,
          accessShown: !document.getElementById('access').hidden,
          privateStatus: document.getElementById('private-status').textContent,
          privateButtonShown: !document.getElementById('private-open').hidden,
        }`);
        if (state.note && state.privateStatus !== 'Checking…') break;
        await sleep(200);
      } while (Date.now() < until);

      assert.equal(state.version, `Version ${VERSION}`, 'the installed version, next to the title');
      assert.match(state.summary, new RegExp(`^${BUILT_IN} sites on the built-in list`));
      assert.equal(state.note, "Firefox doesn't let add-ons run this check automatically, so use the button above.");
      assert.equal(state.introShown, false, 'no sentence promising a check Firefox cannot run');
      assert.equal(state.results, 0);
      assert.equal(state.accessShown, false, 'no website access warning, because Firefox granted access');
      assert.match(state.privateStatus, /^Private windows are not blocked yet, .*about:addons.*“Run in Private Windows”/);
      assert.equal(state.privateButtonShown, false, 'no "Open Details page" button: Firefox does not let extensions open about:addons');
    });

    test('the tries at the test site so far are noted on the settings page, and a new one appears while the page is open', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      const rows = () =>
        browser.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      const waitForRows = async (test) => {
        let found = [];
        for (let i = 0; i < 40 && !test(found); i++) {
          if (i) await sleep(250);
          found = await rows();
        }
        return found;
      };

      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      // The tests above open the site many times, but tries less than two seconds apart count as one.
      const before = await waitForRows((found) => found.length > 0);
      assert.ok(before.length >= 1 && before.every((row) => row[1] === SITE && row[2] === 'Blocked'), JSON.stringify(before));
      assert.match(await browser.run(`return document.getElementById('attempts-summary').textContent`), /^\d+ attempts?, the latest at .+\.$/);

      await sleep(2100); // more than the two seconds that make two notes one try
      await browser.newTab();
      await assertBlocked(BLOCKED_URL);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const after = await waitForRows((found) => found.length === before.length + 1);
      assert.equal(after.length, before.length + 1, `a new note while the page was open: ${JSON.stringify(after.slice(0, 3))}`);
      assert.deepEqual(after[0].slice(1), [SITE, 'Blocked'], 'newest first');

      // Stand in for a Firefox where the blocking is off: switch the built-in rules off for a moment.
      const builtInRules = (on) =>
        browser.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1];
            const ids = browser.runtime.getManifest().declarative_net_request.rule_resources.map(({ id }) => id);
            const change = arguments[0] ? { enableRulesetIds: ids } : { disableRulesetIds: ids };
            browser.declarativeNetRequest.updateEnabledRulesets(change).then(() => done('ok'), (error) => done('error: ' + error));`,
          args: [on],
        });
      try {
        assert.equal(await builtInRules(false), 'ok');
        await sleep(2100);
        await browser.newTab();
        assert.equal((await browser.visit(BLOCKED_URL)).outcome, 'site loaded');
        await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
        const got = await waitForRows((found) => found.length === after.length + 1 && found[0][2] !== 'Blocked');
        assert.deepEqual(got[0].slice(1), [SITE, 'Opened, not blocked'], JSON.stringify(got.slice(0, 2)));
        assert.match(await browser.run(`return document.getElementById('attempts-summary').textContent`), / 1 page opened instead of being blocked\.$/);
      } finally {
        assert.equal(await builtInRules(true), 'ok');
      }
      await sleep(2100);
      await browser.newTab();
      await assertBlocked(BLOCKED_URL);
    });

    test('a password locked away with a short wait comes back after it, and is locked away again', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const shown = () =>
        browser.run(`return ['lockbox-empty', 'lockbox-locked', 'lockbox-open'].find((id) => !document.getElementById(id).hidden)`);
      const waitUntilShown = async (id, ms = 20_000) => {
        const until = Date.now() + ms;
        while ((await shown()) !== id) {
          if (Date.now() > until) throw new Error(`${id} never showed; status: ${await browser.run("return document.getElementById('lockbox-status').textContent")}`);
          await sleep(200);
        }
      };

      await waitUntilShown('lockbox-empty');
      await browser.run(`
        document.getElementById('lockbox-delay').append(new Option('3 seconds', '3', true, true));
        document.getElementById('lockbox-secret').value = 'Firefox-Admin-Password';
        document.getElementById('lockbox-lock').click();`);
      await waitUntilShown('lockbox-locked');
      assert.equal(await browser.run("return document.getElementById('lockbox-secret').value"), '');

      const started = Date.now();
      await browser.run("document.getElementById('lockbox-start').click()");
      await waitUntilShown('lockbox-open');
      assert.ok(Date.now() - started >= 1500, 'not sooner than the wait allows');
      assert.equal(await browser.run("return document.getElementById('lockbox-revealed').value"), 'Firefox-Admin-Password');

      await browser.run("document.getElementById('lockbox-hide').click()");
      await waitUntilShown('lockbox-locked');
    });
  });

  describe('the extension folder itself, loaded as the README\'s "Try it" steps do', () => {
    let folder;
    let tabsAfterLoad = [];

    before(async () => {
      folder = await launchFirefox(stub, { packaged: false });
      tabsAfterLoad = await folder.tabs();
      await folder.newTab();
    });

    after(() => folder?.close());

    test('test case: exampleadultsite.com is blocked', () => assertBlocked(BLOCKED_URL, folder));

    test('the settings page opens by itself after install', () => {
      assert.ok(tabsAfterLoad.some(({ url }) => url.endsWith('/options.html')), JSON.stringify(tabsAfterLoad));
    });

    test('Firefox reads its manifest, service_worker line included, without warnings', async () => {
      const { background, warnings, errors } = await folder.manifestReport();
      assert.deepEqual({ warnings: unexpected(warnings, folder.version), errors }, { warnings: [], errors: [] });
      assert.match(background.service_worker, /\/background\.js$/, 'the folder keeps the line for Chrome, Edge and Brave');
      assert.match(background.scripts[0], /\/background\.js$/);
    });
  });
});
