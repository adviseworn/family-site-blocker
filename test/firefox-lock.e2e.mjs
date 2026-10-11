// Firefox lock tests: with the policies from scripts/firefox-lock.mjs in force, Firefox installs the signed
// add-on itself, and nobody can switch it off. Run with:  SIGNED_XPI=path/to/signed.xpi npm run test:firefox-lock
//
// It sets the policies the way they reach Firefox for real and takes them away afterwards. On a Mac that is
// /Library/Preferences/org.mozilla.firefox, the settings the configuration profile carries (needs sudo, and
// runs only in CI, so it never touches a family's own lock). Elsewhere it writes distribution/policies.json
// next to the Firefox it tests. Skipped without a signed .xpi or a way to set policies.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADDON_ID, XPI_PATH, firefoxPolicies, macSettings, plist } from '../scripts/firefox-lock.mjs';
import { readZip } from '../scripts/read-zip.mjs';
import { startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const SITE = 'exampleadultsite.com';
const FIREFOX = findFirefox();
const SIGNED = process.env.SIGNED_XPI;
const MAC = process.platform === 'darwin';
const test = (name, fn) => it(name, { timeout: 60_000 }, fn);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function whyNot() {
  if (!FIREFOX) return 'no Firefox found (set FIREFOX=/path/to/firefox)';
  if (!SIGNED) return 'set SIGNED_XPI to a .xpi signed by Mozilla';
  if (MAC) {
    if (!process.env.CI) return 'on a Mac this changes the lock for every account, so it only runs in CI';
    return spawnSync('sudo', ['-n', 'true']).status === 0 ? false : 'needs sudo without a password';
  }
  try {
    accessSync(dirname(FIREFOX), constants.W_OK);
    return false;
  } catch {
    return `can't write policies next to ${FIREFOX}`;
  }
}

/** Puts the lock in force for the next Firefox start. Returns a function that takes it away again. */
function applyLock(scratch) {
  if (MAC) {
    mkdirSync(dirname(XPI_PATH), { recursive: true });
    copyFileSync(SIGNED, XPI_PATH);
    const settings = join(scratch, 'org.mozilla.firefox.plist');
    writeFileSync(settings, plist(macSettings()));
    const sudo = (...args) => assert.equal(spawnSync('sudo', ['-n', ...args], { stdio: 'inherit' }).status, 0, args.join(' '));
    sudo('defaults', 'import', '/Library/Preferences/org.mozilla.firefox', settings);
    return () => {
      sudo('defaults', 'delete', '/Library/Preferences/org.mozilla.firefox');
      rmSync(dirname(XPI_PATH), { recursive: true, force: true });
    };
  }
  const xpi = join(scratch, 'family-site-blocker.xpi');
  copyFileSync(SIGNED, xpi);
  const file = join(dirname(FIREFOX), 'distribution', 'policies.json');
  const previous = existsSync(file) ? readFileSync(file) : null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ policies: firefoxPolicies(pathToFileURL(xpi).href) }, null, 2));
  return () => (previous ? writeFileSync(file, previous) : rmSync(file, { force: true }));
}

describe('Firefox lock', { skip: whyNot() }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const version = SIGNED && JSON.parse(readZip(readFileSync(SIGNED)).get('manifest.json').data).version;
  let unlock;
  let stub;
  let browser;

  const inChrome = async (command, script, args) => {
    await browser.fx.send('Marionette:SetContext', { value: 'chrome' });
    try {
      return await browser.fx.send(command, { script, args });
    } finally {
      await browser.fx.send('Marionette:SetContext', { value: 'content' });
    }
  };
  const chrome = (script, ...args) => inChrome('WebDriver:ExecuteAsyncScript', `
    const done = arguments[arguments.length - 1];
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    (async () => { ${script} })().then(done, (error) => done({ error: String(error) }));`, args);

  const addon = () => chrome(`
    const a = await AddonManager.getAddonByID(arguments[0]);
    return a && {
      version: a.version, active: a.isActive, temporary: a.temporarilyInstalled,
      signedByMozilla: a.signedState === AddonManager.SIGNEDSTATE_SIGNED,
      source: a.installTelemetryInfo && a.installTelemetryInfo.source,
      canDisable: Boolean(a.permissions & AddonManager.PERM_CAN_DISABLE),
      canRemove: Boolean(a.permissions & AddonManager.PERM_CAN_UNINSTALL),
    };`, ADDON_ID);

  async function assertBlocked(url) {
    stub.clear();
    const result = await browser.visit(url);
    assert.equal(result.outcome, 'blocked page', `${url} ended at ${result.finalUrl}`);
    assert.equal(stub.reached(SITE), false, 'a request reached the site');
  }

  before(async () => {
    unlock = applyLock(scratch);
    stub = await startStubInternet();
    browser = await launchFirefox(stub, { extension: false });
    for (let i = 0; i < 80; i++) {
      const info = await addon();
      if (info?.active) break;
      await sleep(250);
    }
    await browser.newTab();
  });

  after(async () => {
    await browser?.close();
    await stub?.close();
    unlock?.();
    rmSync(scratch, { recursive: true, force: true });
  });

  test('Firefox installs the signed add-on by itself', async () => {
    assert.deepEqual(await addon(), {
      version, active: true, temporary: false, signedByMozilla: true, source: 'enterprise-policy', canDisable: false, canRemove: false,
    });
  });

  test('test case: with the lock, exampleadultsite.com is blocked', () => assertBlocked(`http://${SITE}/`));

  test('in the Add-ons Manager, Family Site Blocker has no on/off switch, and its menu says "Can’t Be Removed"', async () => {
    await browser.fx.send('WebDriver:Navigate', { url: 'about:addons' });
    await browser.run(`window.gViewController.loadView('addons://list/extension')`);
    let card = null;
    for (let i = 0; i < 40 && !card; i++) {
      card = await browser.run(`
        const card = document.querySelector('addon-card[addon-id="' + arguments[0] + '"]');
        if (!card) return null;
        card.querySelector('[action="more-options"]')?.click(); // open the "…" menu, as a person would
        const onOff = card.querySelector('[action="toggle-disabled"]');
        const remove = card.querySelector('panel-item[action="remove"]');
        return {
          name: card.addon && card.addon.name,
          onOffSwitch: Boolean(onOff && !onOff.hidden),
          removeItem: remove && { usable: !remove.hidden && !remove.disabled, label: remove.getAttribute('data-l10n-id') },
        };`, ADDON_ID);
      if (!card) await sleep(250);
    }
    assert.deepEqual(card, {
      name: 'Family Site Blocker',
      onOffSwitch: false,
      removeItem: { usable: false, label: 'remove-addon-disabled-button' },
    });
    await assertBlocked(`http://${SITE}/`);
  });

  test('its access to websites is locked on, so the block page keeps working', async () => {
    const state = await chrome(`
      return {
        locked: typeof Services.policies.isAddonRequiredByPolicy === 'function' ? Services.policies.isAddonRequiredByPolicy(arguments[0]) : 'not in this Firefox',
        origins: WebExtensionPolicy.getByID(arguments[0]).allowedOrigins.patterns.map((p) => p.pattern),
      };`, ADDON_ID);
    assert.equal(state.locked, true, `Firefox ${browser.version} locks the website access of add-ons the lock requires`);
    assert.ok(state.origins.includes('<all_urls>'), JSON.stringify(state.origins));
  });

  test('it runs in private windows too, and blocks there', async () => {
    const allowed = await chrome(`return WebExtensionPolicy.getByID(arguments[0]).privateBrowsingAllowed;`, ADDON_ID);
    assert.equal(allowed, true);
    const before = await browser.fx.send('WebDriver:GetWindowHandles');
    await chrome(`
      const win = OpenBrowserWindow({ private: true });
      await new Promise((loaded) => win.addEventListener('load', loaded, { once: true }));`);
    let handle;
    for (let i = 0; i < 40 && !handle; i++) {
      handle = (await browser.fx.send('WebDriver:GetWindowHandles')).find((h) => !before.includes(h));
      if (!handle) await sleep(250);
    }
    assert.ok(handle, 'a private window opened');
    await browser.fx.send('WebDriver:SwitchToWindow', { handle });
    const isPrivate = await chrome(`return PrivateBrowsingUtils.isWindowPrivate(Services.wm.getMostRecentWindow("navigator:browser"));`);
    assert.equal(isPrivate, true);
    await assertBlocked(`http://${SITE}/`);
  });

  test('Troubleshoot Mode, Refresh Firefox and about:config are turned off', async () => {
    const allowed = await chrome(`return { safeMode: Services.policies.isAllowed('safeMode'), profileRefresh: Services.policies.isAllowed('profileRefresh') };`);
    assert.deepEqual(allowed, { safeMode: false, profileRefresh: false });
    await browser.fx.send('WebDriver:Navigate', { url: 'about:config' }).catch(() => {});
    const page = await browser.run('return { uri: document.documentURI, text: document.body ? document.body.innerText : "" }');
    assert.match(page.uri, /^about:neterror\?e=blockedByPolicy/, JSON.stringify(page));
  });

  test("the setting that switches off every add-on's blocking is locked on", async () => {
    const pref = await chrome(`return { value: Services.prefs.getBoolPref('extensions.dnr.enabled'), locked: Services.prefs.prefIsLocked('extensions.dnr.enabled') };`);
    assert.deepEqual(pref, { value: true, locked: true });
  });
});
