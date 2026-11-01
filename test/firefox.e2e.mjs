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
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDomainList } from '../extension/lib/domains.js';
import { BLOCKLIST_DIR } from '../scripts/build-rules.mjs';
import { filterEntries, filterSites } from '../scripts/firefox-lock.mjs';
import { EXTENSION_DIR, startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';
import { BACKGROUND_MARKS, FAKE_CAMERA_PREFS, MARKS, backgroundsPage, cameraPage, extensionWithStandInClassifier, galleryPage, servePictures, serveVideos, videoPage } from './helpers/pictures.mjs';

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

// Where Firefox reads its own policies.json: next to the program on Linux and Windows, inside the app on a
// Mac. The last group below writes the lock's filter there; it is skipped where that can't be written, where
// Firefox would read /etc/firefox/policies/policies.json instead, and on a Mac outside CI, where writing
// inside Firefox.app needs an administrator (the lock tests cover it there).
const MAC = process.platform === 'darwin';
const FIREFOX = findFirefox();
const POLICIES_PATH = !FIREFOX ? '' : MAC ? join(dirname(dirname(FIREFOX)), 'Resources', 'distribution', 'policies.json') : join(dirname(FIREFOX), 'distribution', 'policies.json');
function whyNoPolicies() {
  if (!POLICIES_PATH) return 'no Firefox found';
  if (!MAC && existsSync('/etc/firefox/policies/policies.json')) return 'Firefox would read /etc/firefox/policies/policies.json instead';
  if (existsSync(POLICIES_PATH)) return `${POLICIES_PATH} exists already`;
  if (MAC) {
    if (!process.env.CI) return 'on a Mac this writes inside Firefox.app, so it only runs in CI (the lock tests cover it)';
    return spawnSync('sudo', ['-n', 'true']).status === 0 ? false : 'needs sudo without a password';
  }
  try {
    const folder = dirname(POLICIES_PATH);
    accessSync(existsSync(folder) ? folder : dirname(folder), constants.W_OK);
    return false;
  } catch {
    return `can't write ${POLICIES_PATH}`;
  }
}
const sudo = (...args) => assert.equal(spawnSync('sudo', ['-n', ...args], { stdio: 'inherit' }).status, 0, args.join(' '));

/** Writes the policies file (as root on a Mac) and returns a function that takes it away again. */
function writePolicies(policies) {
  const folder = dirname(POLICIES_PATH);
  const madeFolder = !existsSync(folder);
  const text = JSON.stringify({ policies });
  if (MAC) {
    const staged = join(tmpdir(), `family-site-blocker-policies-${process.pid}.json`);
    writeFileSync(staged, text);
    sudo('mkdir', '-p', folder);
    sudo('cp', staged, POLICIES_PATH);
    rmSync(staged, { force: true });
    return () => sudo('rm', '-rf', madeFolder ? folder : POLICIES_PATH);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(POLICIES_PATH, text);
  return () => rmSync(madeFolder ? folder : POLICIES_PATH, { recursive: true, force: true });
}

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
          checksShown: !document.getElementById('check-details').hidden,
          results: document.querySelectorAll('#results li').length,
          accessShown: !document.getElementById('access').hidden,
          privateStatus: document.getElementById('private-status').textContent,
          privateButtonShown: !document.getElementById('private-open').hidden,
          privateMark: document.getElementById('private').className,
          lockShown: !document.getElementById('lock').hidden,
          lockStatus: document.getElementById('lock-status').textContent,
          lockMark: document.getElementById('lock').className,
          lockLink: document.querySelector('#lock-status a')?.getAttribute('href'),
          lockboxLine: document.getElementById('lockbox-line').textContent,
          words: document.body.innerText.split(/\s+/).filter(Boolean).length,
        }`);
        if (state.note && state.privateStatus !== 'Checking…' && state.lockShown && !state.lockboxLine.startsWith('Loading')) break;
        await sleep(200);
      } while (Date.now() < until);

      assert.equal(state.version, `Version ${VERSION}`, 'the installed version, next to the title');
      assert.match(state.summary, new RegExp(`^${BUILT_IN} sites on the built-in list`));
      assert.equal(state.note, "Firefox doesn't let add-ons check the addresses automatically, so open the test site.");
      assert.equal(state.checksShown, false, 'no list promising a check Firefox cannot run');
      assert.equal(state.results, 0);
      assert.equal(state.accessShown, false, 'no website access warning, because Firefox granted access');
      assert.match(state.privateStatus, /^Private windows are not blocked yet, .*about:addons.*“Run in Private Windows”/);
      assert.equal(state.privateButtonShown, false, 'no "Open Details page" button: Firefox does not let extensions open about:addons');
      assert.equal(state.privateMark, 'todo');
      // The board says whether anything stops the person switching the add-on off (#70): a temporary add-on, nothing.
      assert.equal(state.lockStatus, 'Loaded temporarily: Firefox removes the add-on when it quits, and anyone can switch it off before then. How to keep it installed, and lock it.');
      assert.equal(state.lockMark, 'todo');
      assert.equal(state.lockLink, 'https://github.com/adviseworn/family-site-blocker#keep-it-installed-after-firefox-quits');
      assert.equal(state.lockboxLine, 'No password is locked away.');
      assert.ok(state.words < 450, `${state.words} words on the settings page`);
      // What that line rests on (#69): Firefox reports a temporary add-on as "development", with a switch, through management.getSelf, which needs no permission.
      const self = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1]; browser.management.getSelf().then((info) => done({ installType: info.installType, mayDisable: info.mayDisable }), (e) => done('error: ' + e));`,
        args: [],
      });
      assert.deepEqual(self, { installType: 'development', mayDisable: true });
    });

    /** The record page in a tab of its own, where the browser's history is looked through from (#70); its handle. */
    let recordHandle = null;
    async function openRecordTab() {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      const address = `moz-extension://${new URL(settings.url).host}/attempts.html`;
      const existing = recordHandle && (await browser.tabs()).find(({ handle }) => handle === recordHandle);
      if (existing) {
        await browser.fx.send('WebDriver:SwitchToWindow', { handle: recordHandle });
        if (!existing.url.endsWith('/attempts.html')) await browser.visit(address); // a test left it on another page
        return recordHandle;
      }
      recordHandle = await browser.newTab();
      await browser.visit(address);
      return recordHandle;
    }
    /** Looks through the history from the record page and waits for its line to say what was found. */
    async function scanHistory(done) {
      await openRecordTab();
      await browser.run("document.getElementById('history-scan-now').click()");
      const until = Date.now() + 15_000;
      let status = '';
      while (!done(status) && Date.now() < until) {
        await sleep(200);
        status = await browser.run("return document.getElementById('history-scan').textContent");
      }
      return status;
    }
    /** The record as stored, read from the settings page. */
    const storedAttempts = () =>
      browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('attempts').then((got) => done(got.attempts ?? []), (e) => done([]));`,
        args: [],
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
      assert.ok(before.length >= 1 && before.length <= 3 && before.every((row) => row[1] === SITE && row[2] === 'Blocked'), JSON.stringify(before));
      const summary = await browser.run(`return document.getElementById('attempts-summary').textContent`);
      assert.match(summary, /^\d+ attempts?, the latest at .+\.$/);
      const countBefore = Number(summary.match(/^\d+/)[0]);

      await sleep(2100); // more than the two seconds that make two notes one try
      await browser.newTab();
      await assertBlocked(BLOCKED_URL);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const grown = Date.now() + 10_000;
      let count = countBefore;
      while (count !== countBefore + 1 && Date.now() < grown) {
        await sleep(250);
        count = Number((await browser.run(`return document.getElementById('attempts-summary').textContent`)).match(/^\d+/)[0]);
      }
      assert.equal(count, countBefore + 1, 'a new note while the page was open');
      const after = await waitForRows((found) => found.length === Math.min(3, countBefore + 1));
      assert.equal(after.length, Math.min(3, countBefore + 1), `the latest three at most: ${JSON.stringify(after)}`);
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
        const got = await waitForRows((found) => found.length > 0 && found[0][2] !== 'Blocked');
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
      const status = await scanHistory((text) => /^Looked through this browser's history on .+: found \d+ visits? to listed sites/.test(text));
      assert.match(status, /found \d+ visits? to listed sites, (all|\d+) new\.( Removed .+\.)?$/, status);
      assert.equal(await browser.run("return document.getElementById('history-scan-now').textContent"), 'Look through this browser’s history again', 'started from the record page');
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      assert.equal(await browser.run("return document.getElementById('history-scan-now')"), null, 'and no longer from the settings page (#70)');
      const list = await storedAttempts();
      const fromHistory = list.filter((entry) => entry.from === 'history');
      assert.ok(fromHistory.length >= 1, JSON.stringify(list.slice(0, 5)));
      assert.ok(fromHistory.every((entry) => entry.site === SITE), 'only listed sites');
      assert.ok(fromHistory.some((entry) => Math.abs(entry.at - threeDaysAgo) < 60_000), `an entry dated three days ago: ${JSON.stringify(fromHistory)}`);
      assert.equal(list[0].from, 'history', 'the oldest entry is the one from three days ago');
      // The settings page shows the latest three, which the old visit is not among; every try has its page.
      const rows = await browser.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      assert.ok(rows.length <= 3 && rows.every((row) => row[2] !== 'Visited (browser history)'), JSON.stringify(rows));
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
      const status = await scanHistory((text) => /Removed/.test(text));
      assert.match(status, /: found 1 visit to listed sites, all new\. Removed 1 page from this browser's history and 1 bookmark\.$/, status);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      assert.deepEqual(await inHistory(), []);
      assert.deepEqual(await bookmarked(), []);
      assert.equal(await autofill('exa'), 'exa', 'nothing left to suggest');
      const list = await storedAttempts();
      assert.ok(list.some((entry) => entry.site === SITE && entry.from === 'history' && Math.abs(entry.at - (Date.now() - 7 * 86_400_000)) < 120_000), 'the visit stays in the record');

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
      assert.ok(shownOnSettings <= 3 && shownOnSettings <= count, 'the settings page shows the latest three at most');

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
            rows: [...document.querySelectorAll('.day tbody tr:not(.band)')].map((row) => [...row.cells].map((cell) => cell.textContent)),
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
      await scanHistory((text) => /^Looked through/.test(text));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const until = Date.now() + 15_000;
      let note = { hidden: true };
      while (note.hidden && Date.now() < until) {
        await sleep(200);
        note = await browser.run(`const note = document.getElementById('unlisted-note'); return { hidden: note.hidden, text: note.textContent }`);
      }
      assert.equal(note.text, "1 site in this browser's history looks adult but isn't on either list: see which.");

      // The unlisted page (#54), opened in the record page's tab.
      const recordTab = { handle: await openRecordTab() };
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
      // The unblocked visit a moment ago went into the history and from there into the record; a try less
      // than two seconds after it would count as the same one.
      await sleep(2100);
      await browser.newTab();
      await assertBlocked('http://hentai-example.test/three');
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      assert.equal(await browser.run("return document.getElementById('custom').value"), 'hentai-example.test', "the settings page's box shows the addition");
      let record = await storedAttempts();
      assert.ok(record.some((entry) => entry.site === 'hentai-example.test' && entry.from === 'history'), JSON.stringify(record.slice(-4)));
      const noted = Date.now() + 10_000;
      while (!record.some((entry) => entry.site === 'hentai-example.test' && !entry.from) && Date.now() < noted) {
        await sleep(250);
        record = await storedAttempts();
      }
      assert.ok(record.some((entry) => entry.site === 'hentai-example.test' && !entry.from), `the try just made: ${JSON.stringify(record.slice(-5))}`);
    });

    // --- Was it ever off? (#69) ---
    /** Runs a script on the current extension page with the WebExtension APIs, as the pages themselves do; it must call done(result). */
    const inPage = (script, ...args) => browser.fx.send('WebDriver:ExecuteAsyncScript', { script: `const done = arguments[arguments.length - 1]; ${script}`, args });
    const storedWatching = () => inPage(`browser.storage.local.get('watching').then((got) => done(got.watching), (e) => done('error: ' + e));`);

    test('the add-on keeps track of when it is running, from the install on, with an alarm every minute', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const state = await storedWatching();
      assert.ok(state && typeof state === 'object', JSON.stringify(state));
      assert.ok(state.since > Date.now() - 30 * 60_000 && state.since <= Date.now(), `since the install, earlier in this run: ${JSON.stringify(state)}`);
      assert.equal(state.atLeast, undefined);
      assert.ok(state.periods.length >= 1 && state.periods[0].from === state.since, JSON.stringify(state.periods));
      assert.ok(Date.now() - state.periods.at(-1).to < 2 * 60_000, `kept up to the minute: ${JSON.stringify(state.periods.at(-1))}`);
      const alarms = await inPage(`browser.alarms.getAll().then((all) => done(all.map(({ name, periodInMinutes }) => ({ name, periodInMinutes }))), (e) => done('error: ' + e));`);
      assert.deepEqual(alarms, [{ name: 'heartbeat', periodInMinutes: 1 }]);
    });

    test("a visit from a time the add-on was off is told from one from before it was installed: Firefox's history, dated, inside a silence in the add-on's own account of running", async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const original = await storedWatching();
      const now = Date.now();
      const hour = 3600_000;
      // The add-on's account of running, as it would stand had it been installed three hours ago and off
      // between two and one hours ago; and Firefox's history with a page from then, a listed site visited
      // then, and one visited before the install, which the look through the history records and takes out.
      const set = await inPage(
        `const [now, hour] = arguments;
         browser.storage.local.set({ watching: { since: now - 3 * hour, periods: [{ from: now - 3 * hour, to: now - 2 * hour }, { from: now - hour, to: now }], off: [] } })
           .then(() => Promise.all([
             browser.history.addUrl({ url: 'http://allowed.test/while-off', visitTime: now - 90 * 60_000 }),
             browser.history.addUrl({ url: 'http://exampleadultsite.com/while-off', visitTime: now - 85 * 60_000 }),
             browser.history.addUrl({ url: 'http://exampleadultsite.com/before-the-install', visitTime: now - 4 * hour }),
           ]))
           .then(() => done('ok'), (e) => done('error: ' + e));`,
        now,
        hour,
      );
      assert.equal(set, 'ok');
      await scanHistory((text) => /^Looked through this browser's history on .+: found \d+ visits? to listed sites/.test(text));
      const host = new URL(settings.url).host;
      const until = Date.now() + 20_000;
      let shown = {};
      do {
        shown = await browser.run(`return {
          since: document.getElementById('since').textContent,
          off: document.getElementById('off-summary').textContent,
          link: document.querySelector('#off-summary a')?.getAttribute('href') ?? null,
          summary: document.getElementById('summary').textContent,
        }`);
        if (shown.link) break;
        await sleep(250);
      } while (Date.now() < until);
      assert.equal(shown.link, 'tries.html#off', JSON.stringify(shown));
      const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const sameDay = new Date(now - 2 * hour).toDateString() === new Date(now - hour).toDateString();
      const back = (sameDay ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }) : when).format(now - hour);
      const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        shown.off,
        new RegExp(`^Off once, from ${literal(when.format(now - 2 * hour))} until ${literal(back)}: 1 page visited meanwhile\\. 1 visit to a listed site while the extension was off, the latest on .+\\. See it among every try\\.`),
        `the time off with the page visited meanwhile, the visit to the listed site from it, and the link: ${shown.off}`,
      );
      assert.equal(shown.since, `Watching since ${when.format(now - 3 * hour)}, when the extension was installed in this browser.`);
      assert.match(shown.summary, / from this browser's history, 1 of them from times the extension was off\.$/);
      const state = await storedWatching();
      assert.deepEqual(state.off, [{ from: now - 2 * hour, to: now - hour, pages: 1 }]);
      assert.equal(state.periods.length, 2, `the silence stays, being a time the add-on was off: ${JSON.stringify(state.periods)}`);

      // Every try marks it, apart from the visits from before the install.
      await browser.visit(`moz-extension://${host}/tries.html`);
      let rows = [];
      for (let i = 0; i < 40 && !rows.some((row) => row[2] === 'Visited while the add-on was off'); i++) {
        if (i) await sleep(250);
        rows = await browser.run(`return [...document.querySelectorAll('.day tbody tr:not(.band)')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      }
      assert.deepEqual(rows.filter((row) => row[2] === 'Visited while the add-on was off').map((row) => row[1]), [SITE]);
      assert.ok(rows.some((row) => row[2] === 'Visited (browser history)'), `the visit from before the install keeps its wording: ${JSON.stringify(rows)}`);
      const bands = await browser.run(`return [...document.querySelectorAll('.day tr.band')].map((row) => row.textContent)`);
      assert.equal(bands.length, 1, `the time it was off, laid in as a band: ${JSON.stringify(bands)}`);
      assert.match(bands[0], /^Add-on off from .+ until .+: 1 page visited meanwhile\.$/);
      // The account of running as it was, so the rest of the run is not told the add-on was off.
      await inPage(`browser.storage.local.set({ watching: arguments[0] }).then(() => done('ok'), (e) => done('error: ' + e));`, original);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
    });

    test("a live try's sweep of the site's pages from Firefox's history records the earlier visits it finds before taking them out", async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const yesterday = Date.now() - 86_400_000;
      // A visit the add-on never saw, which no look through the history has recorded.
      const seeded = await inPage(`browser.history.addUrl({ url: 'http://exampleadultsite.com/yesterday', visitTime: arguments[0] }).then(() => done('ok'), (e) => done('error: ' + e));`, yesterday);
      assert.equal(seeded, 'ok');
      const inHistory = () =>
        inPage(`browser.history.search({ text: 'yesterday', startTime: 0, maxResults: 100 }).then((items) => done(items.map((item) => item.url)), (e) => done('error: ' + e));`);
      assert.deepEqual(await inHistory(), ['http://exampleadultsite.com/yesterday']);
      await sleep(2100);
      await browser.newTab();
      await assertBlocked(BLOCKED_URL);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const until = Date.now() + 15_000;
      let left = await inHistory();
      while (left.length > 0 && Date.now() < until) {
        await sleep(250);
        left = await inHistory();
      }
      assert.deepEqual(left, [], "the sweep took yesterday's page out");
      const attempts = await inPage(`browser.storage.local.get('attempts').then((got) => done(got.attempts), (e) => done('error: ' + e));`);
      const recorded = attempts.filter((entry) => entry.site === SITE && entry.from === 'history' && Math.abs(entry.at - yesterday) < 1000);
      assert.equal(recorded.length, 1, `yesterday's visit went into the record first: ${JSON.stringify(attempts.slice(-3))}`);
      const live = attempts.filter((entry) => entry.site === SITE && !entry.from && Date.now() - entry.at < 60_000);
      assert.ok(live.length >= 1, 'the try itself is noted once, not again from the history');
      assert.equal(attempts.filter((entry) => entry.site === SITE && entry.from === 'history' && Date.now() - entry.at < 60_000).length, 0);
    });

    test('a password locked away with a short wait comes back after it, and is locked away again; the settings page says where it stands', async () => {
      const settings = tabsAfterInstall.find(({ url }) => url.endsWith('/options.html'));
      // The password has a page of its own (#70).
      await browser.newTab();
      await browser.visit(`moz-extension://${new URL(settings.url).host}/lockbox.html`);
      const lockboxHandle = (await browser.tabs()).find(({ url }) => url.endsWith('/lockbox.html')).handle;
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: lockboxHandle });
      const shown = () =>
        browser.run(`return ['lockbox-empty', 'lockbox-locked', 'lockbox-open'].find((id) => !document.getElementById(id).hidden)`);
      const storedBox = () =>
        browser.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('lockbox').then((got) => done(got.lockbox ?? null), () => done(null));`,
          args: [],
        });
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
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const lineUntil = Date.now() + 10_000;
      let line = '';
      while (!/^A password is locked away/.test(line) && Date.now() < lineUntil) {
        await sleep(200);
        line = await browser.run("return document.getElementById('lockbox-line').textContent");
      }
      assert.match(line, /^A password is locked away \(since .+\), never unlocked; getting it back takes about [1-4] seconds\.$/);
      assert.equal(await browser.run("return document.getElementById('lockbox-page').getAttribute('href')"), 'lockbox.html');
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: lockboxHandle });

      // The wait can be lengthened without unlocking (#76): the box goes inside a longer puzzle, and the
      // lines on both pages say so; unlocking then solves the outer puzzle and the inner one in turn.
      await browser.run(`
        document.getElementById('lockbox-longer').append(new Option('5 seconds', '5', true, true));
        document.getElementById('lockbox-lengthen').click();`);
      const lengthenedUntil = Date.now() + 15_000;
      let status = '';
      while (!/^The wait is now/.test(status) && Date.now() < lengthenedUntil) {
        await sleep(200);
        status = await browser.run("return document.getElementById('lockbox-status').textContent");
      }
      assert.match(status, /^The wait is now [4-6] seconds\. Save a new backup file/);
      assert.match(await browser.run("return document.getElementById('lockbox-summary').textContent"), /^A password is locked away \(since .+, wait lengthened .+\)\. Getting it back takes about [4-6] seconds of computing/);
      const stored = await storedBox();
      assert.equal(stored.version, 2);
      assert.equal(stored.holds, 'box');
      assert.equal(stored.inside.length, 1);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const longerUntil = Date.now() + 10_000;
      while (!/wait lengthened/.test(line) && Date.now() < longerUntil) {
        await sleep(200);
        line = await browser.run("return document.getElementById('lockbox-line').textContent");
      }
      assert.match(line, /^A password is locked away \(since .+, wait lengthened .+\), never unlocked; getting it back takes about [4-6] seconds\.$/);
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: lockboxHandle });

      const started = Date.now();
      await browser.run("document.getElementById('lockbox-why').value = 'to try it'; document.getElementById('lockbox-start').click()");
      await waitUntilShown('lockbox-open', 30_000);
      assert.ok(Date.now() - started >= 2500, 'not sooner than the wait allows');
      assert.equal(await browser.run("return document.getElementById('lockbox-revealed').value"), 'Firefox-Admin-Password');

      // The record of what happened (#75), summed up in a line under the password (1.14.0), once it has been locked away again.
      const recordUntil = Date.now() + 15_000;
      let recordLine = '';
      while (!/^5 entries/.test(recordLine) && Date.now() < recordUntil) {
        await sleep(200);
        recordLine = await browser.run("return document.getElementById('lockbox-record-line').textContent");
      }
      assert.match(recordLine, /^5 entries since .+, the latest on .+: Locked away again, with the same wait of 5 seconds\. See them among every try\.$/);
      assert.equal(await browser.run("return document.querySelector('#lockbox-record-line a').getAttribute('href')"), 'tries.html#password');
      const events = await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('lockboxEvents').then((got) => done((got.lockboxEvents ?? []).map(({ event }) => event)), (e) => done([]));`,
        args: [],
      });
      assert.deepEqual(events, ['locked', 'lengthened', 'started', 'shown', 'sealed']);
      assert.match(await browser.run("return document.getElementById('lockbox-again').textContent"), /^It’s already locked away again with the same wait \(5 seconds\)\./);

      await browser.run("document.getElementById('lockbox-hide').click()");
      await waitUntilShown('lockbox-locked');
      const again = await storedBox();
      assert.equal(again.version, 1, 'locked away again as one puzzle, with the whole wait');
      assert.equal(again.delay, 5);

      // The entries are rows among every try, in the password page's words, newest first, the beginning last (1.14.0).
      await browser.visit(`moz-extension://${new URL(settings.url).host}/tries.html#password`);
      let record = [];
      for (let i = 0; i < 40 && record.length < 6; i++) {
        if (i) await sleep(250);
        record = await browser.run("return Array.from(document.querySelectorAll('.day tbody tr'), (row) => [row.cells[1].textContent, row.cells[2].textContent])");
      }
      assert.deepEqual(record.map(([site]) => site), Array(6).fill('Locked-away password'), JSON.stringify(record));
      assert.equal(record[0][1], 'Locked away again, with the same wait of 5 seconds.');
      assert.match(record[1][1], /^The password was shown \(unlocking started .+: “to try it”\)\.$/);
      assert.equal(record[2][1], 'Unlocking started: “to try it”.', 'with the reason asked for (1.13.2)');
      assert.equal(record[3][1], 'The wait was lengthened from 3 seconds to 5 seconds, without unlocking.');
      assert.equal(record[4][1], 'Locked away, with a wait of 3 seconds.');
      assert.equal(record[5][1], 'The record began.', 'the last row, from 1.13.1');
      assert.equal(await browser.run("return document.getElementById('filter-site').textContent"), 'the locked-away password');

      // And the settings page's line counts the unlock.
      await browser.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
      const countUntil = Date.now() + 10_000;
      while (!/unlocked once/.test(line) && Date.now() < countUntil) {
        await sleep(200);
        line = await browser.run("return document.getElementById('lockbox-line').textContent");
      }
      assert.match(line, /^A password is locked away \(since .+\), unlocked once, last on .+; getting it back takes about [4-6] seconds\.$/);
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
    /** Waits until the elements with background pictures named are judged, and gives back every such element's mark and background. */
    const waitForBackgrounds = async (target, want, ms = 30_000) => {
      const until = Date.now() + ms;
      let marks = {};
      while (Date.now() < until) {
        marks = Object.fromEntries(await target.run(`return ${BACKGROUND_MARKS}`));
        if (Object.entries(want).every(([id, mark]) => marks[id]?.[0] === mark)) return marks;
        await sleep(250);
      }
      throw new Error(`backgrounds never judged as expected: ${JSON.stringify(marks)}`);
    };

    before(() => {
      servePictures(stub, ['cat', 'coffee', 'photo', 'nude', 'lingerie', 'drawn']);
      stub.page('allowed.test/real', galleryPage(['cat', 'coffee']));
      stub.page('allowed.test/gallery', galleryPage(['photo', 'nude', 'lingerie', 'drawn']));
      stub.page('allowed.test/backgrounds', backgroundsPage());
      // Videos: red is "nude" to the stand-in, blue a photo; blue-then-red turns after a second.
      serveVideos(stub);
      stub.page(
        'allowed.test/videos',
        videoPage([
          'id="red" src="/videos/red.webm" autoplay muted loop',
          'id="blue" src="/videos/blue.webm" autoplay muted loop',
          'id="turns" src="/videos/blue-then-red.webm" autoplay muted loop',
          'id="poster-bad" src="/videos/blue.webm" poster="http://pics.test/pics/lingerie.jpg?poster" preload="none"',
          'id="foreign" src="http://videos.test/videos/red.webm" autoplay muted loop',
        ]),
      );
      // The device's own camera (Firefox's fake one starts green, "lingerie" to the stand-in, and drifts
      // through blue to red), alone and next to the same picture as streams from elsewhere.
      stub.page('camera.test/camera', cameraPage());
      stub.page('camera.test/streams', cameraPage({ streams: true }));
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
      assert.match(line, /^Pictures and videos are judged before they show: since the browser started, \d+ pictures judged, 0 hidden \(through WebAssembly\)\.$/);
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
        // A picture an element's own style sets as its background is judged too (#80): X shows a tweet's
        // picture that way, under a see-through <img>.
        await judge.newTab();
        await judge.visit('http://allowed.test/backgrounds');
        const backgrounds = await waitForBackgrounds(judge, { 'bg-nude': 'hidden', 'bg-photo': 'hidden', 'bg-layers': 'hidden', 'bg-icon': 'small', 'bg-thumb': 'hidden', 'bg-mask': 'ok', 'x-bg': 'hidden', 'bg-late': 'hidden' });
        assert.deepEqual(
          [backgrounds['bg-nude'], backgrounds['bg-icon'], backgrounds['bg-mask'], backgrounds['x-bg']],
          [['hidden', 'none'], ['small', 'url("http://pics.test/icon.gif")'], ['ok', 'none'], ['hidden', 'none']],
          JSON.stringify(backgrounds),
        );
        const pair = await waitForMarks(judge, ['x-img']);
        assert.deepEqual(pair['x-img'], ['hidden', 'hidden'], 'the see-through <img> over it is hidden too');
        await judge.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
        const record = await judge.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('pictures').then((got) => done(got.pictures ?? []), (e) => done([]));`,
          args: [],
        });
        const names = record.filter((entry) => entry.site === 'allowed.test').map((entry) => [entry.url.split('/').pop(), entry.reason]).sort();
        assert.deepEqual(
          names,
          [
            ['drawn.jpg', 'nudity'],
            ['lingerie.jpg', 'suggestive'],
            ['lingerie.jpg?layer', 'suggestive'],
            ['lingerie.jpg?x', 'suggestive'],
            ['nude.jpg', 'nudity'],
            ['nude.jpg?bg', 'nudity'],
            ['nude.jpg?late-bg', 'nudity'],
            ['nude.jpg?swapped-bg', 'nudity'],
            ['nude.jpg?thumb', 'nudity'],
          ],
          JSON.stringify(record),
        );
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

    test('with the stand-in classifier: a video is judged by its poster and frames as it plays, hidden and paused when one shows something, and noted as a video', async () => {
      const standIn = extensionWithStandInClassifier();
      const judge = await launchFirefox(stub, { extensionDir: standIn.dir });
      try {
        const settings = (await judge.tabs()).find(({ url }) => url.endsWith('/options.html'));
        await judge.newTab();
        await judge.visit('http://allowed.test/videos');
        const marks = await waitForMarks(judge, ['red', 'blue', 'poster-bad', 'foreign']);
        // Firefox lets an add-on read the frames of a video from another site, which the page itself may not
        // (Chromium doesn't), so the video from videos.test is judged by its frames too, and hidden.
        assert.deepEqual(
          [marks.red, marks.blue, marks['poster-bad'], marks.foreign],
          [['hidden', 'hidden'], ['ok', 'visible'], ['hidden', 'hidden'], ['hidden', 'hidden']],
          JSON.stringify(marks),
        );
        // Neither hidden video was ever shown; the blue one was judged out of sight, then shown.
        const seen = await judge.run('return window.__marks');
        assert.ok(!seen.red.includes('ok'), JSON.stringify(seen.red));
        assert.deepEqual(seen.blue, ['checking', 'ok'], JSON.stringify(seen.blue));
        // The one that turns is shown first, then hidden within a moment; hidden videos are paused, the rest play.
        const until = Date.now() + 20_000;
        while (!(await judge.run("return document.getElementById('turns').getAttribute('data-family-site-blocker') === 'hidden'")) && Date.now() < until) await sleep(250);
        const turns = (await judge.run('return window.__marks')).turns;
        assert.ok(turns.indexOf('ok') >= 0 && turns.indexOf('ok') < turns.lastIndexOf('hidden'), `shown, then hidden: ${JSON.stringify(turns)}`);
        await sleep(500);
        assert.deepEqual(await judge.run("return ['red', 'turns', 'foreign', 'blue'].map((id) => document.getElementById(id).paused)"), [true, true, true, false]);
        await judge.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
        const record = await judge.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('pictures').then((got) => done(got.pictures ?? []), (e) => done([]));`,
          args: [],
        });
        const videos = record.filter((entry) => entry.kind === 'video').map((entry) => [entry.url.replace('http://', ''), entry.reason]).sort();
        assert.deepEqual(videos, [['allowed.test/videos/blue-then-red.webm', 'nudity'], ['allowed.test/videos/red.webm', 'nudity'], ['videos.test/videos/red.webm', 'nudity']], JSON.stringify(record));
        assert.ok(record.some((entry) => entry.url.endsWith('lingerie.jpg?poster') && !entry.kind), 'the poster is noted as a picture');
      } finally {
        await judge.close();
        standIn.remove();
      }
    });

    test("with the stand-in classifier: a video of the device's own camera is shown as it is and never judged; the same picture as a stream the page made, or from another peer, is judged and hidden", async (t) => {
      const standIn = extensionWithStandInClassifier();
      const judge = await launchFirefox(stub, { extensionDir: standIn.dir, prefs: FAKE_CAMERA_PREFS });
      try {
        const settings = (await judge.tabs()).find(({ url }) => url.endsWith('/options.html'));
        const streamsInPlace = async () => {
          const until = Date.now() + 15_000;
          let page = {};
          while (!page.ready && !page.error && Date.now() < until) {
            await sleep(250);
            page = await judge.run('return { ready: window.__ready, error: window.__error }');
          }
          assert.deepEqual(page, { ready: true, error: null }, 'the page got its camera and streams');
        };
        // The camera alone (#84): shown once the stream is known to be the camera's, and left alone after.
        await judge.newTab();
        await judge.visit('http://camera.test/camera');
        await streamsInPlace();
        let marks = await waitForMarks(judge, ['camera']);
        assert.deepEqual(marks.camera, ['ok', 'visible'], JSON.stringify(marks));
        await sleep(3500); // long enough for two frames to have been judged, had it been judged
        assert.deepEqual((await judge.run('return window.__marks')).camera, ['checking', 'ok'], 'never hidden');
        assert.deepEqual(await judge.run("const v = document.getElementById('camera'); return [v.paused, v.videoWidth > 0, v.currentTime > 0]"), [false, true, true], 'the camera plays on');
        // The control: the picture the camera shows is one the stand-in hides. Copied through a canvas into
        // a stream the page made, it is judged by its frames, hidden and paused, and noted under the page's
        // address; so is a green picture arriving through a peer connection, as another person's camera
        // does in a call, wherever Firefox can connect to itself (on GitHub's Mac the connection fails, and
        // that leg is reported rather than judged).
        await judge.newTab();
        await judge.visit('http://camera.test/streams');
        await streamsInPlace();
        const peerState = () => judge.run("const v = document.getElementById('peer'); return { mark: v.getAttribute('data-family-site-blocker'), connection: window.__peer ?? null, readyState: v.readyState, width: v.videoWidth }");
        const until = Date.now() + 30_000;
        let peer = await peerState();
        const done = async () => (await judge.run("return document.getElementById('copy').getAttribute('data-family-site-blocker') === 'hidden'")) && (peer.mark === 'hidden' || peer.connection === 'failed');
        while (!(await done()) && Date.now() < until) {
          await sleep(250);
          peer = await peerState();
        }
        marks = Object.fromEntries(await judge.run(`return ${MARKS}`));
        assert.deepEqual([marks.camera, marks.copy], [['ok', 'visible'], ['hidden', 'hidden']], JSON.stringify(marks));
        const connected = peer.connection === 'connected' || peer.mark === 'hidden';
        if (connected) assert.deepEqual(marks.peer, ['hidden', 'hidden'], `${JSON.stringify(marks)}; the peer's video ${JSON.stringify(peer)}`);
        else t.diagnostic(`the peer connection never came up in this Firefox (${JSON.stringify(peer)}), so the stream through it went unjudged here`);
        await sleep(500);
        const pausedNow = await judge.run("return ['camera', 'copy', 'peer'].map((id) => document.getElementById(id).paused)");
        assert.deepEqual(pausedNow.slice(0, 2), [false, true], `camera, copy paused: ${pausedNow}`);
        if (connected) assert.equal(pausedNow[2], true, 'the hidden stream from the peer is paused'); // one that never connected never started
        assert.deepEqual((await judge.run('return window.__marks')).camera, ['checking', 'ok'], 'the camera was never hidden');
        await judge.fx.send('WebDriver:SwitchToWindow', { handle: settings.handle });
        const record = await judge.fx.send('WebDriver:ExecuteAsyncScript', {
          script: `const done = arguments[arguments.length - 1]; browser.storage.local.get('pictures').then((got) => done(got.pictures ?? []), (e) => done([]));`,
          args: [],
        });
        const here = record.filter((entry) => entry.site === 'camera.test');
        assert.ok(here.length >= 1 && here.every((entry) => entry.kind === 'video' && entry.url === 'http://camera.test/streams'), JSON.stringify(record));
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

  // Firefox's own copy of the built-in list is a Firefox policy (WebsiteFilter), which the lock installs on a
  // Mac and which blocks with no add-on running, as in Troubleshoot Mode. Here it goes into Firefox's own
  // policies.json (see writePolicies above), with no add-on loaded.
  describe("Firefox's own copy of the list (the lock's filter) blocks with no add-on running", { skip: whyNoPolicies() }, () => {
    let plain;
    let removePolicies = () => {};

    before(async () => {
      removePolicies = writePolicies({ WebsiteFilter: { Block: filterEntries() } });
      plain = await launchFirefox(stub, { extension: false });
      await plain.newTab();
    });

    after(async () => {
      await plain?.close();
      removePolicies();
    });

    async function assertFirefoxBlocks(url, site) {
      stub.clear();
      const result = await plain.visit(url);
      assert.equal(result.outcome, 'blocked by Firefox', `${url} ended at ${result.documentUri || result.finalUrl}`);
      assert.equal(stub.reached(site), false, `${url}: a request reached ${site}`);
    }

    test('Firefox takes all 1,000 entries, the whole domains included, as valid patterns', async () => {
      // Firefox logs an invalid pattern and drops it; a dropped one would leave a site open without a word.
      const state = await plain.inFirefox(`
        const done = arguments[arguments.length - 1];
        try {
          const { WebsiteFilter } = ChromeUtils.importESModule("resource:///modules/policies/WebsiteFilter.sys.mjs");
          done({ patterns: WebsiteFilter._blockPatterns.patterns.map((pattern) => pattern.pattern) });
        } catch (error) {
          done({ error: String(error) });
        }`);
      assert.deepEqual(state.patterns, filterEntries(), state.error);
    });

    test('the test case, and the sites that fill the copy, are blocked by Firefox itself', async () => {
      const { sites } = filterSites();
      const starter = parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'starter.txt'), 'utf8')).domains;
      const sample = ['exampleadultsite.com', ...sites.filter((site, i) => !starter.includes(site) && i % 100 === 0), sites[sites.length - 1]];
      for (const site of sample) await assertFirefoxBlocks(`http://${site}/`, site);
    });

    test('a site on an adult top-level domain is blocked whether or not a list has it', async () => {
      for (const site of ['tik.porn', 'www.tik.porn', 'brand-new-site.porn', 'a.xxx', 'b.sex', 'c.adult', 'd.sexy']) {
        await assertFirefoxBlocks(`http://${site}/`, site);
        await assertFirefoxBlocks(`https://${site}/video/1?x=y`, site);
      }
    });

    test("a name that only ends like one, and never.txt's sites, load", async () => {
      for (const url of ['http://allowed.test/', 'http://notporn.com/', 'http://porn.allowed.test/', 'http://tik.porn.allowed.test/', 'http://www.refinery29.com/', 'http://cdn-of-a-shop.b-cdn.net/']) {
        const result = await plain.visit(url);
        assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.documentUri || result.finalUrl}`);
      }
    });
  });
});
