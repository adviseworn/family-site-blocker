// The pictures the picture filter kept hidden, on a page of their own: summed up by site, then one by one,
// newest first, with the judge's scores (lib/pictures.js). The record page (attempts.html) links here.
// This page only reads the record; nothing here can clear it.
import { element, plural, showVersion, whenFormat } from './lib/page.js';
import { PICTURES, hiddenBySite } from './lib/pictures.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const SHOWN = 50;
const REASONS = { nudity: 'Nudity', suggestive: 'Suggestive' };

function render(record) {
  const list = Array.isArray(record) ? [...record].reverse() : [];
  $('hidden-sites').hidden = list.length === 0;
  $('hidden-pictures').hidden = list.length === 0;
  if (list.length === 0) {
    $('summary').textContent = 'No picture hidden so far.';
    return;
  }
  const sites = hiddenBySite(list);
  $('summary').textContent = `${plural(list.length, 'picture')} hidden on ${plural(sites.length, 'site')}, the latest at ${whenFormat.format(list[0].at)}.`;
  const siteRows = $('hidden-sites-table').querySelector('tbody');
  siteRows.replaceChildren();
  for (const row of sites) {
    const tr = element('tr');
    tr.append(element('td', row.site), element('td', String(row.pictures)), element('td', whenFormat.format(row.last)));
    siteRows.append(tr);
  }
  const table = $('hidden-pictures-table');
  table.caption.textContent = list.length > SHOWN ? `The latest ${SHOWN}` : '';
  const rows = table.querySelector('tbody');
  rows.replaceChildren();
  for (const entry of list.slice(0, SHOWN)) {
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

async function load() {
  const stored = await api.storage.local.get(PICTURES);
  render(stored[PICTURES]);
}

// Keep the record current while the page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PICTURES]) load();
});

showVersion(api);
load().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
