// Small helpers the record pages share (attempts.html, tries.html, pictures.html, unlisted.html).
import { borderline, countHidden, hiddenBySite } from './pictures.js';

/** An element with text and attributes. */
export function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const tries = (n) => (n === 1 ? '1 try' : `${n} tries`);

export const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
export const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

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
 * 1 video hidden on 2 sites, the latest at …. 1 of them is borderline."; for one site, "… hidden at
 * a.test, the latest at …". '' with none hidden.
 */
export function hiddenWords(record, site = null) {
  const list = Array.isArray(record) ? record : [];
  if (list.length === 0) return '';
  const close = list.filter(borderline).length;
  const where = site ? `at ${site}` : `on ${plural(hiddenBySite(list).length, 'site')}`;
  return (
    `${countHidden(list)} hidden ${where}, the latest at ${whenFormat.format(Math.max(...list.map((entry) => entry.at)))}.` +
    (close ? ` ${close === 1 ? '1 of them is' : `${close} of them are`} borderline.` : '')
  );
}
