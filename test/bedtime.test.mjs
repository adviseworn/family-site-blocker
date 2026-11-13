// Run with: npm test. Bedtime (extension/lib/bedtime.js, 1.30.0): every site blocked between two times of
// day; a change that lets more through waits a day and needs a reason; the record; the words the pages
// show; and the rules that do the blocking (extension/lib/rules.js bedtimeRules). The times are built on
// this computer's own clock, as the add-on reads them, so the tests pass in any time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toCsv } from '../extension/lib/attempts.js';
import {
  BEDTIME_NAME,
  DEFAULT_TIMES,
  MAX_EVENTS,
  UNDO_MS,
  WAIT_MS,
  WARN_MS,
  WHY_LENGTH,
  addressFrom,
  ask,
  bedtimeEvents,
  beginsSoon,
  blockedAt,
  covers,
  describeBedtime,
  endOf,
  eventWords,
  hoursWords,
  isLooser,
  isTimes,
  keep,
  lengthOf,
  loosens,
  minutesAt,
  nextAt,
  nextChange,
  pageFor,
  parseTime,
  recordBedtime,
  settingOf,
  settle,
  timeValue,
  timeWords,
  undo,
  within,
} from '../extension/lib/bedtime.js';
import { addToMyList, myList, saveMyList } from '../extension/lib/mylist.js';
import { everyTryShows } from '../extension/lib/page.js';
import { BEDTIME_FIRST_ID, BEDTIME_PAGE, BEDTIME_PRIORITY, PAGE_BLOCK_FIRST_ID, PAGE_BLOCK_PRIORITY, bedtimeRules, buildRules, domainsOf, isBedtimeRule, pageBlockRules } from '../extension/lib/rules.js';
import { loadRules } from '../scripts/build-rules.mjs';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

// A moment on this computer's clock: Wednesday Nov 11, 2026 unless another day is given.
const at = (hour, minute = 0, day = 11) => new Date(2026, 10, day, hour, minute).getTime();
const NIGHT = { on: true, from: 21 * 60, to: 5 * 60 }; // 9:00 PM to 5:00 AM
const OFF = { on: false, ...DEFAULT_TIMES };
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const clock = (ms) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(ms);

test('bedtime: 9:00 PM to 5:00 AM is offered first, and it is off until someone sets it', () => {
  assert.deepEqual(DEFAULT_TIMES, { from: 1260, to: 300 });
  assert.deepEqual(settingOf(undefined), OFF);
  assert.deepEqual(settingOf(null), OFF);
  assert.deepEqual(settingOf('junk'), OFF);
  assert.deepEqual(settingOf({ on: true, from: 300, to: 300 }), OFF, 'two times that are the same are no bedtime');
  assert.deepEqual(settingOf({ on: true, from: -1, to: 300 }), OFF);
  assert.deepEqual(settingOf({ on: true, from: 1260.5, to: 300 }), OFF);
  assert.deepEqual(settingOf({ on: 'yes', from: 1260, to: 300 }), OFF, 'on only when it says so');
  assert.deepEqual(settingOf({ ...NIGHT, extra: 1 }), NIGHT);
  assert.equal(blockedAt(settingOf(null), at(23)), false);
});

test('bedtime: a setting read from storage keeps a change that waits and an undo only when they are well-formed', () => {
  const next = { on: false, from: 1260, to: 300, asked: at(15), at: at(15, 0, 12), why: 'Travelling' };
  assert.deepEqual(settingOf({ ...NIGHT, next }), { ...NIGHT, next });
  assert.deepEqual(settingOf({ ...NIGHT, next: { ...next, why: 7 } }).next.why, '');
  assert.deepEqual(settingOf({ ...NIGHT, next: { ...next, at: 'soon' } }), NIGHT);
  assert.deepEqual(settingOf({ ...NIGHT, next: { ...next, on: 'no' } }), NIGHT);
  const before = { ...OFF };
  assert.deepEqual(settingOf({ ...NIGHT, undo: { before, until: at(15, 10) } }), { ...NIGHT, undo: { before, until: at(15, 10) } });
  assert.deepEqual(settingOf({ ...NIGHT, undo: { before: 'junk', until: at(15, 10) } }), NIGHT);
  assert.deepEqual(settingOf({ ...NIGHT, undo: { before, until: null } }), NIGHT);
  // What it was before keeps a change that waited then, but nothing to undo in its turn.
  const nested = settingOf({ ...NIGHT, undo: { before: { ...NIGHT, next, undo: { before, until: 1 } }, until: at(15, 10) } });
  assert.deepEqual(nested.undo.before, { ...NIGHT, next });
});

test('bedtime: a time field’s value and minutes after midnight, both ways', () => {
  assert.equal(timeValue(0), '00:00');
  assert.equal(timeValue(1260), '21:00');
  assert.equal(timeValue(5 * 60 + 7), '05:07');
  assert.equal(parseTime('21:00'), 1260);
  assert.equal(parseTime('05:07'), 307);
  assert.equal(parseTime('5:07'), 307);
  assert.equal(parseTime('23:59:30'), 1439, 'seconds are left off');
  assert.equal(parseTime('23:59:30.250'), 1439);
  for (const junk of ['', null, undefined, '24:00', '12:60', '9pm', '21', '21:0', 'ab:cd']) assert.equal(parseTime(junk), null, String(junk));
  for (const minutes of [0, 1, 299, 300, 1260, 1439]) assert.equal(parseTime(timeValue(minutes)), minutes);
  assert.equal(isTimes({ from: 0, to: 1 }), true);
  assert.equal(isTimes({ from: 1, to: 1 }), false);
  assert.equal(isTimes({ from: 0, to: 1440 }), false);
  assert.equal(isTimes(null), false);
});

test('bedtime: hours that start later than they end run over midnight', () => {
  assert.equal(within(NIGHT, 21 * 60), true, 'the first minute');
  assert.equal(within(NIGHT, 23 * 60 + 59), true);
  assert.equal(within(NIGHT, 0), true);
  assert.equal(within(NIGHT, 4 * 60 + 59), true, 'the last minute');
  assert.equal(within(NIGHT, 5 * 60), false, 'over at its end');
  assert.equal(within(NIGHT, 12 * 60), false);
  assert.equal(within(NIGHT, 20 * 60 + 59), false);
  const nap = { from: 13 * 60, to: 14 * 60 };
  assert.equal(within(nap, 13 * 60), true);
  assert.equal(within(nap, 13 * 60 + 59), true);
  assert.equal(within(nap, 14 * 60), false);
  assert.equal(within(nap, 12 * 60 + 59), false);
  assert.equal(lengthOf(NIGHT), 8 * 60);
  assert.equal(lengthOf(nap), 60);
  assert.equal(minutesAt(at(21, 30)), 21 * 60 + 30);
  assert.equal(blockedAt(NIGHT, at(22)), true);
  assert.equal(blockedAt(NIGHT, at(3)), true);
  assert.equal(blockedAt(NIGHT, at(12)), false);
  assert.equal(blockedAt({ ...NIGHT, on: false }, at(22)), false, 'off blocks nothing');
});

test('bedtime: a change holds at once only when it blocks at least what the bedtime in force blocks', () => {
  const b = (from, to, on = true) => ({ on, from: from * 60, to: to * 60 });
  assert.equal(covers(b(21, 5), b(21, 5)), true, 'the same hours');
  assert.equal(covers(b(20, 5), b(21, 5)), true, 'an earlier start');
  assert.equal(covers(b(21, 6), b(21, 5)), true, 'a later end');
  assert.equal(covers(b(20, 6), b(22, 4)), true);
  assert.equal(covers(b(22, 5), b(21, 5)), false, 'a later start');
  assert.equal(covers(b(21, 4), b(21, 5)), false, 'an earlier end');
  assert.equal(covers(b(22, 6), b(21, 5)), false, 'moved: later at both ends');
  assert.equal(covers(b(9, 17), b(21, 5)), false, 'other hours altogether');
  assert.equal(covers(b(5, 21), b(21, 5)), false, 'the other part of the day');
  assert.equal(covers(b(21, 5, false), b(21, 5)), false, 'off covers nothing');
  assert.equal(covers(b(9, 10), b(21, 5, false)), true, 'anything covers off');
  assert.equal(covers(b(21, 5, false), b(21, 5, false)), true);
  // Across midnight both ways.
  assert.equal(covers(b(23, 7), b(0, 6)), true);
  assert.equal(covers(b(0, 6), b(23, 7)), false);
  assert.equal(loosens(NIGHT, b(20, 6)), false);
  assert.equal(loosens(NIGHT, b(22, 5)), true);
  assert.equal(loosens(NIGHT, { ...NIGHT, on: false }), true, 'turning it off');
  assert.equal(loosens(OFF, NIGHT), false, 'turning it on');
});

test('bedtime: turning it on holds at once and can be undone for ten minutes', () => {
  const now = at(15);
  const turned = ask(null, NIGHT, { now });
  assert.deepEqual(turned.event, { at: now, event: 'set', ...NIGHT });
  assert.deepEqual(turned.setting, { ...NIGHT, undo: { before: OFF, until: now + UNDO_MS } });
  assert.equal(UNDO_MS, 10 * 60 * 1000);
  assert.deepEqual(ask(turned.setting, NIGHT, { now: now + 1000 }), { unchanged: true }, 'the same again is nothing to do');
  // Undone within the ten minutes, it is as it was; after them there is nothing to undo.
  const undone = undo(turned.setting, { now: now + UNDO_MS - 1 });
  assert.deepEqual(undone, { setting: OFF, event: { at: now + UNDO_MS - 1, event: 'undone', ...OFF } });
  assert.deepEqual(undo(turned.setting, { now: now + UNDO_MS }), { error: 'There is nothing to undo any more.' });
  assert.deepEqual(settle(turned.setting, now + UNDO_MS), { setting: NIGHT, events: [], changed: true }, 'the undo runs out without a word in the record');
  assert.deepEqual(settle(turned.setting, now + 1), { setting: turned.setting, events: [], changed: false });
});

test('bedtime: what the form sends has to be a bedtime', () => {
  const now = at(15);
  assert.deepEqual(ask(null, { from: 1260, to: 300 }, { now }), { error: 'Say whether bedtime is on or off.' });
  assert.deepEqual(ask(null, null, { now }), { error: 'Say whether bedtime is on or off.' });
  assert.deepEqual(ask(null, { on: true, from: 300, to: 300 }, { now }), { error: 'The two times are the same. Choose a start and an end.' });
  assert.deepEqual(ask(null, { on: true, from: null, to: 300 }, { now }), { error: 'Choose a start and an end.' });
  assert.deepEqual(ask(null, { on: true }, { now }), { error: 'Choose a start and an end.' });
  assert.deepEqual(ask(null, { on: false }, { now }), { unchanged: true }, 'off already');
  assert.deepEqual(ask(null, { on: false, from: 60, to: 120 }, { now }), { unchanged: true }, 'off already, whatever times came with it');
});

test('bedtime: an earlier start or a later end holds at once; a later start, an earlier end or turning it off waits a day and needs a reason', () => {
  const now = at(15);
  const longer = ask(NIGHT, { on: true, from: 20 * 60, to: 6 * 60 }, { now });
  assert.equal(longer.event.event, 'set');
  assert.deepEqual(longer.setting, { on: true, from: 1200, to: 360, undo: { before: NIGHT, until: now + UNDO_MS } });

  for (const wanted of [{ on: true, from: 22 * 60, to: 5 * 60 }, { on: true, from: 21 * 60, to: 4 * 60 }, { on: true, from: 9 * 60, to: 17 * 60 }, { on: false }]) {
    assert.deepEqual(ask(NIGHT, wanted, { now }), { error: 'Say why first. Your answer goes into the record.' }, JSON.stringify(wanted));
    assert.deepEqual(ask(NIGHT, wanted, { now, why: '   ' }), { error: 'Say why first. Your answer goes into the record.' }, 'spaces are no reason');
  }
  assert.equal(WAIT_MS, 24 * 60 * 60 * 1000, 'a day');
  const off = ask(NIGHT, { on: false }, { now, why: '  Travelling ' });
  const next = { on: false, from: 1260, to: 300, asked: now, at: now + WAIT_MS, why: 'Travelling' };
  assert.deepEqual(off.setting, { ...NIGHT, next }, 'the bedtime stays as it is; the change waits beside it, the times kept for when it is off');
  assert.deepEqual(off.event, { at: now, event: 'asked', on: false, from: 1260, to: 300, due: now + WAIT_MS, why: 'Travelling' });
  assert.equal(ask(NIGHT, { on: false }, { now, why: 'x'.repeat(WHY_LENGTH + 50) }).event.why.length, WHY_LENGTH, 'a reason is cut to its length');

  // Until the day is up the bedtime holds just as it was: the change does nothing yet.
  assert.equal(blockedAt(settle(off.setting, at(22)).setting, at(22)), true);
  assert.equal(blockedAt(settle(off.setting, at(4, 0, 12)).setting, at(4, 0, 12)), true);
  const later = ask(NIGHT, { on: true, from: 22 * 60, to: 6 * 60 }, { now, why: 'Working late' });
  assert.equal(blockedAt(settle(later.setting, at(21, 30)).setting, at(21, 30)), true, 'the hour it will lose is still blocked tonight');
  assert.equal(blockedAt(settle(later.setting, at(5, 30, 12)).setting, at(5, 30, 12)), false, 'and the hour it will gain is not blocked yet');

  // When the day is up the change takes the bedtime's place, with an entry dated at that moment, whenever it is noticed.
  const settled = settle(off.setting, now + WAIT_MS + 5 * 60 * 1000);
  assert.deepEqual(settled, { setting: { on: false, from: 1260, to: 300 }, events: [{ at: now + WAIT_MS, event: 'changed', on: false, from: 1260, to: 300 }], changed: true });
  assert.deepEqual(settle(off.setting, now + WAIT_MS - 1), { setting: off.setting, events: [], changed: false });
  assert.deepEqual(settle(later.setting, now + WAIT_MS).setting, { on: true, from: 1320, to: 360 });
});

test('bedtime: a change that waits can be taken back, asked for again or replaced, and none of it opens a site', () => {
  const now = at(15);
  const off = ask(NIGHT, { on: false }, { now, why: 'Travelling' }).setting;
  // The same change again is the one that waits already: its day doesn't start over.
  assert.deepEqual(ask(off, { on: false }, { now: now + 1000, why: 'Again' }), { unchanged: true, waiting: now + WAIT_MS });
  assert.deepEqual(ask(off, { on: false, from: 60, to: 120 }, { now: now + 1000, why: 'Again' }), { unchanged: true, waiting: now + WAIT_MS }, 'off is off, whatever times came with it');
  // Taken back, by the link or by asking for the bedtime as it is.
  const kept = { setting: NIGHT, event: { at: now + 1000, event: 'kept' } };
  assert.deepEqual(keep(off, { now: now + 1000 }), kept);
  assert.deepEqual(ask(off, NIGHT, { now: now + 1000 }), kept);
  assert.deepEqual(keep(NIGHT, { now }), { error: 'No change is waiting.' });
  assert.deepEqual(keep(off, { now: now + WAIT_MS }), { error: 'No change is waiting.' }, 'it took effect: there is nothing left to take back');
  // Another change in its place waits its own day from when it was asked for.
  const other = ask(off, { on: true, from: 22 * 60, to: 5 * 60 }, { now: now + 3600_000, why: 'Working late' });
  assert.deepEqual(other.setting.next, { on: true, from: 1320, to: 300, asked: now + 3600_000, at: now + 3600_000 + WAIT_MS, why: 'Working late' });
  for (const setting of [off, kept.setting, other.setting]) assert.equal(blockedAt(settle(setting, at(21, 30)).setting, at(21, 30)), true);
  // A longer bedtime meanwhile holds at once and drops the change that waited, which the record says; undone, the change waits again.
  const longer = ask(off, { on: true, from: 20 * 60, to: 6 * 60 }, { now: now + 2000 });
  assert.deepEqual(longer.event, { at: now + 2000, event: 'set', on: true, from: 1200, to: 360, dropped: true });
  assert.equal(longer.setting.next, undefined);
  assert.deepEqual(undo(longer.setting, { now: now + 3000 }).setting, off);
});

test('bedtime: for the ten minutes a change can be undone, what counts is the bedtime from before it', () => {
  const now = at(22); // inside the hours just set by mistake
  const turned = ask(null, NIGHT, { now }).setting;
  // Unticking the box and saving is the undo: back to off at once, with no reason asked.
  assert.deepEqual(ask(turned, { on: false }, { now: now + 60_000 }), { setting: OFF, event: { at: now + 60_000, event: 'undone', ...OFF } });
  // Other hours hold at once too, and the ten minutes don't start over.
  const moved = ask(turned, { on: true, from: 23 * 60, to: 5 * 60 }, { now: now + 60_000 });
  assert.deepEqual(moved.setting, { on: true, from: 1380, to: 300, undo: { before: OFF, until: now + UNDO_MS } });
  assert.equal(moved.event.event, 'set');
  // After the ten minutes the same change waits a day.
  assert.deepEqual(ask(turned, { on: false }, { now: now + UNDO_MS }), { error: 'Say why first. Your answer goes into the record.' });

  // From a bedtime that was on before: back to it, or to anything that blocks as much, at once; less than it waits a day.
  const longer = ask(NIGHT, { on: true, from: 20 * 60, to: 6 * 60 }, { now }).setting;
  assert.equal(ask(longer, NIGHT, { now: now + 1000 }).event.event, 'undone');
  assert.equal(ask(longer, { on: true, from: 20 * 60 + 30, to: 5 * 60 + 30 }, { now: now + 1000 }).event.event, 'set');
  assert.deepEqual(ask(longer, { on: true, from: 21 * 60 + 30, to: 5 * 60 }, { now: now + 1000 }), { error: 'Say why first. Your answer goes into the record.' });
  assert.deepEqual(ask(longer, { on: false }, { now: now + 1000 }), { error: 'Say why first. Your answer goes into the record.' });
  // A change asked for meanwhile leaves the undo in place, and undoing drops it.
  const asked = ask(longer, { on: false }, { now: now + 1000, why: 'Travelling' }).setting;
  assert.deepEqual(asked.undo, longer.undo);
  assert.deepEqual(undo(asked, { now: now + 2000 }).setting, NIGHT);
  assert.deepEqual(keep(asked, { now: now + 2000 }).setting, longer, 'taking the change back leaves the undo too');
});

test('bedtime: when the blocking ends, and the next moment anything changes', () => {
  assert.equal(nextAt(5 * 60, at(22)), at(5, 0, 12), 'tomorrow morning');
  assert.equal(nextAt(5 * 60, at(3)), at(5), 'this morning');
  assert.equal(nextAt(5 * 60, at(5)), at(5, 0, 12), 'strictly after now');
  assert.equal(endOf(NIGHT, at(12)), null, 'nothing is blocked at noon');
  assert.equal(endOf(null, at(23)), null);
  assert.equal(endOf(NIGHT, at(22)), at(5, 0, 12));
  assert.equal(endOf(NIGHT, at(3)), at(5));
  // A change that waits ends it early when it takes effect first…
  const off = { ...NIGHT, next: { on: false, from: 1260, to: 300, asked: at(3), at: at(3, 0, 12), why: 'x' } };
  assert.equal(endOf(off, at(22)), at(3, 0, 12));
  assert.equal(endOf(off, at(3, 30, 12)), null, 'and after that it is off');
  // …or runs it on, when its own hours hold at that moment.
  const later = { ...NIGHT, next: { on: true, from: 1320, to: 360, asked: at(3), at: at(3, 0, 12), why: 'x' } };
  assert.equal(endOf(later, at(22)), at(6, 0, 12));
  assert.equal(endOf(later, at(4)), at(5), 'tonight’s end is the old one: the change comes tomorrow');

  // The alarm: the warning, the start, the end, a change taking effect, an undo running out.
  assert.equal(WARN_MS, 10 * 60 * 1000);
  assert.equal(nextChange(OFF, at(12)), null);
  assert.equal(nextChange(NIGHT, at(12)), at(20, 50), 'the warning, ten minutes before');
  assert.equal(nextChange(NIGHT, at(20, 50)), at(21), 'the start');
  assert.equal(nextChange(NIGHT, at(21)), at(5, 0, 12), 'the end');
  assert.equal(nextChange(NIGHT, at(5)), at(20, 50));
  assert.equal(nextChange({ ...NIGHT, undo: { before: OFF, until: at(12, 10) } }, at(12, 5)), at(12, 10));
  assert.equal(nextChange(off, at(22)), at(3, 0, 12));
  assert.equal(nextChange({ ...OFF, undo: { before: NIGHT, until: at(12, 10) } }, at(12, 20)), null);
});

test('bedtime: the pages open are told ten minutes before every site closes', () => {
  assert.equal(beginsSoon(NIGHT, at(20, 49)), null, 'too early');
  assert.equal(beginsSoon(NIGHT, at(20, 50)), at(21));
  assert.equal(beginsSoon(NIGHT, at(20, 59)), at(21));
  assert.equal(beginsSoon(NIGHT, at(21)), null, 'it has begun: the pages are closed, not told');
  assert.equal(beginsSoon(OFF, at(20, 55)), null);
  assert.equal(beginsSoon(null, at(20, 55)), null);
  // A change that will have turned it off, or moved it, by then: nothing closes at nine.
  const off = { ...NIGHT, next: { on: false, from: 1260, to: 300, asked: at(20, 58, 10), at: at(20, 58), why: 'x' } };
  assert.equal(beginsSoon(off, at(20, 55)), null);
  // A change that takes effect in the middle of its own hours closes every site at that moment.
  const nap = { ...NIGHT, next: { on: true, from: 13 * 60, to: 15 * 60, asked: at(14, 0, 10), at: at(14), why: 'x' } };
  assert.equal(beginsSoon(nap, at(13, 55)), at(14));
  assert.equal(beginsSoon(nap, at(13, 45)), null);
});

test('bedtime: the record keeps what was done, oldest first, the latest thousand, and leaves junk out', () => {
  const set = { at: 1000, event: 'set', ...NIGHT };
  const asked = { at: 2000, event: 'asked', on: false, from: 1260, to: 300, due: 2000 + WAIT_MS, why: 'Travelling' };
  const kept = { at: 3000, event: 'kept' };
  assert.deepEqual(bedtimeEvents([set, null, 'junk', { at: 'x', event: 'set', ...NIGHT }, { at: 5, event: 'cleared' }, { at: 6, event: 'set' }, asked, kept]), [set, asked, kept]);
  assert.deepEqual(bedtimeEvents(undefined), []);
  assert.deepEqual(bedtimeEvents('junk'), []);
  assert.deepEqual(recordBedtime([asked], [kept, set]), [set, asked, kept], 'by time');
  assert.deepEqual(recordBedtime(undefined, [set]), [set]);
  const many = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ({ at: i, event: 'kept' }));
  const trimmed = recordBedtime(many, [{ at: MAX_EVENTS + 5, event: 'kept' }]);
  assert.equal(trimmed.length, MAX_EVENTS);
  assert.equal(trimmed[0].at, 6, 'the oldest go');
  assert.equal(trimmed.at(-1).at, MAX_EVENTS + 5);
});

test('bedtime: what a row of the record says', () => {
  const nine = timeWords(21 * 60);
  const five = timeWords(5 * 60);
  assert.equal(hoursWords(NIGHT), `${nine} to ${five}`);
  assert.equal(timeWords(0), clock(new Date(2000, 0, 1, 0, 0)));
  assert.equal(BEDTIME_NAME, 'Bedtime');
  assert.equal(eventWords({ at: 1, event: 'set', ...NIGHT }), `Set: ${nine} to ${five}.`);
  assert.equal(eventWords({ at: 1, event: 'set', ...NIGHT, dropped: true }), `Set: ${nine} to ${five}. The change asked for before it was dropped.`);
  assert.equal(eventWords({ at: 1, event: 'asked', on: false, from: 1260, to: 300, due: 1 + WAIT_MS, why: 'Travelling' }), 'Asked to turn it off after a day’s wait: “Travelling”.');
  assert.equal(eventWords({ at: 1, event: 'asked', on: true, from: 1320, to: 300, due: 1 + WAIT_MS, why: 'Working late' }), `Asked to change it to ${timeWords(22 * 60)} to ${five} after a day’s wait: “Working late”.`);
  assert.equal(eventWords({ at: 1, event: 'asked', on: false, from: 1260, to: 300 }), 'Asked to turn it off after a day’s wait.', 'an entry without its details still reads');
  assert.equal(eventWords({ at: at(15), event: 'asked', on: false, from: 1260, to: 300, due: at(15, 0, 13), why: 'x' }), `Asked to turn it off from ${when(at(15, 0, 13))}: “x”.`, 'another wait is said by its end');
  assert.equal(eventWords({ at: 1, event: 'changed', on: false, from: 1260, to: 300 }), 'Turned off, as asked a day before.');
  assert.equal(eventWords({ at: 1, event: 'changed', on: true, from: 1320, to: 300 }), `Changed to ${timeWords(22 * 60)} to ${five}, as asked a day before.`);
  assert.equal(eventWords({ at: 1, event: 'kept' }), 'The change asked for was taken back.');
  assert.equal(eventWords({ at: 1, event: 'undone', ...NIGHT }), `Change undone: back to ${nine} to ${five}.`);
  assert.equal(eventWords({ at: 1, event: 'undone', ...OFF }), 'Change undone: off again.');
  assert.deepEqual(['set', 'asked', 'changed', 'kept', 'undone'].map((event) => isLooser({ event })), [false, true, true, false, false]);
});

test('bedtime: where it stands, for the settings page and for its record on Every try', () => {
  const hours = hoursWords(NIGHT);
  assert.equal(describeBedtime(null, at(12)), 'Bedtime is off.');
  assert.equal(describeBedtime(NIGHT, at(12)), `Every site is blocked from ${hours}, every day.`);
  assert.equal(describeBedtime(NIGHT, at(22)), `It’s bedtime until ${clock(at(5, 0, 12))}. Every site is blocked from ${hours}, every day.`);
  const off = { ...NIGHT, next: { on: false, from: 1260, to: 300, asked: at(15), at: at(15, 0, 12), why: 'x' } };
  assert.equal(describeBedtime(off, at(16)), `Every site is blocked from ${hours}, every day. On ${when(at(15, 0, 12))} it turns off.`);
  const later = { ...NIGHT, next: { on: true, from: 1320, to: 360, asked: at(15), at: at(15, 0, 12), why: 'x' } };
  assert.equal(describeBedtime(later, at(16)), `Every site is blocked from ${hours}, every day. On ${when(at(15, 0, 12))} it changes to ${hoursWords({ from: 1320, to: 360 })}.`);
  assert.equal(describeBedtime(off, at(16, 0, 12)), 'Bedtime is off.', 'once the change has taken effect');
});

test('bedtime: the bedtime page carries the address it stands in for, and goes back to nothing but a web page', () => {
  const page = 'moz-extension://1234/bedtime.html';
  assert.equal(pageFor(page, 'https://example.org/a?b=1#c'), 'moz-extension://1234/bedtime.html#https://example.org/a?b=1#c');
  assert.equal(addressFrom('#https://example.org/a?b=1#c'), 'https://example.org/a?b=1#c');
  assert.equal(addressFrom('#http://example.org'), 'http://example.org/');
  assert.equal(addressFrom('#HTTPS://Example.org/Path'), 'https://example.org/Path');
  for (const junk of ['', '#', undefined, null, '#javascript:alert(1)', '#data:text/html,hi', '#file:///etc/passwd', '#about:blank', '#chrome-extension://abc/options.html', '#moz-extension://abc/options.html', '#//example.org', '#example.org', '#https://', '#ftp://example.org/']) {
    assert.equal(addressFrom(junk), null, String(junk));
  }
});

// A stand-in for the browser's matcher, for rules with a regexFilter: the rule that wins a request (the
// highest priority, then a block before a redirect) and what it does to it.
function outcome(rules, url, type = 'main_frame') {
  const fits = rules.filter(({ condition }) => {
    if (condition.resourceTypes && !condition.resourceTypes.includes(type)) return false;
    if (condition.excludedResourceTypes?.includes(type)) return false;
    return new RegExp(condition.regexFilter).test(url);
  });
  const rank = { block: 1, redirect: 2 };
  fits.sort((a, b) => b.priority - a.priority || rank[a.action.type] - rank[b.action.type]);
  const [best] = fits;
  if (!best) return 'allow';
  if (best.action.type !== 'redirect') return best.action.type;
  return url.replace(new RegExp(best.condition.regexFilter), () => best.action.redirect.regexSubstitution.replace('\\0', url.match(new RegExp(best.condition.regexFilter))[0]));
}

test('bedtime: its rules send every page being opened to the bedtime page, with its address, and block everything else a page could ask for', () => {
  const page = 'moz-extension://1234/bedtime.html';
  const rules = bedtimeRules(page);
  assert.equal(rules.length, 2);
  for (const url of ['https://example.org/', 'http://example.org/a/b?c=d&e=f', 'https://www.google.com/search?q=cats', 'https://exampleadultsite.com/', 'http://127.0.0.1:8080/x']) {
    assert.equal(outcome(rules, url), `${page}#${url}`, url);
    assert.equal(addressFrom(new URL(outcome(rules, url)).hash), new URL(url).href, 'which the page reads back');
  }
  for (const type of ['sub_frame', 'image', 'script', 'stylesheet', 'xmlhttprequest', 'media', 'font', 'ping', 'other']) assert.equal(outcome(rules, 'https://example.org/x', type), 'block', type);
  assert.equal(outcome(rules, 'wss://example.org/socket', 'websocket'), 'block');
  assert.equal(outcome(rules, 'ws://example.org/socket', 'websocket'), 'block');
  // Pages that aren't on the web are left alone: the extension's own, the browser's, a file.
  for (const url of ['moz-extension://1234/options.html', 'chrome-extension://abcd/options.html', 'about:blank', 'file:///home/me/notes.html', 'data:text/html,hi', 'view-source:https://example.org/']) {
    assert.equal(outcome(rules, url), 'allow', url);
    assert.equal(outcome(rules, url, 'image'), 'allow', url);
  }
  // Without access to websites a browser drops a redirect, so the page is blocked outright, ahead of the redirect (the background script then sends the tab to the bedtime page).
  const without = bedtimeRules(page, { access: false });
  assert.equal(without.length, 3);
  assert.equal(outcome(without, 'https://example.org/'), 'block');
  assert.equal(outcome(without, 'https://example.org/x', 'image'), 'block');
});

test('bedtime: its rules come ahead of every other rule, under ids no other rule has, and are not part of the person’s list', async () => {
  const all = loadRules();
  const rules = bedtimeRules('moz-extension://1234/bedtime.html', { access: false });
  assert.ok(rules.every((rule) => rule.priority > Math.max(PAGE_BLOCK_PRIORITY, ...all.map((other) => other.priority))), 'ahead of the lists, safe search and the page-blocking rules');
  assert.ok(BEDTIME_PRIORITY > PAGE_BLOCK_PRIORITY);
  assert.ok(rules.every(isBedtimeRule));
  assert.ok(BEDTIME_FIRST_ID > Math.max(...all.map((rule) => rule.id)), 'beyond every static rule');
  assert.ok(Math.max(...rules.map((rule) => rule.id)) < PAGE_BLOCK_FIRST_ID, 'and short of the page-blocking rules');
  assert.equal([...all, ...pageBlockRules(['a.example']), ...buildRules(['a.example'])].some(isBedtimeRule), false);
  assert.deepEqual(new Set(rules.map((rule) => rule.id)).size, rules.length);
  // Chrome and Firefox take a regexFilter only as a string RE2 can compile; these are as plain as they come.
  for (const rule of rules) assert.match(rule.condition.regexFilter, /^\^[\w?:()|/.*]+$/);

  // The person's list lives in the same store (the dynamic rules): it is read without the bedtime's rules, and saving it leaves them in place.
  let store = [...bedtimeRules('moz-extension://1234/bedtime.html')];
  const dnr = {
    getDynamicRules: async () => store,
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      store = [...store.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
    },
  };
  assert.deepEqual(await myList(dnr), []);
  assert.deepEqual(domainsOf(store), []);
  await saveMyList(dnr, ['a.test', 'b.test']);
  assert.deepEqual(await myList(dnr), ['a.test', 'b.test']);
  assert.equal(store.filter(isBedtimeRule).length, 2, 'the bedtime’s rules are still there');
  assert.equal(await addToMyList(dnr, 'c.test'), true);
  await saveMyList(dnr, []);
  assert.deepEqual(await myList(dnr), []);
  assert.deepEqual(store.map((rule) => rule.id).sort(), [BEDTIME_FIRST_ID, BEDTIME_FIRST_ID + 1]);
});

test('bedtime: its page exists, is web accessible so the rules can send a page there, and loads nothing from the network', () => {
  assert.equal(BEDTIME_PAGE, '/bedtime.html');
  const accessible = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const file of ['bedtime.html', 'bedtime.js', 'blocked.css']) {
    assert.ok(existsSync(join(EXT, file)), `${file} exists`);
    assert.ok(accessible.includes(file), `${file} is listed in web_accessible_resources`);
  }
  const html = readFileSync(join(EXT, 'bedtime.html'), 'utf8');
  assert.equal(/(?:src|href)="(?:https?:)?\/\//.test(html), false, 'nothing from the network');
  assert.match(html, /<h1 id="heading">It’s bedtime<\/h1>/);
  // The library is one of the files a page of the add-on can load from the bedtime page.
  const script = readFileSync(join(EXT, 'bedtime.js'), 'utf8');
  assert.match(script, /from '\.\/lib\/bedtime\.js'/);
});

test('bedtime: the settings page has its section, with the reason asked from a menu as on the locked-away password’s page', () => {
  const html = readFileSync(join(EXT, 'options.html'), 'utf8');
  const section = html.match(/<section id="bedtime"[^]*?<\/section>/)?.[0] ?? '';
  assert.match(section, /<h2 id="bedtime-heading">Bedtime<\/h2>/);
  assert.match(section, /<input id="bedtime-on" type="checkbox">/);
  assert.match(section, /<input id="bedtime-from" type="time">/);
  assert.match(section, /<input id="bedtime-to" type="time">/);
  const choices = [...section.matchAll(/<option(?: value="([^"]*)")?>([^<]+)<\/option>/g)].map((m) => [m[1] ?? m[2], m[2]]);
  assert.deepEqual(choices[0], ['', 'Choose a reason'], 'no reason chosen to begin with');
  assert.deepEqual(choices.at(-1), ['other', 'Something else'], 'the last opens a box to type one');
  assert.ok(choices.length >= 4);
  assert.equal((section.match(/<button [^>]*type="submit"/g) ?? []).length, 1, 'one button: Save');
  assert.equal((section.match(/class="button/g) ?? []).length, 0, 'the rest are plain links');
  assert.match(section, /https:\/\/adviseworn\.github\.io\/family-site-blocker-updates\/#bedtime/, 'with a link to its part of the guide');
});

test('bedtime: its record shows on Every try and goes into the saved file, among the tries by time', () => {
  const nothing = { attempts: [], off: [], events: [], pictures: [] };
  assert.equal(everyTryShows({ ...nothing, bedtime: [] }), false);
  assert.equal(everyTryShows({ ...nothing, bedtime: [{ at: 1, event: 'set', ...NIGHT }] }), true, "an entry in the bedtime's record (1.30.0)");
  const start = new Date(2026, 9, 18, 15, 12, 3).getTime();
  const csv = toCsv(
    [{ at: start + 1000, site: 'a.test' }],
    undefined,
    [],
    [],
    [],
    [
      { at: start, event: 'set', ...NIGHT },
      { at: start + 2000, event: 'asked', on: false, from: 1260, to: 300, due: start + 2000 + WAIT_MS, why: 'Travelling, "for work"' },
      null,
      { at: start + 3000, event: 'nonsense' },
    ],
  ).split('\n');
  assert.deepEqual(csv.map((line) => line.replace(/^2026-10-18T15:12:\d\d[+-]\d\d:\d\d,/, 'T,')), [
    'when,site,result,address,nudity,suggestive,mark',
    `T,Bedtime,Set: ${hoursWords(NIGHT)}.,,,,`,
    'T,a.test,Blocked,,,,',
    'T,Bedtime,"Asked to turn it off after a day’s wait: “Travelling, ""for work""”.",,,,',
    '',
  ]);
  assert.equal(toCsv([], undefined, [], [], [], 'junk'), 'when,site,result,address,nudity,suggestive,mark\n');
});
