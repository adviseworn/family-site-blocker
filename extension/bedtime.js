// The bedtime page (bedtime.html): what a tab shows in place of a web page while a bedtime lasts
// (lib/bedtime.js, 1.30.0). The browser sends a page being opened here, and the background script the tabs
// already open, each with the address it stands in for after the # (lib/rules.js bedtimeRules). The page
// says until when every site is blocked, and looks again when that time comes, when the tab is looked at
// and when the setting changes. Once the bedtime is over it goes back to its address, when the tab is the
// one being looked at: a tab left in the background waits until it is. An address on a blocked list is
// left to the block page, without trying it. Shown inside another page (a frame), it says its words and
// does nothing: only a tab's own page is ever sent here.
import { BEDTIME, addressFrom } from './lib/bedtime.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const address = addressFrom(location.hash);

// Going back to the address must never go round in circles: should the browser send the tab straight
// here again (its rules still in place, though the bedtime is over), the page stays, and offers a button.
const RETURNED = 'bedtimeReturned';
const SAME_RETURN_MS = 10_000;
function returnedJustNow() {
  try {
    const last = JSON.parse(sessionStorage.getItem(RETURNED) ?? 'null');
    return last?.address === address && Date.now() - last.at < SAME_RETURN_MS;
  } catch {
    return false;
  }
}

function goBack() {
  try {
    sessionStorage.setItem(RETURNED, JSON.stringify({ address, at: Date.now() }));
  } catch {
    // Without it the page still goes back; only the guard against going round in circles is missing.
  }
  location.replace(address);
}

let timer = null;
let until = null; // when the bedtime ends, as last heard

/** Asks the background script whether the bedtime still lasts, and shows what it says. */
async function look() {
  clearTimeout(timer);
  until = null;
  let state = null;
  try {
    state = await api.runtime.sendMessage({ type: 'bedtime-state', url: address });
  } catch {
    state = null;
  }
  if (!state || state.error) {
    timer = setTimeout(look, 5000); // the background script was starting, say: ask again shortly
    return;
  }
  if (state.blocked) {
    $('heading').textContent = 'It’s bedtime';
    $('words').textContent = `Every site is blocked until ${clock.format(state.until)}.`;
    $('open').hidden = true;
    // Again when it ends. A timer that long can come late once the computer has slept, so the clock is read as well (below).
    until = state.until;
    timer = setTimeout(look, Math.max(1000, state.until - Date.now() + 500));
    return;
  }
  if (state.listed) {
    location.replace('blocked.html');
    return;
  }
  if (address && !document.hidden && !returnedJustNow()) {
    goBack();
    return;
  }
  document.title = 'Bedtime is over';
  $('heading').textContent = 'Bedtime is over';
  $('words').textContent = address ? 'This tab’s page opens when you come back to it.' : 'Sites open again.';
  $('open').hidden = !address;
}

if (window.top === window) {
  $('open').addEventListener('click', goBack);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) look();
  });
  // Back or Forward to this page, kept whole by the browser, after the bedtime ended.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) look();
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[BEDTIME]) look();
  });
  setInterval(() => {
    if (until !== null && Date.now() >= until) look();
  }, 15_000);
  look();
}
