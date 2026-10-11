// Firefox lock tests: with the policies from scripts/firefox-lock.mjs in force, Firefox installs the signed
// add-on itself, and nobody can switch it off. The situations: the lock on its own; the lock next to another
// blocker's policies (like Plucky's), where both must stay in force; the lock arriving after the add-on was
// installed by hand and switched off (the same version, or an older one); and updating it by hand. Run with:
//   SIGNED_XPI=signed.xpi OLDER_XPI=older-signed-version.xpi OTHER_XPI=another-signed-add-on.xpi \
//     npm run test:firefox-lock
//
// It sets the policies the way they reach Firefox for real and takes them away afterwards. On a Mac the lock
// goes in /Library/Preferences/org.mozilla.firefox, the settings the configuration profile carries (needs sudo,
// and runs only in CI, so it never touches a family's own lock), and the other blocker's policies go in
// Firefox's own distribution/policies.json, a separate place, as a program like Plucky can set them. Elsewhere
// Firefox reads a single policies.json, so the two go in it combined, the way Firefox combines them on a Mac.
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
import { ADDON_ID, XPI_PATH, firefoxPolicies, macSettings, plist } from '../scripts/firefox-lock.mjs';
import { readZip } from '../scripts/read-zip.mjs';
import { startStubInternet } from './helpers/browser.mjs';
import { findFirefox, launchFirefox } from './helpers/firefox.mjs';

const SITE = 'exampleadultsite.com';
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

/**
 * Puts the lock in force for the next Firefox start, with `xpi` as the file it installs from, and with { other }
 * another program's policies as well. Returns the lock's policies, and a function that takes everything away.
 */
function applyPolicies(scratch, { xpi = SIGNED, other = null } = {}) {
  const undo = [];
  let lock;
  if (MAC) {
    mkdirSync(dirname(XPI_PATH), { recursive: true });
    copyFileSync(xpi, XPI_PATH);
    undo.push(() => rmSync(dirname(XPI_PATH), { recursive: true, force: true }));
    lock = firefoxPolicies();
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
    const folderCopy = join(scratch, 'family-site-blocker.xpi');
    copyFileSync(xpi, folderCopy);
    lock = firefoxPolicies(folderCopy);
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

  async function assertBlocked(url = `http://${SITE}/`) {
    stub.clear();
    const result = await browser.visit(url);
    assert.equal(result.outcome, 'blocked page', `${url} ended at ${result.finalUrl}`);
    assert.equal(stub.reached(SITE), false, 'a request reached the site');
  }

  return Object.assign(browser, { chrome, addon, waitForAddon, card, clickSwitch, assertBlocked });
}

describe('Firefox lock', { skip: SKIP }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const version = SIGNED && manifestOf(SIGNED).version;
  let policies;
  let stub;
  let firefox;

  before(async () => {
    policies = applyPolicies(scratch);
    stub = await startStubInternet();
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

  test('Firefox installs the signed add-on by itself', async () => {
    const { updated, canEnable, ...info } = await firefox.addon(ADDON_ID);
    assert.deepEqual(info, {
      version, active: true, temporary: false, signedByMozilla: true, source: 'enterprise-policy', canDisable: false, canRemove: false,
    });
  });

  test('test case: with the lock, exampleadultsite.com is blocked', () => firefox.assertBlocked());

  test('in the Add-ons Manager, Family Site Blocker has no on/off switch, and its menu says "Can’t Be Removed"', async () => {
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertBlocked();
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

  test('private windows are turned off: the menu item is gone, and asking for one opens an ordinary window, which blocks', async () => {
    const menu = await firefox.chrome(`
      return {
        privateWindows: PrivateBrowsingUtils.enabled,
        menuItemHidden: document.getElementById('menu_newPrivateWindow').hidden,
        shortcut: Boolean(document.getElementById('key_privatebrowsing')),
      };`);
    assert.deepEqual(menu, { privateWindows: false, menuItemHidden: true, shortcut: false });
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

describe('Firefox lock next to another blocker', { skip: SKIP || (!OTHER && "set OTHER_XPI to another program's signed add-on") }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  const other = OTHER && manifestOf(OTHER);
  let policies;
  let stub;
  let firefox;

  before(async () => {
    const otherXpi = join(scratch, 'other-blocker.xpi');
    copyFileSync(OTHER, otherXpi);
    policies = applyPolicies(scratch, { other: otherBlockerPolicies(other.id, otherXpi) });
    stub = await startStubInternet();
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
        dnrLocked: policies.Preferences && policies.Preferences['extensions.dnr.enabled'],
        switchedOn: arguments[0].filter((name) => policies[name] === true),
      };`, SWITCHES);
    assert.deepEqual(active, {
      ExtensionSettings: [other.id],
      Extensions: policies.lock.Extensions,
      dnrLocked: DNR_LOCKED['extensions.dnr.enabled'],
      switchedOn: SWITCHES,
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
    await first.fx.send('Addon:Install', { path: resolve(handXpi), temporary: false });
    assert.equal((await first.waitForAddon(ADDON_ID))?.active, true, 'installed by hand');
    await first.chrome(`await (await AddonManager.getAddonByID(arguments[0])).disable();`, ADDON_ID);
    assert.equal((await first.waitForAddon(ADDON_ID, (info) => info && !info.active))?.active, false, 'switched off');
  } finally {
    await first.close();
  }
  const policies = applyPolicies(scratch, { xpi: lockXpi });
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

  test('test case: exampleadultsite.com is blocked', () => started.firefox.assertBlocked());
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

  test('once it is switched on, the switch is gone and exampleadultsite.com is blocked', async () => {
    const { firefox } = started;
    await firefox.card(ADDON_ID);
    await firefox.clickSwitch(ADDON_ID);
    assert.equal((await firefox.waitForAddon(ADDON_ID))?.active, true, 'switched on');
    assert.deepEqual(await firefox.card(ADDON_ID), { name: 'Family Site Blocker', onOffSwitch: 'none', removeItem: CANT_BE_REMOVED });
    await firefox.assertBlocked();
  });
});

describe('Firefox lock, when a newer version is installed by hand', { skip: SKIP || (!OLDER && 'set OLDER_XPI to an earlier signed version of this add-on') }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'family-site-blocker-lock-'));
  let policies;
  let stub;
  let firefox;

  before(async () => {
    // The lock with the earlier version in the folder, as when a newer one has come out since.
    policies = applyPolicies(scratch, { xpi: OLDER });
    stub = await startStubInternet();
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
  });
});
