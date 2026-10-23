// Blocking is done by the browser itself from the rules in rules/adult.json and the list saved from the
// settings page. This script opens the settings page (right after the extension is installed, so the
// person can see whether anything still needs switching on, and when the toolbar button is clicked) and
// keeps the record of blocked attempts. Chrome, Edge and Brave run it as a service worker; Firefox runs
// it as an event page. Both load it as a module (manifest.json: background.type).
import { ATTEMPTS, HISTORY_SCAN, bookmarksTo, hostOf, listedDomain, mergeVisits, record } from './lib/attempts.js';
import { PICTURES, STRICTNESS, recordHidden, strictnessOf, verdict } from './lib/pictures.js';
import { domainsOf } from './lib/rules.js';
import { UNLISTED, tallyUnlisted } from './lib/suspects.js';
import { backendInUse, judgeBytes } from './classifier.js';

const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.runtime.openOptionsPage();
  // A new or updated copy may list sites that were visited before it was watching: find them in the history.
  if (reason === 'install' || reason === 'update') scanHistory();
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
// after a short idle, so the lists are reread often anyway. It also asks for the history to be looked
// through again (the button on the page).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'list-changed') domains = null;
  if (message?.type === 'scan-history') scanHistory();
  if (message?.type === 'judge-picture') {
    judgePicture(message.url, sender).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true; // the answer comes later
  }
  if (message?.type === 'picture-status') {
    sendResponse({ backend: backendInUse(), judged: judgedCount, hidden: hiddenCount, failed: failedCount });
    return true;
  }
  return undefined;
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

// --- The browser's history -------------------------------------------------------------------------------
// The record starts when the extension starts watching, but the browser's own history goes back further:
// every page it loaded in this profile, for months (Firefox) or 90 days (Chrome), except in private windows.
// Looking through it for listed sites adds the visits from before the extension was installed, or before a
// site was listed, marked as found in the history. Pages inside other pages (frames) are left out, as live.
// Once they are in the record, those pages are taken out of the browser's history, and bookmarks to listed
// sites are removed (see "The address bar" below); the scan's note says how many. The same look notes the
// sites that aren't listed but look adult from their names (lib/suspects.js), for the record page.
let scanning = null;
let scanAgain = false; // asked for while a scan was running (the record page asks right after adding a site)
function scanHistory() {
  if (scanning) {
    scanAgain = true;
    return scanning;
  }
  scanning = (async () => {
    const started = Date.now();
    const visits = [];
    const pages = [];
    let unlisted = null;
    let error = null;
    try {
      const listed = await listedDomains();
      const items = await api.history.search({ text: '', startTime: 0, maxResults: 1_000_000 });
      for (const item of items) {
        const site = listedDomain(hostOf(item.url), listed);
        if (!site) continue;
        pages.push(item.url);
        for (const visit of await api.history.getVisits({ url: item.url })) {
          if (!/subframe/.test(visit.transition ?? '')) visits.push({ at: visit.visitTime, site });
        }
      }
      unlisted = { at: started, sites: tallyUnlisted(items, listed) };
    } catch (failure) {
      error = String(failure?.message ?? failure);
    }
    await (writing = writing
      .then(async () => {
        const stored = (await api.storage.local.get(ATTEMPTS))[ATTEMPTS];
        const { attempts, found, added } = mergeVisits(stored, visits);
        const taken = error ? { removed: 0, bookmarks: 0 } : await takeOut(pages, await listedDomains().catch(() => new Set()));
        const scan = { at: started, found, added, ...taken, ...(error ? { error } : {}) };
        await api.storage.local.set({
          ...(added ? { [ATTEMPTS]: attempts } : {}),
          ...(unlisted ? { [UNLISTED]: unlisted } : {}),
          [HISTORY_SCAN]: scan,
        });
      })
      .catch(() => {}));
  })().finally(() => {
    scanning = null;
    if (scanAgain) {
      scanAgain = false;
      scanHistory();
    }
  });
  return scanning;
}

// --- The address bar -------------------------------------------------------------------------------------
// The browser fills in addresses from its history and its bookmarks, blocked sites included: a blocked try
// still puts the typed address into the history, where typing its first letter brings it back. So once a
// try is in the record, the site's pages are taken out of the browser's history, and bookmarks to listed
// sites are removed; the record keeps them, with their times. A live try is swept a moment after it is
// noted, because the browser writes the history entry while the page loads, not when the navigation starts.
const SWEEP_AFTER_MS = 2500;
const sweeps = new Map(); // site -> timer, so a burst of tries at one site is one sweep

function sweepSoon(site) {
  clearTimeout(sweeps.get(site));
  sweeps.set(
    site,
    setTimeout(() => {
      sweeps.delete(site);
      sweep(site).catch(() => {});
    }, SWEEP_AFTER_MS),
  );
}

async function sweep(site) {
  const listed = await listedDomains();
  const pages = [];
  for (const item of await api.history.search({ text: site, startTime: 0, maxResults: 100_000 })) {
    if (listedDomain(hostOf(item.url), listed)) pages.push(item.url);
  }
  await takeOut(pages, listed);
}

/** Removes bookmarks to any listed site, then the given pages from the history; returns how many of each. */
async function takeOut(pages, listed) {
  let bookmarks = 0;
  if (api.bookmarks && listed.size) {
    const tree = await api.bookmarks.getTree().catch(() => []);
    for (const bookmark of bookmarksTo(tree, listed)) {
      await api.bookmarks.remove(bookmark.id).catch(() => {});
      bookmarks += 1;
    }
  }
  let removed = 0;
  for (const url of new Set(pages)) {
    await api.history.deleteUrl({ url }).catch(() => {});
    removed += 1;
  }
  return { removed, bookmarks };
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
  if (!site) return;
  await note({ at: details.timeStamp ?? Date.now(), site });
  sweepSoon(site);
}

// A listed site's page has loaded: the attempt got through. (A block page, Firefox's or the add-on's,
// has its own address, so it never counts: Firefox reports its error pages under about:neterror.)
async function opened(details) {
  const site = await listedSite(details);
  if (!site) return;
  await note({ at: details.timeStamp ?? Date.now(), site, opened: true });
  sweepSoon(site);
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

// --- The picture filter ----------------------------------------------------------------------------------
// A page's content script (content.js) asks about each picture it shows; the picture is fetched here (the
// browser's cache usually has it), judged by the classifier (classifier.js), and the verdict sent back
// (lib/pictures.js). Verdicts are remembered by address, so a picture shown twice is judged once, and a
// hidden picture is noted in the record with its scores, so a wrong verdict can be seen and understood.
const MAX_REMEMBERED = 2000;
const judgments = new Map(); // address -> Promise<scores>, oldest first
let strictness = null; // Promise<string>
let judgedCount = 0; // since this script started, for the settings page
let hiddenCount = 0;
let failedCount = 0; // pictures that couldn't be fetched or decoded, and so were shown

function currentStrictness() {
  strictness ??= api.storage.local.get(STRICTNESS).then((stored) => strictnessOf(stored[STRICTNESS]));
  return strictness;
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STRICTNESS]) strictness = null;
});

function scoresFor(url) {
  if (!judgments.has(url)) {
    const scores = fetch(url, { credentials: 'include', cache: 'force-cache', redirect: 'follow' })
      .then((response) => {
        if (!response.ok) throw new Error(`the picture couldn't be fetched (${response.status})`);
        return response.blob();
      })
      .then((blob) => judgeBytes(blob, url))
      .then((scores) => {
        judgedCount += 1;
        return scores;
      });
    scores.catch(() => {
      failedCount += 1;
      judgments.delete(url); // not kept: next time may work (a passing network error)
    });
    judgments.set(url, scores);
    if (judgments.size > MAX_REMEMBERED) judgments.delete(judgments.keys().next().value);
  }
  return judgments.get(url);
}

const NOTE_SAME_WITHIN_MS = 60_000; // the same hidden picture on the same site is one note a minute

async function judgePicture(url, sender) {
  if (typeof url !== 'string' || !/^(?:https?|data):/i.test(url)) return { hide: false, reason: null };
  const [scores, setting] = await Promise.all([scoresFor(url), currentStrictness()]);
  const result = verdict(scores, setting);
  if (result.hide) {
    hiddenCount += 1;
    const site = hostOf(sender?.tab?.url ?? sender?.url ?? '') ?? 'unknown';
    const at = Date.now();
    writing = writing
      .then(async () => {
        const stored = (await api.storage.local.get(PICTURES))[PICTURES];
        const list = Array.isArray(stored) ? stored : [];
        const last = list[list.length - 1];
        if (last && last.site === site && last.url === url && at - last.at < NOTE_SAME_WITHIN_MS) return;
        await api.storage.local.set({ [PICTURES]: recordHidden(list, { at, site, url, reason: result.reason, scores }) });
      })
      .catch(() => {});
    await writing;
  }
  return { ...result, scores };
}

