// What the locked-away password's page (lockbox.html) and the settings page share: where the box, the
// unlocking progress and the record of what has happened are kept, how long a wait reads, the one line
// that says where things stand, and the words for each entry in the record.
import { isBox, stepsOf, waitOf } from './timelock.js';

export const BOX = 'lockbox'; // the sealed box (lib/timelock.js)
// The unlocking under way: { n, x, done, before, inner, startedAt, workedAt }. n is the stored box's
// modulus, so the progress counts only for that box; x the number reached and done the squarings done in
// the layer being worked on; before the squarings done in the layers already opened (0 until the first
// is); inner the layer being worked on, once the stored box has been opened to a box inside it (absent
// while the stored box's own puzzle is the one; a box inside is as locked as the stored one, so keeping it
// here gives nothing away); startedAt when the work started and workedAt when it was last saved.
export const PROGRESS = 'lockboxProgress';
export const EVENTS = 'lockboxEvents'; // what has happened to the password, oldest first: [{ at, event, … }] (#75)
// When the record began, as an ISO time: its first entry's, kept as the oldest entries go (from 1.11.4; a
// record from before carries none until its next entry is written, and reads from its oldest entry meanwhile).
export const EVENTS_SINCE = 'lockboxEventsSince';

/** How many entries the record keeps; the oldest go when it is longer. */
export const EVENTS_KEPT = 500;

/**
 * The events the page records, and what each carries besides `at` (an ISO time) and `event`:
 * locked { delay }, lengthened { from, to }, started {}, resumed { done, steps }, stopped { done, steps },
 * shown { startedAt }, sealed { delay, previous? }, seal-failed {}, restored { lockedAt }, deleted {}. An
 * unlock is a `started` … `shown` pair; `sealed` or `seal-failed` follows `shown` straight away, and
 * `sealed` with `previous` is the password locked away again with a wait of the person's choosing (#76).
 */
export const EVENT_NAMES = ['locked', 'lengthened', 'started', 'resumed', 'stopped', 'shown', 'sealed', 'seal-failed', 'restored', 'deleted'];

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "45 seconds", "12 minutes", "3 hours 20 minutes", "2 days": a wait in words. */
export function duration(seconds) {
  seconds = Math.max(1, Math.round(seconds));
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return [plural(hours, 'hour'), minutes % 60 ? plural(minutes % 60, 'minute') : ''].filter(Boolean).join(' ');
  const days = Math.floor(hours / 24);
  return [plural(days, 'day'), hours % 24 ? plural(hours % 24, 'hour') : ''].filter(Boolean).join(' ');
}

/** "once", "twice", "3 times". */
export const times = (count) => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`);

const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** An entry of the record, as the page writes them. */
export const isEvent = (value) => typeof value === 'object' && value !== null && isTime(value.at) && typeof value.event === 'string';

/** When the record began, as an ISO time: the time kept since 1.11.4, else (a record from before) its oldest entry's, whichever is earlier; null with neither. */
export function recordBegan(events, since) {
  const known = [since, events[0]?.at].filter(isTime);
  return known.length ? known.reduce((earliest, time) => (Date.parse(time) < Date.parse(earliest) ? time : earliest)) : null;
}

const day = (time) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' });
const when = (time) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const percent = ({ done, steps }) => (steps > 0 ? Math.floor((Math.min(done, steps) / steps) * 100) : 0);

/**
 * The stored box, the progress made on it, the record and when it began: { box, progress, events, since },
 * the first two null when there is none, the record an array (empty when nothing has been recorded) and
 * `since` an ISO time (null with no record).
 */
export async function loadBox(store) {
  const { [BOX]: box, [PROGRESS]: progress, [EVENTS]: events, [EVENTS_SINCE]: since } = await store.get([BOX, PROGRESS, EVENTS, EVENTS_SINCE]);
  const record = Array.isArray(events) ? events.filter(isEvent) : [];
  const began = recordBegan(record, since);
  if (!isBox(box)) return { box: null, progress: null, events: record, since: began };
  // Progress only counts for the box it was made on, and the layer it names has to be a box.
  if (progress?.n !== box.n || (progress.inner !== undefined && !isBox(progress.inner))) return { box, progress: null, events: record, since: began };
  return { box, progress: { before: 0, ...progress }, events: record, since: began };
}

/** The layer being worked on, or to start on: a box inside the stored one that the work has reached, else the stored box. */
export const layerUnderWork = ({ box, progress }) => progress?.inner ?? box;

/** How far unlocking has got, as a fraction of all the squarings the stored box takes. */
export const fractionDone = ({ box, progress }) => (progress ? Math.min(1, ((progress.before ?? 0) + progress.done) / stepsOf(box)) : 0);

/** Adds an entry to the record, with the time, and returns it. The oldest entries go once the record is long; when it began stays. */
export async function recordEvent(store, event, details = {}) {
  const { [EVENTS]: events, [EVENTS_SINCE]: since } = await store.get([EVENTS, EVENTS_SINCE]);
  const record = Array.isArray(events) ? events.filter(isEvent) : [];
  const entry = { at: new Date().toISOString(), event, ...details };
  // The beginning is kept before the oldest entry can go: the time stored, else the oldest entry's, else this first entry's.
  await store.set({ [EVENTS]: [...record.slice(-(EVENTS_KEPT - 1)), entry], [EVENTS_SINCE]: recordBegan(record, since) ?? entry.at });
  return entry;
}

/**
 * The part of the record about the password now locked away: the entries since it was locked away or
 * restored. With no such entry (the record began after the password was locked away, in 1.9.0), the whole
 * record, and `whole` false to say the record may not cover the password's whole life.
 */
export function thisPassword(events) {
  let from = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'locked' || events[i].event === 'restored') {
      from = i;
      break;
    }
  }
  return { entries: from >= 0 ? events.slice(from) : events, whole: from >= 0 };
}

/** When the password now locked away was locked away or restored here, from the record, else when its box was sealed. */
export function sinceOf({ box, events = [] }) {
  const { entries, whole } = thisPassword(events);
  return whole ? entries[0].at : box.lockedAt;
}

/** "since Oct 11, 2026", with ", wait lengthened Oct 25, 2026" when the box says it was (#76). */
export const sinceText = ({ box, events = [] }) => `since ${day(sinceOf({ box, events }))}${box.lengthenedAt ? `, wait lengthened ${day(box.lengthenedAt)}` : ''}`;

/** ", unlocked once, last on Oct 24, 2026" or ", never unlocked": what the record says about the password now locked away; "" with no record. */
function unlocksOf(events) {
  const { entries, whole } = thisPassword(events);
  const shown = entries.filter(({ event }) => event === 'shown');
  if (shown.length) return `, unlocked ${times(shown.length)}, last on ${day(shown.at(-1).at)}`;
  return whole ? ', never unlocked' : '';
}

/** One line on where things stand, for the settings page. */
export function describeBox({ box, progress, events = [] }) {
  if (!box) {
    const last = events.at(-1);
    return last?.event === 'deleted' ? `No password is locked away; the last one was deleted on ${day(last.at)}.` : 'No password is locked away.';
  }
  const state = `A password is locked away (${sinceText({ box, events })})${unlocksOf(events)}`;
  if (progress) {
    const started = isTime(progress.startedAt) ? `, started ${day(progress.startedAt)}` : '';
    return `${state}; unlocking it is ${Math.floor(fractionDone({ box, progress }) * 100)}% done${started}.`;
  }
  return `${state}; getting it back takes about ${duration(waitOf(box))}.`;
}

/**
 * The line under the record's heading on the password's page: when the record began and, once its oldest
 * entries have gone (EVENTS_KEPT), how far back it still reaches. "" with no record.
 */
export function describeRecord({ events = [], since = null }) {
  const began = recordBegan(events, since);
  if (!began || events.length === 0) return '';
  const oldest = events[0].at;
  return Date.parse(oldest) > Date.parse(began)
    ? `The record began ${when(began)}, but it keeps only the latest ${EVENTS_KEPT} entries, so those before ${when(oldest)} have gone.`
    : `The record began ${when(began)}; everything done with the password on this page since then is in it.`;
}

/** What an entry of the record says happened, in words, for the record on the password's page. */
export function describeEvent(entry) {
  switch (entry.event) {
    case 'locked':
      return typeof entry.delay === 'number' ? `Locked away, with a wait of ${duration(entry.delay)}.` : 'Locked away.';
    case 'lengthened':
      return typeof entry.from === 'number' && typeof entry.to === 'number'
        ? `The wait was lengthened from ${duration(entry.from)} to ${duration(entry.to)}, without unlocking.`
        : 'The wait was lengthened, without unlocking.';
    case 'started':
      return 'Unlocking started.';
    case 'resumed':
      return `Unlocking carried on, from ${percent(entry)}% done.`;
    case 'stopped':
      return `Unlocking stopped at ${percent(entry)}% done; the work was thrown away.`;
    case 'shown':
      return isTime(entry.startedAt) ? `The password was shown (unlocking started ${when(entry.startedAt)}).` : 'The password was shown.';
    case 'sealed':
      if (typeof entry.delay === 'number' && typeof entry.previous === 'number') {
        return `Locked away again, with a wait of ${duration(entry.delay)} in place of ${duration(entry.previous)}.`;
      }
      return typeof entry.delay === 'number' ? `Locked away again, with the same wait of ${duration(entry.delay)}.` : 'Locked away again, with the same wait.';
    case 'seal-failed':
      return 'Couldn’t be locked away again with a fresh puzzle, so the old one was kept.';
    case 'restored':
      return isTime(entry.lockedAt) ? `Restored from a backup file, sealed ${when(entry.lockedAt)}.` : 'Restored from a backup file.';
    case 'deleted':
      return 'Deleted.';
    default:
      return `${entry.event}.`;
  }
}
