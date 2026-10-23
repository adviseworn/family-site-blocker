// The record on a page of its own: the settings page shows only the latest few blocked attempts and links
// here. This page sums the record up: by site, with a link for each site to every one of its tries on
// tries.html (which also lists every try of all, grouped by day); then the pictures hidden, and the sites
// that might belong on the list. A button saves the whole record as a CSV file. Like the settings page,
// this page only reads the record; nothing here can clear it (see lib/attempts.js).
import { ATTEMPTS, bySite, outcome, toCsv } from './lib/attempts.js';
import { MY_LIST_CHANGED, addToMyList } from './lib/mylist.js';
import { PICTURES, hiddenBySite } from './lib/pictures.js';
import { UNLISTED } from './lib/suspects.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let attempts = []; // the record as stored: oldest first

function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

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

// --- Not on the list, but might belong there -------------------------------------------------------------
// What the history scan found that looks adult by name but isn't listed (lib/suspects.js). Adding a site
// here puts it on the person's own list, the same list as the box on the settings page; the background
// script is then told to reread the lists and look through the history again, which records the site's
// earlier visits and takes it off this table.
const added = new Set(); // sites added from this page, kept marked until the next look through the history

function renderUnlisted(unlisted) {
  const section = $('unlisted');
  if (!unlisted) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const rows = $('unlisted-table').querySelector('tbody');
  rows.replaceChildren();
  const sites = unlisted.sites ?? [];
  $('unlisted-summary').textContent = sites.length
    ? `${plural(sites.length, 'site')}, as of ${whenFormat.format(unlisted.at)}.`
    : `None found when the history was last looked through, ${whenFormat.format(unlisted.at)}.`;
  $('unlisted-table').hidden = sites.length === 0;
  for (const { site, visits, last } of sites) {
    const row = element('tr');
    const action = element('td');
    const button = element('button', added.has(site) ? 'Added' : 'Add to your list', { type: 'button', class: 'secondary small' });
    button.disabled = added.has(site);
    button.addEventListener('click', () => add(site, button));
    action.append(button);
    row.append(element('td', site), element('td', String(visits)), element('td', last ? whenFormat.format(last) : '—'), action);
    rows.append(row);
  }
}

async function add(site, button) {
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await addToMyList(api.declarativeNetRequest, site);
    added.add(site);
    button.textContent = 'Added';
    await api.storage.local.set({ [MY_LIST_CHANGED]: Date.now() });
    await api.runtime.sendMessage({ type: 'list-changed' }).catch(() => {});
    await api.runtime.sendMessage({ type: 'scan-history' }).catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Add to your list';
    $('unlisted-summary').textContent = `Couldn't add ${site}: ${error.message}`;
  }
}

// --- Pictures hidden ---------------------------------------------------------------------------------------
const SHOWN_PICTURES = 50;
const REASONS = { nudity: 'Nudity', suggestive: 'Suggestive' };

function renderHiddenPictures(record) {
  const list = Array.isArray(record) ? [...record].reverse() : [];
  const sites = $('hidden-sites-table');
  const table = $('hidden-pictures-table');
  sites.hidden = list.length === 0;
  table.hidden = list.length === 0;
  if (list.length === 0) {
    $('hidden-pictures-summary').textContent = 'No picture hidden so far.';
    return;
  }
  const bySiteRows = hiddenBySite(list);
  $('hidden-pictures-summary').textContent = `${plural(list.length, 'picture')} hidden on ${plural(bySiteRows.length, 'site')}, the latest at ${whenFormat.format(list[0].at)}.`;
  const siteRows = sites.querySelector('tbody');
  siteRows.replaceChildren();
  for (const row of bySiteRows) {
    const tr = element('tr');
    tr.append(element('td', row.site), element('td', String(row.pictures)), element('td', whenFormat.format(row.last)));
    siteRows.append(tr);
  }
  table.caption.textContent = list.length > SHOWN_PICTURES ? `The latest ${SHOWN_PICTURES}` : '';
  const rows = table.querySelector('tbody');
  rows.replaceChildren();
  for (const entry of list.slice(0, SHOWN_PICTURES)) {
    const tr = element('tr');
    const nudity = (entry.scores?.porn ?? 0) + (entry.scores?.hentai ?? 0);
    tr.append(
      element('td', whenFormat.format(entry.at)),
      element('td', entry.site),
      element('td', entry.url, { class: 'picture-url', title: entry.url }),
      element('td', REASONS[entry.reason] ?? entry.reason ?? ''),
      element('td', nudity.toFixed(2)),
      element('td', (entry.scores?.sexy ?? 0).toFixed(2)),
    );
    rows.append(tr);
  }
}

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, UNLISTED, PICTURES]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  renderSummary();
  $('save-file').hidden = attempts.length === 0;
  $('every-try').hidden = attempts.length === 0;
  $('every-try').textContent = `See every try (${attempts.length})`;
  $('sites').hidden = attempts.length === 0;
  renderSites();
  renderUnlisted(stored[UNLISTED]);
  renderHiddenPictures(stored[PICTURES]);
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
// Keep the record current while the page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[UNLISTED]) added.clear(); // a fresh look: anything added is listed now, so it is gone from the table
  if (changes[ATTEMPTS] || changes[UNLISTED] || changes[PICTURES]) render();
});

$('version').textContent = `Version ${api.runtime.getManifest().version}`;
render().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
