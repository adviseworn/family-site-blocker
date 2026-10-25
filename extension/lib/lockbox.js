// What the locked-away password's page (lockbox.html) and the settings page share: where the box, the
// unlocking progress and the record of what has happened are kept, how long a wait reads, the one line
// that says where things stand, and the words for each entry in the record.
import { isBox } from './timelock.js';

export const BOX = 'lockbox'; // the sealed box (lib/timelock.js)
export const PROGRESS = 'lockboxProgress'; // { n, x, done, startedAt, workedAt }: the box being worked on, the number reached so far, steps done, when the work started and was last saved
export const EVENTS = 'lockboxEvents'; // what has happened to the password, oldest first: [{ at, event, … }] (#75)

/** How many entries the record keeps; the oldest go when it is longer. */
export const EVENTS_KEPT = 500;

/**
 * The events the page records, and what each carries besides `at` (an ISO time) and `event`:
 * locked { delay }, started {}, resumed { done, steps }, stopped { done, steps }, shown { startedAt },
 * sealed { delay }, seal-failed {}, restored { lockedAt }, deleted {}. An unlock is a `started` … `shown`
 * pair; `sealed` or `seal-failed` follows `shown` straight away.
 */
export const EVENT_NAMES = ['locked', 'started', 'resumed', 'stopped', 'shown', 'sealed', 'seal-failed', 'restored', 'deleted'];

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

const day = (time) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' });
const when = (time) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const percent = ({ done, steps }) => (steps > 0 ? Math.floor((Math.min(done, steps) / steps) * 100) : 0);

/**
 * The stored box, the progress made on it and the record: { box, progress, events }, the first two null
 * when there is none, the record an array (empty when nothing has been recorded).
 */
export async function loadBox(store) {
  const { [BOX]: box, [PROGRESS]: progress, [EVENTS]: events } = await store.get([BOX, PROGRESS, EVENTS]);
  const record = Array.isArray(events) ? events.filter(isEvent) : [];
  if (!isBox(box)) return { box: null, progress: null, events: record };
  // Progress only counts for the box it was made on.
  return { box, progress: progress?.n === box.n ? progress : null, events: record };
}

/** Adds an entry to the record, with the time, and returns it. The oldest entries go once the record is long. */
export async function recordEvent(store, event, details = {}) {
  const { [EVENTS]: events } = await store.get(EVENTS);
  const kept = (Array.isArray(events) ? events.filter(isEvent) : []).slice(-(EVENTS_KEPT - 1));
  const entry = { at: new Date().toISOString(), event, ...details };
  await store.set({ [EVENTS]: [...kept, entry] });
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
  const state = `A password is locked away (since ${day(sinceOf({ box, events }))})${unlocksOf(events)}`;
  if (progress) {
    const started = isTime(progress.startedAt) ? `, started ${day(progress.startedAt)}` : '';
    return `${state}; unlocking it is ${percent({ done: progress.done, steps: box.steps })}% done${started}.`;
  }
  return `${state}; getting it back takes about ${duration(box.steps / box.rate)}.`;
}

/** What an entry of the record says happened, in words, for the record on the password's page. */
export function describeEvent(entry) {
  switch (entry.event) {
    case 'locked':
      return typeof entry.delay === 'number' ? `Locked away, with a wait of ${duration(entry.delay)}.` : 'Locked away.';
    case 'started':
      return 'Unlocking started.';
    case 'resumed':
      return `Unlocking carried on, from ${percent(entry)}% done.`;
    case 'stopped':
      return `Unlocking stopped at ${percent(entry)}% done; the work was thrown away.`;
    case 'shown':
      return isTime(entry.startedAt) ? `The password was shown (unlocking started ${when(entry.startedAt)}).` : 'The password was shown.';
    case 'sealed':
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
