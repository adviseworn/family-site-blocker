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
import { MARKS, extensionWithStandInClassifier, galleryPage, servePictures } from './helpers/pictures.mjs';

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

  describe('safe search', () => {
    for (const [url, key, value] of [
      ['http://www.google.com/search?q=test', 'safe', 'active'],
      ['http://www.bing.com/images/search?q=test&adlt=off', 'adlt', 'strict'],
      ['http://duckduckgo.com/?q=test&ia=web', 'kp', '1'],
      ['http://search.yahoo.com/search?p=test', 'vm', 'r'],
      ['http://search.brave.com/search?q=test', 'safesearch', 'strict'],
    ]) {
      test(`${url} goes out once, with ${key}=${value}`, async () => {
        stub.clear();
        const result = await browser.visit(url);
        assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.finalUrl}`);
        assert.equal(new URL(result.finalUrl).searchParams.get(key), value, result.finalUrl);
        // The page itself was asked for once, with the setting (Firefox may ask for other things, such as
        // the site's icon, on its own).
        const sent = stub.requests.filter((r) => r.path === new URL(url).pathname);
        assert.equal(sent.length, 1, `one request for the page, not a loop: ${JSON.stringify(stub.requests.map((r) => r.host + r.path + r.search))}`);
        assert.equal(new URL(`http://${sent[0].host}${sent[0].path}${sent[0].search}`).searchParams.get(key), value);
      });
    }

    test('a search already made strict, and pages that are not searches, are left alone', async () => {
      for (const url of ['http://www.google.com/search?q=test&safe=active', 'http://www.google.com/', 'http://www.google.com/maps?q=test', 'http://example.com/search?q=test']) {
        stub.clear();
        const result = await browser.visit(url);
        assert.equal(result.finalUrl, url);
        const sent = stub.requests.filter((r) => r.path === new URL(url).pathname);
        assert.deepEqual(sent.map((r) => r.search), [new URL(url).search], `${url}: asked for once, unchanged`);
      }
    });

    test('requests to YouTube carry the Restricted Mode header; others do not', async () => {
      stub.clear();
      stub.page('www.youtube.com/results', '<script>fetch("http://www.youtube.com/youtubei/v1/search").catch(() => {})</script>');
      await browser.visit('http://www.youtube.com/results?search_query=test');
      await sleep(500);
      const toYouTube = stub.requests.filter((r) => r.host === 'www.youtube.com');
      assert.ok(toYouTube.length >= 2, JSON.stringify(stub.requests.map((r) => r.host + r.path)));
      assert.ok(toYouTube.every((r) => r.headers['youtube-restrict'] === 'Strict'), JSON.stringify(toYouTube.map((r) => [r.path, r.headers['youtube-restrict']])));
      stub.clear();
      await browser.visit('http://allowed.test/');
      assert.equal(stub.requests.find((r) => r.host === 'allowed.test')?.headers['youtube-restrict'], undefined);
    });
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

    test("a visit from before the add-on was watching is found in Firefox's history and added with its own date", async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const threeDaysAgo = Date.now() - 3 * 86_400_000;
      // Firefox lets a visit be dated: a page of the test site opened three days ago, and an unlisted one.
      const seeded = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1];
          Promise.all([
            browser.history.addUrl({ url: 'http://exampleadultsite.com/from-before', visitTime: arguments[0] }),
            browser.history.addUrl({ url: 'http://allowed.test/not-listed', visitTime: arguments[0] }),
          ]).then(() => done('ok'), (error) => done('error: ' + error));`,
        args: [threeDaysAgo],
      });
      assert.equal(seeded, 'ok');
      await browser.run("document.getElementById('history-scan-now').click()");
      const until = Date.now() + 15_000;
      let status = '';
      while (!/^Looked through this browser's history on .+: found \d+ visits? to listed sites/.test(status) && Date.now() < until) {
        await sleep(200);
        status = await browser.run("return document.getElementById('history-scan').textContent");
      }
      assert.match(status, /found \d+ visits? to listed sites, (all|\d+) new\.( Removed .+\.)?$/, status);
      const rows = await browser.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      const fromHistory = rows.filter((row) => row[2] === 'Visited (browser history)');
      assert.ok(fromHistory.length >= 1, JSON.stringify(rows.slice(0, 5)));
      assert.ok(fromHistory.every((row) => row[1] === SITE), 'only listed sites');
      const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(threeDaysAgo);
      assert.ok(fromHistory.some((row) => row[0] === expected), `a row dated ${expected}: ${JSON.stringify(fromHistory)}`);
      assert.equal(rows.at(-1)[2], 'Visited (browser history)', 'the oldest entry is the one from three days ago');
    });

    test("listed sites are taken out of Firefox's history and bookmarks once they are in the record, so the address bar stops suggesting them", async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      // What the address bar fills in for some typed letters, once Firefox has worked out how often each
      // site is used (it does that in idle moments; here it is asked to do it now).
      const autofill = async (typed) => {
        await browser.inFirefox(`const done = arguments[arguments.length - 1];
          const recalculator = Cc['@mozilla.org/places/frecency-recalculator;1'].getService(Ci.nsIObserver).wrappedJSObject;
          recalculator.recalculateAnyOutdatedFrecencies().then(() => recalculator.recalculateAnyOutdatedFrecencies()).then(() => done('ok'), (e) => done('error: ' + e));`);
        return browser.inFirefox(
          `const done = arguments[arguments.length - 1];
          const win = Services.wm.getMostRecentWindow('navigator:browser');
          win.gURLBar.focus();
          win.gURLBar.value = '';
          win.gURLBar.search(arguments[0]);
          setTimeout(() => { const value = win.gURLBar.value; win.gURLBar.value = ''; win.gURLBar.view.close(); done(value); }, 1500);`,
          typed,
        );
      };
      // The site's own pages (and its subdomains') in Firefox's history and bookmarks; look-alikes such as
      // notexampleadultsite.com, which earlier tests opened, are not its pages and stay.
      const ofSite = (urls) => urls.filter((url) => new URL(url).hostname === SITE || new URL(url).hostname.endsWith(`.${SITE}`));
      const inHistory = () =>
        browser.fx
          .send('WebDriver:ExecuteAsyncScript', {
            script: `const done = arguments[arguments.length - 1];
            browser.history.search({ text: arguments[0], startTime: 0, maxResults: 1000 }).then((items) => done(items.map((item) => item.url)), (e) => done('error: ' + e));`,
            args: [SITE],
          })
          .then(ofSite);
      const bookmarked = () =>
        browser.fx
          .send('WebDriver:ExecuteAsyncScript', {
            script: `const done = arguments[arguments.length - 1];
            browser.bookmarks.search(arguments[0]).then((items) => done(items.map((item) => item.url)), (e) => done('error: ' + e));`,
            args: [SITE],
          })
          .then(ofSite);

      // Before: a visit from last week and a bookmark, as a profile from before the add-on would have.
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const seeded = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1];
          Promise.all([
            browser.history.addUrl({ url: 'http://exampleadultsite.com/last-week', visitTime: arguments[0] }),
            browser.bookmarks.create({ title: 'saved', url: 'https://www.exampleadultsite.com/saved' }),
          ]).then(() => done('ok'), (error) => done('error: ' + error));`,
        args: [Date.now() - 7 * 86_400_000],
      });
      assert.equal(seeded, 'ok');
      assert.deepEqual(await inHistory(), ['http://exampleadultsite.com/last-week']);
      assert.deepEqual(await bookmarked(), ['https://www.exampleadultsite.com/saved']);
      assert.equal(await autofill('exa'), 'exampleadultsite.com/', 'Firefox suggests the site from its history and bookmarks');

      // The scan notes the visit, then takes the page and the bookmark away.
      await browser.run("document.getElementById('history-scan-now').click()");
      const until = Date.now() + 15_000;
      let status = '';
      while (!/Removed/.test(status) && Date.now() < until) {
        await sleep(200);
        status = await browser.run("return document.getElementById('history-scan').textContent");
      }
      assert.match(status, /: found 1 visit to listed sites, all new\. Removed 1 page from this browser's history and 1 bookmark\.$/, status);
      assert.deepEqual(await inHistory(), []);
      assert.deepEqual(await bookmarked(), []);
      assert.equal(await autofill('exa'), 'exa', 'nothing left to suggest');
      const rows = await browser.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      assert.ok(rows.some((row) => row[1] === SITE && row[2] === 'Visited (browser history)'), 'the visit stays in the record');

      // Live: the site typed into the address bar, as a person would. Firefox puts the typed address into
      // its history as the block page takes over; a moment later the add-on has taken it out again.
      await browser.newTab();
      const landed = await browser.inFirefox(
        `const done = arguments[arguments.length - 1];
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        win.gURLBar.focus();
        win.gURLBar.value = arguments[0];
        win.gURLBar.handleCommand();
        setTimeout(() => done(win.gBrowser.selectedBrowser.currentURI.spec), 2000);`,
        SITE,
      );
      assert.match(landed, /^moz-extension:\/\/.+\/blocked\.html$/, `typing ${SITE} ended at ${landed}`);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const swept = Date.now() + 15_000;
      let left = await inHistory();
      while (left.length > 0 && Date.now() < swept) {
        await sleep(250);
        left = await inHistory();
      }
      assert.deepEqual(left, [], 'the typed address is gone from the history');
      assert.equal(await autofill('exa'), 'exa');
    });

    test('the whole record has a page of its own, opened from the settings page, with the record by site and a file to save', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const link = await browser.run(`const link = document.getElementById('attempts-all'); return { hidden: link.hidden, text: link.textContent, href: link.href, target: link.target }`);
      assert.equal(link.hidden, false);
      assert.match(link.text, /^See the whole record \(\d+\)$/);
      assert.equal(link.target, '_blank');
      const count = Number(link.text.match(/\d+/)[0]);
      const shownOnSettings = await browser.run(`return document.querySelectorAll('#attempts-table tbody tr').length`);
      assert.ok(shownOnSettings <= 10 && shownOnSettings <= count, 'the settings page shows the latest ten at most');

      const before = (await browser.tabs()).map(({ handle }) => handle); // tabs() leaves another tab current
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      await browser.run(`document.getElementById('attempts-all').click()`);
      let opened = null;
      for (let i = 0; i < 40 && !opened; i++) {
        await sleep(250);
        opened = (await browser.tabs()).find(({ handle, url }) => !before.includes(handle) && url.endsWith('/attempts.html'));
      }
      assert.ok(opened, 'the record page opened in a new tab');
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: opened.handle });
      const until = Date.now() + 10_000;
      let state = {};
      do {
        state = await browser.run(`return {
          version: document.getElementById('version').textContent,
          summary: document.getElementById('summary').textContent,
          sites: [...document.querySelectorAll('#sites-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)),
          siteLink: document.querySelector('#sites-table a')?.getAttribute('href'),
          everyTry: document.getElementById('every-try').textContent,
          days: document.querySelectorAll('.day').length,
        }`);
        if (state.sites.length > 0) break;
        await sleep(200);
      } while (Date.now() < until);
      assert.equal(state.version, `Version ${VERSION}`);
      assert.match(state.summary, new RegExp(`^${count} attempts? at 1 site, the latest at .+\\. 1 page opened instead of being blocked\\. \\d+ from this browser's history\\.$`));
      assert.equal(state.sites.length, 1, JSON.stringify(state.sites));
      assert.equal(state.sites[0][0], SITE);
      assert.equal(state.sites[0][1], `${count}1 opened`, 'the tries, with how many got through');
      assert.equal(state.siteLink, `tries.html#site=${SITE}`);
      assert.equal(state.everyTry, `See every try (${count})`);
      assert.equal(state.days, 0, 'the tries themselves are on a page of their own (#52)');

      // Every try, on its page: all of them, then the one site's.
      await browser.run(`document.getElementById('every-try').click()`);
      await browser.waitForUrl((url) => url.endsWith('/tries.html'));
      const tries = async (expected) => {
        const end = Date.now() + 10_000;
        let got = {};
        do {
          got = await browser.run(`return {
            summary: document.getElementById('summary').textContent,
            filter: document.getElementById('filter').hidden ? null : document.getElementById('filter').textContent,
            days: document.querySelectorAll('.day').length,
            rows: [...document.querySelectorAll('.day tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent)),
          }`);
          if (got.rows.length === expected) return got;
          await sleep(200);
        } while (Date.now() < end);
        throw new Error(`expected ${expected} rows: ${JSON.stringify(got).slice(0, 300)}`);
      };
      let every = await tries(count);
      assert.match(every.summary, new RegExp(`^${count} tr(y|ies) at 1 site, the latest at .+\\.`));
      assert.equal(every.filter, null);
      assert.ok(every.days >= 2, `the try from three days ago has a day of its own: ${every.days} days`);
      assert.ok(every.rows.every((row) => row[1] === SITE && /^(Blocked|Opened, not blocked|Visited \(browser history\))$/.test(row[2])), JSON.stringify(every.rows.slice(0, 3)));
      assert.equal(every.rows.at(-1)[2], 'Visited (browser history)', 'oldest last');
      await browser.visit(`moz-extension://${new URL(await browser.currentUrl()).host}/tries.html#site=${SITE}`);
      every = await tries(count);
      assert.equal(every.filter, `Only ${SITE}. Show every site`);
      await browser.run(`document.getElementById('filter-clear').click()`);
      await browser.waitForUrl((url) => url.endsWith('/tries.html'));
      every = await tries(count);
      assert.equal(every.filter, null);
      await browser.visit(`moz-extension://${new URL(await browser.currentUrl()).host}/attempts.html`);

      // The file: the page makes it from the record the same way the fast tests check; Firefox then saves
      // it to the downloads folder, which is Firefox's business, so only its contents are checked here.
      const csv = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1];
          import(browser.runtime.getURL('lib/attempts.js'))
            .then((lib) => browser.storage.local.get('attempts').then(({ attempts }) => done(lib.toCsv(attempts))))
            .catch((error) => done('error: ' + error));`,
        args: [],
      });
      const lines = String(csv).split('\n');
      assert.equal(lines[0], 'when,site,result');
      assert.equal(lines.length, count + 2, `${count} rows, a heading and a final newline`);
      assert.match(lines[1], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d,${SITE.replace(/\./g, '\\.')},Visited \\(browser history\\)$`));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
    });

    test('a site that looks adult by name but is not listed is noted on the record page, and one click there adds it to the list', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const seeded = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1];
          Promise.all([
            browser.history.addUrl({ url: 'http://hentai-example.test/one', visitTime: arguments[0] }),
            browser.history.addUrl({ url: 'http://m.hentai-example.test/two', visitTime: arguments[0] + 1000 }),
            browser.history.addUrl({ url: 'http://sussex-example.test/', visitTime: arguments[0] }),
          ]).then(() => done('ok'), (error) => done('error: ' + error));`,
        args: [Date.now() - 2 * 86_400_000],
      });
      assert.equal(seeded, 'ok');
      await browser.run("document.getElementById('history-scan-now').click()");
      const until = Date.now() + 15_000;
      let note = { hidden: true };
      while (note.hidden && Date.now() < until) {
        await sleep(200);
        note = await browser.run(`const note = document.getElementById('unlisted-note'); return { hidden: note.hidden, text: note.textContent }`);
      }
      assert.equal(note.text, "1 site in this browser's history looks adult but isn't on either list: see which.");

      // The unlisted page (#54), opened in the record page's tab.
      const recordTab = (await browser.tabs()).find(({ url }) => url.endsWith('/attempts.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: recordTab.handle });
      await browser.visit(`moz-extension://${new URL(await browser.currentUrl()).host}/unlisted.html`);
      const rows = () =>
        browser.run(`return [...document.querySelectorAll('#unlisted-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      let found = [];
      for (let i = 0; i < 40 && found.length === 0; i++) {
        if (i) await sleep(250);
        found = await rows();
      }
      assert.deepEqual(found.map((row) => row.slice(0, 2)), [['hentai-example.test', '2']], JSON.stringify(found));
      await browser.newTab();
      assert.equal((await browser.visit('http://hentai-example.test/three')).outcome, 'site loaded', 'not blocked yet');

      await browser.fx.send('WebDriver:SwitchToWindow', { handle: recordTab.handle });
      await browser.run("document.querySelector('#unlisted-table button').click()");
      const gone = Date.now() + 15_000;
      let summary = '';
      while (!summary.startsWith('None found') && Date.now() < gone) {
        await sleep(250);
        summary = await browser.run("return document.getElementById('summary').textContent");
      }
      assert.match(summary, /^None found when the history was last looked through/, summary);
      await browser.newTab();
      await assertBlocked('http://hentai-example.test/three');
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      assert.equal(await browser.run("return document.getElementById('custom').value"), 'hentai-example.test', "the settings page's box shows the addition");
      const record = await browser.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      assert.ok(record.some((row) => row[1] === 'hentai-example.test' && row[2] === 'Visited (browser history)'), JSON.stringify(record.slice(0, 4)));
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

  describe('pictures', () => {
    // The picture filter in Firefox: the real classifier on two ordinary photos, then a copy of the
    // extension whose classifier judges by the picture's address for the hiding, the setting and the record.
    const waitForMarks = async (target, ids, ms = 30_000) => {
      const until = Date.now() + ms;
      let marks = {};
      while (Date.now() < until) {
        marks = Object.fromEntries(await target.run(`return ${MARKS}`));
        if (ids.every((id) => ['ok', 'hidden', 'small'].includes(marks[id]?.[0]))) return marks;
        await sleep(250);
      }
      throw new Error(`pictures never judged: ${JSON.stringify(marks)}`);
    };

    before(() => {
      servePictures(stub, ['cat', 'coffee', 'photo', 'nude', 'lingerie', 'drawn']);
      stub.page('allowed.test/real', galleryPage(['cat', 'coffee']));
      stub.page('allowed.test/gallery', galleryPage(['photo', 'nude', 'lingerie', 'drawn']));
    });

    test('the real classifier, through WebAssembly, finds two ordinary photos neutral and shows them', async () => {
      await browser.newTab();
      const result = await browser.visit('http://allowed.test/real');
      assert.equal(result.finalUrl, 'http://allowed.test/real', `ended at ${result.finalUrl}`);
      const marks = await waitForMarks(browser, ['cat', 'coffee', 'icon']);
      assert.deepEqual([marks.cat, marks.coffee, marks.icon], [['ok', 'visible'], ['ok', 'visible'], ['small', 'visible']], JSON.stringify(marks));
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const status = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1]; browser.runtime.sendMessage({ type: 'picture-status' }).then(done, (e) => done({ error: String(e) }));`,
        args: [],
      });
      assert.equal(status.backend, 'wasm', JSON.stringify(status));
      assert.ok(status.judged >= 2 && status.failed === 0, JSON.stringify(status));
      assert.equal(await browser.run("return document.getElementById('picture-strictness').value"), 'strict');
      const until = Date.now() + 15_000;
      let line = '';
      while (!/judged/.test(line) && Date.now() < until) {
        await sleep(300);
        line = await browser.run("return document.getElementById('picture-status').textContent");
      }
      assert.match(line, /^Since the browser started: \d+ pictures judged, 0 hidden; judging runs through WebAssembly\.$/);
    });

    test('with the stand-in classifier: nudity and suggestive pictures are hidden, a photo shown, the record filled, and "Nudity only" lets the suggestive one through', async () => {
      const standIn = extensionWithStandInClassifier();
      const judge = await launchFirefox(stub, { extensionDir: standIn.dir });
      try {
        const settings = (await judge.tabs()).find(({ url }) => url.endsWith('/options.html'));
        await judge.newTab();
        await judge.visit('http://allowed.test/gallery');
        let marks = await waitForMarks(judge, ['photo', 'nude', 'lingerie', 'drawn']);
        assert.deepEqual(
          [marks.photo, marks.nude, marks.lingerie, marks.drawn, marks.icon],
          [['ok', 'visible'], ['hidden', 'hidden'], ['hidden', 'hidden'], ['hidden', 'hidden'], ['small', 'visible']],
          JSON.stringify(marks),
        );
        await judge.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
        const record = await judge.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('pictures').then((got) => done(got.pictures ?? []), (e) => done([]));`,
          args: [],
        });
        const names = record.filter((entry) => entry.site === 'allowed.test').map((entry) => [entry.url.split('/').pop(), entry.reason]).sort();
        assert.deepEqual(names, [['drawn.jpg', 'nudity'], ['lingerie.jpg', 'suggestive'], ['nude.jpg', 'nudity']], JSON.stringify(record));
        await judge.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.set({ pictureStrictness: 'nudity' }).then(() => done('ok'), (e) => done('error ' + e));`,
          args: [],
        });
        await judge.newTab();
        await judge.visit('http://allowed.test/gallery');
        marks = await waitForMarks(judge, ['photo', 'nude', 'lingerie', 'drawn']);
        assert.deepEqual([marks.photo[0], marks.nude[0], marks.lingerie[0], marks.drawn[0]], ['ok', 'hidden', 'ok', 'hidden'], JSON.stringify(marks));
      } finally {
        await judge.close();
        standIn.remove();
      }
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
