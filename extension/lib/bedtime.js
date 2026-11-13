// Bedtime (1.30.0): every site blocked between two times of day, every day, so that the browser is no use
// once it is time to sleep. The setting is kept in the extension's storage under BEDTIME:
//
//   { on, from, to, next?: { on, from, to, asked, at, why }, undo?: { before, until } }
//
// `from` and `to` are minutes after midnight on the computer's own clock, so 9:00 PM to 5:00 AM is
// { from: 1260, to: 300 }: a bedtime that starts later in the day than it ends runs over midnight. `on`
// says whether there is a bedtime at all; the times are kept when it is off, so the page can offer them again.
//
// Anyone at the keyboard can set it, as with the rest of the settings: there is no password. What guards
// it is a wait and the record, as with the locked-away password. A change that blocks at least everything
// the bedtime in force blocks (turning it on, an earlier start, a later end) holds at once. Any other
// change (turning it off, a later start, an earlier end, other hours altogether) is only asked for, with a
// reason: it waits in `next` and takes the bedtime's place WAIT_MS later, at `at`, so that nothing decided
// at night changes that night. Until then the bedtime in force holds just as it is, and the change asked
// for does nothing yet, so taking it back (keep) or asking for another in its place never opens a site
// that was blocked. For UNDO_MS after a change that held at once, it can be undone (`undo` holds the
// setting as it was before): a slip, such as PM for AM, would otherwise block every site for a day. Until
// then any bedtime that blocks at least what that earlier one did holds at once too, so the slip can as
// well be put right in the form; going back to exactly the earlier one is the undo.
//
// Everything done to it goes into a record under BEDTIME_EVENTS, a row each on Every try and in the saved
// file. The background script is the one that writes both (background.js, in turn with its other writes),
// puts the rules that do the blocking in place when a bedtime begins and takes them off when it ends
// (lib/rules.js bedtimeRules), and sends the tabs open to the bedtime page (bedtime.html), which carries the
// address it stands in for, so that the page comes back when the bedtime is over.
//
// The times are the computer's clock's: someone who can change the clock or the time zone can move the
// bedtime. On a Mac that takes an administrator's password, which can be the one locked away.
//
// Pure functions, shared by background.js, the settings page, the bedtime page and Every try, and tested
// in test/bedtime.test.mjs.

export const BEDTIME = 'bedtime';
export const BEDTIME_EVENTS = 'bedtimeEvents';
/** How long a change that lets more through waits before it takes the bedtime's place: a day. */
export const WAIT_MS = 24 * 60 * 60 * 1000;
/** How long a change that held at once can be undone. */
export const UNDO_MS = 10 * 60 * 1000;
/** How long before a bedtime begins the pages open are told. */
export const WARN_MS = 10 * 60 * 1000;
/** How many entries the record keeps; the oldest go when it is longer. */
export const MAX_EVENTS = 1000;
/** How long a reason can be. */
export const WHY_LENGTH = 200;
/** What the bedtime's rows say in the site column, on Every try and in the saved file. */
export const BEDTIME_NAME = 'Bedtime';
/** The times offered before any are set: 9:00 PM to 5:00 AM. */
export const DEFAULT_TIMES = { from: 21 * 60, to: 5 * 60 };

const DAY_MINUTES = 24 * 60;

const isMinutes = (value) => Number.isInteger(value) && value >= 0 && value < DAY_MINUTES;
/** Whether a value carries two times of day, minutes after midnight, that aren't the same. */
export const isTimes = (value) => value != null && typeof value === 'object' && isMinutes(value.from) && isMinutes(value.to) && value.from !== value.to;

/** The bedtime alone, without what waits or can be undone: { on, from, to }. */
const plain = ({ on, from, to }) => ({ on, from, to });

/**
 * A well-formed setting from whatever is stored: { on, from, to }, with `next` and `undo` when they are
 * well-formed too. Anything else is left out, and with no times stored the bedtime is off at the times
 * offered first.
 */
export function settingOf(stored) {
  if (!isTimes(stored)) return { on: false, ...DEFAULT_TIMES };
  const setting = { on: stored.on === true, from: stored.from, to: stored.to };
  const { next, undo } = stored;
  if (isTimes(next) && typeof next.on === 'boolean' && Number.isFinite(next.asked) && Number.isFinite(next.at)) {
    setting.next = { ...plain(next), asked: next.asked, at: next.at, why: typeof next.why === 'string' ? next.why : '' };
  }
  if (undo != null && typeof undo === 'object' && Number.isFinite(undo.until) && isTimes(undo.before)) {
    // What it was before keeps a change that waited then, but nothing to undo in its turn.
    const { undo: _, ...before } = settingOf(undo.before);
    setting.undo = { before, until: undo.until };
  }
  return setting;
}

/** "21:00" from 1260: a time as a time field holds it. */
export const timeValue = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** 1260 from "21:00", a time field's value (seconds, if any, are left off); null when it isn't a time. */
export function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && isMinutes(minutes) ? minutes : null;
}

/** The minutes after midnight at a moment, on the computer's clock. */
export function minutesAt(ms) {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether a time of day falls within a bedtime's hours, which run over midnight when they start later than they end. */
export function within({ from, to }, minutes) {
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** How long a bedtime's hours are, in minutes. */
export const lengthOf = ({ from, to }) => (to - from + DAY_MINUTES) % DAY_MINUTES;

/** Whether bedtime `a` blocks every minute bedtime `b` does. One that is off blocks nothing. */
export function covers(a, b) {
  if (!b.on) return true;
  if (!a.on) return false;
  const later = (b.from - a.from + DAY_MINUTES) % DAY_MINUTES; // how long after a's start b's comes
  return later + lengthOf(b) <= lengthOf(a);
}

/** Whether changing a setting's bedtime to `wanted` would let through anything it blocks, and so has to wait. */
export const loosens = (setting, wanted) => !covers(wanted, setting);

/** Whether two bedtimes are the same: both off, whatever times are kept with them, or both on at the same times. */
const same = (a, b) => a.on === b.on && (!a.on || (a.from === b.from && a.to === b.to));

/**
 * The setting as it stands at `now`: a change that has waited out its time takes the bedtime's place, and
 * an undo that has run out goes. Returns { setting, events, changed }: `events` the record's entries for
 * what happened, dated when it did (the change took effect at its own time, whenever that is noticed).
 */
export function settle(stored, now) {
  let setting = settingOf(stored);
  const events = [];
  let changed = false;
  if (setting.next && now >= setting.next.at) {
    const { next } = setting;
    events.push({ at: next.at, event: 'changed', ...plain(next) });
    setting = plain(next);
    changed = true;
  }
  if (setting.undo && now >= setting.undo.until) {
    const { undo: _, ...rest } = setting;
    setting = rest;
    changed = true;
  }
  return { setting, events, changed };
}

/** Whether every site is blocked at `now`: the bedtime is on and the clock is within its hours. A change that waits doesn't count yet. */
export function blockedAt(setting, now) {
  return setting.on === true && within(setting, minutesAt(now));
}

/** The next moment after `now` when the computer's clock reads `minutes` after midnight. */
export function nextAt(minutes, now) {
  const date = new Date(now);
  const on = (day) => new Date(date.getFullYear(), date.getMonth(), day, Math.floor(minutes / 60), minutes % 60).getTime();
  const today = on(date.getDate());
  return today > now ? today : on(date.getDate() + 1);
}

/**
 * When the blocking in force at `now` ends, or null when nothing is blocked then: at the end of the
 * bedtime's hours, unless a change that waits takes its place first, which can end it early or, when its
 * own hours hold at that moment, run it on to their end.
 */
export function endOf(stored, now) {
  let { setting } = settle(stored, now);
  if (!blockedAt(setting, now)) return null;
  let at = now;
  // The bedtime in force, then the one that takes its place: two steps at most.
  for (let step = 0; step < 3; step += 1) {
    const end = nextAt(setting.to, at);
    at = setting.next && setting.next.at < end ? setting.next.at : end;
    ({ setting } = settle(setting, at));
    if (!blockedAt(setting, at)) break;
  }
  return at;
}

/**
 * The next moment after `now` when the background script has something to do, for its alarm: the bedtime's
 * start, the warning before it, or its end; a change that waits taking effect; or an undo running out.
 * Null when the bedtime is off and nothing waits.
 */
export function nextChange(setting, now) {
  const moments = [];
  if (setting.on) moments.push(nextAt(setting.from, now), nextAt(setting.from, now + WARN_MS) - WARN_MS, nextAt(setting.to, now));
  if (setting.next) moments.push(setting.next.at);
  if (setting.undo) moments.push(setting.undo.until);
  const later = moments.filter((moment) => moment > now);
  return later.length ? Math.min(...later) : null;
}

/** A reason as the record keeps it: trimmed, and no longer than WHY_LENGTH. */
export const reasonOf = (why) => String(why ?? '').trim().slice(0, WHY_LENGTH);

/**
 * Changes the bedtime to `wanted`, { on, from, to }, at `now`. Returns { setting, event } for the setting to
 * store and the record's entry; { unchanged: true } when that is the bedtime already, with `waiting`, the
 * moment it takes effect, when it is the change that waits already; or { error } in words for the page. A
 * change that blocks at least what the bedtime in force blocks holds at once (a `set` entry), can be
 * undone for UNDO_MS, and drops any change that waited (`dropped` on the entry). While a change can still
 * be undone, what counts is the bedtime from before it: one that blocks at least as much holds at once,
 * within the same few minutes, and that very bedtime again is the undo. Any other change waits WAIT_MS,
 * needs `why`, and takes the place of any change that waited already (an `asked` entry).
 */
export function ask(stored, wanted, { now, why = '' }) {
  const { setting } = settle(stored, now);
  if (typeof wanted?.on !== 'boolean') return { error: 'Say whether bedtime is on or off.' };
  if (wanted.on && !isTimes(wanted)) return { error: isMinutes(wanted.from) && wanted.from === wanted.to ? 'The two times are the same. Choose a start and an end.' : 'Choose a start and an end.' };
  // Turned off, the times stay as they were unless new ones came with it.
  const to = { on: wanted.on, ...(isTimes(wanted) ? { from: wanted.from, to: wanted.to } : { from: setting.from, to: setting.to }) };
  const current = plain(setting);
  // The bedtime as it is: nothing to do, unless a change waits, which asking for the bedtime as it is takes back.
  if (same(current, to)) return setting.next ? keep(setting, { now }) : { unchanged: true };
  if (setting.undo && same(plain(setting.undo.before), to)) return undo(setting, { now });
  if (!loosens(setting.undo ? plain(setting.undo.before) : current, to)) {
    const { undo: _, ...before } = setting;
    return { setting: { ...to, undo: setting.undo ?? { before, until: now + UNDO_MS } }, event: { at: now, event: 'set', ...to, ...(setting.next ? { dropped: true } : {}) } };
  }
  if (setting.next && same(setting.next, to)) return { unchanged: true, waiting: setting.next.at };
  const reason = reasonOf(why);
  if (!reason) return { error: 'Say why first. Your answer goes into the record.' };
  const next = { ...to, asked: now, at: now + WAIT_MS, why: reason };
  return { setting: { ...setting, next }, event: { at: now, event: 'asked', ...to, due: next.at, why: reason } };
}

/** Takes back a change that waits, so the bedtime stays as it is: { setting, event }, or { error } when none waits. */
export function keep(stored, { now }) {
  const { setting } = settle(stored, now);
  if (!setting.next) return { error: 'No change is waiting.' };
  const { next: _, ...rest } = setting;
  return { setting: rest, event: { at: now, event: 'kept' } };
}

/** Undoes the last change that held at once, while it still can be: { setting, event }, or { error }. */
export function undo(stored, { now }) {
  const { setting } = settle(stored, now);
  if (!setting.undo) return { error: 'There is nothing to undo any more.' };
  const { before } = setting.undo;
  return { setting: before, event: { at: now, event: 'undone', ...plain(before) } };
}

const EVENTS = ['set', 'asked', 'changed', 'kept', 'undone'];

/** The record as stored, well-formed: [{ at, event, … }], oldest first, with anything else left out. */
export function bedtimeEvents(stored) {
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry) => entry && Number.isFinite(entry.at) && EVENTS.includes(entry.event) && (entry.event === 'kept' || (typeof entry.on === 'boolean' && isTimes(entry))));
}

/** The record with entries added, oldest first: the oldest go once it is longer than MAX_EVENTS. */
export function recordBedtime(stored, entries) {
  const kept = [...bedtimeEvents(stored), ...bedtimeEvents(entries)].sort((a, b) => a.at - b.at);
  return kept.length > MAX_EVENTS ? kept.slice(kept.length - MAX_EVENTS) : kept;
}

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "9:00 PM", a time of day in the reader's own way of writing times. */
export const timeWords = (minutes) => clock.format(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));

/** "9:00 PM to 5:00 AM". */
export const hoursWords = ({ from, to }) => `${timeWords(from)} to ${timeWords(to)}`;

/** ": “Travelling”", the reason given, or "" without one. */
const whyOf = (entry) => (typeof entry.why === 'string' && entry.why ? `: “${entry.why}”` : '');

/**
 * What an entry of the record says happened, in words, for its row on Every try and in the saved file:
 * "Set: 9:00 PM to 5:00 AM."; "Asked to turn it off after a day’s wait: “Travelling”."; "Turned off, as
 * asked a day before."; "The change asked for was taken back."; "Change undone: back to 9:00 PM to 5:00 AM."
 */
export function eventWords(entry) {
  switch (entry.event) {
    case 'set':
      return `Set: ${hoursWords(entry)}.${entry.dropped ? ' The change asked for before it was dropped.' : ''}`;
    case 'asked': {
      const wait = Number.isFinite(entry.due) && entry.due - entry.at !== WAIT_MS ? ` from ${when(entry.due)}` : ' after a day’s wait';
      return `${entry.on ? `Asked to change it to ${hoursWords(entry)}` : 'Asked to turn it off'}${wait}${whyOf(entry)}.`;
    }
    case 'changed':
      return entry.on ? `Changed to ${hoursWords(entry)}, as asked a day before.` : 'Turned off, as asked a day before.';
    case 'kept':
      return 'The change asked for was taken back.';
    case 'undone':
      return entry.on ? `Change undone: back to ${hoursWords(entry)}.` : 'Change undone: off again.';
    default:
      return `${entry.event}.`;
  }
}

/** Whether an entry of the record lets more through, or asks to: marked on Every try as the locked-away password's rows are. */
export const isLooser = (entry) => entry.event === 'asked' || entry.event === 'changed';

/**
 * Where the bedtime stands at `now`, in a few short sentences for the settings page: that it is bedtime
 * now and until when; whether there is a bedtime and its hours; and what a change that waits will make of
 * it, and when. It also heads the bedtime's record on Every try, shown alone.
 */
export function describeBedtime(stored, now) {
  const { setting } = settle(stored, now);
  const end = endOf(setting, now);
  const parts = [];
  if (end !== null) parts.push(`It’s bedtime until ${clock.format(end)}.`);
  parts.push(setting.on ? `Every site is blocked from ${hoursWords(setting)}, every day.` : 'Bedtime is off.');
  if (setting.next) parts.push(`On ${when(setting.next.at)} it ${setting.next.on ? `changes to ${hoursWords(setting.next)}` : 'turns off'}.`);
  return parts.join(' ');
}

/** The bedtime page's address for a page it stands in for: the page's own after the #, as it is. */
export const pageFor = (bedtimePage, url) => `${bedtimePage}#${url}`;

/**
 * The address a bedtime page stands in for, from its own address's # part: a web page's (http or https),
 * or null. Nothing else is ever opened from it.
 */
export function addressFrom(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The moment every site closes, when that is within WARN_MS of `now` and nothing is blocked yet: what the
 * pages open are warned of. It is the bedtime's start, unless a change that waits will have turned it off
 * or moved it by then; or the moment such a change takes effect in the middle of its own hours. Null otherwise.
 */
export function beginsSoon(stored, now) {
  const { setting } = settle(stored, now);
  if (blockedAt(setting, now)) return null;
  const starts = [];
  if (setting.on) starts.push(nextAt(setting.from, now));
  if (setting.next) starts.push(setting.next.at);
  const soon = starts.filter((start) => start - now <= WARN_MS && blockedAt(settle(setting, start).setting, start));
  return soon.length ? Math.min(...soon) : null;
}
