// The settings page: a board that says whether everything is working and what still needs switching on,
// the two settings (the person's own sites, the pictures setting), the record in a few lines, and where
// the locked-away password stands. The record and the password have pages of their own.
import { ATTEMPTS, LABELS, outcome } from './lib/attempts.js';
import { parseDomainList } from './lib/domains.js';
import { describeLock, lockInForce, managedStamp } from './lib/lock.js';
import { BOX, EVENTS, PROGRESS, describeBox, loadBox } from './lib/lockbox.js';
import { MY_LIST_CHANGED, myList, saveMyList } from './lib/mylist.js';
import { PICTURES, STRICTNESS, STRICTNESS_CHOICES, countHidden, hiddenBySite, strictnessOf } from './lib/pictures.js';
import { ENGINES } from './lib/safesearch.js';
import { UNLISTED } from './lib/suspects.js';

// Firefox provides `browser`; Chrome, Edge and Brave provide `chrome`. Both return promises here.
const api = globalThis.browser ?? globalThis.chrome;
const dnr = api.declarativeNetRequest;
const isFirefox = location.protocol === 'moz-extension:';
const ALL_SITES = { origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);

// Each check asks the browser's own rule matcher whether a page load would be blocked.
const CHECKS = [
  { label: 'exampleadultsite.com, the test case', url: 'https://exampleadultsite.com/', blocked: true },
  { label: 'www.exampleadultsite.com with a path and query', url: 'http://www.exampleadultsite.com/page?x=1#top', blocked: true },
  { label: 'cdn.img.exampleadultsite.com on port 8443', url: 'https://cdn.img.exampleadultsite.com:8443/', blocked: true },
  { label: 'exampleadultsite.com.example.org, a different site', url: 'https://exampleadultsite.com.example.org/', blocked: false },
  { label: 'notexampleadultsite.com, a different site', url: 'https://notexampleadultsite.com/', blocked: false },
  { label: 'example.com, an unrelated site', url: 'https://example.com/', blocked: false },
];

const sites = (n) => (n === 1 ? '1 site' : `${n} sites`);

/** Marks a line of the board: 'ok' (a tick), 'todo' (something to do), or 'checking'. */
function markLine(id, state) {
  const line = $(id);
  line.classList.remove('ok', 'todo', 'checking');
  line.classList.add(state);
}

async function builtInDomains() {
  const response = await fetch(api.runtime.getURL('rules/domains.json'));
  return response.json();
}

let loaded = null; // the person's list as last shown in the box, to tell unsaved edits from the saved list
async function refresh() {
  const [builtIn, mine] = await Promise.all([builtInDomains(), myList(dnr)]);
  loaded = mine.join('\n');
  $('custom').value = loaded;
  $('summary').textContent = `${sites(builtIn.length)} on the built-in list, ${mine.length} on yours.`;
}

// Only some browsers let an extension ask their rule matcher directly: Chrome and Edge for extensions
// loaded unpacked, Firefox only with an extra permission and a developer setting. Everywhere else, the
// list of checks stays hidden and the note points at the test site instead.
async function runChecks() {
  const list = $('results');
  const note = $('check-note');
  list.replaceChildren();
  note.textContent = '';

  const outcomes = [];
  try {
    for (const check of CHECKS) {
      const { matchedRules } = await dnr.testMatchOutcome({ url: check.url, type: 'main_frame' });
      outcomes.push(matchedRules.length > 0);
    }
  } catch {
    $('check-details').hidden = true;
    note.textContent = isFirefox
      ? "Firefox doesn't let add-ons check the addresses automatically, so open the test site."
      : "This browser doesn't let extensions check the addresses automatically, so open the test site.";
    markLine('check', 'ok'); // nothing is known to be wrong; the test site is the check
    return;
  }
  $('check-details').hidden = false;

  let failed = 0;
  CHECKS.forEach((check, index) => {
    const blocked = outcomes[index];
    const passed = blocked === check.blocked;
    if (!passed) failed += 1;

    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = passed ? 'Passed' : 'Failed';

    const detail = document.createElement('small');
    const expected = check.blocked ? 'blocked' : 'allowed';
    detail.textContent = `${blocked ? 'Blocked' : 'Allowed'}, ${passed ? 'as expected' : `but it should be ${expected}`}`;

    const what = document.createElement('span');
    what.append(check.label, detail);

    const item = document.createElement('li');
    item.className = passed ? 'passed' : 'failed';
    item.append(status, what);
    list.append(item);
  });

  note.textContent = failed
    ? `${failed} of ${CHECKS.length} checks failed. Open the browser's extensions page and look for errors on this extension.`
    : `All ${CHECKS.length} checks passed.`;
  markLine('check', failed ? 'todo' : 'ok');
}

async function save() {
  const { domains, invalid } = parseDomainList($('custom').value);
  const status = $('status');
  try {
    await saveMyList(dnr, domains);
    // The background script keeps its own copy of the lists for noting blocked attempts.
    api.runtime.sendMessage({ type: 'list-changed' }).catch(() => {});
    await refresh();
    const shown = invalid.slice(0, 3).join(', ') + (invalid.length > 3 ? ', …' : '');
    status.textContent =
      `Saved. ${sites(domains.length)} on your list.` +
      (invalid.length ? ` Skipped because they aren't domain names: ${shown}. Use names like example.com.` : '');
    await runChecks();
  } catch (error) {
    status.textContent = `Couldn't save: ${error.message}`;
  }
}

// Sending a page to "This site is blocked" needs access to websites. Chrome, Edge and Brave grant it
// when the extension is installed. Firefox can leave it off, and then listed sites still open.
async function checkAccess() {
  let allowed;
  try {
    allowed = await api.permissions.contains(ALL_SITES);
  } catch {
    allowed = true; // Can't tell, so don't show a warning the person can't act on.
  }
  $('access').hidden = allowed;
}

// Whether anything stops the person using the browser from switching the add-on off. Under the Firefox
// lock (the README's "Lock it" section) Firefox installs the add-on itself and shows no switch; the browser
// reports that as an installation by an administrator (getSelf needs no permission), and the lock's profile
// says which copy it is through the add-on's managed storage (lib/lock.js). Read once, for both lines.
const lockState = (async () => {
  let info;
  try {
    info = await api.management.getSelf();
  } catch {
    return null; // nothing to say
  }
  const state = { installType: info.installType, firefox: isFirefox, own: api.runtime.getManifest().version, stamp: null };
  // Only the Firefox lock writes the stamp; in other browsers there is nothing to read.
  if (lockInForce(state)) state.stamp = await managedStamp(api.storage);
  return state;
})();

async function checkLock() {
  const line = $('lock');
  const status = $('lock-status');
  const state = await lockState;
  if (!state) {
    line.hidden = true;
    return;
  }
  const readme = ({ anchor, text }) => {
    const link = document.createElement('a');
    link.href = `https://github.com/adviseworn/family-site-blocker#${anchor}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = text;
    return link;
  };
  const described = describeLock(state);
  status.replaceChildren(...described.parts.map((part) => (typeof part === 'string' ? part : readme(part))));
  markLine('lock', described.state);
  line.hidden = false;
}

// Browsers switch extensions off in private windows unless the person allows them there, which would
// leave an easy way round the blocker. Say so, and point at the switch. The Firefox lock turns private
// windows off altogether, so under it there is nothing to allow.
async function checkPrivateWindows() {
  const status = $('private-status');
  const windows = isFirefox ? 'Private windows' : 'Private (Incognito) windows';
  const howTo = isFirefox
    ? 'Type about:addons in the address bar, choose Family Site Blocker and set “Run in Private Windows” to Allow.'
    : 'Open this extension’s Details page and turn on “Allow in Incognito”.';
  try {
    const state = await lockState;
    if (state && lockInForce(state)) {
      status.textContent = 'Private windows are turned off by the Firefox lock, so nothing can be opened there.';
      $('private-open').hidden = true;
      markLine('private', 'ok');
      return;
    }
    const covered = await api.extension.isAllowedIncognitoAccess();
    status.textContent = covered
      ? `${windows} are blocked too.`
      : `${windows} are not blocked yet, so sites can still be opened there. ${howTo}`;
    // Firefox doesn't let extensions open about:addons, so the button is for Chrome, Edge and Brave only.
    $('private-open').hidden = covered || isFirefox;
    markLine('private', covered ? 'ok' : 'todo');
  } catch {
    status.textContent = `Couldn’t tell whether private windows are blocked. ${howTo}`;
    markLine('private', 'todo');
  }
}

// --- The record -----------------------------------------------------------------------------------------
// The background script notes every attempt to open a listed site (see lib/attempts.js). The latest
// few are shown here, newest first; the whole record is on attempts.html, in its own tab, with the look
// through the browser's history. The pictures hidden and the sites that might belong on the list get a
// line each. Nothing here can clear the record.
const SHOWN = 3;
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Sites the history scan found that aren't listed but look adult from their names (lib/suspects.js): a
// pointer to the page where they can be added to the person's list.
function renderUnlisted(unlisted) {
  const note = $('unlisted-note');
  const count = unlisted?.sites?.length ?? 0;
  note.hidden = count === 0;
  if (count) note.firstChild.textContent = `${sites(count)} in this browser's history look${count === 1 ? 's' : ''} adult but ${count === 1 ? "isn't" : "aren't"} on either list: `;
}

function renderPicturesLine(pictures) {
  const hidden = Array.isArray(pictures) ? pictures : [];
  $('pictures-line').firstElementChild.textContent = hidden.length
    ? `${countHidden(hidden)} hidden on ${plural(hiddenBySite(hidden).length, 'site')}, the latest at ${when.format(Math.max(...hidden.map((entry) => entry.at)))}.`
    : 'No picture hidden so far.';
}

async function renderAttempts() {
  const stored = await api.storage.local.get([ATTEMPTS, UNLISTED, PICTURES]);
  const attempts = Array.isArray(stored[ATTEMPTS]) ? [...stored[ATTEMPTS]].reverse() : [];
  renderUnlisted(stored[UNLISTED]);
  renderPicturesLine(stored[PICTURES]);
  const table = $('attempts-table');
  const all = $('attempts-all');
  const rows = table.querySelector('tbody');
  rows.replaceChildren();

  if (attempts.length === 0) {
    $('attempts-summary').textContent = 'No attempts so far.';
    table.hidden = true;
    all.hidden = true;
    return;
  }

  const opened = attempts.filter((attempt) => outcome(attempt) === 'opened').length;
  const fromHistory = attempts.filter((attempt) => outcome(attempt) === 'history').length;
  $('attempts-summary').textContent =
    `${plural(attempts.length, 'attempt')}, the latest at ${when.format(attempts[0].at)}.` +
    (opened ? ` ${plural(opened, 'page')} opened instead of being blocked.` : '') +
    (fromHistory ? ` ${fromHistory} from this browser's history.` : '');
  table.caption.textContent = attempts.length > SHOWN ? `The latest ${SHOWN}` : '';

  for (const attempt of attempts.slice(0, SHOWN)) {
    const row = document.createElement('tr');
    row.className = outcome(attempt);
    for (const text of [when.format(attempt.at), attempt.site, LABELS[outcome(attempt)]]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  }
  table.hidden = false;
  all.hidden = false;
  all.textContent = `See the whole record (${attempts.length})`;
}

// Keep the record current while the page is open, and the box with the person's list when the record
// page adds to it (unless the box holds unsaved edits, which must not be thrown away).
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ATTEMPTS] || changes[UNLISTED] || changes[PICTURES]) renderAttempts();
  if (changes[BOX] || changes[PROGRESS] || changes[EVENTS]) renderLockbox();
  if (changes[MY_LIST_CHANGED] && $('custom').value === loaded) refresh().catch(() => {});
});

// --- Locked-away password ---------------------------------------------------------------------------------
// One line on where it stands, and what its record says (#75); everything else is on lockbox.html.
async function renderLockbox() {
  try {
    $('lockbox-line').textContent = describeBox(await loadBox(api.storage.local));
  } catch (error) {
    $('lockbox-line').textContent = `Couldn't read the locked-away password: ${error.message}`;
  }
}

$('access-allow').addEventListener('click', () => {
  // The permission prompt only appears when it is requested straight from the click.
  api.permissions.request(ALL_SITES).then(checkAccess, checkAccess);
});
api.permissions.onAdded?.addListener(checkAccess);
api.permissions.onRemoved?.addListener(checkAccess);
$('private-open').addEventListener('click', () => {
  api.tabs.create({ url: `chrome://extensions/?id=${api.runtime.id}` });
});
$('save').addEventListener('click', save);

// The version next to the title: when a new one is being installed account by account, it shows which
// accounts still have the old one.
// --- Pictures ---------------------------------------------------------------------------------------------
// The setting is kept in storage; the background script reads it for each verdict (lib/pictures.js).
const strictnessSelect = $('picture-strictness');
for (const { value, label } of STRICTNESS_CHOICES) strictnessSelect.append(new Option(label, value));
async function renderPictureSetting() {
  const stored = await api.storage.local.get(STRICTNESS);
  strictnessSelect.value = strictnessOf(stored[STRICTNESS]);
}
strictnessSelect.addEventListener('change', () => {
  api.storage.local.set({ [STRICTNESS]: strictnessOf(strictnessSelect.value) }).catch(() => {});
});
const BACKEND_NAMES = { wasm: 'through WebAssembly', webgl: 'on the graphics card', cpu: 'in plain JavaScript, which is slow' };
async function renderPictureStatus() {
  const line = $('picture-status');
  try {
    const status = await api.runtime.sendMessage({ type: 'picture-status' });
    if (!status || !status.backend) {
      line.textContent = 'Pictures and videos are judged before they show; none judged yet since the browser started.';
      return;
    }
    line.textContent =
      `Pictures and videos are judged before they show: since the browser started, ${plural(status.judged, 'picture')} judged, ${status.hidden} hidden` +
      (status.frames ? `; ${plural(status.frames, 'video frame')} judged, ${plural(status.videos ?? 0, 'video')} hidden` : '') +
      (status.failed ? `; ${status.failed} shown unjudged because they couldn't be fetched or read` : '') +
      ` (${BACKEND_NAMES[status.backend] ?? status.backend}).`;
  } catch (error) {
    line.textContent = `Couldn't ask about pictures: ${error.message}`;
  }
}

$('version').textContent = `Version ${api.runtime.getManifest().version}`;
renderPictureSetting().catch(() => {});
renderPictureStatus();
renderLockbox();
checkLock();
// The counts move while pages are open elsewhere: keep the line current while this page is in view.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderPictureStatus();
});
setInterval(() => {
  if (!document.hidden) renderPictureStatus();
}, 5000);
$('engines').textContent = `${ENGINES.slice(0, -1).map(({ name }) => name).join(', ')} and ${ENGINES.at(-1).name}`;
checkAccess();
checkPrivateWindows();
renderAttempts().catch((error) => {
  $('attempts-summary').textContent = `Couldn't read the record: ${error.message}`;
});
refresh()
  .then(runChecks)
  .catch((error) => {
    $('summary').textContent = `Couldn't read the settings: ${error.message}`;
  });
