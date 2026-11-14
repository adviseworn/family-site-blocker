// Blocking is done by the browser itself from the rules in rules/adult-1.json, adult-2.json, … and the
// list saved from the settings page. This script opens the settings page (right after the extension is
// installed, so the person can see whether anything still needs switching on, and when the toolbar button
// is clicked), sends a tab already showing a listed site to the block page when the lists change (the
// rules act only on page loads), keeps listed pages blocked while the browser hasn't given the extension
// access to websites (see "Access to websites" below), keeps the record of blocked attempts, and keeps
// track of when it is running (lib/watching.js), so the record can say whether the extension was ever
// off, and whether the Firefox lock was in force (lib/lock.js), so the record can say when it came and
// went, blocks every site while a bedtime lasts (lib/bedtime.js; see "Bedtime" below), and stops a listed
// site that is opened by another road, through a web proxy, a translation or an archive (lib/proxies.js;
// see "Web proxies" below). Chrome, Edge and Brave run it as a service worker; Firefox runs it as an event
// page. Both load it as a module (manifest.json: background.type).
import { ATTEMPTS, HISTORY_SCAN, bookmarksTo, hostOf, mergeVisits, record, sameVisit } from './lib/attempts.js';
import { BEDTIME, BEDTIME_EVENTS, ask, beginsSoon, blockedAt, endOf, keep, minutesAt, nextChange, pageFor, recordBedtime, settingOf, settle, timeWords, undo } from './lib/bedtime.js';
import { LOCK_CHANGES, locked, recordLock } from './lib/lock.js';
import { byAnotherRoad, proxyPageBlockRules, siteAt } from './lib/proxies.js';
import { COPIES, COPY_SIZE, PICTURES, PICTURE_LENGTH, SHOWN, STRICTNESS, URL_LENGTH, WAITING, bodyUpTo, copiesByKey, copyKey, hashOf, hideAgain, isPage, keepCopy, markAlike, noteLook, recordHidden, recordWaiting, sameHidden, settleWaiting, showAgain, shownAgain, strictnessOf, verdict } from './lib/pictures.js';
import { BEDTIME_PAGE, BLOCK_PAGE, PAGE_BLOCK_FIRST_ID, bedtimeRules, domainsOf, isBedtimeRule, pageBlockRules } from './lib/rules.js';
import { UNLISTED, tallyUnlisted } from './lib/suspects.js';
import { BEAT_EVERY_MINUTES, WATCHING, beat, earliestLiveTry, gapsOf, normalize, noteGaps, started } from './lib/watching.js';
import { backendInUse, judgeBytes } from './classifier.js';

const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.runtime.openOptionsPage();
  // Note when the extension first started watching here (lib/watching.js), then look through the history:
  // a new or updated copy may list sites that were visited before it was watching, and may find one of
  // them open in a tab (sweepTabs).
  if (reason === 'install' || reason === 'update') {
    firstStart(reason).then(() => scanHistory());
    sweepTabs().catch(() => {});
    syncBedtime({ remake: true }); // a new version makes a bedtime's rules afresh, in case it writes them differently
  }
});
// Each time the browser starts, too: the history may hold visits from a time the extension was off (in
// Firefox's Troubleshoot Mode, say, which a restart ends).
api.runtime.onStartup.addListener(() => scanHistory());
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// --- Blocked attempts ---------------------------------------------------------------------------------
// The browser reports every navigation; the ones to a listed site are noted (lib/attempts.js). The rules
// block those same navigations, so an attempt is noted whether the add-on's block page took over, or
// Firefox's own copy of the list stopped it first. If the site's page then loads anyway, the note says
// so: that means the blocking isn't working (the rules switched off, say). A try at a listed site by
// another road, and a try at a web proxy's page, are noted with the road (lib/proxies.js siteAt).

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

// The settings page says when the person's own list changes, so the lists are reread and the tabs swept
// for the site just added (sweepTabs); the browser also restarts this script after a short idle, so the
// lists are reread often anyway. It also asks for the history to be looked through again (the button on
// the page).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'list-changed') {
    domains = null;
    syncAccess(); // the page-blocking rules, if any are in place, are remade from the new list
    sweepTabs().catch(() => {});
  }
  if (message?.type === 'scan-history') scanHistory();
  if (message?.type === 'check-gaps') {
    // The record page asks before it shows when the extension was off, so the answer is current.
    checkGaps().then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'judge-picture') {
    judgePicture(message.url, sender, message.again === true).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true; // the answer comes later
  }
  if (message?.type === 'judge-video-frame') {
    judgeFrame(message, sender).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'picture-waiting') {
    // A page says a picture has had no verdict in a while, or has had one at last (content.js watched): noted in the record (noteWaiting).
    noteWaiting(message, sender);
    return undefined;
  }
  if (message?.type === 'picture-status') {
    sendResponse({ backend: backendInUse(), judged: judgedCount, second: secondCount, hidden: hiddenCount, failed: failedCount, frames: frameCount, videos: videoCount });
    return true;
  }
  if (message?.type === 'note-look' || message?.type === 'mark-hidden') {
    // The Every try page and the check page note looks at hidden pictures, and the marks given after them (lib/pictures.js).
    changeHidden(message).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'copies-index') {
    // The check page asks for the index of the copies, each with its hash (lib/pictures.js samePicture).
    copiesIndex().then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'bedtime-save' || message?.type === 'bedtime-keep' || message?.type === 'bedtime-undo') {
    // The settings page changes the bedtime through here, so that the setting and its record are written in turn (changeBedtime).
    changeBedtime(message).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'bedtime-state') {
    // The bedtime page asks whether the bedtime still lasts, having looked at the clock afresh (bedtimeState).
    bedtimeState(message.url).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'copy-picture') {
    // The Every try page asks for a copy, made now, of a hidden picture that has none kept (lib/pictures.js).
    copyNow(message.url).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
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

// --- When the extension is running ---------------------------------------------------------------------
// Firefox keeps no history of an add-on being switched off and on, so the extension keeps its own (see
// lib/watching.js): the moment it first started watching in this profile, and the stretches of time this
// script is known to have been running, from a note when it starts, on every page load it sees (tried,
// below) and once a minute from an alarm, which also wakes this script when the browser has put it to
// sleep. A silence longer than lib/watching.js's gap ends a stretch; what the browser's history holds from
// inside the silence then says whether the browser was in use while the extension wasn't running
// (checkGaps). When a silence ends, the history is looked through for what was missed meanwhile.
const HEARTBEAT = 'heartbeat';
const BEAT_FROM_PAGES_EVERY_MS = 5000; // page loads come in bursts; one look at the stored state in five seconds is plenty

/** Notes when the extension first started watching here: now on an install; for a profile updated from an earlier version, the first try that version noted. */
function firstStart(reason) {
  return (writing = writing
    .then(async () => {
      const stored = await api.storage.local.get([WATCHING, ATTEMPTS]);
      const now = Date.now();
      let state = stored[WATCHING];
      // On an install, this script's first beat came a moment before this event: the start is that beat.
      if (reason === 'install') state = started(state, Math.min(now, normalize(state).periods[0]?.from ?? now));
      else state = started(state, earliestLiveTry(stored[ATTEMPTS]) ?? now, { atLeast: true });
      await api.storage.local.set({ [WATCHING]: beat(state, now).state });
    })
    .catch(() => {}));
}

let lastBeatFromPage = 0;
/** Notes that this script is running now; the state is written when lib/watching.js says it is worth it. */
function noteRunning({ fromPage = false } = {}) {
  const now = Date.now();
  if (fromPage && now - lastBeatFromPage < BEAT_FROM_PAGES_EVERY_MS) return writing;
  lastBeatFromPage = now;
  return (writing = writing
    .then(async () => {
      const stored = (await api.storage.local.get(WATCHING))[WATCHING];
      const { state, changed } = beat(stored, Date.now());
      if (!changed) return;
      await api.storage.local.set({ [WATCHING]: state });
      // A silence has just ended: the extension was off, or the browser closed. The history says which, and holds what was missed.
      if (state.periods.length > (stored?.periods?.length ?? 0) && state.periods.length > 1 && !scanning) scanHistory();
    })
    .catch(() => {}));
}

api.alarms.onAlarm.addListener(({ name }) => {
  if (name === HEARTBEAT) noteRunning();
  // The clock is looked at for the bedtime at its own alarm, and each minute too, should that one come late (see "Bedtime" below).
  if (name === HEARTBEAT || name === BEDTIME_ALARM) syncBedtime();
});
api.alarms
  .get(HEARTBEAT)
  .then((alarm) => alarm ?? api.alarms.create(HEARTBEAT, { periodInMinutes: BEAT_EVERY_MINUTES }))
  .catch(() => {});
noteRunning(); // this script has just started (or been woken)

// --- The Firefox lock ------------------------------------------------------------------------------------
// Whether the Firefox lock is in force (lib/lock.js) can change only across a Firefox start: Firefox reads
// the policies the lock is made of when it starts, and answers management.getSelf() from them. This script
// starts with Firefox, so it asks at each of its own starts and notes what it finds in the lock's record
// when that differs from the last time (lib/lock.js recordLock); the first check of all is noted as what
// was found when the add-on began keeping track (1.22.0). Only Firefox has the lock, so only Firefox keeps
// the record; the settings page reads the same answer for its lock line, as of now, without noting it.
const isFirefox = api.runtime.getURL('').startsWith('moz-extension:');

function noteLock() {
  if (!isFirefox || typeof api.management?.getSelf !== 'function') return Promise.resolve();
  return (writing = writing
    .then(async () => {
      const found = locked(await api.management.getSelf());
      const stored = (await api.storage.local.get(LOCK_CHANGES))[LOCK_CHANGES];
      const updated = recordLock(stored, { at: Date.now(), locked: found });
      if (updated !== stored) await api.storage.local.set({ [LOCK_CHANGES]: updated });
    })
    .catch(() => {}));
}
noteLock(); // this script has just started, which in Firefox means Firefox may have

/**
 * Looks at each silence between the stretches this script was running: the pages the browser's history
 * holds from it, and the visits to listed sites the record holds from it (taken out of the history once
 * noted). lib/watching.js then notes the silences with something in them as times the extension was off,
 * and closes up the empty ones.
 */
async function checkGaps() {
  await noteRunning();
  const stored = await api.storage.local.get([WATCHING, ATTEMPTS]);
  const attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  const findings = [];
  for (const gap of gapsOf(stored[WATCHING])) {
    const items = await api.history.search({ text: '', startTime: gap.from, endTime: gap.to, maxResults: 100_000 });
    const pages = items.filter((item) => hostOf(item.url)).length; // web pages; not the block page or the settings pages
    const listed = attempts.filter((attempt) => attempt.from === 'history' && attempt.at > gap.from && attempt.at < gap.to).length;
    findings.push({ ...gap, pages, listed });
  }
  await (writing = writing
    .then(async () => {
      const current = (await api.storage.local.get(WATCHING))[WATCHING];
      const updated = noteGaps(current, findings);
      if (updated !== current) await api.storage.local.set({ [WATCHING]: updated });
    })
    .catch(() => {}));
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
        const found = siteAt(item.url, listed);
        if (!found) continue;
        pages.push(item.url);
        for (const visit of await api.history.getVisits({ url: item.url })) {
          if (!/subframe/.test(visit.transition ?? '')) visits.push({ ...found, at: visit.visitTime });
        }
      }
      unlisted = { at: started, sites: tallyUnlisted(items, listed) };
    } catch (failure) {
      error = String(failure?.message ?? failure);
    }
    await (writing = writing
      .then(async () => {
        const stored = await api.storage.local.get([ATTEMPTS, WATCHING]);
        const { attempts, found, added } = mergeVisits(stored[ATTEMPTS], visits);
        const taken = error ? { removed: 0, bookmarks: 0 } : await takeOut(pages, await listedDomains().catch(() => new Set()));
        const scan = { at: started, found, added, ...taken, ...(error ? { error } : {}) };
        await api.storage.local.set({
          // Visits found a moment ago fall inside the current stretch of running only if its end is written along with them.
          ...(added ? { [ATTEMPTS]: attempts, [WATCHING]: beat(stored[WATCHING], Date.now()).state } : {}),
          ...(unlisted ? { [UNLISTED]: unlisted } : {}),
          [HISTORY_SCAN]: scan,
        });
      })
      .catch(() => {}));
    // The same history says whether the browser was in use while the extension wasn't running.
    if (!error) await checkGaps();
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
// The sweep finds every page of the site, so the history may hold earlier visits the extension never saw
// (from a time it was off, say) that no look through the history has recorded yet: those go into the
// record first, as the scan does it, so nothing leaves the history unrecorded. Visits from the last few
// minutes are the try just noted (a page that got through is written to the history when it has loaded).
// The history is searched for the site's name; a try by another road (lib/proxies.js) can have the name
// coded in its address, where no search finds it, so the address tried is looked up as it is as well.
const SWEEP_AFTER_MS = 2500;
const SWEEP_SAME_MS = 300_000;
const sweeps = new Map(); // site -> { timer, urls: the addresses tried }, so a burst of tries at one site is one sweep

function sweepSoon(site, url) {
  const waiting = sweeps.get(site) ?? { timer: null, urls: new Set() };
  clearTimeout(waiting.timer);
  if (url) waiting.urls.add(url);
  waiting.timer = setTimeout(() => {
    sweeps.delete(site);
    sweep(site, waiting.urls).catch(() => {});
  }, SWEEP_AFTER_MS);
  sweeps.set(site, waiting);
}

async function sweep(site, urls = []) {
  const listed = await listedDomains();
  const pages = [];
  const visits = [];
  const recent = Date.now() - SWEEP_SAME_MS;
  const items = await api.history.search({ text: site, startTime: 0, maxResults: 100_000 });
  const searched = new Set(items.map((item) => item.url));
  for (const url of urls) if (!searched.has(url)) items.push({ url });
  for (const item of items) {
    const found = siteAt(item.url, listed);
    if (!found) continue;
    pages.push(item.url);
    for (const visit of await api.history.getVisits({ url: item.url }).catch(() => [])) {
      if (visit.visitTime < recent && !/subframe/.test(visit.transition ?? '')) visits.push({ ...found, at: visit.visitTime });
    }
  }
  if (visits.length) {
    await (writing = writing
      .then(async () => {
        const stored = await api.storage.local.get([ATTEMPTS, WATCHING]);
        const { attempts, added } = mergeVisits(stored[ATTEMPTS], visits, SWEEP_SAME_MS);
        if (added) await api.storage.local.set({ [ATTEMPTS]: attempts, [WATCHING]: beat(stored[WATCHING], Date.now()).state });
      })
      .catch(() => {}));
  }
  await takeOut(pages, listed);
}

/** Removes bookmarks to any listed site, by its own address or by another road, then the given pages from the history; returns how many of each. */
async function takeOut(pages, listed) {
  let bookmarks = 0;
  if (api.bookmarks && listed.size) {
    const tree = await api.bookmarks.getTree().catch(() => []);
    for (const bookmark of bookmarksTo(tree, listed, (url) => siteAt(url, listed)?.site ?? null)) {
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
// itself for addresses it guesses the person might open next. What comes back is what the address is to
// the lists (lib/proxies.js siteAt): the listed site, and the road to it when that isn't its own address.
const ownPage = ({ frameId, documentLifecycle }) => frameId === 0 && documentLifecycle !== 'prerender';
async function listedSite(details) {
  return ownPage(details) ? siteAt(details.url, await listedDomains()) : null;
}

// One visit, one note. The browser reports a page load several times over (the listeners below, and those
// under "Web proxies"), and on a slow device the reports come many seconds apart, so the clock can't tell
// them from a second try: what kind of report each is can, and what the tab has shown since
// (lib/attempts.js sameVisit). That is kept here for each tab, while this script runs.
const visits = new Map(); // tab id -> what sameVisit keeps of the visit the tab is making
api.tabs.onRemoved.addListener((tabId) => visits.delete(tabId));

/**
 * What a reported address is to the lists (null: nothing), and whether the report is of a visit already
 * noted. `kind` says which report it is, as sameVisit names them. Every report waits here on the lists and
 * on nothing else, so they are weighed in the order the browser sent them, whatever each does afterwards.
 */
async function reported(kind, details) {
  const found = siteAt(details.url, await listedDomains());
  if (!ownPage(details) || !(details.tabId >= 0)) return { found, again: false };
  const { again, visit } = sameVisit(visits.get(details.tabId), { kind, site: found?.site ?? null, at: details.timeStamp ?? Date.now(), request: details.requestId });
  if (visit) visits.set(details.tabId, visit);
  return { found, again };
}

async function tried(kind, details) {
  noteRunning({ fromPage: true }); // every page load the extension sees says it is running
  if (!ownPage(details)) return;
  const { found, again } = await reported(kind, details);
  if (!found) return;
  // Without access to websites the rules stop the page but can't put the block page in its place (see
  // "Access to websites" below): the tab is sent there from here. So is a try by another road, which the
  // rules may not see at all (see "Web proxies" below); during a bedtime its rules take the page instead.
  if (!(await hasAccess()) || (byAnotherRoad(found) && !(await bedtimeNow()).blocked)) api.tabs.update(details.tabId, { url: BLOCK_PAGE_URL }).catch(() => {});
  if (!again) await note({ ...found, at: details.timeStamp ?? Date.now() });
  sweepSoon(found.site, details.url);
}

// A listed site's page has loaded: the attempt got through. (A block page, Firefox's or the add-on's,
// has its own address, so it never counts: Firefox reports its error pages under about:neterror.) A page
// by another road is stopped from here, not by a rule, and can have loaded before it was: that one got
// through only if it can't be taken out of the tab now either.
async function opened(details) {
  const found = await listedSite(details);
  if (!found) return;
  if (byAnotherRoad(found) && (await replacePage(details))) return;
  await note({ ...found, at: details.timeStamp ?? Date.now(), opened: true });
  sweepSoon(found.site, details.url);
}

// Two reports of each navigation, because each misses some. The browser's navigation events see every
// page load that starts, including one Firefox's own copy of the list stops before any request is made;
// but Firefox now and then leaves out the first load in a brand-new tab. Its request events see every
// request that is made, even one the rules then redirect (they run before the rules). The two are one
// visit, noted once (reported, above).
const PAGES = { urls: ['<all_urls>'], types: ['main_frame'] };
api.webNavigation.onBeforeNavigate.addListener((details) => tried('start', details));
api.webRequest.onBeforeRequest.addListener((details) => tried('request', details), PAGES);
// A load that fails is no try, but it ends in the browser's own error page, under the address tried, and
// Chromium says nothing else of that page. A try after it is told by its request as a rule; one that is
// stopped before any request is made has only this to go by, and without it a third such try in a row
// would pass for the second one still on its way. A load that is only dropped is "net::ERR_ABORTED"
// there, and puts nothing in the tab; nor does a link to something that is no web page. Firefox reports
// its error page as a page at the address, so what it says here isn't weighed: it reports a load as
// dropped when it only moves to another process, and then as started again.
api.webNavigation.onErrorOccurred.addListener((details) => {
  if (isWebPage(details.url) && /^net::(?!ERR_ABORTED$)/.test(details.error ?? '')) reported('failed', details).catch(() => {});
});
api.webNavigation.onDOMContentLoaded.addListener(opened);
api.webNavigation.onCompleted.addListener(opened);
api.webRequest.onCompleted.addListener(opened, PAGES);

// --- Access to websites ----------------------------------------------------------------------------------
// The rules send a listed page to the block page by redirecting its load, and a browser lets an extension
// redirect a request only on a site it has given the extension access to. Chrome, Edge and Brave give that
// access when the extension is installed; Firefox can leave it off (on a phone, say), and then drops the
// redirect rule and tries no other: it picks the one rule that fits a request and only then asks whether
// the extension may act on it. So the page loaded. Blocking a request outright needs no access, so while
// access is missing, rules that block listed pages outright are kept ahead of the redirect ones
// (lib/rules.js pageBlockRules), the person's sites included, with the like for a web proxy's addresses
// (lib/proxies.js proxyPageBlockRules), and the tab is sent to the block page from here (tried, above) in
// place of the page that was stopped; they come off when access is given. They last
// the browser session, so they are put back each time this script starts, and remade when the lists
// change. The settings page says what still needs the access: the pictures aren't judged and safe search
// isn't turned on.
const BLOCK_PAGE_URL = api.runtime.getURL(BLOCK_PAGE);
const ALL_SITES = { origins: ['<all_urls>'] };
let access = null; // Promise<boolean>: whether the browser has given the extension access to websites
let syncing = Promise.resolve(); // one change to the page-blocking rules at a time

function hasAccess() {
  access ??= api.permissions.contains(ALL_SITES).catch(() => true); // can't tell: the rules are left as they are
  return access;
}

/** Puts the page-blocking rules in place while access is missing, remade from the lists, and takes them off once it is given. */
function syncAccess() {
  access = null;
  syncing = syncing
    .then(async () => {
      const dnr = api.declarativeNetRequest;
      const removeRuleIds = (await dnr.getSessionRules()).filter((rule) => rule.id >= PAGE_BLOCK_FIRST_ID).map((rule) => rule.id);
      const addRules = (await hasAccess()) ? [] : [...pageBlockRules([...(await listedDomains())]), ...proxyPageBlockRules()];
      if (removeRuleIds.length || addRules.length) await dnr.updateSessionRules({ removeRuleIds, addRules });
    })
    .catch(() => {});
  return syncing;
}
syncAccess(); // each time this script starts: the session's rules are gone after a restart, and the access may have changed
api.permissions.onAdded?.addListener(syncAccess);
api.permissions.onRemoved?.addListener(syncAccess);
// Bedtime's rules depend on the access too (see "Bedtime" below).
api.permissions.onAdded?.addListener(() => syncBedtime());
api.permissions.onRemoved?.addListener(() => syncBedtime());

// --- Tabs already showing a listed site ------------------------------------------------------------------
// The rules act on page loads, so a page open before its site was listed would stay as it is until it was
// loaded again. Instead, whenever the lists change (a site saved on the settings page or added from the
// record page, or a version installed with its built-in list), every tab showing a listed site is sent to
// the block page, as a load of it would be. The page is replaced in the tab's history rather than left
// behind it, so Back doesn't bring it back, and no request goes to the site. A page no script can run in
// (one that failed to load, say) is navigated to the block page instead. A listed site inside another
// page (a frame) is left as it is: a load of it is blocked outright, not sent to the block page, and
// nothing more can load into it. A tab showing a listed site by another road, or a web proxy's page
// (lib/proxies.js), is sent to the block page with the rest.
async function sweepTabs() {
  const listed = await listedDomains();
  const tabs = await api.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => siteAt(tab.url, listed))
      .map(async (tab) => {
        try {
          await api.scripting.executeScript({ target: { tabId: tab.id }, func: (url) => location.replace(url), args: [BLOCK_PAGE_URL] });
        } catch {
          await api.tabs.update(tab.id, { url: BLOCK_PAGE_URL }).catch(() => {});
        }
      }),
  );
}

// --- Web proxies -----------------------------------------------------------------------------------------
// A listed site can be opened by another road: through a web proxy, a translation or an archive, each of
// which fetches the site's page and shows it under an address of its own (lib/proxies.js, 1.31.0). The
// rules stop what they can see: the proxy sites on the built-in list, and every address of the shape the
// common proxy programs make (rules/proxies.json). The rest is done here, because only a script can read
// an address closely enough to find a listed site coded inside it, and because a proxy that serves its
// pages from a script of its own, kept in the browser (a service worker), makes no request for a rule to
// stop.
//
// A try by another road is noted and its tab sent to the block page as the load starts (tried, above).
// The load may win that race, and some pages come up with no load at all (an address the page writes for
// itself, Back to a page the browser kept whole, a page the browser loaded ahead of time), so whatever a
// tab comes to show is looked at again, and replaced by the block page (replacePage). A frame inside a
// page is emptied instead, and not noted, as a listed site in a frame is blocked and not noted.

/**
 * Puts the block page (the bedtime page, during a bedtime) in place of a page by another road that a tab
 * was seen to show at `url`, as sweepTabs does. Resolves to whether such a page is out of the tab: replaced
 * now, or gone already; false only when the tab still shows it and can't be sent anywhere.
 */
async function replacePage({ tabId, url }) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return true; // the tab is closed
  // What the tab shows by now is what counts: it may have moved on while this script was busy, to the block
  // page perhaps. The browser gives a tab's address only for a web page, so none means the tab shows
  // something else by now; unless there is no access to websites, when it gives none at all, and the
  // address reported stands.
  const showing = tab.url ?? ((await hasAccess()) ? null : url);
  if (!byAnotherRoad(siteAt(showing, await listedDomains()))) return true;
  const to = (await bedtimeNow()).blocked ? pageFor(BEDTIME_PAGE_URL, showing) : BLOCK_PAGE_URL;
  try {
    // The page itself says where it is before it goes, in case the tab moves on in the meantime.
    await api.scripting.executeScript({ target: { tabId }, func: (from, address) => location.href === from && location.replace(address), args: [showing, to] });
    return true;
  } catch {
    return api.tabs.update(tabId, { url: to }).then(() => true, () => false);
  }
}

/** Empties a frame that shows `url`. Where no script can run (without access to websites, that is everywhere), the tab itself is all that can be reached, and goes to the block page. */
async function emptyFrame({ tabId, frameId, url }) {
  try {
    await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: (from) => location.href === from && location.replace('about:blank'), args: [url] });
  } catch {
    if (!(await hasAccess())) await api.tabs.update(tabId, { url: BLOCK_PAGE_URL }).catch(() => {});
  }
}

/**
 * A tab or a frame has come to show an address: one by another road is taken out again, and noted if it is
 * the tab's own page and the visit isn't noted yet (reported, above: the load that brought the page was
 * noted as it started, as a rule, and the page then changes the tab's address, and its own as it pleases).
 * What a tab shows that is not a web page is weighed too, because the block page in a tab is what ends a visit.
 */
async function shown(kind, details) {
  if (details.documentLifecycle === 'prerender' || (details.frameId !== 0 && !isWebPage(details.url))) return;
  const { found, again } = await reported(kind, details);
  if (!byAnotherRoad(found)) return;
  if (details.frameId !== 0) return emptyFrame(details);
  await replacePage(details);
  if (!again) await note({ ...found, at: details.timeStamp ?? Date.now() });
  sweepSoon(found.site, details.url);
}
api.webNavigation.onCommitted.addListener((details) => shown('page', details));
api.webNavigation.onHistoryStateUpdated.addListener((details) => shown('address', details));
api.webNavigation.onReferenceFragmentUpdated.addListener((details) => shown('address', details));
// A page the browser loaded ahead of time takes over its tab with no navigation of the tab's own; the tab's address changes all the same.
api.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) shown('tab', { tabId, frameId: 0, url: change.url });
});

// --- Bedtime ---------------------------------------------------------------------------------------------
// Between the two times set on the settings page, every site is blocked (lib/bedtime.js, 1.30.0). The
// browser does the blocking, from rules this script puts in place when a bedtime begins and takes off
// when it ends (lib/rules.js bedtimeRules): a page being opened goes to the bedtime page (bedtime.html)
// with its own address after the #, and everything else a page could ask for is blocked. The rules are
// kept across a restart, so a browser opened during a bedtime blocks from its first page. The rules act on
// loads, so the tabs open are sent to the bedtime page as well, each with its address, to come back when
// the bedtime is over; so is a page that comes up without a load (Back to one the browser kept whole).
//
// This script looks at the clock (syncBedtime) when it starts, at an alarm set for the next moment
// anything changes (a bedtime's start, the warning before it, its end, a change that waits taking
// effect), once a minute with the heartbeat in case that alarm comes late (after the computer slept, say),
// and whenever the setting changes. For WARN_MS before a bedtime, the pages open say that it is coming, so
// that nothing half-written is lost to it.
//
// The settings page changes the setting through this script (changeBedtime), which writes it and its
// record in turn with the other writes. Nothing here stops someone changing the computer's clock.
const BEDTIME_ALARM = 'bedtime';
const BEDTIME_PAGE_URL = api.runtime.getURL(BEDTIME_PAGE);
const isWebPage = (url) => /^https?:/i.test(url ?? '');
// What the last look at the clock found: Promise<{ blocked, until, changes, soon }>, `until` when the blocking
// ends (null when nothing is blocked), `changes` the next moment anything does (null when nothing will) and
// `soon` the moment every site closes, when that is near enough for the pages open to be told (else null).
let bedtime = null;
let warnedOf = null; // the moment the pages open were last warned of, so the warning can be taken away

/**
 * Looks at the clock for the bedtime: see "Bedtime" above. Resolves to what it found. With { remake }, rules
 * in place for a bedtime are taken off and put back, as this version writes them.
 */
function syncBedtime({ remake = false } = {}) {
  bedtime = (async () => {
    const now = Date.now();
    let setting = settingOf(null);
    // A change that has waited out its day takes effect, with its entry in the record, dated when it did.
    await (writing = writing
      .then(async () => {
        const stored = await api.storage.local.get([BEDTIME, BEDTIME_EVENTS]);
        const settled = settle(stored[BEDTIME], now);
        setting = settled.setting;
        if (settled.changed) await api.storage.local.set({ [BEDTIME]: setting, ...(settled.events.length ? { [BEDTIME_EVENTS]: recordBedtime(stored[BEDTIME_EVENTS], settled.events) } : {}) });
      })
      .catch(() => {}));
    const blocked = blockedAt(setting, now);
    await (syncing = syncing
      .then(async () => {
        const dnr = api.declarativeNetRequest;
        const present = (await dnr.getDynamicRules()).filter(isBedtimeRule);
        const wanted = blocked ? bedtimeRules(BEDTIME_PAGE_URL, { access: await hasAccess() }) : [];
        const ids = (rules) => rules.map((rule) => rule.id).sort().join();
        if (ids(present) !== ids(wanted) || (remake && wanted.length)) await dnr.updateDynamicRules({ removeRuleIds: present.map((rule) => rule.id), addRules: wanted });
      })
      .catch(() => {}));
    const changes = nextChange(setting, now);
    // A moment past the minute, so that the clock reads the new minute when the alarm comes.
    if (changes === null) api.alarms.clear(BEDTIME_ALARM).catch(() => {});
    else api.alarms.create(BEDTIME_ALARM, { when: changes + 250 });
    const soon = blocked ? null : beginsSoon(setting, now);
    if (blocked) await sweepForBedtime().catch(() => {});
    // Each look tells the pages again, so that one opened since the last gets the line too.
    if (soon !== null || warnedOf !== null) await warnOfBedtime(soon).catch(() => {});
    return { blocked, until: blocked ? endOf(setting, now) : null, changes, soon };
  })();
  return bedtime;
}
syncBedtime(); // each time this script starts: a bedtime may have begun or ended while it wasn't running
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BEDTIME]) syncBedtime();
});

/** What the clock says of the bedtime now: the last look, or a fresh one when its time has passed. */
async function bedtimeNow() {
  const state = await (bedtime ?? syncBedtime());
  return state.changes !== null && Date.now() >= state.changes ? syncBedtime() : state;
}

/** Sends a tab to the bedtime page in place of the page it shows, as sweepTabs sends one to the block page. */
async function toBedtimePage(tabId, url) {
  const page = pageFor(BEDTIME_PAGE_URL, url);
  try {
    await api.scripting.executeScript({ target: { tabId }, func: (to) => location.replace(to), args: [page] });
  } catch {
    await api.tabs.update(tabId, { url: page }).catch(() => {});
  }
}

/**
 * Sends every tab showing a web page to the bedtime page. A tab the browser has put to sleep (one not opened
 * since the browser started, say) is left as it is: nothing is loaded in it, and opening it is a load, which
 * the rules send to the bedtime page.
 */
async function sweepForBedtime() {
  const tabs = await api.tabs.query({});
  await Promise.all(tabs.filter((tab) => isWebPage(tab.url) && !tab.discarded).map((tab) => toBedtimePage(tab.id, tab.url)));
}

/**
 * Tells the pages open that every site closes at `start` (a line along the foot of each, with how many
 * minutes are left, which can be dismissed), or one tab's page alone, given `tabId`; or, with nothing about
 * to close (`start` null: the change was undone, say), takes the line away again.
 */
async function warnOfBedtime(start, tabId = null) {
  const tabs = tabId === null ? (await api.tabs.query({})).filter((tab) => isWebPage(tab.url) && !tab.discarded) : [{ id: tabId }];
  const closes = start === null ? null : timeWords(minutesAt(start));
  if (tabId === null) warnedOf = start;
  await Promise.all(tabs.map((tab) => api.scripting.executeScript({ target: { tabId: tab.id }, func: bedtimeLine, args: [start, closes] }).catch(() => {})));
}

/**
 * Runs in a page (warnOfBedtime): shows a line along the page's foot that says every site closes at
 * `closes`, the time in words, and in how many minutes, counted down by the page itself until `start`,
 * with a button that takes the line away for that bedtime; leaves a line already there for it as it is;
 * or, with no `start`, takes the line away. A minute after `start` the line goes by itself, should the
 * bedtime have been called off with nobody to say so. It is styled from here alone, so that the page's
 * own styles leave it be.
 */
function bedtimeLine(start, closes) {
  const ID = 'family-site-blocker-bedtime-line';
  const state = (globalThis.familySiteBlockerBedtimeLine ??= { start: null, dismissed: null, timer: null });
  const clear = () => {
    clearInterval(state.timer);
    state.timer = null;
    state.start = null;
    document.getElementById(ID)?.remove();
  };
  if (start === null || state.dismissed === start) {
    clear();
    return;
  }
  if (state.start === start && document.getElementById(ID)) return;
  clear();
  const words = () => {
    const minutes = Math.max(1, Math.ceil((start - Date.now()) / 60_000));
    return `Bedtime in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}: every site closes at ${closes}.`;
  };
  const line = document.createElement('div');
  line.id = ID;
  line.setAttribute('role', 'status');
  line.style.cssText =
    'all: initial; position: fixed; z-index: 2147483647; left: 0; right: 0; bottom: 0; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 10px 16px; background: #17302a; color: #ffffff; font: 600 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);';
  const text = document.createElement('span');
  text.style.cssText = 'all: initial; color: inherit; font: inherit;';
  text.textContent = words();
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.style.cssText = 'all: initial; padding: 4px 12px; border: 1px solid #ffffff; border-radius: 6px; color: inherit; font: inherit; cursor: pointer;';
  dismiss.addEventListener('click', () => {
    state.dismissed = start;
    clear();
  });
  line.append(text, dismiss);
  document.documentElement.append(line);
  state.start = start;
  state.timer = setInterval(() => {
    if (Date.now() > start + 60_000) clear();
    else text.textContent = words();
  }, 5000);
}

// A web page that comes up in a tab during a bedtime without a load the rules could stop (Back to a page
// the browser kept whole) is sent to the bedtime page; and without access to websites, where the rules
// can only stop a page (see "Access to websites" above), the tab is sent there as the load starts, unless
// the site is a listed one, whose tab goes to the block page (tried, above).
async function atBedtime(details, { loadStarting = false } = {}) {
  if (details.frameId !== 0 || details.documentLifecycle === 'prerender' || !isWebPage(details.url)) return;
  if (!(await bedtimeNow()).blocked) return;
  if (loadStarting) {
    if (!(await hasAccess()) && !(await listedSite(details))) api.tabs.update(details.tabId, { url: pageFor(BEDTIME_PAGE_URL, details.url) }).catch(() => {});
  } else toBedtimePage(details.tabId, details.url);
}
api.webNavigation.onBeforeNavigate.addListener((details) => atBedtime(details, { loadStarting: true }));
api.webNavigation.onCommitted.addListener((details) => atBedtime(details));
// A page that finishes loading while the pages open are being told that every site closes soon is told too.
api.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0 || !isWebPage(details.url)) return;
  const { soon } = await bedtimeNow();
  if (soon !== null) warnOfBedtime(soon, details.tabId).catch(() => {});
});

/**
 * Changes the bedtime for the settings page: { type: 'bedtime-save', on, from, to, why } sets it or asks
 * for the change (lib/bedtime.js ask), 'bedtime-keep' takes back a change that waits and 'bedtime-undo'
 * undoes the last one that held at once. The setting and the record's entry are written here, in turn with
 * the other writes, and the clock looked at before the answer goes back, so that the rules are in place
 * by then. Answers { event: the entry's kind, or null } when something changed, { unchanged: true }, or
 * { error } in words for the page.
 */
function changeBedtime({ type, on, from, to, why }) {
  const now = Date.now();
  const result = writing.then(async () => {
    const stored = await api.storage.local.get([BEDTIME, BEDTIME_EVENTS]);
    const settled = settle(stored[BEDTIME], now);
    const outcome = type === 'bedtime-save' ? ask(settled.setting, { on, from, to }, { now, why }) : type === 'bedtime-keep' ? keep(settled.setting, { now }) : undo(settled.setting, { now });
    if (!outcome.setting) return outcome;
    const entries = [...settled.events, ...(outcome.event ? [outcome.event] : [])];
    await api.storage.local.set({ [BEDTIME]: outcome.setting, ...(entries.length ? { [BEDTIME_EVENTS]: recordBedtime(stored[BEDTIME_EVENTS], entries) } : {}) });
    return { event: outcome.event?.event ?? null };
  });
  writing = result.catch(() => {});
  return result.then(async (answer) => {
    await syncBedtime();
    return answer;
  });
}

/**
 * For the bedtime page: whether the bedtime still lasts and until when, from a fresh look at the clock, which
 * takes the rules off first when it is over, so that the page can go back to the address it stands in for;
 * and whether that address is a listed site's, by its own address or by another road (lib/proxies.js), which
 * the page then leaves to the block page.
 */
async function bedtimeState(url) {
  const { blocked, until } = await syncBedtime();
  const listed = Boolean(siteAt(url ?? '', await listedDomains().catch(() => new Set())));
  return { blocked, until, listed };
}

// --- The picture filter ----------------------------------------------------------------------------------
// A page's content script (content.js) asks about each picture it shows; the picture is fetched here (the
// browser's cache usually has it), judged by the classifier (classifier.js), and the verdict sent back
// (lib/pictures.js). From 1.20.0 a picture the first judge would hide is judged again by the second, the
// bigger model, whose verdict decides: the first is quick but hides ordinary photos by mistake, the second
// is slow and so only looks at what the first found. Verdicts are remembered by address, so a picture
// shown twice is judged once, and a hidden picture is noted in the record with the deciding scores, so a
// wrong verdict can be seen and understood, and the picture marked hidden by mistake, after which it is
// shown again (judgePicture below). A verdict that is slow in coming, or never comes, is noted too (1.27.0):
// the page says when it has waited WAIT_MS (content.js), and what this script was doing for the picture at
// that moment goes into the note (noteWaiting, underWay), so a picture left blank can be understood.
// For a video, the content script sends frames as it plays (small JPEGs, as data: addresses), which are
// judged the same way but not remembered: no two frames are alike, and a frame has no address.
const MAX_REMEMBERED = 2000;
const judgments = new Map(); // address -> Promise<scores> from the first judge, oldest first
const secondOpinions = new Map(); // the same from the second judge, for pictures the first would hide (1.20.0)
let strictness = null; // Promise<string>
let judgedCount = 0; // since this script started, for the settings page
let secondCount = 0; // pictures judged a second time
let hiddenCount = 0;
let failedCount = 0; // pictures that couldn't be fetched or decoded, and so were shown
let frameCount = 0; // video frames judged
let videoCount = 0; // videos hidden

// What this script is doing for each address a page waits on, for the record of pictures that waited
// (lib/pictures.js WAITING, 1.27.0): address -> { asked: how many judgments of it are under way, stage: one
// of lib/pictures.js STAGES' keys }. Gone once the last judgment of the address has answered.
const underWay = new Map();

/** Marks what this script is doing for an address while a judgment of it is under way. */
function stageOf(url, stage) {
  const state = underWay.get(url);
  if (state) state.stage = stage;
}

/** Runs a judgment of an address with the address marked under way, so that noteWaiting can say what this script was doing for it. */
async function underway(url, run) {
  const state = underWay.get(url) ?? { asked: 0, stage: 'fetching' };
  underWay.set(url, state);
  state.asked += 1;
  try {
    return await run();
  } finally {
    state.asked -= 1;
    if (state.asked === 0 && underWay.get(url) === state) underWay.delete(url);
  }
}

function currentStrictness() {
  strictness ??= api.storage.local.get(STRICTNESS).then((stored) => strictnessOf(stored[STRICTNESS]));
  return strictness;
}
let shownPictures = null; // Promise<list>: the pictures marked hidden by mistake, shown again (lib/pictures.js SHOWN)
function shownList() {
  shownPictures ??= api.storage.local.get(SHOWN).then((stored) => (Array.isArray(stored[SHOWN]) ? stored[SHOWN] : []));
  return shownPictures;
}
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STRICTNESS]) strictness = null;
  if (changes[SHOWN]) shownPictures = null;
});

function scoresFor(url, judge = 'first') {
  const remembered = judge === 'second' ? secondOpinions : judgments;
  if (!remembered.has(url)) {
    stageOf(url, judge === 'second' ? 'second' : 'fetching');
    const scores = pictureBytes(url)
      .then((blob) => {
        stageOf(url, judge === 'second' ? 'second' : 'judging');
        return judgeBytes(blob, url, judge);
      })
      .then((scores) => {
        if (judge === 'second') secondCount += 1;
        else judgedCount += 1;
        return scores;
      });
    scores.catch(() => {
      if (judge === 'first') failedCount += 1;
      remembered.delete(url); // not kept: next time may work (a passing network error)
    });
    remembered.set(url, scores);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
  }
  return remembered.get(url);
}

const NOTE_SAME_WITHIN_MS = 60_000; // the same hidden picture on the same site is one note a minute

/**
 * Notes a hidden picture or video in the record, unless the same one was noted a moment ago. For a
 * picture, `copy` makes a smaller copy of it to keep apart from the record (lib/pictures.js keepCopy), so
 * that the Every try page can show it whatever becomes of its address (1.17.4); it is made only when the
 * picture is noted, and a copy that can't be made (the picture gone from its address already, say) is no
 * loss to the note. A copy made already (judgePicture makes one to tell a picture shown again) is given as it is.
 */
function noteHidden({ site, url, kind, reason, scores, copy = null }) {
  const at = Date.now();
  const kept = String(url ?? '').slice(0, URL_LENGTH); // the address as the record keeps it
  writing = writing
    .then(async () => {
      const stored = (await api.storage.local.get(PICTURES))[PICTURES];
      const list = Array.isArray(stored) ? stored : [];
      const last = list[list.length - 1];
      if (last && last.site === site && last.url === kept && at - last.at < NOTE_SAME_WITHIN_MS) return;
      await api.storage.local.set({ [PICTURES]: recordHidden(list, { at, site, url, reason, scores, kind }) });
      const made = typeof copy === 'function' ? await copy().catch(() => null) : copy;
      if (!made) return;
      const { index, key, remove } = keepCopy((await api.storage.local.get(COPIES))[COPIES], { at, url: kept, copy: made });
      await api.storage.local.set({ [COPIES]: index, [key]: made });
      if (remove.length) await api.storage.local.remove(remove);
    })
    .catch(() => {});
  return writing;
}

/** The fetch a picture is judged from, and copied from: with the browser's cookies, from its cache when it has it. */
const fetchPicture = (url, options = {}) => fetch(url, { credentials: 'include', cache: 'force-cache', redirect: 'follow', ...options });

/**
 * The picture at an address, fetched whole (fetchPicture) to be judged or copied: a Blob of its bytes,
 * read only up to PICTURE_LENGTH of them (1.18.3). A bigger one is an error, as one that can't be
 * fetched is: shown without being judged, and not copied. Read whole, however big, it could fill the
 * add-on's memory, which in Firefox this script shares with every one of the add-on's pages.
 */
async function pictureBytes(url, options = {}) {
  const response = await fetchPicture(url, options);
  if (!response.ok) throw new Error(`the picture couldn't be fetched (${response.status})`);
  const blob = await bodyUpTo(response, PICTURE_LENGTH);
  if (!blob) throw new Error(`the picture is bigger than ${PICTURE_LENGTH / 1_000_000} MB`);
  return blob;
}

const KEEP_WAIT_MS = 10_000; // how long a hidden picture's address is given to answer again, whole, for the copy kept

/**
 * A smaller copy of the picture at an address, fetched again (from the cache, after the judge's fetch),
 * to keep with the record. Given KEEP_WAIT_MS, no more: it is made in turn with the record's other
 * changes (noteHidden), which wait for it, as a look from the Every try page does.
 */
async function smallCopy(url) {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), KEEP_WAIT_MS);
  try {
    return await smallCopyOf(await pictureBytes(url, { signal: giveUp.signal }));
  } finally {
    clearTimeout(timer);
  }
}

const COPY_WAIT_MS = 20_000; // how long a picture's address is given to answer a copy made now, and to send the picture whole

/**
 * For the Every try page: a copy made now of the picture at an address, for a hidden picture that has no
 * copy kept (hidden before 1.17.4, or among the oldest, let go): { copy } as smallCopyOf makes it,
 * { page: true } when the address answers with a page (which a video the page made itself is noted under),
 * told from the answer's content type before a byte of it is read, or { error } in the page's words when
 * it can't be had. Fetched here, as the picture was fetched to be judged, rather than from the page, and
 * read only up to PICTURE_LENGTH bytes, within COPY_WAIT_MS.
 */
async function copyNow(url) {
  if (typeof url !== 'string' || !/^(?:https?|data):/i.test(url)) return { error: 'its address isn’t one that can be fetched' };
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), COPY_WAIT_MS);
  try {
    let response;
    try {
      response = await fetchPicture(url, { signal: giveUp.signal });
    } catch (error) {
      return { error: giveUp.signal.aborted ? `its address didn’t answer in ${COPY_WAIT_MS / 1000} seconds` : `its address couldn’t be reached (${error.message})` };
    }
    if (!response.ok) return { error: `it couldn’t be fetched (${response.status})` };
    if (isPage(response.headers.get('content-type'))) {
      giveUp.abort(); // the page itself is not wanted
      return { page: true };
    }
    let blob;
    try {
      blob = await bodyUpTo(response, PICTURE_LENGTH);
    } catch (error) {
      return { error: giveUp.signal.aborted ? `it didn’t arrive whole in ${COPY_WAIT_MS / 1000} seconds` : `it couldn’t be fetched whole (${error.message})` };
    }
    if (!blob) return { error: `it is bigger than ${PICTURE_LENGTH / 1_000_000} MB` };
    try {
      return { copy: await smallCopyOf(blob) };
    } catch {
      return { error: 'not a picture this browser can show' };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A smaller copy of a picture, for the record (lib/pictures.js keepCopy) or for a look: a JPEG at most
 * COPY_SIZE on its longer side (a smaller picture is copied at its own size), as a data: address.
 */
async function smallCopyOf(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, COPY_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // a JPEG has no see-through parts: they come out white, as on a page
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${jpeg.type};base64,${btoa(binary)}`;
  } finally {
    bitmap.close();
  }
}

/**
 * Changes hidden pictures' entries for the add-on's pages (tries.js, check.js): looks at them from there
 * ({ type: 'note-look', keys: [{ at, url }, …], why }, or one key as at and url) or the mark given after
 * one ({ type: 'mark-hidden', keys, mistake }), which goes to every other row showing the same picture
 * too (lib/pictures.js markAlike), written here, in turn with the notes of pictures just hidden, so that
 * neither is lost. A mark changes the list of pictures shown again with it (lib/pictures.js showAgain,
 * hideAgain; 1.19.0): the pictures marked hidden by mistake go on it, and the pages open are told, so that
 * one hidden on a page shows at once (content.js); those marked rightly hidden come off it. Answers
 * { found: whether any key names an entry still in the record (the oldest go once it is full), count: how
 * many do, alike: how many other rows were marked with them }.
 */
function changeHidden({ type, keys, at, url, why, mistake }) {
  const now = Date.now();
  const named = Array.isArray(keys) ? keys.map((key) => ({ at: key?.at, url: key?.url })) : [{ at, url }];
  const result = writing.then(async () => {
    const stored = await api.storage.local.get([PICTURES, COPIES, SHOWN]);
    const list = Array.isArray(stored[PICTURES]) ? stored[PICTURES] : [];
    const present = named.filter((key) => list.some((entry) => sameHidden(entry, key)));
    let changed = list;
    let alike = 0;
    let shown = null;
    if (type === 'note-look') for (const key of present) changed = noteLook(changed, key, { at: now, why });
    else {
      const copies = copiesByKey(await hashedIndex(stored[COPIES]));
      let marked;
      ({ record: changed, alike, marked } = markAlike(list, present, { at: now, mistake }, copies));
      if (marked.length) shown = mistake ? showAgain(stored[SHOWN], marked, copies, now) : hideAgain(stored[SHOWN], marked, copies);
    }
    if (present.length) await api.storage.local.set({ [PICTURES]: changed, ...(shown ? { [SHOWN]: shown } : {}) });
    if (shown) {
      shownPictures = Promise.resolve(shown); // for the next judgment, before the storage says it changed
      if (mistake) tellPagesShownAgain();
    }
    return { found: present.length > 0, count: present.length, alike };
  });
  writing = result.catch(() => {});
  return result;
}

/** Tells every page open that a picture is shown again, so that its content script judges again what it hid there (content.js); a page without one, or gone, is passed over. */
async function tellPagesShownAgain() {
  const tabs = await api.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map((tab) => Promise.resolve(api.tabs.sendMessage(tab.id, { type: 'shown-again' })).catch(() => {})));
}

/**
 * The index of the copies with a hash for each (lib/pictures.js samePicture): the copies kept by 1.17.4
 * were indexed without one, so those are read and hashed once, and the index written back (a copy gone
 * from storage gets an empty hash, which matches nothing).
 */
async function hashedIndex(index) {
  const list = Array.isArray(index) ? index : [];
  const missing = list.filter((entry) => typeof entry?.hash !== 'string');
  if (missing.length === 0) return list;
  const copies = await api.storage.local.get(missing.map(copyKey));
  const hashed = list.map((entry) => (typeof entry?.hash === 'string' ? entry : { ...entry, hash: typeof copies[copyKey(entry)] === 'string' ? hashOf(copies[copyKey(entry)]) : '' }));
  await api.storage.local.set({ [COPIES]: hashed });
  return hashed;
}

/** The index of the copies, each with its hash, for the check page: read in turn with the writes, so that none is lost. */
function copiesIndex() {
  const result = writing.then(async () => hashedIndex((await api.storage.local.get(COPIES))[COPIES]));
  writing = result.catch(() => {});
  return result;
}

const siteOf = (sender) => hostOf(sender?.tab?.url ?? sender?.url ?? '') ?? 'unknown';

/**
 * The verdict on the picture at an address, for the page's content script: { hide, reason, scores }. A
 * picture the judge would hide is shown all the same, with shown: true, when it is one marked hidden by
 * mistake on the add-on's pages (lib/pictures.js shownAgain; 1.19.0): known by its address, or, when the
 * list holds a copy to know a picture by, by a copy made now of this one, which is kept with the record
 * when the picture is hidden after all. Asked `again`, about a picture hidden on the page already
 * (content.js, when one has been marked), a picture hidden still is not noted a second time.
 */
async function judgePicture(url, sender, again = false) {
  if (typeof url !== 'string' || !/^(?:https?|data):/i.test(url)) return { hide: false, reason: null };
  return underway(url, () => judgeAddress(url, sender, again));
}

/** judgePicture's work, with the address marked under way (underway) and the stage noted as it goes (stageOf). */
async function judgeAddress(url, sender, again) {
  const [first, setting] = await Promise.all([scoresFor(url), currentStrictness()]);
  let result = verdict(first, setting);
  if (!result.hide) return { ...result, scores: first };
  // The second opinion (1.20.0): the bigger model judges a picture the first would hide, and decides. When
  // it can't (its model didn't load, say), the first verdict stands, and the picture is hidden.
  stageOf(url, 'second');
  const second = await scoresFor(url, 'second').catch(() => null);
  const scores = second ?? first;
  const opinions = second ? { scores, first } : { scores };
  if (second) {
    result = verdict(second, setting);
    if (!result.hide) return { ...result, ...opinions };
  }
  const shown = await shownList();
  let copy = null;
  if (shownAgain(shown, { url })) return { hide: false, reason: null, ...opinions, shown: true };
  if (shown.some((entry) => entry?.copy)) {
    stageOf(url, 'copying');
    copy = await smallCopy(url).catch(() => null);
    if (copy && shownAgain(shown, { copy })) return { hide: false, reason: null, ...opinions, shown: true };
  }
  if (again) return { ...result, ...opinions };
  hiddenCount += 1;
  stageOf(url, 'noting');
  await noteHidden({ site: siteOf(sender), url, reason: result.reason, scores, copy: copy ?? (() => smallCopy(url)) });
  return { ...result, ...opinions };
}

/**
 * Notes a picture that has had no verdict in a while, in the record of pictures that waited (lib/pictures.js
 * WAITING, 1.27.0), with what this script is doing for its address (underWay), or, with `outcome` given,
 * that the verdict came after all and what it was; written in turn with the record's other changes. The
 * page's content script sends both (content.js watched).
 */
function noteWaiting({ url, waited, outcome, kind }, sender) {
  if (typeof url !== 'string') return Promise.resolve();
  const at = Date.now();
  const site = siteOf(sender);
  const stage = underWay.get(url)?.stage ?? null;
  writing = writing
    .then(async () => {
      const stored = (await api.storage.local.get(WAITING))[WAITING];
      const list = Array.isArray(stored) ? stored : [];
      const updated = outcome ? settleWaiting(list, { site, url, waited, outcome }) : recordWaiting(list, { at, site, url, waited, stage, kind });
      if (updated !== list) await api.storage.local.set({ [WAITING]: updated });
    })
    .catch(() => {});
  return writing;
}

// A frame of a video, judged like a picture (the second judge deciding when the first would hide it) but
// not remembered. A verdict to hide is noted under an address someone can open: the video's own if it has
// one (not a blob: the page made), else its poster's, else the page's.
async function judgeFrame({ frame, src, poster }, sender) {
  if (typeof frame !== 'string' || !/^data:image\//i.test(frame)) return { hide: false, reason: null };
  // Marked under way by the address the page's content script watches the frame under (content.js): the video's, its poster's or its page's.
  const watchedAs = [src, poster, sender?.url ?? sender?.tab?.url ?? ''].find((address) => /^https?:/i.test(address ?? '')) ?? '';
  return underway(watchedAs, async () => {
    stageOf(watchedAs, 'judging');
    const [blob, setting] = await Promise.all([fetch(frame).then((response) => response.blob()), currentStrictness()]);
    let scores;
    try {
      scores = await judgeBytes(blob, 'video-frame');
    } catch (error) {
      failedCount += 1;
      throw error;
    }
    frameCount += 1;
    let result = verdict(scores, setting);
    if (result.hide) {
      stageOf(watchedAs, 'second');
      const second = await judgeBytes(blob, 'video-frame', 'second').catch(() => null);
      if (second) {
        scores = second;
        result = verdict(second, setting);
      }
    }
    if (result.hide) {
      videoCount += 1;
      const page = sender?.tab?.url ?? sender?.url ?? '';
      const url = [src, poster, page].find((address) => /^https?:/i.test(address ?? '')) ?? page;
      stageOf(watchedAs, 'noting');
      await noteHidden({ site: siteOf(sender), url, kind: 'video', reason: result.reason, scores });
    }
    return { ...result, scores };
  });
}

