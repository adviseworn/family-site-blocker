// Blocking is done by the browser itself from the rules in rules/adult.json and the list saved from the
// settings page. This script opens the settings page (right after the extension is installed, so the
// person can see whether anything still needs switching on, and when the toolbar button is clicked) and
// keeps the record of blocked attempts. Chrome, Edge and Brave run it as a service worker; Firefox runs
// it as an event page. Both load it as a module (manifest.json: background.type).
import { ATTEMPTS, hostOf, listedDomain, record } from './lib/attempts.js';
import { domainsOf } from './lib/rules.js';

const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.runtime.openOptionsPage();
});
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// --- Blocked attempts ---------------------------------------------------------------------------------
// The browser reports every navigation; the ones to a listed site are noted (lib/attempts.js). The rules
// block those same navigations, so an attempt is noted whether the add-on's block page took over, or
// Firefox's own copy of the list stopped it first. If the site's page then loads anyway, the note says
// so: that means the blocking isn't working (no access to websites yet, for example).

const BUILT_IN = api.runtime.getURL('rules/domains.json'); // the built-in list as plain domains (npm run build)
let domains = null; // Promise<Set<string>>: the built-in list plus the sites saved on the settings page.

function listedDomains() {
  if (!domains) {
    domains = Promise.all([
      fetch(BUILT_IN).then((response) => response.json()),
      api.declarativeNetRequest.getDynamicRules().then(domainsOf),
    ]).then(([builtIn, mine]) => new Set([...builtIn, ...mine]));
    // A read that fails (right after an install, say) must not be kept: try again on the next event.
    domains.catch(() => {
      domains = null;
    });
  }
  return domains;
}

// The settings page says when the person's own list changes; the browser also restarts this script
// after a short idle, so the lists are reread often anyway.
api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'list-changed') domains = null;
});

// One write at a time: two navigations close together must not read the same old list and lose a note.
let writing = Promise.resolve();
function note(attempt) {
  writing = writing
    .then(async () => {
      const stored = (await api.storage.local.get(ATTEMPTS))[ATTEMPTS];
      const updated = record(stored, attempt);
      if (updated) await api.storage.local.set({ [ATTEMPTS]: updated });
    })
    .catch(() => {});
  return writing;
}

// Only pages in a tab (frameId 0), not frames inside other pages, and not pages Chrome prerenders by
// itself for addresses it guesses the person might open next.
async function listedSite({ frameId, url, documentLifecycle }) {
  if (frameId !== 0 || documentLifecycle === 'prerender') return null;
  const host = hostOf(url);
  return host && listedDomain(host, await listedDomains());
}

async function tried(details) {
  const site = await listedSite(details);
  if (site) await note({ at: details.timeStamp ?? Date.now(), site });
}

// A listed site's page has loaded: the attempt got through. (A block page, Firefox's or the add-on's,
// has its own address, so it never counts: Firefox reports its error pages under about:neterror.)
async function opened(details) {
  const site = await listedSite(details);
  if (site) await note({ at: details.timeStamp ?? Date.now(), site, opened: true });
}

// Two reports of each navigation, because each misses some. The browser's navigation events see every
// page load that starts, including one Firefox's own copy of the list stops before any request is made;
// but Firefox now and then leaves out the first load in a brand-new tab. Its request events see every
// request that is made, even one the rules then redirect (they run before the rules). lib/attempts.js
// counts a site reported twice within two seconds once.
const PAGES = { urls: ['<all_urls>'], types: ['main_frame'] };
api.webNavigation.onBeforeNavigate.addListener(tried);
api.webRequest.onBeforeRequest.addListener(tried, PAGES);
api.webNavigation.onDOMContentLoaded.addListener(opened);
api.webNavigation.onCompleted.addListener(opened);
api.webRequest.onCompleted.addListener(opened, PAGES);
