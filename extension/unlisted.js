// The sites the history scan found that look adult by name but aren't on either list (lib/suspects.js),
// on a page of their own. Adding a site here puts it on the person's own list, the same list as the box on
// the settings page; the background script is then told to reread the lists and look through the history
// again, which records the site's earlier visits and takes it off this table.
import { MY_LIST_CHANGED, addToMyList } from './lib/mylist.js';
import { element, plural, showVersion, whenFormat } from './lib/page.js';
import { UNLISTED } from './lib/suspects.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const added = new Set(); // sites added from this page, kept marked until the next look through the history

function render(unlisted) {
  const sites = unlisted?.sites ?? [];
  $('unlisted').hidden = sites.length === 0;
  if (!unlisted) {
    $('summary').textContent = "This browser's history hasn't been looked through yet.";
    return;
  }
  $('summary').textContent = sites.length
    ? `${plural(sites.length, 'site')}, as of ${whenFormat.format(unlisted.at)}.`
    : `None found when the history was last looked through, ${whenFormat.format(unlisted.at)}.`;
  const rows = $('unlisted-table').querySelector('tbody');
  rows.replaceChildren();
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
    $('summary').textContent = `Couldn't add ${site}: ${error.message}`;
  }
}

async function load() {
  const stored = await api.storage.local.get(UNLISTED);
  render(stored[UNLISTED]);
}

// A fresh look through the history: anything added is listed now, so it is gone from the table.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[UNLISTED]) return;
  added.clear();
  load();
});

showVersion(api);
load().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
