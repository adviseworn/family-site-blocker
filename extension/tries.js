// Every try in the record of blocked attempts, grouped by day, newest first, on a page of its own: the
// record page (attempts.html) shows the record summed up and links here, for the whole record or for one
// site (tries.html#site=<the site>, from the by-site table there). Like the other pages, this one only
// reads the record; nothing here can clear it (see lib/attempts.js).
import { ATTEMPTS, LABELS, byDay, outcome, summarize, toCsv } from './lib/attempts.js';
import { dayFormat, element, plural, showVersion, timeFormat, tries as triesWord, whenFormat } from './lib/page.js';
import { WATCHING } from './lib/watching.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let attempts = []; // the record as stored: oldest first
let watching = null; // when the extension was running (lib/watching.js), which places the visits from the history

/** The site named in the address (tries.html#site=example.com), or null for every site. */
function onlySite() {
  const match = /(?:^#|&)site=([^&]+)/.exec(location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

function dayHeading(day, count) {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const name = day === midnight ? 'Today' : day === midnight - 86_400_000 ? 'Yesterday' : null;
  const heading = element('h3', name ? `${name}, ` : '');
  heading.append(element('span', dayFormat.format(day)), ' ', element('small', triesWord(count)));
  return heading;
}

function renderDays(shown) {
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
      const what = outcome(attempt, watching);
      const row = element('tr', null, { class: what });
      row.append(element('td', timeFormat.format(attempt.at)), element('td', attempt.site), element('td', LABELS[what]));
      body.append(row);
    }
    table.append(head, body);
    section.append(table);
    days.append(section);
  }
  $('days').replaceChildren(days);
}

function renderSummary(shown, site) {
  if (attempts.length === 0) {
    $('summary').textContent = 'No attempts so far.';
    return;
  }
  if (site && shown.length === 0) {
    $('summary').textContent = `No tries at ${site} in the record.`;
    return;
  }
  const counts = summarize(shown, watching);
  $('summary').textContent =
    `${triesWord(counts.tries)}${site ? '' : ` at ${plural(counts.sites, 'site')}`}, the latest at ${whenFormat.format(counts.latest)}.` +
    (counts.opened ? ` ${plural(counts.opened, 'page')} opened instead of being blocked.` : '') +
    (counts.history ? ` ${counts.history} from this browser's history${counts.off ? `, ${counts.off} of them from times the extension was off` : ''}.` : '');
}

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, WATCHING]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  watching = stored[WATCHING] ?? null;
  const site = onlySite();
  const shown = site ? attempts.filter((attempt) => attempt.site === site) : attempts;
  $('filter').hidden = !site;
  $('filter-site').textContent = site ?? '';
  document.title = site ? `Family Site Blocker record: ${site}` : 'Family Site Blocker record: every try';
  renderSummary(shown, site);
  $('save-file').hidden = attempts.length === 0;
  $('all').hidden = shown.length === 0;
  renderDays(shown);
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
// Keep the record current while the page is open. (The extension's running time is written every minute;
// a redraw for that would place a visit from the last minute no differently, so only the record counts.)
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ATTEMPTS]) render();
});

showVersion(api);
render().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
