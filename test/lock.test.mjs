// Run with: npm test. The lock line of the settings page's board (extension/lib/lock.js): what it says
// about the Firefox lock and, under it, about the copy of the profile installed, from what Firefox
// reports and the stamp the profile hands the add-on through its managed storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { STAMP, STAMP_FROM, compareVersions, describeLock, isStamp, lockInForce, locked, managedStamp, textOf } from '../extension/lib/lock.js';
import { STAMP_PATH, VERSION, lockStamp } from '../scripts/firefox-lock.mjs';

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
    text: "The Firefox lock is in force, but it's an older copy: from version 1.8.0, with 1,000 entries in Firefox's own list, while this is version 1.9.0. Install the current profile so Firefox's own list catches up. How to install it.",
  });
  assert.deepEqual(links({ installType: 'admin', firefox: true, own: '1.9.0', stamp }), [{ anchor: 'firefox', text: 'How to install it' }]);
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

test('the lock line elsewhere: policy in another browser, a temporary add-on, an ordinary install in Firefox and in the others', () => {
  assert.deepEqual(describe({ installType: 'admin', firefox: false, own: '1.8.0', stamp }), {
    state: 'ok',
    text: 'Installed by policy: the browser gives no way to switch the add-on off or remove it.',
  });
  assert.deepEqual(describe({ installType: 'development', firefox: true, own: '1.8.0' }), {
    state: 'todo',
    text: 'Loaded temporarily: Firefox removes the add-on when it quits, and anyone can switch it off before then. How to keep it installed, and lock it.',
  });
  assert.deepEqual(describe({ installType: 'normal', firefox: true, own: '1.8.0' }), {
    state: 'todo',
    text: 'Not under the Firefox lock: anyone who opens the Add-ons Manager can switch the add-on off or remove it. How to lock it, on a Mac.',
  });
  assert.deepEqual(links({ installType: 'normal', firefox: true, own: '1.8.0' }), [{ anchor: 'firefox', text: 'How to lock it, on a Mac' }]);
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
  assert.deepEqual(own, lockStamp());
  assert.deepEqual(own, { version: VERSION, entries: 1000 });
  assert.ok(isStamp(own));
  assert.equal(readFileSync(STAMP_PATH, 'utf8'), `${JSON.stringify(lockStamp(), null, 2)}\n`, 'written the way the build writes it');
  assert.equal(compareVersions(VERSION, STAMP_FROM) >= 0, true, 'this version carries the stamp');
});
