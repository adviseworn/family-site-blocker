// Run with: npm test. The lock line of the settings page's board (extension/lib/lock.js): what it says
// about the Firefox lock and, under it, about the copy of the profile installed, from what Firefox
// reports and the stamp the profile hands the add-on through its managed storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DIGEST_FROM, STAMP, STAMP_FILE, STAMP_FROM, compareVersions, describeLock, hasDigest, isStamp, lockInForce, locked, managedStamp, ownStamp, sameSettings, textOf } from '../extension/lib/lock.js';
import { ADDON_ID, STAMP_PATH, VERSION, addonStamp, digestOf, firefoxPolicies, lockSettings, lockStamp, readAddonStamp } from '../scripts/firefox-lock.mjs';

const stamp = { version: '1.8.0', entries: 1000 };
const describe = (state) => ({ state: describeLock(state).state, text: textOf(describeLock(state).parts) });
const links = (state) => describeLock(state).parts.filter((part) => typeof part !== 'string');

test('versions are compared part by part, numerically, as Firefox orders them', () => {
  assert.equal(compareVersions('1.8.0', '1.8.0'), 0);
  assert.ok(compareVersions('1.8.0', '1.7.9') > 0);
  assert.ok(compareVersions('1.9.9', '1.10.0') < 0, 'not as text');
  assert.equal(compareVersions('1.10', '1.10.0'), 0, 'a missing part is 0');
  assert.ok(compareVersions('2', '1.99.99') > 0);
  assert.deepEqual(['1.2.0', '1.10.0', '1.9.9', '1.10'].sort(compareVersions), ['1.2.0', '1.9.9', '1.10.0', '1.10']);
});

test("a stamp is a version and a count of entries, as the profile writes it; anything else isn't", () => {
  assert.ok(isStamp(stamp));
  assert.ok(isStamp({ version: '2', entries: 0, extra: true }), 'more keys are fine');
  for (const bad of [null, undefined, 'lock', 7, {}, { version: '1.8.0' }, { entries: 1000 }, { version: 1.8, entries: 1000 }, { version: 'latest', entries: 1000 }, { version: '1.8.0', entries: '1000' }, { version: '1.8.0', entries: -1 }, { version: '1.8.0', entries: 1.5 }]) {
    assert.equal(isStamp(bad), false, JSON.stringify(bad));
  }
});

test('the stamp is read from managed storage, and its absence, in any form, is null', async () => {
  const storage = (get) => ({ managed: { get } });
  assert.deepEqual(await managedStamp(storage(async (key) => ({ [key]: stamp }))), stamp);
  assert.equal(await managedStamp(storage(async () => ({}))), null, 'a policy for the add-on without a stamp');
  assert.equal(await managedStamp(storage(async () => ({ [STAMP]: { version: 'x' } }))), null, 'not a stamp');
  assert.equal(await managedStamp(storage(async () => { throw new Error('Managed storage manifest not found'); })), null, 'Firefox, with no policy or manifest for the add-on');
  assert.equal(await managedStamp({}), null, 'no managed storage at all');
  let asked;
  await managedStamp(storage(async (key) => { asked = key; return {}; }));
  assert.equal(asked, STAMP, 'asks for the one key');
});

test('the lock line under the Firefox lock: this copy, an older copy, a newer copy, and a copy from before the stamp', () => {
  const own = '1.8.0';
  assert.deepEqual(describe({ installType: 'admin', firefox: true, own, stamp }), {
    state: 'ok',
    text: "The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is this version's copy (1.8.0), with 1,000 entries in Firefox's own list.",
  });
  assert.deepEqual(describe({ installType: 'admin', firefox: true, own: '1.9.0', stamp }), {
    state: 'todo',
    text: "The Firefox lock is in force, but it's an older copy: from version 1.8.0, with 1,000 entries in Firefox's own list, while this is version 1.9.0. Install the current profile so Firefox's own list and the lock's other settings catch up. How to install it.",
  });
  assert.deepEqual(links({ installType: 'admin', firefox: true, own: '1.9.0', stamp }), [{ anchor: 'lock-it-so-nobody-can-switch-it-off-firefox-on-a-mac', text: 'How to install it' }]);
  assert.deepEqual(describe({ installType: 'admin', firefox: true, own, stamp: { version: '1.10.0', entries: 1000 } }), {
    state: 'ok',
    text: 'The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is the copy from version 1.10.0, newer than this add-on (1.8.0), which updates itself.',
  });
  assert.deepEqual(describe({ installType: 'admin', firefox: true, own, stamp: null }), {
    state: 'todo',
    text: `The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is a copy from before version ${STAMP_FROM}, so this page can't say which; installing the current profile gives Firefox the current list, and says so here. How to install it.`,
  });
  assert.equal(STAMP_FROM, '1.8.0', 'the version whose profile first carried the stamp');
  assert.deepEqual(describe({ installType: 'admin', firefox: true, own, stamp: { version: '1.8.0', entries: 1 } }).text.includes('with 1 entry in'), true);
});

test("from 1.15.0 the stamps carry a digest of Firefox's own list and the lock's other settings, and copies are compared by it, not by version (#78)", () => {
  const own = '1.15.0';
  const mine = { version: '1.15.0', entries: 1000, digest: 'cb99ede1d311', sameSince: '1.10.5' }; // the add-on's own copy
  const at = (stamp, ownStamp = mine) => describe({ installType: 'admin', firefox: true, own, stamp, ownStamp });
  const same = { version: '1.12.0', entries: 1000, digest: 'cb99ede1d311' };
  assert.deepEqual(at(same), {
    state: 'ok',
    text: "The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is the copy from version 1.12.0, with the same list and settings as this version's (1.15.0): 1,000 entries in Firefox's own list.",
  });
  assert.deepEqual(at({ ...same, digest: 'ab0000000000' }), {
    state: 'todo',
    text: "The Firefox lock is in force, but it's an older copy: from version 1.12.0, with 1,000 entries in Firefox's own list, while this is version 1.15.0. Install the current profile so Firefox's own list and the lock's other settings catch up. How to install it.",
  }, 'a changed list or setting');
  assert.deepEqual(at({ version: '1.15.0', entries: 998, digest: 'ab0000000000' }), {
    state: 'todo',
    text: "The Firefox lock is in force, but the copy installed isn't this version's (1.15.0): its list or settings differ, with 998 entries in Firefox's own list. Install the current profile so Firefox's own list and the lock's other settings catch up. How to install it.",
  }, "this version's number on a profile built from other lists or settings");
  assert.deepEqual(links({ installType: 'admin', firefox: true, own, stamp: { version: '1.15.0', entries: 998, digest: 'ab0000000000' }, ownStamp: mine }), [{ anchor: 'lock-it-so-nobody-can-switch-it-off-firefox-on-a-mac', text: 'How to install it' }]);
  assert.equal(at({ ...same, version: '1.15.0' }).text, "The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is this version's copy (1.15.0), with 1,000 entries in Firefox's own list.");
  assert.equal(at({ ...same, version: '1.16.0' }).text, "The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is the copy from version 1.16.0, with the same list and settings as this version's (1.15.0): 1,000 entries in Firefox's own list.", 'a newer profile with the same list and settings');
  assert.deepEqual(at({ version: '1.16.0', entries: 1000, digest: 'ab0000000000' }), {
    state: 'ok',
    text: 'The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is the copy from version 1.16.0, newer than this add-on (1.15.0), which updates itself.',
  }, 'a newer profile with other settings: the add-on catches up by itself');
  // A profile from before the digest: its version says, against the version the add-on's own list and settings date from.
  assert.equal(at({ version: '1.11.3', entries: 1000 }).text, "The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it. The lock installed is the copy from version 1.11.3, with the same list and settings as this version's (1.15.0): 1,000 entries in Firefox's own list.");
  assert.equal(at({ version: '1.10.5', entries: 1000 }).state, 'ok', 'from sameSince on');
  assert.equal(at({ version: '1.9.0', entries: 1000 }).state, 'todo', 'before sameSince');
  assert.equal(at({ version: '1.11.3', entries: 999 }).state, 'todo', 'not as many entries');
  assert.equal(at({ version: '1.11.3', entries: 1000 }, { version: '1.15.0', entries: 1000, digest: 'cb99ede1d311' }).state, 'todo', 'an own copy without sameSince: by version');
  assert.equal(at({ version: '1.11.3', entries: 1000 }, null).state, 'todo', 'no own copy: by version, as before');
  assert.equal(at(same, null).state, 'todo', 'no own copy to compare the digest with: by version');
  assert.equal(at({ ...same, digest: 'not even hex' }).state, 'todo', "a malformed digest doesn't pass for a copy from before the digest");
  assert.equal(compareVersions(DIGEST_FROM, STAMP_FROM) > 0, true);
});

test('whether two stamps describe the same list and settings: by digest, or by version for a profile from before the digest', () => {
  const mine = { version: '1.15.0', entries: 1000, digest: 'cb99ede1d311', sameSince: '1.10.5' };
  assert.equal(sameSettings({ version: '1.12.0', entries: 1000, digest: 'cb99ede1d311' }, mine), true);
  assert.equal(sameSettings({ version: '1.12.0', entries: 1000, digest: 'ab0000000000' }, mine), false);
  assert.equal(sameSettings({ version: '1.12.0', entries: 1000, digest: 'cb99ede1d311' }, { version: '1.15.0', entries: 1000 }), null, 'an own copy without a digest');
  assert.equal(sameSettings({ version: '1.11.3', entries: 1000 }, mine), true, 'from sameSince on, with as many entries');
  assert.equal(sameSettings({ version: '1.10.5', entries: 1000 }, mine), true);
  assert.equal(sameSettings({ version: '1.10.4', entries: 1000 }, mine), false);
  assert.equal(sameSettings({ version: '1.11.3', entries: 1001 }, mine), false);
  assert.equal(sameSettings({ version: '1.11.3', entries: 1000 }, { ...mine, sameSince: undefined }), null);
  assert.equal(sameSettings({ version: '1.11.3', entries: 1000 }, null), null);
  assert.equal(sameSettings(null, mine), null);
  assert.ok(hasDigest(mine));
  assert.equal(hasDigest({ version: '1.11.3', entries: 1000 }), false);
  assert.equal(hasDigest({ ...mine, digest: 'XYZ' }), false, 'hex, as the build writes it');
  assert.equal(hasDigest({ ...mine, digest: '' }), false);
});

test("the add-on's own copy of the stamp is read from its package, and anything else is null", async () => {
  const runtime = { getURL: (path) => `moz-extension://abc/${path}` };
  const stamp = { version: '1.15.0', entries: 1000, digest: 'cb99ede1d311', sameSince: '1.10.5' };
  let asked;
  const serving = (body) => async (url) => { asked = url; return { json: async () => JSON.parse(body) }; };
  assert.deepEqual(await ownStamp(runtime, serving(JSON.stringify(stamp))), stamp);
  assert.equal(asked, `moz-extension://abc/${STAMP_FILE}`);
  assert.equal(STAMP_FILE, 'rules/lock.json');
  assert.equal(await ownStamp(runtime, serving('{"version":"x"}')), null, 'not a stamp');
  assert.equal(await ownStamp(runtime, serving('not json')), null);
  assert.equal(await ownStamp(runtime, async () => { throw new Error('no such file'); }), null);
});

test('the lock line elsewhere: policy in another browser, a temporary add-on, an ordinary install in Firefox and in the others', () => {
  assert.deepEqual(describe({ installType: 'admin', firefox: false, own: '1.8.0', stamp }), {
    state: 'ok',
    text: 'Installed by policy: the browser gives no way to switch the add-on off or remove it.',
  });
  assert.deepEqual(describe({ installType: 'development', firefox: true, own: '1.8.0' }), {
    state: 'todo',
    text: 'Loaded temporarily: Firefox removes the add-on when it quits, and anyone can switch it off before then. How to keep it installed, and lock it.',
  });
  assert.deepEqual(links({ installType: 'development', firefox: true, own: '1.8.0' }), [{ anchor: 'keep-it-installed-after-firefox-quits', text: 'How to keep it installed, and lock it' }]);
  assert.deepEqual(describe({ installType: 'normal', firefox: true, own: '1.8.0' }), {
    state: 'todo',
    text: 'Not under the Firefox lock: anyone who opens the Add-ons Manager can switch the add-on off or remove it. How to lock it, on a Mac.',
  });
  assert.deepEqual(links({ installType: 'normal', firefox: true, own: '1.8.0' }), [{ anchor: 'lock-it-so-nobody-can-switch-it-off-firefox-on-a-mac', text: 'How to lock it, on a Mac' }]);
  assert.deepEqual(describe({ installType: 'normal', firefox: false, own: '1.8.0' }), {
    state: 'todo',
    text: 'Anyone who can open the extensions page can switch the add-on off or remove it; the lock covers Firefox only. What to do about that.',
  });
  assert.deepEqual(links({ installType: 'development', firefox: false, own: '1.8.0' }), [{ anchor: 'limits', text: 'What to do about that' }], 'unpacked in Chrome is the ordinary case there');
});

test('either report of a lock is enough: installed by policy, or no way to switch the add-on off (#69)', () => {
  // Firefox gives both under the lock (installType "admin", mayDisable false); a browser might give one.
  assert.equal(locked({ installType: 'admin', mayDisable: false }), true);
  assert.equal(locked({ installType: 'admin', mayDisable: true }), true, 'installed by policy, whatever the switch says');
  assert.equal(locked({ installType: 'admin' }), true, 'a browser that says nothing about the switch');
  assert.equal(locked({ installType: 'normal', mayDisable: false }), true, 'no switch, whatever installed it');
  assert.equal(locked({ installType: 'normal', mayDisable: true }), false);
  assert.equal(locked({ installType: 'development', mayDisable: true }), false);
  assert.equal(locked({ installType: 'normal' }), false, 'mayDisable missing is not false');
  assert.deepEqual(describe({ installType: 'normal', mayDisable: false, firefox: true, own: '1.8.0', stamp }), describe({ installType: 'admin', firefox: true, own: '1.8.0', stamp }), 'the Firefox line from mayDisable alone');
  assert.deepEqual(describe({ installType: 'normal', mayDisable: false, firefox: false, own: '1.8.0' }), {
    state: 'ok',
    text: 'Installed by policy: the browser gives no way to switch the add-on off or remove it.',
  });
  assert.equal(describe({ installType: 'development', mayDisable: true, firefox: true, own: '1.8.0' }).state, 'todo');
});

test('the Firefox lock in force means its other settings are too: private windows are off', () => {
  assert.equal(lockInForce({ installType: 'admin', firefox: true }), true);
  assert.equal(lockInForce({ installType: 'admin', mayDisable: false, firefox: true }), true);
  assert.equal(lockInForce({ installType: 'normal', mayDisable: false, firefox: true }), true, 'no switch is enough');
  assert.equal(lockInForce({ installType: 'admin', firefox: false }), false, 'another browser, another policy');
  assert.equal(lockInForce({ installType: 'normal', firefox: true }), false);
  assert.equal(lockInForce({ installType: 'normal', mayDisable: true, firefox: true }), false);
  assert.equal(lockInForce({ installType: 'development', firefox: true }), false);
});

test("the add-on's own copy of the stamp matches the profile's, for this version (run npm run build)", () => {
  const own = JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  assert.deepEqual(own, addonStamp());
  assert.deepEqual(own, { version: VERSION, entries: 1000, digest: lockStamp().digest, sameSince: own.sameSince });
  assert.ok(isStamp(own) && hasDigest(own));
  assert.match(own.digest, /^[0-9a-f]{12}$/);
  // 1.10.5 is the first release whose profile carried today's list and settings (a diff of the profile from
  // that release on touches only the stamp and the description), which seeded sameSince when the digest came in.
  assert.ok(compareVersions(own.sameSince, '1.10.5') >= 0 && compareVersions(own.sameSince, VERSION) <= 0, `sameSince ${own.sameSince}`);
  assert.deepEqual(readAddonStamp(), own);
  assert.equal(readFileSync(STAMP_PATH, 'utf8'), `${JSON.stringify(addonStamp(), null, 2)}\n`, 'written the way the build writes it');
  assert.equal(compareVersions(VERSION, STAMP_FROM) >= 0, true, 'this version carries the stamp');
  assert.equal(compareVersions(VERSION, DIGEST_FROM) >= 0, true, 'and the digest');
  assert.deepEqual(firefoxPolicies()['3rdparty'].Extensions[ADDON_ID][STAMP], lockStamp(), "the profile's stamp is the same, without sameSince, which only the add-on needs");
});

test("the digest covers Firefox's own list and the lock's other settings, not the address the add-on installs from, and sameSince holds while it does", () => {
  const entries = ['*://*.a.test/*', '*://*.b.test/*'];
  const stamp = lockStamp(entries, '9.8.7');
  assert.deepEqual(stamp, { version: '9.8.7', entries: 2, digest: digestOf(lockSettings(entries)) });
  assert.match(stamp.digest, /^[0-9a-f]{12}$/);
  assert.equal(lockStamp(entries, '9.9.0').digest, stamp.digest, 'the version is not in it');
  assert.notEqual(lockStamp(['*://*.a.test/*'], '9.8.7').digest, stamp.digest, 'the list is');
  assert.notEqual(lockStamp([...entries].reverse(), '9.8.7').digest, stamp.digest, 'in its order');
  assert.notEqual(digestOf({ ...lockSettings(entries), DisablePrivateBrowsing: false }), stamp.digest, 'a switch is');
  assert.notEqual(digestOf({ ...lockSettings(entries), Preferences: { 'extensions.dnr.enabled': { Value: true, Status: 'locked' } } }), stamp.digest, 'a locked preference is');
  assert.equal(firefoxPolicies('http://elsewhere.test/x.xpi', entries)['3rdparty'].Extensions[ADDON_ID][STAMP].digest, stamp.digest, 'the address is not (the lock tests install from a stand-in)');
  assert.deepEqual(Object.keys(lockSettings(entries)).sort(), ['BlockAboutConfig', 'DisablePrivateBrowsing', 'DisableProfileRefresh', 'DisableSafeMode', 'ExtensionUpdate', 'Extensions', 'Preferences', 'WebsiteFilter'], 'everything but the stamp');
  assert.deepEqual(lockSettings(entries).Extensions, { Locked: [ADDON_ID] }, 'the lock on the add-on, without the address');
  assert.equal(digestOf({ b: 1, a: { d: [2, 1], c: 3 } }), digestOf({ a: { c: 3, d: [2, 1] }, b: 1 }), 'keys in any order');
  assert.notEqual(digestOf({ a: [1, 2] }), digestOf({ a: [2, 1] }), 'the order of a list counts');
  assert.deepEqual(addonStamp(stamp, null), { ...stamp, sameSince: '9.8.7' }, 'a first build starts sameSince at its version');
  assert.deepEqual(addonStamp(stamp, { ...stamp, version: '9.0.0', sameSince: '8.0.0' }), { ...stamp, sameSince: '8.0.0' }, 'kept while the digest holds');
  assert.deepEqual(addonStamp(stamp, { version: '9.0.0', entries: 2, digest: 'ab0000000000', sameSince: '8.0.0' }), { ...stamp, sameSince: '9.8.7' }, 'a new digest starts it afresh');
  assert.deepEqual(addonStamp(stamp, { version: '9.0.0', entries: 2 }), { ...stamp, sameSince: '9.8.7' }, 'after a copy from before the digest');
  assert.deepEqual(addonStamp(stamp, { ...stamp, sameSince: 'yesterday' }), { ...stamp, sameSince: '9.8.7' }, 'a sameSince that is not a version');
  assert.equal(readAddonStamp('/nowhere/lock.json'), null);
});
