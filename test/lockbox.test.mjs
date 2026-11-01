// Run with: npm test. What the locked-away password's page and the settings page share (extension/lib/lockbox.js):
// the record of what has happened to the password (#75): how entries are kept, what the settings page's line
// says from them, and the words for each entry; with the wait lengthened (#76), how the stored box and
// the unlocking progress are read, layer by layer, and how the line sums them up; and the waits set for each
// password (1.13.0), by which a backup file from before the wait was lengthened gets the longer wait as it is restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto; // Node 18 has Web Crypto, but not on globalThis

const { BOX, EVENTS, EVENTS_KEPT, EVENTS_SINCE, EVENT_NAMES, PROGRESS, WAITS, WAITS_KEPT, beginningOf, boxKey, describeBox, describeEvent, duration, fractionDone, isEvent, layerUnderWork, loadBox, longerWaitFor, noteBox, recordBegan, recordEvent, sinceOf, sinceText, thisPassword, times } =
  await import('../extension/lib/lockbox.js');
const { lengthen, seal } = await import('../extension/lib/timelock.js');

/** A stand-in for storage.local: get, set and remove over a plain object. */
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

const day = (time) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' });
const when = (time) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const at = (time, event, details = {}) => ({ at: time, event, ...details });

const T = {
  locked: '2026-10-11T20:40:00.000Z',
  started: '2026-10-22T19:03:00.000Z',
  shown: '2026-10-24T21:12:00.000Z',
  deleted: '2026-10-25T09:00:00.000Z',
};

test('an entry is a time and an event name; the record keeps only such entries', async () => {
  assert.ok(isEvent({ at: T.locked, event: 'locked', delay: 60 }));
  for (const bad of [null, 'locked', {}, { at: T.locked }, { event: 'locked' }, { at: 'yesterday', event: 'locked' }, { at: T.locked, event: 7 }]) {
    assert.equal(isEvent(bad), false, JSON.stringify(bad));
  }
  const store = fakeStore({ [EVENTS]: [at(T.locked, 'locked', { delay: 60 }), 'junk', { at: T.started }] });
  assert.deepEqual((await loadBox(store)).events, [at(T.locked, 'locked', { delay: 60 })]);
  assert.deepEqual((await loadBox(fakeStore())).events, [], 'no record yet');
  assert.deepEqual((await loadBox(fakeStore({ [EVENTS]: 'junk' }))).events, []);
});

test('recording adds the entry with the time, oldest first, drops the oldest once the record is long, and keeps when the record began', async () => {
  const store = fakeStore();
  const before = Date.now();
  const first = await recordEvent(store, 'locked', { delay: 172800 });
  assert.equal(first.event, 'locked');
  assert.equal(first.delay, 172800);
  assert.ok(Date.parse(first.at) >= before - 1000 && Date.parse(first.at) <= Date.now() + 1000, first.at);
  await recordEvent(store, 'started');
  assert.deepEqual(store.data[EVENTS].map(({ event }) => event), ['locked', 'started']);
  assert.ok(store.data[EVENTS].every(isEvent));
  assert.equal(store.data[EVENTS_SINCE], first.at, 'when the record began: its first entry (1.11.4)');

  const long = fakeStore({ [EVENTS]: Array.from({ length: EVENTS_KEPT }, (_, i) => at(new Date(i * 1000).toISOString(), 'resumed', { done: i, steps: 9 })) });
  await recordEvent(long, 'stopped', { done: 5, steps: 9 });
  assert.equal(long.data[EVENTS].length, EVENTS_KEPT);
  assert.equal(long.data[EVENTS][0].done, 1, 'the oldest went');
  assert.equal(long.data[EVENTS].at(-1).event, 'stopped');
  assert.equal(long.data[EVENTS_SINCE], new Date(0).toISOString(), 'a record from before 1.11.4 began at its oldest entry, kept as that entry goes');
  await recordEvent(long, 'started');
  assert.equal(long.data[EVENTS_SINCE], new Date(0).toISOString(), 'and it stays');

  const kept = fakeStore({ [EVENTS]: [at(T.started, 'started')], [EVENTS_SINCE]: T.locked });
  await recordEvent(kept, 'shown');
  assert.equal(kept.data[EVENTS_SINCE], T.locked, 'the time stored stays, before the entries left');
});

test("when the record began, and the table's last row that says so (1.11.4; a row from 1.13.1)", async () => {
  assert.equal(recordBegan([], undefined), null, 'no record');
  assert.equal(recordBegan([at(T.started, 'started')], undefined), T.started, 'a record from before 1.11.4: its oldest entry');
  assert.equal(recordBegan([at(T.started, 'started')], 'junk'), T.started);
  assert.equal(recordBegan([at(T.started, 'started')], T.locked), T.locked, 'the time kept, once the entry has gone');
  assert.equal(recordBegan([at(T.locked, 'locked')], T.started), T.locked, 'whichever is earlier');
  assert.equal(recordBegan([], T.locked), T.locked);

  assert.equal((await loadBox(fakeStore())).since, null);
  assert.equal((await loadBox(fakeStore({ [EVENTS]: [at(T.started, 'started')] }))).since, T.started);
  assert.equal((await loadBox(fakeStore({ [EVENTS]: [at(T.started, 'started')], [EVENTS_SINCE]: T.locked }))).since, T.locked);

  assert.equal(beginningOf({ events: [] }), null, 'no row with no record');
  assert.equal(beginningOf({ events: [], since: T.locked }), null);
  assert.deepEqual(beginningOf({ events: [at(T.locked, 'locked', { delay: 60 }), at(T.started, 'started')], since: T.locked }), { at: T.locked, what: 'The record began.' });
  assert.deepEqual(beginningOf({ events: [at(T.started, 'started')] }), { at: T.started, what: 'The record began.' }, 'a record from before 1.11.4 began at its oldest entry');
  assert.deepEqual(
    beginningOf({ events: [at(T.started, 'started'), at(T.shown, 'shown')], since: T.locked }),
    { at: T.locked, what: `The record began. It keeps only the latest ${EVENTS_KEPT} entries, so those before ${when(T.started)} have gone.` },
    'once the oldest entries have gone',
  );
});

test('the part of the record about the password now locked away starts at the last locking or restoring', () => {
  const events = [at(T.locked, 'locked', { delay: 60 }), at(T.started, 'started'), at(T.shown, 'shown'), at(T.deleted, 'deleted'), at('2026-10-26T10:00:00.000Z', 'locked', { delay: 120 })];
  assert.deepEqual(thisPassword(events), { entries: events.slice(4), whole: true });
  assert.deepEqual(thisPassword(events.slice(0, 4)), { entries: events.slice(0, 4), whole: true });
  const restored = [at(T.locked, 'locked', { delay: 60 }), at(T.deleted, 'deleted'), at('2026-10-26T10:00:00.000Z', 'restored', { lockedAt: T.locked })];
  assert.deepEqual(thisPassword(restored), { entries: restored.slice(2), whole: true });
  // A record that began after the password was locked away (before 1.9.0) may not cover its whole life.
  const partial = [at(T.started, 'started'), at(T.shown, 'shown')];
  assert.deepEqual(thisPassword(partial), { entries: partial, whole: false });
  assert.deepEqual(thisPassword([]), { entries: [], whole: false });
});

test('"since" is when the password was locked away or restored here, else when its box was sealed', async () => {
  const box = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  assert.equal(sinceOf({ box, events: [] }), box.lockedAt);
  assert.equal(sinceOf({ box, events: [at(T.started, 'started'), at(T.shown, 'shown'), at(T.shown, 'sealed', { delay: 60 })] }), box.lockedAt);
  assert.equal(sinceOf({ box, events: [at(T.locked, 'locked', { delay: 60 }), at(T.started, 'started'), at(T.shown, 'shown'), at(T.shown, 'sealed', { delay: 60 })] }), T.locked);
  assert.equal(sinceOf({ box, events: [at(T.locked, 'locked', { delay: 60 }), at(T.deleted, 'deleted'), at(T.deleted, 'restored', { lockedAt: T.locked })] }), T.deleted);
});

test("the settings page's line: where things stand, and what the record says about unlocking", async () => {
  const box = await seal('secret', { steps: 6000, delay: 60, rate: 100 });
  const since = `(since ${day(box.lockedAt)})`;
  const wait = `getting it back takes about ${duration(60)}.`;
  assert.equal(describeBox({ box, progress: null, events: [] }), `A password is locked away ${since}; ${wait}`, 'no record: as before');
  assert.equal(describeBox({ box, progress: null }), `A password is locked away ${since}; ${wait}`, 'the record may be left out');

  const locked = at(T.locked, 'locked', { delay: 60 });
  assert.equal(
    describeBox({ box, progress: null, events: [locked] }),
    `A password is locked away (since ${day(T.locked)}), never unlocked; ${wait}`,
    'the record covers the whole life of the password',
  );
  assert.equal(
    describeBox({ box, progress: null, events: [at(T.started, 'started'), at(T.started, 'stopped', { done: 10, steps: 6000 })] }),
    `A password is locked away ${since}; ${wait}`,
    "a record that began after the locking can't say never",
  );
  const once = [locked, at(T.started, 'started'), at(T.shown, 'shown', { startedAt: T.started }), at(T.shown, 'sealed', { delay: 60 })];
  assert.equal(describeBox({ box, progress: null, events: once }), `A password is locked away (since ${day(T.locked)}), unlocked once, last on ${day(T.shown)}; ${wait}`);
  const again = '2026-10-25T08:30:00.000Z';
  const twice = [...once, at(again, 'started'), at(again, 'shown', { startedAt: again }), at(again, 'sealed', { delay: 60 })];
  assert.equal(describeBox({ box, progress: null, events: twice }), `A password is locked away (since ${day(T.locked)}), unlocked twice, last on ${day(again)}; ${wait}`);
  const thrice = [...twice, at(T.deleted, 'started'), at(T.deleted, 'shown', { startedAt: T.deleted }), at(T.deleted, 'seal-failed')];
  assert.match(describeBox({ box, progress: null, events: thrice }), /unlocked 3 times, last on /);
  // Only the password now locked away counts: a new one starts the count again.
  const replaced = [...once, at(T.deleted, 'deleted'), at(again, 'locked', { delay: 60 })];
  assert.equal(describeBox({ box, progress: null, events: replaced }), `A password is locked away (since ${day(again)}), never unlocked; ${wait}`);

  // Unlocking under way: how far, and since when if the progress says.
  const progress = { n: box.n, x: 'abc', done: 2400, steps: 6000 };
  assert.equal(describeBox({ box, progress, events: once }), `A password is locked away (since ${day(T.locked)}), unlocked once, last on ${day(T.shown)}; unlocking it is 40% done.`);
  assert.equal(
    describeBox({ box, progress: { ...progress, startedAt: T.started, workedAt: T.shown }, events: [] }),
    `A password is locked away ${since}; unlocking it is 40% done, started ${day(T.started)}.`,
  );
  assert.equal(describeBox({ box, progress: { ...progress, done: 6000 }, events: [] }), `A password is locked away ${since}; unlocking it is 100% done.`);

  // Nothing locked away: and whether one was deleted.
  assert.equal(describeBox({ box: null, progress: null, events: [] }), 'No password is locked away.');
  assert.equal(describeBox({ box: null, progress: null, events: [locked] }), 'No password is locked away.', 'gone without the page deleting it');
  assert.equal(describeBox({ box: null, progress: null, events: [...once, at(T.deleted, 'deleted')] }), `No password is locked away; the last one was deleted on ${day(T.deleted)}.`);
});

test('every entry has words, with its times and its share of the work', () => {
  assert.equal(describeEvent(at(T.locked, 'locked', { delay: 172800 })), 'Locked away, with a wait of 2 days.');
  assert.equal(describeEvent(at(T.locked, 'locked')), 'Locked away.');
  assert.equal(describeEvent(at(T.started, 'started')), 'Unlocking started.');
  assert.equal(describeEvent(at(T.started, 'resumed', { done: 2400, steps: 6000 })), 'Unlocking carried on, from 40% done.');
  assert.equal(describeEvent(at(T.started, 'resumed', { done: 0, steps: 6000 })), 'Unlocking carried on, from 0% done.');
  assert.equal(describeEvent(at(T.started, 'stopped', { done: 5999, steps: 6000 })), 'Unlocking stopped at 99% done; the work was thrown away.');
  assert.equal(describeEvent(at(T.started, 'stopped', { done: 7000, steps: 6000 })), 'Unlocking stopped at 100% done; the work was thrown away.', 'never over 100');
  assert.equal(describeEvent(at(T.started, 'stopped', { done: 3, steps: 0 })), 'Unlocking stopped at 0% done; the work was thrown away.', 'no dividing by zero');
  assert.equal(describeEvent(at(T.shown, 'shown', { startedAt: T.started })), `The password was shown (unlocking started ${when(T.started)}).`);
  assert.equal(describeEvent(at(T.shown, 'shown')), 'The password was shown.');
  assert.equal(describeEvent(at(T.started, 'started', { why: 'to set up the printer' })), 'Unlocking started: “to set up the printer”.', 'the reason asked for since 1.13.2');
  assert.equal(describeEvent(at(T.shown, 'shown', { startedAt: T.started, why: 'to set up the printer' })), `The password was shown (unlocking started ${when(T.started)}: “to set up the printer”).`);
  assert.equal(describeEvent(at(T.shown, 'shown', { why: 'to set up the printer' })), 'The password was shown: “to set up the printer”.');
  assert.equal(describeEvent(at(T.started, 'started', { why: '' })), 'Unlocking started.', 'an empty reason is no reason');
  assert.equal(describeEvent(at(T.shown, 'sealed', { delay: 60 })), 'Locked away again, with the same wait of 1 minute.');
  assert.equal(describeEvent(at(T.shown, 'sealed')), 'Locked away again, with the same wait.');
  assert.equal(describeEvent(at(T.shown, 'sealed', { delay: 172800, previous: 60 })), 'Locked away again, with a wait of 2 days in place of 1 minute.', 'a wait of the person\'s choosing (#76)');
  assert.equal(describeEvent(at(T.locked, 'lengthened', { from: 60, to: 3600 })), 'The wait was lengthened from 1 minute to 1 hour, without unlocking.');
  assert.equal(describeEvent(at(T.locked, 'lengthened')), 'The wait was lengthened, without unlocking.');
  assert.equal(describeEvent(at(T.shown, 'seal-failed')), 'Couldn’t be locked away again with a fresh puzzle, so the old one was kept.');
  assert.equal(describeEvent(at(T.deleted, 'restored', { lockedAt: T.locked })), `Restored from a backup file, sealed ${when(T.locked)}.`);
  assert.equal(describeEvent(at(T.deleted, 'restored')), 'Restored from a backup file.');
  assert.equal(
    describeEvent(at(T.deleted, 'restored', { lockedAt: T.locked, from: 60, to: 600 })),
    `Restored from a backup file, sealed ${when(T.locked)}, with the wait lengthened from 1 minute to the 10 minutes set here after the file was saved.`,
    'a file from before the wait was lengthened (1.13.0)',
  );
  assert.equal(describeEvent(at(T.deleted, 'restored', { from: 60, to: 600 })), 'Restored from a backup file, with the wait lengthened from 1 minute to the 10 minutes set here after the file was saved.');
  assert.equal(describeEvent(at(T.deleted, 'deleted')), 'Deleted.');
  assert.equal(describeEvent(at(T.deleted, 'something-new')), 'something-new.', 'an entry from a newer version still shows');
  for (const name of EVENT_NAMES) assert.notEqual(describeEvent(at(T.deleted, name, { delay: 60, done: 1, steps: 2 })), `${name}.`, `${name} has words of its own`);
});

test('the small words: times, and the keys the pages share', () => {
  assert.equal(times(1), 'once');
  assert.equal(times(2), 'twice');
  assert.equal(times(3), '3 times');
  assert.deepEqual([BOX, PROGRESS, EVENTS, EVENTS_SINCE, WAITS], ['lockbox', 'lockboxProgress', 'lockboxEvents', 'lockboxEventsSince', 'lockboxWaits']);
});

// The wait lengthened (#76): a box inside a box, read layer by layer.

test('a wait reads in words, rounded to what matters', () => {
  assert.equal(duration(0.4), '1 second');
  assert.equal(duration(45), '45 seconds');
  assert.equal(duration(60), '1 minute');
  assert.equal(duration(12 * 60 + 20), '12 minutes');
  assert.equal(duration(3 * 3600 + 20 * 60), '3 hours 20 minutes');
  assert.equal(duration(47 * 3600), '47 hours');
  assert.equal(duration(2 * 86400), '2 days');
  assert.equal(duration(2 * 86400 + 3600), '2 days 1 hour');
});

const inner = await seal('secret', { steps: 1000, delay: 10, rate: 100 });
const outer = await lengthen(inner, { steps: 4000, delay: 30, rate: 200 });

test('the line gives the whole wait of a lengthened box, says when it was lengthened, and counts every layer towards the work done', () => {
  const locked = at(T.locked, 'locked', { delay: 10 });
  const lengthened = at(T.started, 'lengthened', { from: 10, to: 30 });
  assert.equal(sinceText({ box: inner, events: [] }), `since ${day(inner.lockedAt)}`);
  assert.equal(sinceText({ box: outer, events: [] }), `since ${day(inner.lockedAt)}, wait lengthened ${day(outer.lengthenedAt)}`, 'the box says when the password was locked away and when the wait grew');
  assert.equal(sinceText({ box: outer, events: [locked, lengthened] }), `since ${day(T.locked)}, wait lengthened ${day(outer.lengthenedAt)}`, 'the record says when it was locked away here');
  assert.equal(describeBox({ box: inner, progress: null, events: [] }), `A password is locked away (since ${day(inner.lockedAt)}); getting it back takes about 10 seconds.`);
  assert.equal(
    describeBox({ box: outer, progress: null, events: [locked, lengthened] }),
    `A password is locked away (since ${day(T.locked)}, wait lengthened ${day(outer.lengthenedAt)}), never unlocked; getting it back takes about 30 seconds.`,
    'the whole wait: lengthening is not an unlock',
  );
  // In the inner layer of the lengthened box: the outer puzzle's 4000 squarings done, and 500 of the 1000 inside.
  const progress = { n: outer.n, inner, x: '2', done: 500, before: 4000, startedAt: T.started };
  assert.equal(
    describeBox({ box: outer, progress, events: [locked, lengthened] }),
    `A password is locked away (since ${day(T.locked)}, wait lengthened ${day(outer.lengthenedAt)}), never unlocked; unlocking it is 90% done, started ${day(T.started)}.`,
  );
  assert.equal(fractionDone({ box: outer, progress }), 0.9);
  assert.equal(fractionDone({ box: outer, progress: { ...progress, done: 5000 } }), 1, 'never past the end');
  assert.equal(fractionDone({ box: inner, progress: { n: inner.n, x: '2', done: 250 } }), 0.25, 'progress saved before 1.10.0 has no layers before it');
  assert.equal(fractionDone({ box: outer, progress: null }), 0);
});

test('reading storage gives the box and the progress made on it, layer and all, or nothing', async () => {
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: { format: 'family-site-blocker-lockbox', version: 1 } })), { box: null, progress: null, events: [], since: null }, 'not a box');
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: inner })), { box: inner, progress: null, events: [], since: null });
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: outer })), { box: outer, progress: null, events: [], since: null });
  const progress = { n: outer.n, x: 'ff', done: 7, before: 0 };
  assert.deepEqual((await loadBox(fakeStore({ [BOX]: outer, [PROGRESS]: progress }))).progress, progress);
  assert.equal((await loadBox(fakeStore({ [BOX]: outer, [PROGRESS]: { n: inner.n, x: 'ff', done: 7 } }))).progress, null, 'progress on another box does not count');
  assert.deepEqual((await loadBox(fakeStore({ [BOX]: inner, [PROGRESS]: { n: inner.n, x: 'ff', done: 7 } }))).progress, { n: inner.n, x: 'ff', done: 7, before: 0 }, 'progress saved before 1.10.0 has no layers before it');
  const deeper = { n: outer.n, inner, x: 'ff', done: 7, before: 4000 };
  assert.deepEqual((await loadBox(fakeStore({ [BOX]: outer, [PROGRESS]: deeper }))).progress, deeper);
  assert.equal((await loadBox(fakeStore({ [BOX]: outer, [PROGRESS]: { ...deeper, inner: { n: 'abc' } } }))).progress, null, 'the layer being worked on has to be a box');
});

test('the layer being worked on is the stored box until that has been opened to one inside', () => {
  assert.equal(layerUnderWork({ box: outer, progress: null }), outer);
  assert.equal(layerUnderWork({ box: outer, progress: { n: outer.n, x: '2', done: 1, before: 0 } }), outer);
  assert.equal(layerUnderWork({ box: outer, progress: { n: outer.n, inner, x: '2', done: 1, before: 4000 } }), inner);
});

// The waits set for each password (1.13.0): the boxes that have held it, and the wait last chosen, so that a
// backup file of an earlier box is lengthened to the wait set since as it is restored.

/** A box with the same modulus and puzzle as `box`, as a file could write it: its `n` padded with noughts, and its wait as the file pleases. */
const asFile = (box, changes = {}) => ({ ...box, n: `000${box.n}`, ...changes });
/** The waits as stored, each box as the start of its key and its wait. */
const noted = (store) => store.data[WAITS].map(({ delay, boxes }) => ({ delay, boxes: boxes.map(({ key, delay: own }) => `${key.slice(0, 8)}:${own}`) }));
const short = async (box) => (await boxKey(box)).slice(0, 8);
/** A box of the waits as `noted` writes it, from a box and the wait it was stored with. */
const entry = async (box, delay) => `${await short(box)}:${delay}`;
/** A made-up box of the waits, with a key of its own. */
const made = (n, delay = 60) => ({ key: `${'a'.repeat(56)}${String(n).padStart(8, '0')}`, delay });

test('a box locked away starts a password; lengthening and locking away again carry it on, and set its wait', async () => {
  const store = fakeStore();
  const first = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, first, { delay: 60 });
  assert.deepEqual(noted(store), [{ delay: 60, boxes: [await entry(first, 60)] }]);
  assert.equal(await longerWaitFor(store, first), null, 'its wait is the one set');

  // Lengthened: the longer box joins the password, and the wait set is the longer one.
  const longer = await lengthen(first, { steps: 900, delay: 600, rate: 100 });
  await noteBox(store, longer, { previous: first, delay: 600 });
  assert.deepEqual(noted(store), [{ delay: 600, boxes: [await entry(first, 60), await entry(longer, 600)] }]);
  assert.deepEqual(await longerWaitFor(store, first), { delay: 600, from: 60 }, 'a backup file of the first box gets the longer wait');
  assert.equal(await longerWaitFor(store, longer), null);

  // Shown and locked away again with the same wait: the fresh box joins, and the wait stays.
  const again = await seal('secret', { steps: 1000, delay: 600, rate: 100 });
  await noteBox(store, again, { previous: longer });
  assert.deepEqual(noted(store), [{ delay: 600, boxes: [await entry(first, 60), await entry(longer, 600), await entry(again, 600)] }]);
  assert.deepEqual(await longerWaitFor(store, first), { delay: 600, from: 60 });

  // Locked away again with a shorter wait, once the wait has been served: the password's wait is the shorter one now.
  const shorter = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, shorter, { previous: again, delay: 60 });
  assert.equal(store.data[WAITS][0].delay, 60);
  assert.equal(await longerWaitFor(store, first), null, 'a file of the first box opens after its own wait, which is the one set again');
  assert.equal(await longerWaitFor(store, longer), null, 'a longer wait than the one set is no shorter for it');
  // And lengthened again, every earlier box gets the new wait.
  const longest = await lengthen(shorter, { steps: 3500, delay: 3600, rate: 100 });
  await noteBox(store, longest, { previous: shorter, delay: 3600 });
  assert.deepEqual(await longerWaitFor(store, first), { delay: 3600, from: 60 });
  assert.deepEqual(await longerWaitFor(store, longer), { delay: 3600, from: 600 });
  assert.deepEqual(await longerWaitFor(store, shorter), { delay: 3600, from: 60 });
  assert.equal(await longerWaitFor(store, longest), null);
});

test('a box from a backup file is known by its modulus, however the file writes it, and by the wait noted when it was stored, not the one it claims', async () => {
  const box = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  assert.match(await boxKey(box), /^[0-9a-f]{64}$/, 'a hash of the modulus');
  assert.equal(await boxKey(asFile(box)), await boxKey(box));
  assert.notEqual(await boxKey(box), await boxKey(await seal('secret', { steps: 100, delay: 60, rate: 100 })));
  const store = fakeStore();
  const first = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, first, { delay: 60 });
  const longer = await lengthen(first, { steps: 900, delay: 600, rate: 100 });
  await noteBox(store, longer, { previous: first, delay: 600 });
  assert.deepEqual(await longerWaitFor(store, asFile(first)), { delay: 600, from: 60 }, 'noughts in front of the modulus make no other box');
  assert.deepEqual(await longerWaitFor(store, asFile(first, { delay: 86400, rate: 0.001 })), { delay: 600, from: 60 }, 'nor does a file that claims a long wait');
  assert.deepEqual(await longerWaitFor(store, asFile(longer, { inside: [{ steps: 10 ** 12, rate: 1 }] })), null, 'the box stored last, whatever its file says');
  const elsewhere = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  assert.equal(await longerWaitFor(store, elsewhere), null, 'a box never stored here is taken as it is');
  await noteBox(store, asFile(first));
  assert.equal(store.data[WAITS].length, 1, 'restoring a box known here adds nothing');
  assert.deepEqual(noted(store)[0].boxes, [await entry(first, 60), await entry(longer, 600)]);
  // Restored and lengthened to the wait set: the box made joins the password.
  const restored = await lengthen(asFile(first), { steps: 900, delay: 600, rate: 100 });
  await noteBox(store, restored, { previous: asFile(first) });
  assert.deepEqual(noted(store)[0].boxes, [await entry(first, 60), await entry(longer, 600), await entry(restored, 600)]);
  assert.equal(store.data[WAITS][0].delay, 600);
});

test('each password has a wait of its own: a new one locked away with a short wait leaves an older one as it is', async () => {
  const store = fakeStore();
  const old = await seal('old', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, old, { delay: 60 });
  const longer = await lengthen(old, { steps: 900, delay: 600, rate: 100 });
  await noteBox(store, longer, { previous: old, delay: 600 });
  const dummy = await seal('new', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, dummy, { delay: 60 });
  assert.equal(store.data[WAITS].length, 2);
  assert.deepEqual(await longerWaitFor(store, old), { delay: 600, from: 60 }, 'the old password keeps its wait');
  assert.equal(await longerWaitFor(store, dummy), null);
  // Even once the new one has been unlocked and locked away again with a short wait.
  const dummyAgain = await seal('new', { steps: 100, delay: 60, rate: 100 });
  await noteBox(store, dummyAgain, { previous: dummy, delay: 60 });
  assert.deepEqual(await longerWaitFor(store, old), { delay: 600, from: 60 });
  assert.equal(store.data[WAITS][1].boxes.length, 2, 'the password touched last is last');
  assert.equal(store.data[WAITS][0].boxes.length, 2);
});

test('a box stored before the waits were kept joins as it is, and so does a box found inside one while unlocking', async () => {
  const store = fakeStore();
  const old = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  // Lengthened under this version, a box from before has no entry: it gets one with the box it is lengthened to.
  const longer = await lengthen(old, { steps: 900, delay: 600, rate: 100 });
  await noteBox(store, longer, { previous: old, delay: 600 });
  assert.deepEqual(noted(store), [{ delay: 600, boxes: [await entry(old, 60), await entry(longer, 600)] }]);
  assert.deepEqual(await longerWaitFor(store, old), { delay: 600, from: 60 }, 'so a backup file from before this version gets the longer wait too');

  // A box lengthened before this version says nothing of the box inside it, until unlocking opens it: then that box joins, with its own wait.
  const other = fakeStore();
  const inner = await seal('secret', { steps: 100, delay: 60, rate: 100 });
  const outer = await lengthen(inner, { steps: 900, delay: 600, rate: 100 });
  await noteBox(other, inner, { previous: outer });
  assert.deepEqual(noted(other), [{ delay: 600, boxes: [await entry(outer, 600), await entry(inner, 60)] }]);
  assert.deepEqual(await longerWaitFor(other, inner), { delay: 600, from: 60 });
  assert.equal(await longerWaitFor(other, outer), null);

  // A box that says nothing of its wait is noted with none, which sets no wait for the password.
  const mute = fakeStore();
  const { delay, ...nameless } = old;
  await noteBox(mute, nameless);
  assert.deepEqual(noted(mute), [{ delay: 0, boxes: [await entry(old, 0)] }]);
  assert.equal(await longerWaitFor(mute, old), null);
});

test('the waits keep only so many boxes, and drop junk in storage', async () => {
  const boxes = [];
  for (let i = 0; i < 4; i += 1) boxes.push(await seal('secret', { steps: 10, delay: 60 * (i + 1), rate: 100 }));
  const keys = await Promise.all(boxes.map(boxKey));
  // Two passwords: the first with WAITS_KEPT - 1 boxes, the second with one. One more box, and the first password's oldest goes.
  const store = fakeStore({
    [WAITS]: [
      { delay: 600, boxes: Array.from({ length: WAITS_KEPT - 1 }, (_, i) => made(i)) },
      'junk',
      { delay: 'soon', boxes: [{ key: keys[0], delay: 60 }] },
      { delay: 60, boxes: [] },
      { delay: 60, boxes: [{ key: 'not a key', delay: 60 }] },
      { delay: 60, boxes: [{ key: keys[1], delay: 60 }] },
    ],
  });
  await noteBox(store, boxes[2], { previous: boxes[1], delay: 600 });
  assert.equal(store.data[WAITS].length, 2, 'the junk went');
  assert.equal(store.data[WAITS][0].boxes.length, WAITS_KEPT - 2);
  assert.equal(store.data[WAITS][0].boxes[0].key, made(1).key, 'the oldest box of the password longest untouched went');
  assert.deepEqual(noted(store)[1], { delay: 600, boxes: [await entry(boxes[1], 60), await entry(boxes[2], 180)] }, 'the box with its own wait, the password with the one chosen');
  assert.equal(await longerWaitFor(store, boxes[0]), null, 'a box whose entry was junk is taken as it is');

  // The password longest untouched goes altogether once its boxes have.
  const small = fakeStore({ [WAITS]: [{ delay: 60, boxes: [{ key: keys[0], delay: 60 }] }, { delay: 60, boxes: Array.from({ length: WAITS_KEPT - 1 }, (_, i) => made(i)) }] });
  await noteBox(small, boxes[3], { previous: boxes[1], delay: 600 });
  assert.equal(small.data[WAITS].length, 2, 'boxes[1] was unknown there, so it and boxes[3] make a password');
  assert.equal(small.data[WAITS][0].boxes.length, WAITS_KEPT - 2, 'and the first password went, then the oldest box of the next');
  assert.equal(small.data[WAITS][0].boxes[0].key, made(1).key);
  assert.equal(await longerWaitFor(small, boxes[0]), null, 'gone');
  assert.deepEqual(await longerWaitFor(small, boxes[1]), { delay: 600, from: 120 });

  assert.deepEqual((await loadBox(fakeStore({ [WAITS]: 'junk' }))).events, [], 'nothing else is upset by junk there');
  assert.equal(await longerWaitFor(fakeStore({ [WAITS]: 'junk' }), boxes[0]), null);
});
