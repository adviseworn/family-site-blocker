// The pictures the picture filter kept hidden, on a page of their own: summed up by site, then one by one,
// newest first, with the judge's scores (lib/pictures.js). The record page (attempts.html) links here.
// This page only reads the record; nothing here can clear it.
import { element, plural, showVersion, whenFormat } from './lib/page.js';
import { PICTURES, borderline, hiddenBySite } from './lib/pictures.js';

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
  const close = list.filter(borderline).length;
  $('summary').textContent =
    `${plural(list.length, 'picture')} hidden on ${plural(sites.length, 'site')}, the latest at ${whenFormat.format(list[0].at)}.` +
    (close ? ` ${close === 1 ? '1 of them is' : `${close} of them are`} borderline.` : '');
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
    const close = borderline(entry);
    const tr = element('tr', null, close ? { class: 'borderline' } : {});
    const nudity = (entry.scores?.porn ?? 0) + (entry.scores?.hentai ?? 0);
    const why = element('td', REASONS[entry.reason] ?? entry.reason ?? '');
    if (close) why.append(element('small', 'borderline', { class: 'borderline-mark' }));
    const action = element('td');
    const copy = element('button', 'Copy address', { type: 'button', class: 'secondary small' });
    copy.addEventListener('click', () => copyAddress(entry.url, copy));
    action.append(copy);
    tr.append(
      element('td', whenFormat.format(entry.at)),
      element('td', entry.site),
      element('td', entry.url, { class: 'picture-url', title: entry.url }),
      why,
      element('td', nudity.toFixed(2)),
      element('td', (entry.scores?.sexy ?? 0).toFixed(2)),
      action,
    );
    rows.append(tr);
  }
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
