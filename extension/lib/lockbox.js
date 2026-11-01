// What the locked-away password's page (lockbox.html) and the settings page share: where the box, the
// unlocking progress, the record of what has happened and the waits set for each password are kept, how
// long a wait reads, the one line that says where things stand, and the words for each entry in the record.
import { isBox, modulusOf, stepsOf, waitOf } from './timelock.js';

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
// The wait set here for each password locked away, and the boxes that have held it (from 1.13.0): [{ delay,
// boxes: [{ key, delay }] }], one entry per password, the one touched last at the end. A box joins the entry
// of the box it was made from (lengthening, or restoring a backup file that gets lengthened) or whose
// password it holds again (shown and locked away again), else starts one; `delay` is the wait last chosen
// for the password (locked away, lengthened, locked away again), and each box's `delay` its own wait as it
// was when stored. So a backup file of an earlier box, which can't be changed, restores here with the wait
// set since (longerWaitFor). Kept when the password is deleted, which is just when it matters. A box is
// known by `key` (boxKey), which gives nothing of it away.
export const WAITS = 'lockboxWaits';
/** How many boxes the waits remember in all; the oldest go, from the password longest untouched. */
export const WAITS_KEPT = 200;

/**
 * The events the page records, and what each carries besides `at` (an ISO time) and `event`:
 * locked { delay }, lengthened { from, to }, started {}, resumed { done, steps }, stopped { done, steps },
 * shown { startedAt }, sealed { delay, previous? }, seal-failed {}, restored { lockedAt, from?, to? }, deleted {}.
 * An unlock is a `started` … `shown` pair; `sealed` or `seal-failed` follows `shown` straight away, and
 * `sealed` with `previous` is the password locked away again with a wait of the person's choosing (#76).
 * `restored` with `from` and `to` is a backup file whose wait was lengthened to the one set here as it was
 * restored (1.13.0).
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

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * What a box is known by in the waits: a hash of its modulus, written the one way (a backup file's `n` padded
 * with noughts is still the same box). The modulus can't be changed without breaking the puzzle, and the hash
 * says nothing of the box, so the waits hold no piece of any box.
 */
export const boxKey = async (box) => hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(modulusOf(box).toString(16)))));
/** A box's own wait in whole seconds, as chosen when it was made; 0 when the box doesn't say. */
const delayOf = (box) => (Number.isFinite(box.delay) && box.delay > 0 ? box.delay : 0);
const isKnownBox = (value) => typeof value?.key === 'string' && /^[0-9a-f]{64}$/.test(value.key) && Number.isFinite(value.delay) && value.delay >= 0;
const isPassword = (value) => Number.isFinite(value?.delay) && value.delay >= 0 && Array.isArray(value.boxes) && value.boxes.length > 0 && value.boxes.every(isKnownBox);
const holds = (password, key) => password.boxes.some((known) => known.key === key);

/** The waits set here, dropping anything in storage that isn't an entry. */
async function loadWaits(store) {
  const { [WAITS]: waits } = await store.get(WAITS);
  return Array.isArray(waits) ? waits.filter(isPassword) : [];
}

/**
 * Notes that `box` is stored here: as a box of the password that `previous` held (the box it was made from
 * by lengthening, or whose password was shown and locked away again in it), else of a password of its own.
 * `delay` is the wait chosen for the password, when one was (locking away, lengthening, locking away again);
 * without it, the password keeps the wait set. A box stored before this was kept (1.13.0) is taken as it is.
 */
export async function noteBox(store, box, { previous = null, delay = null } = {}) {
  const waits = await loadWaits(store);
  const key = await boxKey(box);
  const previousKey = previous ? await boxKey(previous) : null;
  let password = waits.find((candidate) => holds(candidate, key)) ?? (previous ? waits.find((candidate) => holds(candidate, previousKey)) : undefined);
  if (password) waits.splice(waits.indexOf(password), 1);
  else if (previous) password = { delay: delayOf(previous), boxes: [{ key: previousKey, delay: delayOf(previous) }] };
  else password = { delay: delayOf(box), boxes: [] };
  if (!holds(password, key)) password.boxes.push({ key, delay: delayOf(box) });
  if (Number.isFinite(delay)) password.delay = delay;
  waits.push(password);
  let count = waits.reduce((sum, { boxes }) => sum + boxes.length, 0);
  while (count > WAITS_KEPT) {
    waits[0].boxes.shift();
    count -= 1;
    if (waits[0].boxes.length === 0) waits.shift();
  }
  await store.set({ [WAITS]: waits });
}

/**
 * The wait set here for the password that a box from a backup file holds, when the box was stored here and
 * the wait set since is longer than its own: { delay, from } in seconds, `from` the box's wait as noted when
 * it was stored (not as the file says it, which anyone can change); null for a box never stored here, or one
 * whose wait is the one set.
 */
export async function longerWaitFor(store, box) {
  const key = await boxKey(box);
  for (const password of await loadWaits(store)) {
    const known = password.boxes.find((candidate) => candidate.key === key);
    if (known) return password.delay > known.delay ? { delay: password.delay, from: known.delay } : null;
  }
  return null;
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
 * The last row of the record's table on the password's page, below its oldest entry: when the record began
 * and, once its oldest entries have gone (EVENTS_KEPT), how far back it still reaches: { at, what }, null
 * with no record.
 */
export function beginningOf({ events = [], since = null }) {
  const began = recordBegan(events, since);
  if (!began || events.length === 0) return null;
  const oldest = events[0].at;
  const gone = Date.parse(oldest) > Date.parse(began);
  return { at: began, what: gone ? `The record began. It keeps only the latest ${EVENTS_KEPT} entries, so those before ${when(oldest)} have gone.` : 'The record began.' };
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
    case 'restored': {
      const sealed = isTime(entry.lockedAt) ? `, sealed ${when(entry.lockedAt)}` : '';
      if (typeof entry.from === 'number' && typeof entry.to === 'number') {
        return `Restored from a backup file${sealed}, with the wait lengthened from ${duration(entry.from)} to the ${duration(entry.to)} set here after the file was saved.`;
      }
      return `Restored from a backup file${sealed}.`;
    }
    case 'deleted':
      return 'Deleted.';
    default:
      return `${entry.event}.`;
  }
}
