// The whole record of blocked attempts on a page of its own: the settings page shows only the latest few
// and links here. First the record summed up by site, then every try grouped by day, newest first, and a
// button that saves the lot as a CSV file. Like the settings page, this page only reads the record;
// nothing here can clear it (see lib/attempts.js).
import { ATTEMPTS, LABELS, bySite, byDay, outcome, toCsv } from './lib/attempts.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

let attempts = []; // the record as stored: oldest first
let onlySite = null; // a site chosen in the by-site table, or null for every site

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
    if (site.site === onlySite) row.classList.add('chosen');
    const choose = element('button', site.site, { type: 'button', class: 'link', 'aria-pressed': String(site.site === onlySite) });
    choose.addEventListener('click', () => {
      onlySite = onlySite === site.site ? null : site.site;
      renderSites();
      renderDays();
      if (onlySite) $('all').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const name = element('td');
    name.append(choose);
    row.append(name);
    const tries = element('td', String(site.tries));
    if (site.opened) tries.append(element('small', `${site.opened} opened`, { class: 'opened' }));
    row.append(tries, element('td', whenFormat.format(site.first)), element('td', whenFormat.format(site.last)));
    rows.append(row);
  }
}

function dayHeading(day, count) {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const name = day === midnight ? 'Today' : day === midnight - 86_400_000 ? 'Yesterday' : null;
  const heading = element('h3', name ? `${name}, ` : '');
  heading.append(element('span', dayFormat.format(day)), ' ', element('small', count === 1 ? '1 try' : `${count} tries`));
  return heading;
}

function renderDays() {
  const shown = onlySite ? attempts.filter((attempt) => attempt.site === onlySite) : attempts;
  $('filter').hidden = !onlySite;
  $('filter-site').textContent = onlySite ?? '';
  const days = document.createDocumentFragment();
  for (const { day, attempts: list } of byDay(shown)) {
    const section = element('section', null, { class: 'day' });
    section.append(dayHeading(day, list.length));
    const table = element('table', null, { class: 'attempts' });
    const head = element('thead');
    const headRow = element('tr');
    for (const title of ['Time', 'Site', 'Result']) headRow.append(element('th', title, { scope: 'col' }));
    head.append(headRow);
    const body = element('tbody');
    for (const attempt of list) {
      const row = element('tr', null, { class: outcome(attempt) });
      row.append(element('td', timeFormat.format(attempt.at)), element('td', attempt.site), element('td', LABELS[outcome(attempt)]));
      body.append(row);
    }
    table.append(head, body);
    section.append(table);
    days.append(section);
  }
  $('days').replaceChildren(days);
}

async function render() {
  const stored = await api.storage.local.get(ATTEMPTS);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  if (onlySite && !attempts.some((attempt) => attempt.site === onlySite)) onlySite = null;
  renderSummary();
  $('save-file').hidden = attempts.length === 0;
  $('sites').hidden = attempts.length === 0;
  $('all').hidden = attempts.length === 0;
  renderSites();
  renderDays();
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
$('filter-clear').addEventListener('click', () => {
  onlySite = null;
  renderSites();
  renderDays();
});
// Keep the record current while the page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ATTEMPTS]) render();
});

$('version').textContent = `Version ${api.runtime.getManifest().version}`;
render().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
