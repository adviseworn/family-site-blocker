// Small helpers the record pages share (attempts.html, tries.html, pictures.html, unlisted.html).
import { lockChanges } from './lock.js';
import { borderline, countHidden, hiddenBySite, lookedAt, markedMistake, waitingList } from './pictures.js';

/** An element with text and attributes. */
export function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const tries = (n) => (n === 1 ? '1 try' : `${n} tries`);

/** The words on the link to Every try (tries.html), on the settings page and on the record page: with how many tries, when there are any. */
export const everyTryWords = (count) => (count ? `See every try (${count})` : 'See every try');

/**
 * Whether Every try (tries.html) has anything to show, so that the links to it show: a try, a time the
 * add-on was off (lib/watching.js's `off`), a picture hidden (lib/pictures.js), an entry in the
 * locked-away password's record (lib/lockbox.js), one in the Firefox lock's (lib/lock.js, 1.22.0) or a
 * picture that waited for a verdict (lib/pictures.js WAITING, 1.27.0).
 */
export const everyTryShows = ({ attempts, off, events, pictures = [], lock = [], waiting = [] }) => attempts.length > 0 || off.length > 0 || events.length > 0 || pictures.length > 0 || lock.length > 0 || waiting.length > 0;

export const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
export const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/**
 * How a day's rows on Every try give a time: the time alone for a moment on that day (`day`, its midnight),
 * "9:12 PM", and the day named for any other, "Oct 31, 2026, 9:12 PM" (the bands, and the looks at a hidden picture).
 */
export function timeOn(day) {
  const date = new Date(day).toDateString();
  return (ms) => (new Date(ms).toDateString() === date ? timeFormat : whenFormat).format(ms);
}

/** Shows the installed version next to the page's title. */
export function showVersion(api) {
  document.getElementById('version').textContent = `Version ${api.runtime.getManifest().version}`;
}

/** From one moment until another, "Oct 31, 2026, 9:12 PM until 11:40 PM", naming the day of the end only when it is another. */
export function spanWords(from, to) {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  return `${whenFormat.format(from)} until ${(sameDay ? timeFormat : whenFormat).format(to)}`;
}

export const visits = (n) => (n === 1 ? '1 visit to a listed site' : `${n} visits to listed sites`);

/**
 * How often the add-on was off (lib/watching.js's `off`), with the latest time and the pages visited
 * meanwhile: "Off once, from Oct 31, 2026, 9:12 PM until 11:40 PM: 24 pages visited meanwhile." or
 * "Off 3 times, the latest from …"; '' when no time off is known.
 */
export function offWords(off) {
  if (!off.length) return '';
  const latest = off.reduce((a, b) => (b.from > a.from ? b : a));
  const times = off.length === 1 ? 'once' : off.length === 2 ? 'twice' : `${off.length} times`;
  const pages = latest.pages ? `: ${plural(latest.pages, 'page')} visited meanwhile` : '';
  return `Off ${times}, ${off.length === 1 ? 'from' : 'the latest from'} ${spanWords(latest.from, latest.to)}${pages}.`;
}

/**
 * The visits to listed sites from the times the add-on was off, given the record counted up
 * (lib/attempts.js summarize): how many, with the latest; that none was found from those times; or, with
 * no time off known, that none was found while the add-on kept track of when it was running (`tracked`),
 * and '' before it did.
 */
export function offVisitsWords(off, counts, tracked) {
  if (counts.off) return `${visits(counts.off)} while the extension was off, the latest on ${whenFormat.format(counts.latestOff)}.`;
  if (off.length) return `No visit to a listed site found from ${off.length === 1 ? 'then' : 'those times'}.`;
  return tracked ? "No time found when this browser was in use while the extension wasn't running." : '';
}

/**
 * The pictures hidden summed up (lib/pictures.js), for the pictures page and Every try: "3 pictures and
 * 1 video hidden on 2 sites, the latest at …. 1 of them is borderline. 2 looked at, 1 marked hidden by
 * mistake."; for one site, "… hidden at a.test, the latest at …". The last sentence counts the pictures
 * looked at from Every try and those marked as the filter's mistakes (1.17.0), when there are any. '' with
 * none hidden.
 */
export function hiddenWords(record, site = null) {
  const list = Array.isArray(record) ? record : [];
  if (list.length === 0) return '';
  const close = list.filter(borderline).length;
  const where = site ? `at ${site}` : `on ${plural(hiddenBySite(list).length, 'site')}`;
  const looked = list.filter(lookedAt).length;
  const mistakes = list.filter(markedMistake).length;
  const checked = [looked ? `${looked} looked at` : '', mistakes ? `${mistakes} marked hidden by mistake` : ''].filter(Boolean).join(', ');
  return (
    `${countHidden(list)} hidden ${where}, the latest at ${whenFormat.format(Math.max(...list.map((entry) => entry.at)))}.` +
    (close ? ` ${close === 1 ? '1 of them is' : `${close} of them are`} borderline.` : '') +
    (checked ? ` ${checked}.` : '')
  );
}

/**
 * The Firefox lock's record (lib/lock.js) summed up, for Every try showing it alone: since when the lock
 * has been in force, or not, from the latest entry; when that is the first check of all, since at least
 * then, the add-on not knowing what came before; and when it checks. '' with no record.
 */
export function lockWords(changes) {
  const list = lockChanges(changes);
  if (!list.length) return '';
  const latest = list[list.length - 1];
  const state = latest.locked ? 'The Firefox lock has been in force' : 'The Firefox lock has not been in force';
  const since = latest.first ? `since at least ${whenFormat.format(latest.at)}, when the add-on first checked` : `since ${whenFormat.format(latest.at)}`;
  return `${state} ${since}. It checks whenever Firefox starts.`;
}

/**
 * The pictures that waited for a verdict (lib/pictures.js WAITING, 1.27.0) summed up, for Every try showing
 * them alone: "3 pictures waited long for a verdict, the latest at …: 2 were judged in the end, 1 wasn't."
 * '' with none.
 */
export function waitingWords(record) {
  const list = waitingList(record);
  if (!list.length) return '';
  const judged = list.filter((entry) => entry.judged).length;
  const rest = list.length - judged;
  const count = list.length === 1 ? '1 picture waited' : `${list.length} pictures waited`;
  const latest = whenFormat.format(Math.max(...list.map((entry) => entry.at)));
  let ending;
  if (rest === 0) ending = list.length === 1 ? 'it was judged in the end' : 'all were judged in the end';
  else if (judged === 0) ending = list.length === 1 ? 'it was never judged' : 'none was judged';
  else ending = `${judged} ${judged === 1 ? 'was' : 'were'} judged in the end, ${rest} ${rest === 1 ? "wasn't" : "weren't"}`;
  return `${count} long for a verdict, the latest at ${latest}: ${ending}.`;
}

const times = (count) => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`);

/**
 * What a hidden picture's row says of the looks at it from Every try (lib/pictures.js noteLook): "Looked at
 * 6:03 PM: “checking a close call”." With more looks, "Looked at 3 times, the latest at …", with the latest
 * reason. A time on the row's day (`day`, its midnight) is the time alone; any other names its day too,
 * "Nov 1, 2026, 6:03 PM" (every time, with no day given). A reason that ends in a full stop, or a question
 * mark, gets no second one. '' with no look. The mark (markHidden) isn't said: the button pressed in shows
 * it (until 1.21.0 a sentence said it too, with its time, as "Looked at once, at …" said the look).
 */
export function lookWords(entry, day = null) {
  const looks = Array.isArray(entry?.looks) ? entry.looks : [];
  if (!looks.length) return '';
  const when = day === null ? (ms) => whenFormat.format(ms) : timeOn(day);
  const latest = looks[looks.length - 1];
  const reason = typeof latest.why === 'string' ? latest.why : '';
  const why = reason ? `: “${reason}”` : '';
  return `Looked at ${looks.length === 1 ? '' : `${times(looks.length)}, the latest at `}${when(latest.at)}${why}${/[.!?]$/.test(reason) ? '' : '.'}`;
}
