// Firefox lock tests: with the policies from scripts/firefox-lock.mjs in force, Firefox installs the signed
// add-on itself, and nobody can switch it off. The situations: the lock on its own; Troubleshoot Mode, which
// a Mac can still start from outside Firefox and where no add-on runs, so Firefox's own copy of the built-in
// list has to do the blocking; the lock next to another blocker's policies (like Plucky's), where both must
// stay in force; the lock arriving after the add-on was installed by hand and switched off (the same version,
// or an older one); and updating it by hand. Run with:
//   SIGNED_XPI=signed.xpi OLDER_XPI=older-signed-version.xpi OTHER_XPI=another-signed-add-on.xpi \
//     npm run test:firefox-lock
//
// It sets the policies the way they reach Firefox for real and takes them away afterwards. On a Mac the lock
// goes in /Library/Preferences/org.mozilla.firefox, the settings the configuration profile carries (needs sudo,
// and runs only in CI, so it never touches a family's own lock), and the other blocker's policies go in
// Firefox's own distribution/policies.json, a separate place, as a program like Plucky can set them. Elsewhere
// Firefox reads a single policies.json, so the two go in it combined, the way Firefox combines them on a Mac.
// The lock installs the add-on from an address on the update site; here the stand-in internet serves the
// signed file at a stand-in address, which the lock under test names instead.
// Skipped without a signed .xpi or a way to set policies. The parts that need OLDER_XPI (an earlier signed
// version of this add-on) or OTHER_XPI (the GitHub workflow uses LeechBlock NG, a site blocker from
// addons.mozilla.org) are skipped without them.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';
import { BLOCKLIST_DIR } from '../scripts/build-rules.mjs';
import { ADDON_ID, filterSites, firefoxPolicies, macSettings, plist } from '../scripts/firefox-lock.mjs';
import { readZip } from '../scripts/read-zip.mjs';
import { updatesManifest } from '../scripts/updates-manifest.mjs';
import { startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const SITE = 'exampleadultsite.com';
// Not on the built-in list, so only the add-on blocks it once the settings page adds it.
const ADDED_SITE = 'added-on-the-settings-page.test';
// Where the lock under test installs from: the stand-in internet serves a signed file there (see serveLockFile).
const LOCK_URL = 'http://updates.test/family-site-blocker.xpi';
const FIREFOX = findFirefox();
const SIGNED = process.env.SIGNED_XPI;
const OLDER = process.env.OLDER_XPI;
const OTHER = process.env.OTHER_XPI;
const MAC = process.platform === 'darwin';
const SWITCHES = ['BlockAboutConfig', 'DisablePrivateBrowsing', 'DisableProfileRefresh', 'DisableSafeMode'];
const DNR_LOCKED = { 'extensions.dnr.enabled': { Value: true, Status: 'locked' } };
const CANT_BE_REMOVED = { usable: false, label: 'remove-addon-disabled-button' };
const test = (name, fn) => it(name, { timeout: 60_000 }, fn);
const HOOK = { timeout: 180_000 };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Where Firefox looks for its own policies.json: inside the app on a Mac, next to the program elsewhere.
const APP_POLICIES = FIREFOX && (MAC
  ? join(dirname(dirname(FIREFOX)), 'Resources', 'distribution', 'policies.json')
  : join(dirname(FIREFOX), 'distribution', 'policies.json'));

function whyNot() {
  if (!FIREFOX) return 'no Firefox found (set FIREFOX=/path/to/firefox)';
  if (!SIGNED) return 'set SIGNED_XPI to a .xpi signed by Mozilla';
  if (MAC) {
    if (!process.env.CI) return 'on a Mac this changes the lock for every account, so it only runs in CI';
    return spawnSync('sudo', ['-n', 'true']).status === 0 ? false : 'needs sudo without a password';
  }
  if (existsSync('/etc/firefox/policies/policies.json')) return 'Firefox would read /etc/firefox/policies/policies.json instead';
  try {
    accessSync(dirname(FIREFOX), constants.W_OK);
    return false;
  } catch {
    return `can't write policies next to ${FIREFOX}`;
  }
}
const SKIP = whyNot();

/** The ID and version a signed .xpi carries. */
function manifestOf(file) {
  const manifest = JSON.parse(readZip(readFileSync(file)).get('manifest.json').data);
  return { id: (manifest.browser_specific_settings ?? manifest.applications)?.gecko?.id, version: manifest.version };
}

/** Whether a version of the add-on notes blocked attempts on its settings page (from 1.3.0). */
function notesAttempts(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 3);
}

/** Whether a version of the add-on says on its settings page whether the lock is in force (from 1.7.0, #69). */
function saysWhetherLocked(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 7);
}

/**
 * Another blocker's policies, as Plucky sets them: its own add-on force-installed (and so locked) with
 * ExtensionSettings, and the same switches and locked preference as the lock.
 */
function otherBlockerPolicies(id, xpi) {
  return {
    ExtensionSettings: { [id]: { installation_mode: 'force_installed', install_url: pathToFileURL(xpi).href } },
    Preferences: DNR_LOCKED,
    ...Object.fromEntries(SWITCHES.map((name) => [name, true])),
  };
}

const sudo = (...args) => assert.equal(spawnSync('sudo', ['-n', ...args], { stdio: 'inherit' }).status, 0, args.join(' '));

/** Serves `xpi` as the file the lock installs from, at `url` on the stand-in internet. */
function serveLockFile(stub, xpi, url = LOCK_URL) {
  const { host, pathname } = new URL(url);
  stub.page(`${host}${pathname}`, readFileSync(xpi), { headers: { 'content-type': 'application/x-xpinstall' } });
}

/**
 * Puts the lock in force for the next Firefox start, installing from `url` (serve a file there with
 * serveLockFile), and with { other } another program's policies as well. { change } edits the lock's policies
 * first, to stand in for an earlier version of the lock. Returns the lock's policies, and a function that takes
 * everything away.
 */
function applyPolicies(scratch, { url = LOCK_URL, other = null, change = (lock) => lock } = {}) {
  const undo = [];
  const lock = change(firefoxPolicies(url));
  if (MAC) {
    const settings = join(scratch, 'org.mozilla.firefox.plist');
    writeFileSync(settings, plist(macSettings(lock)));
    sudo('defaults', 'import', '/Library/Preferences/org.mozilla.firefox', settings);
    undo.push(() => sudo('defaults', 'delete', '/Library/Preferences/org.mozilla.firefox'));
    if (other) {
      assert.equal(existsSync(APP_POLICIES), false, `${APP_POLICIES} is there already`);
      const file = join(scratch, 'policies.json');
      writeFileSync(file, JSON.stringify({ policies: other }, null, 2));
      const madeFolder = !existsSync(dirname(APP_POLICIES));
      sudo('mkdir', '-p', dirname(APP_POLICIES));
      sudo('cp', file, APP_POLICIES);
      undo.push(() => sudo('rm', '-rf', madeFolder ? dirname(APP_POLICIES) : APP_POLICIES));
    }
  } else {
    const previous = existsSync(APP_POLICIES) ? readFileSync(APP_POLICIES) : null;
    mkdirSync(dirname(APP_POLICIES), { recursive: true });
    // A single file here: combined as Firefox combines them on a Mac, where the profile's win, policy by policy.
    writeFileSync(APP_POLICIES, JSON.stringify({ policies: { ...other, ...lock } }, null, 2));
    undo.push(() => (previous ? writeFileSync(APP_POLICIES, previous) : rmSync(APP_POLICIES, { force: true })));
  }
  return { lock, remove: () => undo.reverse().forEach((step) => step()) };
}

/** Starts Firefox on the stub internet, with ways to look at add-ons the way Firefox and a person see them. */
async function startFirefox(stub, options = {}) {
  const browser = await launchFirefox(stub, { extension: false, ...options });

  const chrome = async (script, ...args) => {
    await browser.fx.send('Marionette:SetContext', { value: 'chrome' });
    try {
      return await browser.fx.send('WebDriver:ExecuteAsyncScript', {
        script: `
          const done = arguments[arguments.length - 1];
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          (async () => { ${script} })().then(done, (error) => done({ error: String(error) }));`,
        args,
      });
    } finally {
      await browser.fx.send('Marionette:SetContext', { value: 'content' });
    }
  };

  const addon = (id) => chrome(`
    const a = await AddonManager.getAddonByID(arguments[0]);
    return a && {
      version: a.version, active: a.isActive, temporary: a.temporarilyInstalled, updated: a.updateDate.getTime(),
      signedByMozilla: a.signedState === AddonManager.SIGNEDSTATE_SIGNED,
      source: a.installTelemetryInfo && a.installTelemetryInfo.source,
      canEnable: Boolean(a.permissions & AddonManager.PERM_CAN_ENABLE),
      canDisable: Boolean(a.permissions & AddonManager.PERM_CAN_DISABLE),
      canRemove: Boolean(a.permissions & AddonManager.PERM_CAN_UNINSTALL),
    };`, id);

  /** Waits (up to 20 seconds) for an add-on to be as `wanted` says, and returns how it is then. */
  async function waitForAddon(id, wanted = (info) => info?.active) {
    let info = null;
    for (let i = 0; i < 80; i++) {
      info = await addon(id);
      if (wanted(info)) break;
      await sleep(250);
    }
    return info;
  }

  /** An add-on's card in the Add-ons Manager, with its "…" menu opened, as a person would look at it. */
  async function card(id) {
    await browser.fx.send('WebDriver:Navigate', { url: 'about:addons' });
    await browser.run(`window.gViewController.loadView('addons://list/extension')`);
    for (let i = 0; i < 40; i++) {
      const found = await browser.run(`
        const card = document.querySelector('addon-card[addon-id="' + arguments[0] + '"]');
        if (!card) return null;
        card.querySelector('[action="more-options"]')?.click();
        const onOff = card.querySelector('[action="toggle-disabled"]');
        const remove = card.querySelector('panel-item[action="remove"]');
        return {
          name: card.addon && card.addon.name,
          onOffSwitch: onOff && !onOff.hidden ? (onOff.pressed ? 'on' : 'off') : 'none',
          removeItem: remove && { usable: !remove.hidden && !remove.disabled, label: remove.getAttribute('data-l10n-id') },
        };`, id);
      if (found) return found;
      await sleep(250);
    }
    return null;
  }

  /** Clicks an add-on's on/off switch on the Add-ons Manager page that card() opened. */
  const clickSwitch = (id) => browser.run(`
    const toggle = document.querySelector('addon-card[addon-id="' + arguments[0] + '"] [action="toggle-disabled"]');
    (toggle.buttonEl ?? toggle).click();`, id);

  /**
   * Opens a built-in site and checks it was blocked with nothing reaching it. Under the lock that is Firefox's
   * own copy of the list, which acts before any add-on, so the person sees Firefox's "Blocked Page".
   */
  async function assertBlocked(url = `http://${SITE}/`, site = SITE) {
    stub.clear();
    const result = await browser.visit(url);
    assert.equal(result.outcome, 'blocked by Firefox', `${url} ended at ${result.documentUri || result.finalUrl}`);
    assert.equal(stub.reached(site), false, `${url}: a request reached ${site}`);
  }

  /**
   * Checks that Family Site Blocker itself runs and blocks: adds a site on its settings page, as a parent would,
   * and opens it. Only the add-on blocks that site, so it shows the add-on's "This site is blocked" page.
   */
  async function assertAddonBlocks() {
    const host = await chrome('return WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname ?? null;', ADDON_ID);
    assert.ok(host, 'Family Site Blocker is running');
    await browser.fx.send('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
    await browser.run(`document.getElementById('custom').value = arguments[0]; document.getElementById('save').click();`, ADDED_SITE);
    let status = '';
    for (let i = 0; i < 40 && !status.startsWith('Saved'); i++) {
      await sleep(150);
      status = await browser.run(`return document.getElementById('status').textContent`);
    }
    assert.match(status, /^Saved/, 'the settings page saved the site');
    stub.clear();
    const result = await browser.visit(`http://${ADDED_SITE}/`);
    assert.equal(result.outcome, 'blocked page', `${ADDED_SITE} ended at ${result.documentUri || result.finalUrl}`);
    assert.equal(stub.reached(ADDED_SITE), false, `a request reached ${ADDED_SITE}`);
  }

  return Object.assign(browser, { chrome, addon, waitForAddon, card, clickSwitch, assertBlocked, assertAddonBlocks });
}

describe('Firefox lock', { skip: SKIP }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const version = SIGNED && manifestOf(SIGNED).version;
  let policies;
  let stub;
  let firefox;

  before(async () => {
    stub = await startStubInternet();
    serveLockFile(stub, SIGNED);
    policies = applyPolicies(scratch);
    firefox = await startFirefox(stub);
    await firefox.waitForAddon(ADDON_ID);
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Firefox installs the signed add-on by itself, from the address the lock names', async () => {
    const { updated, canEnable, ...info } = await firefox.addon(ADDON_ID);
    assert.deepEqual(info, {
      version, active: true, temporary: false, signedByMozilla: true, source: 'enterprise-policy', canDisable: false, canRemove: false,
    });
    assert.ok(stub.requests.some(({ host, path }) => host === 'updates.test' && path === '/family-site-blocker.xpi'), 'fetched from the update site');
  });

  test("test case: with the lock, exampleadultsite.com is blocked, by Firefox's own copy of the list", () => firefox.assertBlocked());

  test("a site added on the settings page gets the add-on's own block page", () => firefox.assertAddonBlocks());

  // Only with a signed version that notes attempts; an older release has no record to look at.
  if (version && notesAttempts(version)) {
    test("both tries are noted on the settings page, the one Firefox's own copy of the list stopped too, and neither got through", async () => {
      await sleep(2100); // tries less than two seconds apart count as one
      await firefox.assertBlocked();
      await firefox.assertAddonBlocks();
      const host = await firefox.chrome('return WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname ?? null;', ADDON_ID);
      await firefox.fx.send('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
      const wanted = (rows) => rows.some((row) => row[1] === SITE) && rows.some((row) => row[1] === ADDED_SITE);
      let rows = [];
      for (let i = 0; i < 40 && !wanted(rows); i++) {
        if (i) await sleep(250);
        rows = await firefox.run(`return [...document.querySelectorAll('#attempts-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent))`);
      }
      assert.ok(wanted(rows), JSON.stringify(rows));
      assert.ok(rows.every((row) => row[2] === 'Blocked'), `nothing got through: ${JSON.stringify(rows)}`);
    });
  }

  test('in the Add-ons Manager, Family Site Blocker has no on/off switch, and its menu says "Can’t Be Removed"', async () => {
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertAddonBlocks();
  });

  test('its access to websites is locked on, so the block page keeps working', async () => {
    const state = await firefox.chrome(`
      return {
        locked: typeof Services.policies.isAddonRequiredByPolicy === 'function' ? Services.policies.isAddonRequiredByPolicy(arguments[0]) : 'not in this Firefox',
        origins: WebExtensionPolicy.getByID(arguments[0]).allowedOrigins.patterns.map((p) => p.pattern),
      };`, ADDON_ID);
    assert.equal(state.locked, true, `Firefox ${firefox.version} locks the website access of add-ons the lock requires`);
    assert.ok(state.origins.includes('<all_urls>'), JSON.stringify(state.origins));
  });

  test('the add-on can tell that the lock is on: Firefox reports it as installed by policy, with no way to switch it off, and from 1.7.0 its settings page says so (#69)', async () => {
    const host = await firefox.chrome('return WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname ?? null;', ADDON_ID);
    await firefox.fx.send('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
    const self = await firefox.fx.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1];
        browser.management.getSelf().then((info) => done({ installType: info.installType, mayDisable: info.mayDisable }), (e) => done('error: ' + e));`,
      args: [],
    });
    assert.deepEqual(self, { installType: 'admin', mayDisable: false }, `what Firefox ${firefox.version} says about an add-on the lock installed`);
    if (version && saysWhetherLocked(version)) {
      let status = '';
      for (let i = 0; i < 40 && (!status || status === 'Checking…'); i++) {
        if (i) await sleep(250);
        status = await firefox.run(`return document.getElementById('lock-status').textContent`);
      }
      assert.equal(status, 'The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it.');
    }
  });

  test('private windows are turned off: the shortcut is gone, and asking for one opens an ordinary window, which blocks', async () => {
    // Firefox also hides the File menu's New Private Window item, but on GitHub's Mac (Firefox 155) that item
    // stayed. Either way, choosing it asks for a private window, as below, and gets an ordinary one.
    const state = await firefox.chrome(`
      const { document } = Services.wm.getMostRecentWindow('navigator:browser');
      return { privateWindows: PrivateBrowsingUtils.enabled, shortcut: Boolean(document.getElementById('key_privatebrowsing')) };`);
    assert.deepEqual(state, { privateWindows: false, shortcut: false });
    const before = await firefox.fx.send('WebDriver:GetWindowHandles');
    await firefox.chrome(`
      const win = OpenBrowserWindow({ private: true });
      await new Promise((loaded) => win.addEventListener('load', loaded, { once: true }));`);
    let handle;
    for (let i = 0; i < 40 && !handle; i++) {
      handle = (await firefox.fx.send('WebDriver:GetWindowHandles')).find((h) => !before.includes(h));
      if (!handle) await sleep(250);
    }
    assert.ok(handle, 'a window opened');
    await firefox.fx.send('WebDriver:SwitchToWindow', { handle });
    const isPrivate = await firefox.chrome(`return PrivateBrowsingUtils.isWindowPrivate(Services.wm.getMostRecentWindow("navigator:browser"));`);
    assert.equal(isPrivate, false);
    // A new tab in that window: unlike the window's first tab, it has finished loading when it opens, so the
    // window's start page can't replace the test address.
    await firefox.newTab();
    await firefox.assertBlocked();
    await firefox.assertAddonBlocks();
  });

  test('Troubleshoot Mode, Refresh Firefox and about:config are turned off', async () => {
    const allowed = await firefox.chrome(`return { safeMode: Services.policies.isAllowed('safeMode'), profileRefresh: Services.policies.isAllowed('profileRefresh') };`);
    assert.deepEqual(allowed, { safeMode: false, profileRefresh: false });
    await firefox.fx.send('WebDriver:Navigate', { url: 'about:config' }).catch(() => {});
    const page = await firefox.run('return { uri: document.documentURI, text: document.body ? document.body.innerText : "" }');
    assert.match(page.uri, /^about:neterror\?e=blockedByPolicy/, JSON.stringify(page));
  });

  test("the setting that switches off every add-on's blocking is locked on", async () => {
    const pref = await firefox.chrome(`return { value: Services.prefs.getBoolPref('extensions.dnr.enabled'), locked: Services.prefs.prefIsLocked('extensions.dnr.enabled') };`);
    assert.deepEqual(pref, { value: true, locked: true });
  });
});

// From 1.3.2 the add-on updates itself: its update_url names an update manifest (scripts/updates-manifest.mjs)
// on a public site, which Firefox reads about once a day. Here the stub internet stands in for that site, and
// the older signed version plays the copy a family Mac has today. That version has no update_url of its own,
// so Firefox asks the address in extensions.update.url instead, which the profile points at the stub; the
// manifest and the file it links to are the real thing, made from the newest signed version.
describe('Firefox lock, when the add-on updates itself', { skip: SKIP || (!OLDER && 'set OLDER_XPI to an earlier signed version of this add-on') }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const UPDATES = 'http://updates.test/';
  const older = OLDER && manifestOf(OLDER).version;
  const newer = SIGNED && manifestOf(SIGNED).version;
  const file = `family-site-blocker-${newer}.xpi`;
  let policies;
  let stub;
  let firefox;

  const setUpdateUrl = (url) => firefox.chrome(`Services.prefs.setCharPref('extensions.update.url', arguments[0]); return true;`, url);

  /** Asks Firefox to check for updates, as the Add-ons Manager's "Check for Updates" does, and installs what it finds. */
  const updateNow = () => firefox.chrome(`
    const addon = await AddonManager.getAddonByID(arguments[0]);
    let install = null;
    const status = await new Promise((done) => addon.findUpdates({
      onUpdateAvailable(a, found) { install = found; },
      onUpdateFinished(a, result) { done(result); },
    }, AddonManager.UPDATE_WHEN_USER_REQUESTED));
    if (!install) return { found: false, status };
    // The newer version may ask for permissions the older one didn't; Firefox would ask the person first. Stand in for their click.
    install.promptHandler = () => Promise.resolve();
    const outcome = await new Promise((done) => {
      install.addListener({
        onInstallEnded: () => done('installed'),
        onInstallFailed: () => done('install failed: ' + install.error),
        onDownloadFailed: () => done('download failed: ' + install.error),
      });
      install.install();
    });
    return { found: true, version: install.version, outcome, incorrectHash: AddonManager.ERROR_INCORRECT_HASH };`, ADDON_ID);

  before(async () => {
    stub = await startStubInternet();
    serveLockFile(stub, OLDER);
    policies = applyPolicies(scratch);
    const signed = readFileSync(SIGNED);
    const manifest = updatesManifest([{ name: file, data: signed }], UPDATES);
    stub.page(`updates.test/updates.json`, JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
    stub.page(`updates.test/${file}`, signed, { headers: { 'content-type': 'application/x-xpinstall' } });
    // The same manifest with the wrong hash, to see that Firefox checks it.
    const tampered = structuredClone(manifest);
    tampered.addons[ADDON_ID].updates[0].update_hash = `sha256:${'0'.repeat(64)}`;
    stub.page(`updates.test/tampered.json`, JSON.stringify(tampered), { headers: { 'content-type': 'application/json' } });
    firefox = await startFirefox(stub, { prefs: { 'extensions.update.url': `${UPDATES}updates.json` } });
    await firefox.waitForAddon(ADDON_ID);
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Firefox installs the older version the lock points at', async () => {
    const info = await firefox.addon(ADDON_ID);
    assert.equal(info.version, older);
    assert.notEqual(older, newer, 'OLDER_XPI is an earlier version than SIGNED_XPI');
  });

  test("a file that doesn't match the hash in the update manifest is refused, and the older version stays", async () => {
    await setUpdateUrl(`${UPDATES}tampered.json`);
    const result = await updateNow();
    assert.equal(result.found, true, JSON.stringify(result));
    assert.equal(result.outcome, `download failed: ${result.incorrectHash}`, JSON.stringify(result));
    assert.equal((await firefox.addon(ADDON_ID)).version, older);
  });

  test('asked to check for updates, Firefox finds the newer signed version in the update manifest and installs it; the lock holds', async () => {
    await setUpdateUrl(`${UPDATES}updates.json`);
    stub.clear();
    const result = await updateNow();
    assert.deepEqual({ found: result.found, version: result.version, outcome: result.outcome }, { found: true, version: newer, outcome: 'installed' }, JSON.stringify(result));
    assert.ok(stub.requests.some(({ host, path }) => host === 'updates.test' && path === `/${file}`), 'the file came from the update site');
    const info = await firefox.waitForAddon(ADDON_ID, (found) => found?.version === newer && found.active);
    const { updated, canEnable, source, ...rest } = info;
    assert.deepEqual(rest, { version: newer, active: true, temporary: false, signedByMozilla: true, canDisable: false, canRemove: false });
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertBlocked();
    await firefox.assertAddonBlocks();
  });
});

/** Waits (up to 8 seconds) for the current tab to show a page whose address passes `test`. */
async function waitForDocument(firefox, test) {
  let uri = '';
  for (let i = 0; i < 40 && !test(uri); i++) {
    if (i) await sleep(200);
    uri = await firefox.run('return document.documentURI').catch(() => '');
  }
  return uri;
}

// On a Mac, holding Option (⌥) while Firefox opens, or opening it with --safe-mode, still offers Troubleshoot
// Mode: Firefox checks DisableSafeMode at that point only on Windows. No add-on runs there. --safe-mode puts
// Firefox in the same mode as the Option key, and Firefox's automation answers its "Open" question.
describe('Troubleshoot Mode, with the lock as it was before it gave Firefox its own copy of the list', { skip: SKIP }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let policies;
  let stub;
  let firefox;

  before(async () => {
    stub = await startStubInternet();
    serveLockFile(stub, SIGNED);
    policies = applyPolicies(scratch, { change: ({ WebsiteFilter, ...earlier }) => earlier });
    firefox = await startFirefox(stub, { troubleshootMode: true });
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Actual, as reported: exampleadultsite.com is allowed (so the next tests can see a failure)', async () => {
    stub.clear();
    const result = await firefox.visit(`http://${SITE}/`);
    assert.equal(result.outcome, 'site loaded', `ended at ${result.documentUri || result.finalUrl}`);
    assert.equal(stub.reached(SITE), true);
  });
});

describe('Firefox lock in Troubleshoot Mode', { skip: SKIP }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let policies;
  let stub;
  let firefox;

  before(async () => {
    stub = await startStubInternet();
    serveLockFile(stub, SIGNED);
    policies = applyPolicies(scratch);
    stub.page('allowed.test/links', `<a id="go" href="http://${SITE}/">go</a>`);
    stub.page('allowed.test/frame', `<iframe id="frame" src="http://${SITE}/frame"></iframe>`);
    stub.page('allowed.test/redirect', '', { status: 302, headers: { location: `http://${SITE}/` } });
    firefox = await startFirefox(stub, { troubleshootMode: true });
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Firefox is in Troubleshoot Mode, and Family Site Blocker is not running', async () => {
    const state = await firefox.chrome(
      'return { troubleshootMode: Services.appinfo.inSafeMode, addonRunning: Boolean(WebExtensionPolicy.getByID(arguments[0])) };',
      ADDON_ID,
    );
    assert.deepEqual(state, { troubleshootMode: true, addonRunning: false });
  });

  test('test case: exampleadultsite.com is blocked, by Firefox itself', () => firefox.assertBlocked());

  describe('the same site, written in other ways, is blocked', () => {
    const variants = [
      ['https', `https://${SITE}/`],
      ['www subdomain', 'http://www.exampleadultsite.com/'],
      ['deep subdomain with path, query and fragment', 'http://a.b.exampleadultsite.com/page?x=1#y'],
      ['upper case', 'http://EXAMPLEADULTSITE.COM/'],
      ['explicit port', 'http://exampleadultsite.com:8080/'],
      ['trailing dot', 'http://exampleadultsite.com./'],
      ['trailing dot on a subdomain', 'http://www.exampleadultsite.com./'],
      ['user name and password', 'http://user:pw@exampleadultsite.com/'],
      ['full-width letters', 'http://ｅｘａｍｐｌｅａｄｕｌｔｓｉｔｅ.com/'],
    ];
    for (const [name, url] of variants) test(name, () => firefox.assertBlocked(url));
  });

  test("the sites in Firefox's own copy of the list are blocked: all of starter.txt, and a sample of the rest", async () => {
    const { sites } = filterSites();
    const starter = parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'starter.txt'), 'utf8')).domains;
    const sample = [...starter, ...sites.filter((site, i) => !starter.includes(site) && i % 25 === 0)];
    assert.ok(sample.length >= starter.length, `${sample.length} sites to check`);
    for (const site of sample) await firefox.assertBlocked(`http://${site}/`, site);
  });

  test('a site on an adult top-level domain is blocked whether or not a list has it, and a name that only ends like one loads', async () => {
    for (const site of ['tik.porn', 'www.tik.porn', 'brand-new-site.porn', 'a.xxx', 'b.sex', 'c.adult', 'd.sexy']) {
      await firefox.assertBlocked(`http://${site}/`, site);
    }
    for (const url of ['http://notporn.com/', 'http://porn.allowed.test/', 'http://tik.porn.allowed.test/']) {
      const result = await firefox.visit(url);
      assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.documentUri || result.finalUrl}`);
    }
  });

  test('a link, a redirect and a frame on another site lead nowhere', async () => {
    await firefox.visit('http://allowed.test/links');
    stub.clear();
    await firefox.run('document.getElementById("go").click()');
    assert.match(await waitForDocument(firefox, (uri) => uri.startsWith('about:neterror')), /^about:neterror\?e=blockedByPolicy/, 'link');
    assert.equal(stub.reached(SITE), false, 'the link reached the site');
    await firefox.assertBlocked('http://allowed.test/redirect');
    stub.clear();
    await firefox.visit('http://allowed.test/frame');
    await sleep(1000);
    assert.equal(stub.reached(SITE), false, 'the frame reached the site');
  });

  test('other sites still load', async () => {
    for (const url of ['http://allowed.test/', 'http://notexampleadultsite.com/', 'http://exampleadultsite.com.allowed.test/', 'http://exampleadultsite.co/']) {
      const result = await firefox.visit(url);
      assert.equal(result.outcome, 'site loaded', `${url} ended at ${result.documentUri || result.finalUrl}`);
    }
  });
});

describe('Firefox lock next to another blocker', { skip: SKIP || (!OTHER && "set OTHER_XPI to another program's signed add-on") }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const other = OTHER && manifestOf(OTHER);
  let policies;
  let stub;
  let firefox;

  before(async () => {
    const otherXpi = join(scratch, 'other-blocker.xpi');
    copyFileSync(OTHER, otherXpi);
    stub = await startStubInternet();
    serveLockFile(stub, SIGNED);
    policies = applyPolicies(scratch, { other: otherBlockerPolicies(other.id, otherXpi) });
    firefox = await startFirefox(stub);
    await firefox.waitForAddon(ADDON_ID);
    await firefox.waitForAddon(other.id);
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test("Firefox keeps both programs' policies, as about:policies lists them", async () => {
    const active = await firefox.chrome(`
      const policies = Services.policies.getActivePolicies();
      return {
        ExtensionSettings: Object.keys(policies.ExtensionSettings || {}),
        Extensions: policies.Extensions,
        // A Mac's settings give true as 1, which Firefox reads as true.
        dnrLocked: policies.Preferences && Object.fromEntries(Object.entries(policies.Preferences['extensions.dnr.enabled'] || {})
          .map(([key, value]) => [key, key === 'Value' ? Boolean(value) : value])),
        switchedOn: arguments[0].filter((name) => policies[name] === true),
        WebsiteFilter: policies.WebsiteFilter,
      };`, SWITCHES);
    assert.deepEqual(active, {
      ExtensionSettings: [other.id],
      Extensions: policies.lock.Extensions,
      dnrLocked: DNR_LOCKED['extensions.dnr.enabled'],
      switchedOn: SWITCHES,
      WebsiteFilter: policies.lock.WebsiteFilter,
    });
  });

  test('both add-ons are installed, and neither can be switched off or removed', async () => {
    for (const [id, name] of [[ADDON_ID, 'Family Site Blocker'], [other.id, 'the other blocker']]) {
      const { active, canDisable, canRemove } = (await firefox.addon(id)) ?? {};
      assert.deepEqual({ active, canDisable, canRemove }, { active: true, canDisable: false, canRemove: false }, name);
    }
  });

  test('in the Add-ons Manager, neither has an on/off switch, and both menus say "Can’t Be Removed"', async () => {
    for (const id of [ADDON_ID, other.id]) {
      const { onOffSwitch, removeItem } = (await firefox.card(id)) ?? {};
      assert.deepEqual({ onOffSwitch, removeItem }, { onOffSwitch: 'none', removeItem: CANT_BE_REMOVED }, id);
    }
  });

  test('test case: with both, exampleadultsite.com is blocked', () => firefox.assertBlocked());

  test("Family Site Blocker's own blocking still works next to the other blocker", () => firefox.assertAddonBlocks());
});

/**
 * The situation of a family that tried the add-on before the lock: `handXpi` installed by hand, as a person
 * does, and switched off. Then the lock arrives (installing from `lockXpi`) and Firefox starts again with the
 * same profile. Returns the second Firefox, once the lock's install has run, and a function that cleans up.
 */
async function switchedOffThenLocked(stub, scratch, { handXpi, lockXpi = SIGNED }) {
  const profile = join(scratch, 'profile');
  mkdirSync(profile);
  const first = await startFirefox(stub, { profile });
  try {
    // Installing opens the settings page, which takes over a blank tab. If that happens while an automation
    // command runs, Firefox's automation loses the tab ("Document was unloaded"). With a page open, as a
    // person would have, the settings page gets a tab of its own.
    await first.fx.send('WebDriver:Navigate', { url: 'http://allowed.test/' });
    await first.fx.send('Addon:Install', { path: resolve(handXpi), temporary: false });
    assert.equal((await first.waitForAddon(ADDON_ID))?.active, true, 'installed by hand');
    await first.chrome(`await (await AddonManager.getAddonByID(arguments[0])).disable();`, ADDON_ID);
    assert.equal((await first.waitForAddon(ADDON_ID, (info) => info && !info.active))?.active, false, 'switched off');
  } finally {
    await first.close();
  }
  serveLockFile(stub, lockXpi);
  const policies = applyPolicies(scratch);
  const firefox = await startFirefox(stub, { profile });
  // The lock's install runs once, early in the start; wait until Firefox has the lock's version.
  const wanted = manifestOf(lockXpi).version;
  await firefox.waitForAddon(ADDON_ID, (info) => info?.version === wanted && (info.active || info.canEnable));
  await sleep(1000);
  await firefox.newTab();
  return { firefox, policies };
}

describe('Firefox lock, after the same version was installed by hand and switched off', { skip: SKIP }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let started;
  let stub;

  before(async () => {
    stub = await startStubInternet();
    started = await switchedOffThenLocked(stub, scratch, { handXpi: SIGNED });
  }, HOOK);

  after(async () => {
    await started?.firefox.close();
    await stub?.close();
    started?.policies.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Firefox switches it back on by itself, and then nobody can switch it off', async () => {
    const { active, canDisable, canRemove } = await started.firefox.addon(ADDON_ID);
    assert.deepEqual({ active, canDisable, canRemove }, { active: true, canDisable: false, canRemove: false });
    assert.deepEqual(await started.firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
  });

  test('test case: exampleadultsite.com is blocked, and the add-on blocks the sites added on its settings page', async () => {
    await started.firefox.assertBlocked();
    await started.firefox.assertAddonBlocks();
  });
});

describe('Firefox lock, after an older version was installed by hand and switched off', { skip: SKIP || (!OLDER && 'set OLDER_XPI to an earlier signed version of this add-on') }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let started;
  let stub;

  before(async () => {
    stub = await startStubInternet();
    started = await switchedOffThenLocked(stub, scratch, { handXpi: OLDER });
  }, HOOK);

  after(async () => {
    await started?.firefox.close();
    await stub?.close();
    started?.policies.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test("Firefox updates it to the lock's version but leaves it off: the Add-ons Manager only offers to switch it on", async () => {
    const { version, active, canEnable, canDisable, canRemove } = await started.firefox.addon(ADDON_ID);
    assert.deepEqual(
      { version, active, canEnable, canDisable, canRemove },
      { version: manifestOf(SIGNED).version, active: false, canEnable: true, canDisable: false, canRemove: false },
    );
    assert.deepEqual(await started.firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'off', removeItem: CANT_BE_REMOVED });
  });

  test("while it is still off, Firefox's own copy of the list keeps exampleadultsite.com blocked", () => started.firefox.assertBlocked());

  test('once it is switched on, the switch is gone and the add-on blocks again', async () => {
    const { firefox } = started;
    await firefox.card(ADDON_ID);
    await firefox.clickSwitch(ADDON_ID);
    assert.equal((await firefox.waitForAddon(ADDON_ID))?.active, true, 'switched on');
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertBlocked();
    await firefox.assertAddonBlocks();
  });
});

// The situation of a family Mac today: every account already has an older copy, installed by an earlier lock.
// A new lock names a different address (here: the same stand-in site under another name), so Firefox runs its
// install again in the existing profile at the next start, and the newer version goes in with nobody clicking.
describe("Firefox lock, when a new lock names a different address and the profile has the earlier lock's version", { skip: SKIP || (!OLDER && 'set OLDER_XPI to an earlier signed version of this add-on') }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const EARLIER_URL = 'http://updates.test/earlier/family-site-blocker.xpi';
  let policies;
  let stub;
  let firefox;

  before(async () => {
    stub = await startStubInternet();
    serveLockFile(stub, OLDER, EARLIER_URL);
    serveLockFile(stub, SIGNED);
    const profile = join(scratch, 'profile');
    mkdirSync(profile);
    // The earlier lock, in force while the account's Firefox profile is made.
    policies = applyPolicies(scratch, { url: EARLIER_URL });
    const earlier = await startFirefox(stub, { profile });
    try {
      assert.equal((await earlier.waitForAddon(ADDON_ID))?.version, manifestOf(OLDER).version, "the earlier lock's version is installed");
    } finally {
      await earlier.close();
    }
    policies.remove();
    // Then the new lock arrives, and Firefox starts again with the same profile.
    policies = applyPolicies(scratch);
    firefox = await startFirefox(stub, { profile });
    await firefox.waitForAddon(ADDON_ID, (info) => info?.version === manifestOf(SIGNED).version && info.active);
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('Firefox installs the newer version from the new address at the next start, switched on and locked', async () => {
    const { updated, canEnable, source, ...info } = await firefox.addon(ADDON_ID);
    assert.deepEqual(info, { version: manifestOf(SIGNED).version, active: true, temporary: false, signedByMozilla: true, canDisable: false, canRemove: false });
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
  });

  test('the new version has the permissions it asks for, so it blocks and notes attempts without anyone accepting anything', async () => {
    const permissions = await firefox.chrome(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return { origins: policy.allowedOrigins.patterns.map((p) => p.pattern), permissions: [...policy.permissions] };`, ADDON_ID);
    assert.ok(permissions.origins.includes('<all_urls>'), JSON.stringify(permissions));
    for (const name of ['webNavigation', 'webRequest']) assert.ok(permissions.permissions.includes(name), `${name} granted: ${JSON.stringify(permissions)}`);
    await firefox.assertBlocked();
    await firefox.assertAddonBlocks();
  });
});

describe('Firefox lock, when a newer version is installed by hand', { skip: SKIP || (!OLDER && 'set OLDER_XPI to an earlier signed version of this add-on') }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let policies;
  let stub;
  let firefox;

  before(async () => {
    // The lock installing the earlier version, as when a newer one has come out since.
    stub = await startStubInternet();
    serveLockFile(stub, OLDER);
    policies = applyPolicies(scratch);
    firefox = await startFirefox(stub);
    await firefox.waitForAddon(ADDON_ID);
    await firefox.newTab();
  }, HOOK);

  after(async () => {
    await firefox?.close();
    await stub?.close();
    policies?.remove();
    rmSync(scratch, { recursive: true, force: true });
  }, HOOK);

  test('the lock lets the newer signed version install over it, and stays on', async () => {
    assert.equal((await firefox.addon(ADDON_ID))?.version, manifestOf(OLDER).version);
    await firefox.fx.send('Addon:Install', { path: resolve(SIGNED), temporary: false });
    const wanted = manifestOf(SIGNED).version;
    const { version, active, canDisable, canRemove } = await firefox.waitForAddon(ADDON_ID, (info) => info?.version === wanted && info.active);
    assert.deepEqual({ version, active, canDisable, canRemove }, { version: wanted, active: true, canDisable: false, canRemove: false });
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertBlocked();
    await firefox.assertAddonBlocks();
  });
});
