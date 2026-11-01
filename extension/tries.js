// Every try in the record of blocked attempts, grouped by day, newest first, on a page of its own: the
// record's one timeline. Laid in among the tries are the times the add-on was off (lib/watching.js), a
// band in its day with the visits to listed sites from then under it; the pictures and videos the picture
// filter kept hidden (lib/pictures.js), a row each with why, the judge's scores and the address to copy;
// and the locked-away password's record (lib/lockbox.js), a row each in the words of the password's page.
// The record page (attempts.html) shows the record summed up and links here, for the whole record, for one
// site (tries.html#site=<the site>, from the by-site table there) or for the times the add-on was off
// alone (tries.html#off, from "Was it ever off?" there); the pictures page links here for the pictures
// alone (tries.html#pictures, and #site=<the site>&pictures for one site's), and the password's page for
// its entries alone (tries.html#password). Like the other pages, this one only reads the records; nothing
// here can clear them (see lib/attempts.js).
import { ATTEMPTS, LABELS, offDuring, outcome, summarize, timeline, toCsv } from './lib/attempts.js';
import { EVENTS, EVENTS_SINCE, beginningOf, describeEvent, describeRecord, loadBox } from './lib/lockbox.js';
import { dayFormat, element, hiddenWords, offVisitsWords, offWords, plural, showVersion, timeFormat, tries as triesWord, whenFormat } from './lib/page.js';
import { PICTURES, borderline, countHidden, describeHidden, isVideo } from './lib/pictures.js';
import { WATCHING, normalize } from './lib/watching.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const PASSWORD = 'Locked-away password'; // what the password's rows say in the site column

let attempts = []; // the record as stored: oldest first
let pictures = []; // the pictures and videos hidden, as stored: oldest first
let watching = null; // when the extension was running (lib/watching.js): places the visits from the history, and holds the times it was off
let lockbox = { events: [], since: null }; // the locked-away password's record: its entries, oldest first, and when it began

/**
 * What the address asks for: one site (tries.html#site=example.com), or null for every site; only the
 * times the add-on was off (tries.html#off); only the pictures hidden (tries.html#pictures, with a site
 * or not); or only the locked-away password's record (tries.html#password).
 */
function asked() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { site: params.get('site') || null, onlyOff: params.has('off'), onlyPictures: params.has('pictures'), onlyPassword: params.has('password') };
}

/** The pictures hidden as entries for the timeline, newest first: { at, picture: the record's entry }. */
const pictureEntries = (list) => list.map((picture) => ({ at: picture.at, picture })).reverse();

/**
 * The password's record as entries for the timeline, newest first: { at, password: the entry } for each,
 * then { at, began } for the row that says when the record began, which the timeline keeps last among
 * entries at the same moment.
 */
function passwordEntries({ events, since }) {
  const entries = events.map((entry) => ({ at: Date.parse(entry.at), password: entry })).reverse();
  const beginning = beginningOf({ events, since });
  if (beginning) entries.push({ at: Date.parse(beginning.at), began: beginning });
  return entries;
}

function dayHeading(day, { tries, hidden, password }) {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const name = day === midnight ? 'Today' : day === midnight - 86_400_000 ? 'Yesterday' : null;
  const heading = element('h3', name ? `${name}, ` : '');
  const counts = [tries ? triesWord(tries) : '', hidden.length ? `${countHidden(hidden)} hidden` : '', password ? `${password} password ${password === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean);
  heading.append(element('span', dayFormat.format(day)), ' ', element('small', counts.join(', ') || 'no tries'));
  return heading;
}

/** The band for a time the add-on was off, in a day's table: times alone for that day, the day named at an end that falls in another. */
function bandWords(day, { off }) {
  const date = new Date(day).toDateString();
  const when = (ms) => (new Date(ms).toDateString() === date ? timeFormat : whenFormat).format(ms);
  const pages = off.pages ? `: ${plural(off.pages, 'page')} visited meanwhile` : '';
  return `Add-on off from ${when(off.from)} until ${when(off.to)}${pages}.`;
}

/** A hidden picture's or video's row: when, the site, and what the record says, with the address to copy under it. */
function pictureRow({ at, picture }) {
  const close = borderline(picture);
  const row = element('tr', null, { class: ['picture', isVideo(picture) ? 'video' : '', close ? 'borderline' : ''].filter(Boolean).join(' ') });
  const what = element('td', describeHidden(picture));
  if (close) what.append(element('small', 'borderline', { class: 'borderline-mark' }));
  // The address is the way to look at the picture: copied into a browser without the extension (pictures.html).
  const where = element('div', null, { class: 'picture-where' });
  const copy = element('button', 'Copy address', { type: 'button', class: 'secondary small' });
  copy.addEventListener('click', () => copyAddress(picture.url, copy));
  where.append(element('small', picture.url, { class: 'picture-url', title: picture.url }), copy);
  what.append(where);
  row.append(element('td', timeFormat.format(at)), element('td', picture.site), what);
  return row;
}

function renderDays(days) {
  const fragment = document.createDocumentFragment();
  for (const { day, entries } of days) {
    const section = element('section', null, { class: 'day' });
    const tries = entries.filter((entry) => entry.attempt).length;
    const hidden = entries.filter((entry) => entry.picture).map((entry) => entry.picture);
    const password = entries.filter((entry) => entry.password).length;
    section.append(dayHeading(day, { tries, hidden, password }));
    const table = element('table', null, { class: 'attempts' });
    if (entries.some((entry) => !entry.off)) {
      const head = element('thead');
      const headRow = element('tr');
      for (const title of ['Time', 'Site', 'Result']) headRow.append(element('th', title, { scope: 'col' }));
      head.append(headRow);
      table.append(head);
    }
    const body = element('tbody');
    for (const entry of entries) {
      if (entry.off) {
        const band = element('tr', null, { class: 'band' });
        band.append(element('td', bandWords(day, entry), { colspan: '3' }));
        body.append(band);
        continue;
      }
      if (entry.picture) {
        body.append(pictureRow(entry));
        continue;
      }
      if (entry.password || entry.began) {
        const row = element('tr', null, { class: entry.began ? 'password began' : 'password' });
        row.append(element('td', timeFormat.format(entry.at)), element('td', PASSWORD), element('td', entry.began ? entry.began.what : describeEvent(entry.password)));
        body.append(row);
        continue;
      }
      const what = outcome(entry.attempt, watching);
      const row = element('tr', null, { class: entry.during ? `${what} within` : what });
      row.append(element('td', timeFormat.format(entry.at)), element('td', entry.attempt.site), element('td', LABELS[what]));
      body.append(row);
    }
    table.append(body);
    section.append(table);
    fragment.append(section);
  }
  $('days').replaceChildren(fragment);
}

function renderSummary(shown, { site, onlyOff, onlyPictures, onlyPassword }, off, tracked, hidden) {
  const counts = summarize(shown, watching);
  const summary = $('summary');
  if (onlyPassword) {
    summary.textContent = describeRecord(lockbox) || 'Nothing has been done with the locked-away password on its page yet.';
    return;
  }
  if (onlyPictures) {
    summary.textContent = hiddenWords(hidden, site) || (site ? `No picture hidden on ${site}.` : 'No picture hidden so far.');
    return;
  }
  if (onlyOff) {
    const found = offVisitsWords(off, counts, tracked) || 'Nothing is known yet about when the extension was running.';
    summary.textContent = off.length ? `${offWords(off)} ${found}` : found;
    return;
  }
  if (site && shown.length === 0) {
    // A site with no tries: say so, and what was hidden there, if anything, which is shown below.
    summary.textContent = [attempts.length ? `No tries at ${site} in the record.` : 'No attempts so far.', hiddenWords(hidden, site)].filter(Boolean).join(' ');
    return;
  }
  const record =
    attempts.length === 0
      ? 'No attempts so far.'
      : `${triesWord(counts.tries)}${site ? '' : ` at ${plural(counts.sites, 'site')}`}, the latest at ${whenFormat.format(counts.latest)}.` +
        (counts.opened ? ` ${plural(counts.opened, 'page')} opened instead of being blocked.` : '') +
        (counts.history ? ` ${counts.history} from this browser's history${counts.off ? `, ${counts.off} of them from times the extension was off` : ''}.` : '');
  summary.textContent = [record, offWords(off)].filter(Boolean).join(' ');
}

// What this page shows of the times the add-on was off, so that the minute-by-minute notes of running don't redraw it.
let offShown = '';
const offPart = (state) => JSON.stringify(normalize(state).off);

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, PICTURES, WATCHING]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  pictures = Array.isArray(stored[PICTURES]) ? stored[PICTURES] : [];
  watching = stored[WATCHING] ?? null;
  offShown = offPart(watching);
  lockbox = await loadBox(api.storage.local);
  const { off, periods } = normalize(watching);
  const { site, onlyOff, onlyPictures, onlyPassword } = asked();
  let shown = site ? attempts.filter((attempt) => attempt.site === site) : attempts;
  if (onlyOff) shown = shown.filter((attempt) => offDuring(off, attempt.at));
  if (onlyPictures || onlyPassword) shown = [];
  // The pictures hidden go in among every try and among one site's tries, and are shown alone; the
  // password's entries go in among every try and are shown alone; the times off are shown with the tries alone.
  const hidden = onlyOff || onlyPassword ? [] : site ? pictures.filter((picture) => picture.site === site) : pictures;
  const password = onlyPassword || (!site && !onlyOff && !onlyPictures) ? passwordEntries(lockbox) : [];
  const only = [onlyOff ? 'the times the add-on was off' : '', onlyPictures ? 'the pictures hidden' : '', onlyPassword ? 'the locked-away password' : ''].filter(Boolean);
  $('filter').hidden = !site && only.length === 0;
  $('filter-site').textContent = [site, ...only].filter(Boolean).join(', ');
  $('filter-clear').textContent = site ? 'Show every site' : 'Show every try';
  document.title = `Family Site Blocker record: ${site ?? (onlyOff ? 'while the add-on was off' : onlyPictures ? 'the pictures hidden' : onlyPassword ? 'the locked-away password' : 'every try')}`;
  renderSummary(shown, { site, onlyOff, onlyPictures, onlyPassword }, off, periods.length > 0, hidden);
  $('off-intro').hidden = off.length === 0 || onlyPictures || onlyPassword;
  $('pictures-intro').hidden = hidden.length === 0;
  $('pictures-alone').hidden = onlyPictures;
  $('password-intro').hidden = password.length === 0 || onlyPassword;
  $('save-file').hidden = attempts.length === 0;
  // A site with neither tries nor pictures shows nothing, not even the times the add-on was off; every
  // other view lays those in, except the pictures' and the password's alone.
  const nothing = site && shown.length === 0 && hidden.length === 0;
  const days = nothing ? [] : timeline(shown, onlyPictures || onlyPassword ? null : watching, [...pictureEntries(hidden), ...password]);
  $('all').hidden = days.length === 0;
  renderDays(days);
}

async function copyAddress(url, button) {
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Copied';
    $('copy-status').textContent = 'Address copied. Paste it into a browser without the extension to see the picture.';
  } catch (error) {
    $('copy-status').textContent = `Couldn't copy: ${error.message}. The address is in the row; select it to copy it.`;
  }
  setTimeout(() => {
    button.textContent = 'Copy address';
  }, 2000);
}

function saveFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `family-site-blocker-record-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toCsv(attempts, watching)], { type: 'text/csv' }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  $('save-status').textContent = `Saved ${name} to your downloads: the whole record, oldest first.`;
}

$('save-file').addEventListener('click', saveFile);
window.addEventListener('hashchange', () => render().catch(() => {}));
// Keep the page current while it is open: the records, and the times the add-on was off. (The extension's
// running time is written every minute; a redraw for that would place a visit from the last minute no
// differently, so only a change in the times off counts.)
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ATTEMPTS] || changes[PICTURES] || changes[EVENTS] || changes[EVENTS_SINCE]) render();
  else if (changes[WATCHING] && offPart(changes[WATCHING].newValue) !== offShown) render();
});

showVersion(api);
render()
  // Then have the background script look at the silences since it last did, so the times off are current.
  .then(() => api.runtime.sendMessage({ type: 'check-gaps' }).catch(() => null))
  .then(() => render())
  .catch((error) => {
    $('summary').textContent = `Couldn't read the record: ${error.message}`;
  });
