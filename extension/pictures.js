// The pictures and videos the picture filter kept hidden, on a page of their own: summed up, and by site,
// each site a link to what was hidden there among every try on tries.html, which lists every one of them
// (lib/pictures.js) with the judge's scores and the address, where each can be looked at, and shows them
// alone from the link here. The record page (attempts.html) links here. This page only reads the record;
// nothing here can clear it.
import { element, hiddenWords, showVersion, whenFormat } from './lib/page.js';
import { PICTURES, hiddenBySite } from './lib/pictures.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

function render(record) {
  const list = Array.isArray(record) ? record : [];
  $('hidden-sites').hidden = list.length === 0;
  $('hidden-pictures').hidden = list.length === 0;
  $('summary').textContent = hiddenWords(list) || 'No picture hidden so far.';
  if (list.length === 0) return;
  const siteRows = $('hidden-sites-table').querySelector('tbody');
  siteRows.replaceChildren();
  for (const row of hiddenBySite(list)) {
    const tr = element('tr', null, { 'data-site': row.site });
    const name = element('td');
    name.append(element('a', row.site, { href: `tries.html#site=${encodeURIComponent(row.site)}&pictures` }));
    tr.append(name, element('td', String(row.pictures)), element('td', whenFormat.format(row.last)));
    siteRows.append(tr);
  }
  $('hidden-pictures-line').replaceChildren(
    'Each one is a row among every try in the record, in its day: the time, the site, why it was hidden, the judge’s scores, and its address, with Look at it. ',
    element('a', `See ${list.length === 1 ? 'it' : 'them'} among every try`, { href: 'tries.html#pictures' }),
    '.',
  );
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
