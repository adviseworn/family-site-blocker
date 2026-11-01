// Every try in the record of blocked attempts, grouped by day, newest first, on a page of its own, with the
// times the add-on was off (lib/watching.js) laid in among them: a band in its day, with the visits to
// listed sites from then under it; and the locked-away password's record (lib/lockbox.js) too, each entry
// a row in its day, in the words of the password's page, so that what was done with the password can be
// read beside what happened in the browser. The record page (attempts.html) shows the record summed up
// and links here, for the whole record, for one site (tries.html#site=<the site>, from the by-site table
// there) or for the times the add-on was off alone (tries.html#off, from "Was it ever off?" there); the
// password's page links here for its entries alone (tries.html#password). Like the other pages, this one
// only reads the records; nothing here can clear them (see lib/attempts.js).
import { ATTEMPTS, LABELS, offDuring, outcome, summarize, timeline, toCsv } from './lib/attempts.js';
import { EVENTS, EVENTS_SINCE, beginningOf, describeEvent, describeRecord, loadBox } from './lib/lockbox.js';
import { dayFormat, element, offVisitsWords, offWords, plural, showVersion, timeFormat, tries as triesWord, whenFormat } from './lib/page.js';
import { WATCHING, normalize } from './lib/watching.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const PASSWORD = 'Locked-away password'; // what the password's rows say in the site column

let attempts = []; // the record as stored: oldest first
let watching = null; // when the extension was running (lib/watching.js): places the visits from the history, and holds the times it was off
let lockbox = { events: [], since: null }; // the locked-away password's record: its entries, oldest first, and when it began

/**
 * What the address asks for: one site (tries.html#site=example.com), or null for every site; only the
 * times the add-on was off (tries.html#off); or only the locked-away password's record (tries.html#password).
 */
function asked() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { site: params.get('site') || null, onlyOff: params.has('off'), onlyPassword: params.has('password') };
}

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

function dayHeading(day, { tries, password }) {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const name = day === midnight ? 'Today' : day === midnight - 86_400_000 ? 'Yesterday' : null;
  const heading = element('h3', name ? `${name}, ` : '');
  const counts = [tries ? triesWord(tries) : '', password ? `${password} password ${password === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean);
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

function renderDays(days) {
  const fragment = document.createDocumentFragment();
  for (const { day, entries } of days) {
    const section = element('section', null, { class: 'day' });
    const tries = entries.filter((entry) => entry.attempt).length;
    const password = entries.filter((entry) => entry.password).length;
    section.append(dayHeading(day, { tries, password }));
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

function renderSummary(shown, { site, onlyOff, onlyPassword }, off, tracked) {
  const counts = summarize(shown, watching);
  const summary = $('summary');
  if (onlyPassword) {
    summary.textContent = describeRecord(lockbox) || 'Nothing has been done with the locked-away password on its page yet.';
    return;
  }
  if (onlyOff) {
    const found = offVisitsWords(off, counts, tracked) || 'Nothing is known yet about when the extension was running.';
    summary.textContent = off.length ? `${offWords(off)} ${found}` : found;
    return;
  }
  if (attempts.length > 0 && site && shown.length === 0) {
    summary.textContent = `No tries at ${site} in the record.`;
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
  const stored = await api.storage.local.get([ATTEMPTS, WATCHING]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  watching = stored[WATCHING] ?? null;
  offShown = offPart(watching);
  lockbox = await loadBox(api.storage.local);
  const { off, periods } = normalize(watching);
  const { site, onlyOff, onlyPassword } = asked();
  let shown = site ? attempts.filter((attempt) => attempt.site === site) : attempts;
  if (onlyOff) shown = shown.filter((attempt) => offDuring(off, attempt.at));
  if (onlyPassword) shown = [];
  // The password's entries go in among every try, and are shown alone; one site's tries, or the times the add-on was off, are shown without them.
  const password = onlyPassword || (!site && !onlyOff) ? passwordEntries(lockbox) : [];
  $('filter').hidden = !site && !onlyOff && !onlyPassword;
  $('filter-site').textContent = [site, onlyOff ? 'the times the add-on was off' : '', onlyPassword ? 'the locked-away password' : ''].filter(Boolean).join(', ');
  $('filter-clear').textContent = site ? 'Show every site' : 'Show every try';
  document.title = site
    ? `Family Site Blocker record: ${site}`
    : onlyOff
      ? 'Family Site Blocker record: while the add-on was off'
      : onlyPassword
        ? 'Family Site Blocker record: the locked-away password'
        : 'Family Site Blocker record: every try';
  renderSummary(shown, { site, onlyOff, onlyPassword }, off, periods.length > 0);
  $('off-intro').hidden = off.length === 0 || onlyPassword;
  $('password-intro').hidden = password.length === 0 || onlyPassword;
  $('save-file').hidden = attempts.length === 0;
  // A site with no tries shows nothing, not even the times the add-on was off; every other view lays those in, except the password's alone.
  const days = site && shown.length === 0 ? [] : timeline(shown, onlyPassword ? null : watching, password);
  $('all').hidden = days.length === 0;
  renderDays(days);
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
// Keep the page current while it is open: the record, the password's record, and the times the add-on was
// off. (The extension's running time is written every minute; a redraw for that would place a visit from
// the last minute no differently, so only a change in the times off counts.)
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ATTEMPTS] || changes[EVENTS] || changes[EVENTS_SINCE]) render();
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
