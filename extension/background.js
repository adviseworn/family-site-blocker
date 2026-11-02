// Blocking is done by the browser itself from the rules in rules/adult.json and the list saved from the
// settings page. This script opens the settings page (right after the extension is installed, so the
// person can see whether anything still needs switching on, and when the toolbar button is clicked),
// sends a tab already showing a listed site to the block page when the lists change (the rules act only
// on page loads), keeps the record of blocked attempts, and keeps track of when it is running
// (lib/watching.js), so the record can say whether the extension was ever off. Chrome, Edge and Brave run
// it as a service worker; Firefox runs it as an event page. Both load it as a module (manifest.json:
// background.type).
import { ATTEMPTS, HISTORY_SCAN, bookmarksTo, hostOf, listedDomain, mergeVisits, record } from './lib/attempts.js';
import { COPIES, COPY_SIZE, PICTURES, STRICTNESS, URL_LENGTH, keepCopy, markHidden, noteLook, recordHidden, sameHidden, strictnessOf, verdict } from './lib/pictures.js';
import { BLOCK_PAGE, domainsOf } from './lib/rules.js';
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

// The settings page says when the person's own list changes, so the lists are reread and the tabs swept
// for the site just added (sweepTabs); the browser also restarts this script after a short idle, so the
// lists are reread often anyway. It also asks for the history to be looked through again (the button on
// the page).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'list-changed') {
    domains = null;
    sweepTabs().catch(() => {});
  }
  if (message?.type === 'scan-history') scanHistory();
  if (message?.type === 'check-gaps') {
    // The record page asks before it shows when the extension was off, so the answer is current.
    checkGaps().then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'judge-picture') {
    judgePicture(message.url, sender).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true; // the answer comes later
  }
  if (message?.type === 'judge-video-frame') {
    judgeFrame(message, sender).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'picture-status') {
    sendResponse({ backend: backendInUse(), judged: judgedCount, hidden: hiddenCount, failed: failedCount, frames: frameCount, videos: videoCount });
    return true;
  }
  if (message?.type === 'note-look' || message?.type === 'mark-hidden') {
    // The Every try page notes a look at a hidden picture, and the mark given after it (lib/pictures.js).
    changeHidden(message).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
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
});
api.alarms
  .get(HEARTBEAT)
  .then((alarm) => alarm ?? api.alarms.create(HEARTBEAT, { periodInMinutes: BEAT_EVERY_MINUTES }))
  .catch(() => {});
noteRunning(); // this script has just started (or been woken)

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
const SWEEP_AFTER_MS = 2500;
const SWEEP_SAME_MS = 300_000;
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
  const visits = [];
  const recent = Date.now() - SWEEP_SAME_MS;
  for (const item of await api.history.search({ text: site, startTime: 0, maxResults: 100_000 })) {
    const found = listedDomain(hostOf(item.url), listed);
    if (!found) continue;
    pages.push(item.url);
    for (const visit of await api.history.getVisits({ url: item.url }).catch(() => [])) {
      if (visit.visitTime < recent && !/subframe/.test(visit.transition ?? '')) visits.push({ at: visit.visitTime, site: found });
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
  noteRunning({ fromPage: true }); // every page load the extension sees says it is running
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

// --- Tabs already showing a listed site ------------------------------------------------------------------
// The rules act on page loads, so a page open before its site was listed would stay as it is until it was
// loaded again. Instead, whenever the lists change (a site saved on the settings page or added from the
// record page, or a version installed with its built-in list), every tab showing a listed site is sent to
// the block page, as a load of it would be. The page is replaced in the tab's history rather than left
// behind it, so Back doesn't bring it back, and no request goes to the site. A page no script can run in
// (one that failed to load, say) is navigated to the block page instead. A listed site inside another
// page (a frame) is left as it is: a load of it is blocked outright, not sent to the block page, and
// nothing more can load into it.
const BLOCK_PAGE_URL = api.runtime.getURL(BLOCK_PAGE);

async function sweepTabs() {
  const listed = await listedDomains();
  const tabs = await api.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => listedDomain(hostOf(tab.url), listed))
      .map(async (tab) => {
        try {
          await api.scripting.executeScript({ target: { tabId: tab.id }, func: (url) => location.replace(url), args: [BLOCK_PAGE_URL] });
        } catch {
          await api.tabs.update(tab.id, { url: BLOCK_PAGE_URL }).catch(() => {});
        }
      }),
  );
}

// --- The picture filter ----------------------------------------------------------------------------------
// A page's content script (content.js) asks about each picture it shows; the picture is fetched here (the
// browser's cache usually has it), judged by the classifier (classifier.js), and the verdict sent back
// (lib/pictures.js). Verdicts are remembered by address, so a picture shown twice is judged once, and a
// hidden picture is noted in the record with its scores, so a wrong verdict can be seen and understood.
// For a video, the content script sends frames as it plays (small JPEGs, as data: addresses), which are
// judged the same way but not remembered: no two frames are alike, and a frame has no address.
const MAX_REMEMBERED = 2000;
const judgments = new Map(); // address -> Promise<scores>, oldest first
let strictness = null; // Promise<string>
let judgedCount = 0; // since this script started, for the settings page
let hiddenCount = 0;
let failedCount = 0; // pictures that couldn't be fetched or decoded, and so were shown
let frameCount = 0; // video frames judged
let videoCount = 0; // videos hidden

function currentStrictness() {
  strictness ??= api.storage.local.get(STRICTNESS).then((stored) => strictnessOf(stored[STRICTNESS]));
  return strictness;
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STRICTNESS]) strictness = null;
});

function scoresFor(url) {
  if (!judgments.has(url)) {
    const scores = fetchPicture(url)
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

/**
 * Notes a hidden picture or video in the record, unless the same one was noted a moment ago. For a
 * picture, `copy` makes a smaller copy of it to keep apart from the record (lib/pictures.js keepCopy), so
 * that the Every try page can show it whatever becomes of its address (1.17.4); it is made only when the
 * picture is noted, and a copy that can't be made (the picture gone from its address already, say) is no
 * loss to the note.
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
      const made = copy ? await copy().catch(() => null) : null;
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

/** A smaller copy of the picture at an address, fetched again (from the cache, after the judge's fetch). */
async function smallCopy(url) {
  const response = await fetchPicture(url);
  if (!response.ok) throw new Error(`the picture couldn't be fetched (${response.status})`);
  return smallCopyOf(await response.blob());
}

const COPY_WAIT_MS = 20_000; // how long a picture's address is given to answer a copy made now

/**
 * For the Every try page: a copy made now of the picture at an address, for a hidden picture that has no
 * copy kept (hidden before 1.17.4, or among the oldest, let go): { copy } as smallCopyOf makes it,
 * { page: true } when the address answers with a page (which a video the page made itself is noted under),
 * or { error } in the page's words when it can't be had. Fetched here, as the picture was fetched to be
 * judged, rather than from the page.
 */
async function copyNow(url) {
  if (typeof url !== 'string' || !/^(?:https?|data):/i.test(url)) return { error: 'its address isn’t one that can be fetched' };
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), COPY_WAIT_MS);
  let response;
  try {
    response = await fetchPicture(url, { signal: giveUp.signal });
  } catch (error) {
    return { error: giveUp.signal.aborted ? `its address didn’t answer in ${COPY_WAIT_MS / 1000} seconds` : `its address couldn’t be reached (${error.message})` };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return { error: `it couldn’t be fetched (${response.status})` };
  const blob = await response.blob();
  if (/^text\/html\b/i.test(blob.type)) return { page: true };
  try {
    return { copy: await smallCopyOf(blob) };
  } catch {
    return { error: 'not a picture this browser can show' };
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
 * Changes a hidden picture's entry for the Every try page (tries.js): a look at it from there
 * ({ type: 'note-look', at, url, why }) or the mark given after one ({ type: 'mark-hidden', at, url,
 * mistake }), written here, in turn with the notes of pictures just hidden, so that neither is lost.
 * Answers { found }: false when the entry has gone from the record (the oldest go once it is full).
 */
function changeHidden({ type, at, url, why, mistake }) {
  const now = Date.now();
  const key = { at, url };
  const result = writing.then(async () => {
    const stored = (await api.storage.local.get(PICTURES))[PICTURES];
    const list = Array.isArray(stored) ? stored : [];
    const found = list.some((entry) => sameHidden(entry, key));
    if (found) {
      const changed = type === 'note-look' ? noteLook(list, key, { at: now, why }) : markHidden(list, key, { at: now, mistake });
      await api.storage.local.set({ [PICTURES]: changed });
    }
    return { found };
  });
  writing = result.catch(() => {});
  return result;
}

const siteOf = (sender) => hostOf(sender?.tab?.url ?? sender?.url ?? '') ?? 'unknown';

async function judgePicture(url, sender) {
  if (typeof url !== 'string' || !/^(?:https?|data):/i.test(url)) return { hide: false, reason: null };
  const [scores, setting] = await Promise.all([scoresFor(url), currentStrictness()]);
  const result = verdict(scores, setting);
  if (result.hide) {
    hiddenCount += 1;
    await noteHidden({ site: siteOf(sender), url, reason: result.reason, scores, copy: () => smallCopy(url) });
  }
  return { ...result, scores };
}

// A frame of a video, judged like a picture but not remembered. A verdict to hide is noted under an
// address someone can open: the video's own if it has one (not a blob: the page made), else its poster's,
// else the page's.
async function judgeFrame({ frame, src, poster }, sender) {
  if (typeof frame !== 'string' || !/^data:image\//i.test(frame)) return { hide: false, reason: null };
  const [blob, setting] = await Promise.all([fetch(frame).then((response) => response.blob()), currentStrictness()]);
  let scores;
  try {
    scores = await judgeBytes(blob, 'video-frame');
  } catch (error) {
    failedCount += 1;
    throw error;
  }
  frameCount += 1;
  const result = verdict(scores, setting);
  if (result.hide) {
    videoCount += 1;
    const page = sender?.tab?.url ?? sender?.url ?? '';
    const url = [src, poster, page].find((address) => /^https?:/i.test(address ?? '')) ?? page;
    await noteHidden({ site: siteOf(sender), url, kind: 'video', reason: result.reason, scores });
  }
  return { ...result, scores };
}

