// The record on a page of its own: the settings page shows only the latest few blocked attempts and links
// here, and straight to every try. This page says whether the extension was ever off (lib/watching.js),
// with a link to the times it was off on tries.html, sums the record of tries up by site, with a link for
// each site to every one of its tries on tries.html (which also lists every try of all, grouped by day,
// with the times the extension was off and the locked-away password's record laid in), and has a button
// that saves the whole record as a CSV file. The other two parts of the record, the pictures hidden and
// the sites that might belong on the list, have pages of their own (pictures.html, unlisted.html), summed
// up here in a line each. The look through the browser's history (background.js scanHistory) is reported
// and started from here. Like the settings page, this page only reads the record; nothing here can clear
// it (see lib/attempts.js).
import { ATTEMPTS, HISTORY_SCAN, bySite, summarize, toCsv } from './lib/attempts.js';
import { EVENTS, loadBox } from './lib/lockbox.js';
import { element, everyTryShows, everyTryWords, offVisitsWords, offWords, plural, showVersion, visits, whenFormat } from './lib/page.js';
import { PICTURES, countHidden, hiddenBySite } from './lib/pictures.js';
import { UNLISTED } from './lib/suspects.js';
import { WATCHING, normalize } from './lib/watching.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let attempts = []; // the record as stored: oldest first
let watching = null; // when the extension was running, as stored (lib/watching.js)
let events = []; // the locked-away password's record (lib/lockbox.js), which Every try shows among the tries

function renderSummary() {
  if (attempts.length === 0) {
    $('summary').textContent = 'No attempts so far.';
    return;
  }
  const counts = summarize(attempts, watching);
  $('summary').textContent =
    `${plural(counts.tries, 'attempt')} at ${plural(counts.sites, 'site')}, the latest at ${whenFormat.format(counts.latest)}.` +
    (counts.opened ? ` ${plural(counts.opened, 'page')} opened instead of being blocked.` : '') +
    (counts.history ? ` ${counts.history} from this browser's history${counts.off ? `, ${counts.off} of them from times the extension was off` : ''}.` : '');
}

// --- Was it ever off? ------------------------------------------------------------------------------------
// When the extension first started watching here, how often the browser was in use while it wasn't
// running, with the latest time, and the visits to listed sites found in the history from times it wasn't
// running (lib/watching.js); the times themselves are laid among every try on tries.html, linked here.
const version = api.runtime.getManifest().version;

function renderWatching() {
  const state = watching ? normalize(watching) : null;
  const since = $('since');
  if (!state || state.since === undefined) {
    since.textContent = `Version ${version} is the first to keep track of when the extension is running; nothing is known yet about earlier.`;
  } else if (state.atLeast) {
    const kept = state.periods[0]?.from;
    since.textContent =
      `Watching since at least ${whenFormat.format(state.since)}, the first try an earlier version noted as it happened` +
      (kept ? `; keeping track of when it is running since ${whenFormat.format(kept)}, when version 1.11.0 or later arrived.` : '.');
  } else {
    since.textContent = `Watching since ${whenFormat.format(state.since)}, when the extension was installed in this browser.`;
  }

  const counts = summarize(attempts, watching);
  const off = state?.off ?? [];
  const summary = $('off-summary');
  summary.replaceChildren();
  const say = (text) => summary.append(summary.childNodes.length ? ` ${text}` : text);
  const words = [offWords(off), offVisitsWords(off, counts, (state?.periods.length ?? 0) > 0)].filter(Boolean);
  if (words.length) say(words.join(' '));
  if (off.length) summary.append(' ', element('a', `See ${off.length === 1 ? 'it' : 'them'} among every try`, { href: 'tries.html#off' }), '.');
  if (counts.unseen) {
    say(
      `${visits(counts.unseen)} from after the extension was installed but before it kept track of when it was running, the latest on ${whenFormat.format(counts.latestUnseen)}: it was off then, or the site wasn't on a list yet.`,
    );
  }
  if (counts.unlisted) say(`${visits(counts.unlisted)} from before the site was listed, while the extension was running.`);
}

function renderSites() {
  const rows = $('sites-table').querySelector('tbody');
  rows.replaceChildren();
  for (const site of bySite(attempts, watching)) {
    const row = element('tr', null, { 'data-site': site.site });
    const name = element('td');
    name.append(element('a', site.site, { href: `tries.html#site=${encodeURIComponent(site.site)}` }));
    row.append(name);
    const tries = element('td', String(site.tries));
    if (site.opened) tries.append(element('small', `${site.opened} opened`, { class: 'opened' }));
    if (site.off) tries.append(element('small', `${site.off} while off`, { class: 'off' }));
    row.append(tries, element('td', whenFormat.format(site.first)), element('td', whenFormat.format(site.last)));
    rows.append(row);
  }
}

// When the browser's history was last looked through for visits to listed sites, and what that found.
function renderHistoryScan(scan) {
  const line = $('history-scan');
  if (!scan) {
    line.textContent = "This browser's history hasn't been looked through yet.";
    return;
  }
  const date = whenFormat.format(scan.at);
  if (scan.error) {
    line.textContent = `Couldn't look through this browser's history on ${date}: ${scan.error}`;
    return;
  }
  const found = scan.found ? `found ${plural(scan.found, 'visit')} to listed sites` : 'found no visits to listed sites';
  const added = scan.added ? `, ${scan.added === scan.found ? 'all' : scan.added} new` : scan.found ? ', none new' : '';
  const taken = [scan.removed ? `${plural(scan.removed, 'page')} from this browser's history` : '', scan.bookmarks ? plural(scan.bookmarks, 'bookmark') : ''].filter(Boolean);
  line.textContent = `Looked through this browser's history on ${date}: ${found}${added}.` + (taken.length ? ` Removed ${taken.join(' and ')}.` : '');
}

// One line each for the other pages of the record.
function renderElsewhere(pictures, unlisted) {
  const hidden = Array.isArray(pictures) ? pictures : [];
  $('pictures-line').firstElementChild.textContent = hidden.length
    ? `${countHidden(hidden)} hidden on ${plural(hiddenBySite(hidden).length, 'site')}, the latest at ${whenFormat.format(Math.max(...hidden.map((entry) => entry.at)))}.`
    : 'No picture hidden so far.';
  const count = unlisted?.sites?.length ?? 0;
  $('unlisted-line').firstElementChild.textContent = !unlisted
    ? "This browser's history hasn't been looked through for sites that look adult but aren't on either list."
    : count
      ? `${plural(count, 'site')} in this browser's history look${count === 1 ? 's' : ''} adult but ${count === 1 ? "isn't" : "aren't"} on either list.`
      : 'No site in this browser\'s history looks adult without being on a list.';
}

// What this page says about being off, so that the minute-by-minute notes of running don't redraw it.
let offShown = '';
const offPart = (state) => JSON.stringify({ since: state?.since, atLeast: state?.atLeast, kept: state?.periods?.[0]?.from, off: state?.off ?? [] });

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, HISTORY_SCAN, UNLISTED, PICTURES, WATCHING]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  watching = stored[WATCHING] ?? null;
  ({ events } = await loadBox(api.storage.local));
  offShown = offPart(watching);
  renderSummary();
  renderWatching();
  renderHistoryScan(stored[HISTORY_SCAN]);
  $('save-file').hidden = attempts.length === 0;
  // Every try holds the tries, the times the extension was off and the password's record: its link shows
  // whenever it has any of them, and the count is the tries.
  $('every-try').hidden = !everyTryShows({ attempts, off: normalize(watching).off, events });
  $('every-try').textContent = everyTryWords(attempts.length);
  $('sites').hidden = attempts.length === 0;
  renderSites();
  renderElsewhere(stored[PICTURES], stored[UNLISTED]);
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
$('history-scan-now').addEventListener('click', () => {
  $('history-scan').textContent = "Looking through this browser's history…";
  api.runtime.sendMessage({ type: 'scan-history' }).catch(() => {});
});
// Keep the record current while the page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ATTEMPTS] || changes[HISTORY_SCAN] || changes[UNLISTED] || changes[PICTURES] || changes[EVENTS]) render();
  else if (changes[WATCHING] && offPart(changes[WATCHING].newValue) !== offShown) render();
});

showVersion(api);
render()
  // Then have the background script look at the silences since it last did, so what this page says is current.
  .then(() => api.runtime.sendMessage({ type: 'check-gaps' }).catch(() => null))
  .then(() => render())
  .catch((error) => {
    $('summary').textContent = `Couldn't read the record: ${error.message}`;
  });
