// The record on a page of its own: the settings page shows only the latest few blocked attempts and links
// here. This page sums the record of tries up by site, with a link for each site to every one of its
// tries on tries.html (which also lists every try of all, grouped by day), and a button that saves the
// whole record as a CSV file. The other two parts of the record, the pictures hidden and the sites that
// might belong on the list, have pages of their own (pictures.html, unlisted.html), summed up here in a
// line each. The look through the browser's history (background.js scanHistory) is reported and started
// from here. Like the settings page, this page only reads the record; nothing here can clear it (see
// lib/attempts.js).
import { ATTEMPTS, HISTORY_SCAN, bySite, outcome, toCsv } from './lib/attempts.js';
import { element, plural, showVersion, whenFormat } from './lib/page.js';
import { PICTURES, countHidden, hiddenBySite } from './lib/pictures.js';
import { UNLISTED } from './lib/suspects.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let attempts = []; // the record as stored: oldest first

function renderSummary() {
  if (attempts.length === 0) {
    $('summary').textContent = 'No attempts so far.';
    return;
  }
  const latest = attempts[attempts.length - 1];
  const sites = new Set(attempts.map((attempt) => attempt.site)).size;
  const opened = attempts.filter((attempt) => outcome(attempt) === 'opened').length;
  const fromHistory = attempts.filter((attempt) => outcome(attempt) === 'history').length;
  $('summary').textContent =
    `${plural(attempts.length, 'attempt')} at ${plural(sites, 'site')}, the latest at ${whenFormat.format(latest.at)}.` +
    (opened ? ` ${plural(opened, 'page')} opened instead of being blocked.` : '') +
    (fromHistory ? ` ${fromHistory} from this browser's history.` : '');
}

function renderSites() {
  const rows = $('sites-table').querySelector('tbody');
  rows.replaceChildren();
  for (const site of bySite(attempts)) {
    const row = element('tr', null, { 'data-site': site.site });
    const name = element('td');
    name.append(element('a', site.site, { href: `tries.html#site=${encodeURIComponent(site.site)}` }));
    row.append(name);
    const tries = element('td', String(site.tries));
    if (site.opened) tries.append(element('small', `${site.opened} opened`, { class: 'opened' }));
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

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, HISTORY_SCAN, UNLISTED, PICTURES]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  renderSummary();
  renderHistoryScan(stored[HISTORY_SCAN]);
  $('save-file').hidden = attempts.length === 0;
  $('every-try').hidden = attempts.length === 0;
  $('every-try').textContent = `See every try (${attempts.length})`;
  $('sites').hidden = attempts.length === 0;
  renderSites();
  renderElsewhere(stored[PICTURES], stored[UNLISTED]);
}

function saveFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `family-site-blocker-record-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toCsv(attempts)], { type: 'text/csv' }));
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
  if (area === 'local' && (changes[ATTEMPTS] || changes[HISTORY_SCAN] || changes[UNLISTED] || changes[PICTURES])) render();
});

showVersion(api);
render().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
