// Run with: npm test. What the locked-away password's page and the settings page share (extension/lib/lockbox.js):
// the record of what has happened to the password (#75): how entries are kept, what the settings page's line
// says from them, and the words for each entry; and, with the wait lengthened (#76), how the stored box and
// the unlocking progress are read, layer by layer, and how the line sums them up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto; // Node 18 has Web Crypto, but not on globalThis

const { BOX, EVENTS, EVENTS_KEPT, EVENT_NAMES, PROGRESS, describeBox, describeEvent, duration, fractionDone, isEvent, layerUnderWork, loadBox, recordEvent, sinceOf, sinceText, thisPassword, times } =
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

test('recording adds the entry with the time, oldest first, and drops the oldest once the record is long', async () => {
  const store = fakeStore();
  const before = Date.now();
  const first = await recordEvent(store, 'locked', { delay: 172800 });
  assert.equal(first.event, 'locked');
  assert.equal(first.delay, 172800);
  assert.ok(Date.parse(first.at) >= before - 1000 && Date.parse(first.at) <= Date.now() + 1000, first.at);
  await recordEvent(store, 'started');
  assert.deepEqual(store.data[EVENTS].map(({ event }) => event), ['locked', 'started']);
  assert.ok(store.data[EVENTS].every(isEvent));

  const long = fakeStore({ [EVENTS]: Array.from({ length: EVENTS_KEPT }, (_, i) => at(new Date(i * 1000).toISOString(), 'resumed', { done: i, steps: 9 })) });
  await recordEvent(long, 'stopped', { done: 5, steps: 9 });
  assert.equal(long.data[EVENTS].length, EVENTS_KEPT);
  assert.equal(long.data[EVENTS][0].done, 1, 'the oldest went');
  assert.equal(long.data[EVENTS].at(-1).event, 'stopped');
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
  assert.equal(describeEvent(at(T.shown, 'sealed', { delay: 60 })), 'Locked away again, with the same wait of 1 minute.');
  assert.equal(describeEvent(at(T.shown, 'sealed')), 'Locked away again, with the same wait.');
  assert.equal(describeEvent(at(T.shown, 'sealed', { delay: 172800, previous: 60 })), 'Locked away again, with a wait of 2 days in place of 1 minute.', 'a wait of the person\'s choosing (#76)');
  assert.equal(describeEvent(at(T.locked, 'lengthened', { from: 60, to: 3600 })), 'The wait was lengthened from 1 minute to 1 hour, without unlocking.');
  assert.equal(describeEvent(at(T.locked, 'lengthened')), 'The wait was lengthened, without unlocking.');
  assert.equal(describeEvent(at(T.shown, 'seal-failed')), 'Couldn’t be locked away again with a fresh puzzle, so the old one was kept.');
  assert.equal(describeEvent(at(T.deleted, 'restored', { lockedAt: T.locked })), `Restored from a backup file, sealed ${when(T.locked)}.`);
  assert.equal(describeEvent(at(T.deleted, 'restored')), 'Restored from a backup file.');
  assert.equal(describeEvent(at(T.deleted, 'deleted')), 'Deleted.');
  assert.equal(describeEvent(at(T.deleted, 'something-new')), 'something-new.', 'an entry from a newer version still shows');
  for (const name of EVENT_NAMES) assert.notEqual(describeEvent(at(T.deleted, name, { delay: 60, done: 1, steps: 2 })), `${name}.`, `${name} has words of its own`);
});

test('the small words: times, and the keys the pages share', () => {
  assert.equal(times(1), 'once');
  assert.equal(times(2), 'twice');
  assert.equal(times(3), '3 times');
  assert.deepEqual([BOX, PROGRESS, EVENTS], ['lockbox', 'lockboxProgress', 'lockboxEvents']);
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
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: { format: 'family-site-blocker-lockbox', version: 1 } })), { box: null, progress: null, events: [] }, 'not a box');
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: inner })), { box: inner, progress: null, events: [] });
  assert.deepEqual(await loadBox(fakeStore({ [BOX]: outer })), { box: outer, progress: null, events: [] });
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
