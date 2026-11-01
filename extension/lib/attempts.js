// The record of blocked attempts: which listed sites someone tried to open, and when. The background
// script writes it, the settings page shows it, and the tests check both through these functions.
//
// It lives in the extension's storage under ATTEMPTS as a list, oldest first, of
//   { at: <milliseconds since 1970>, site: <the listed domain>, opened?: true, from?: 'history' }
// `opened` means the site's page actually loaded instead of being blocked: the extension had no access
// to websites, say, or its rules were off. `from: 'history'` means the visit was found in the browser's
// own history rather than seen as it happened: from before the extension was installed, from a time it
// was off, or from before the site was listed (mergeVisits); which of those, lib/watching.js tells from
// when the extension was running, and outcome() says. Nothing on the settings page removes entries; only
// the oldest go, once there are more than MAX_ATTEMPTS. HISTORY_SCAN holds when the history was last
// looked through, and what that found.
import { kindOfVisit, normalize } from './watching.js';

export const ATTEMPTS = 'attempts';
export const HISTORY_SCAN = 'historyScan';
export const MAX_ATTEMPTS = 10_000; // a few hundred kilobytes at most; the browser's history can add hundreds at a time

/**
 * What an entry says happened, and the words the pages use for it. A visit found in the browser's history
 * is 'history' (from before the extension was installed) unless `watching` (lib/watching.js) places it
 * after that: 'off' (the extension wasn't running then), 'unlisted' (it was running, so the site wasn't
 * listed yet) or 'unseen' (after the install, but before the extension kept track of when it ran).
 */
export function outcome(attempt, watching) {
  if (attempt.from !== 'history') return attempt.opened ? 'opened' : 'blocked';
  if (!watching) return 'history';
  const kind = kindOfVisit(watching, attempt.at);
  return kind === 'before' ? 'history' : kind;
}
export const LABELS = {
  blocked: 'Blocked',
  opened: 'Opened, not blocked',
  history: 'Visited (browser history)',
  off: 'Visited while the add-on was off',
  unlisted: 'Visited before the site was listed',
  unseen: 'Visited after the add-on was installed',
};
/** The outcomes that are visits found in the browser's history, however they are placed. */
export const FROM_HISTORY = ['history', 'off', 'unlisted', 'unseen'];

// Two notes of the same site this close together are one attempt: the browser reports each navigation
// more than once (see background.js), in no fixed order, and a reload is not a new try. A visit found in
// the browser's history is no such report (its time is the history's, not the browser's word that this
// navigation started), so record() doesn't fold a live try into one; the other way round, the history's
// copy of a live try, is left out by mergeVisits (#125).
export const SAME_ATTEMPT_MS = 2000;
// A page that loads this long after the attempt was noted belongs to that attempt.
const OPENED_WITHIN_MS = 60_000;

/** The host of a web address, lowercase and without a trailing dot; null for anything but http(s). */
export function hostOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return host || null;
}

/**
 * The bookmarks in a bookmark tree (bookmarks.getTree) that point at listed sites: { id, url, site } each,
 * in tree order. Folders, separators and bookmarks to anything but http(s) pages are left out.
 */
export function bookmarksTo(tree, domains) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.url) {
      const site = listedDomain(hostOf(node.url), domains);
      if (site) found.push({ id: node.id, url: node.url, site });
    }
    walk(node.children);
  };
  walk(tree);
  return found;
}

/** The listed domain that covers `host` (the host itself or a parent domain), or null if none does. */
export function listedDomain(host, domains) {
  if (!host) return null;
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    if (domains.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Notes an attempt, or that a page opened, and returns the new list; or null when nothing changes.
 * `attempt` is { at, site } for a navigation that started, or { at, site, opened: true } for a page
 * that finished loading, which marks the attempt it belongs to rather than adding one. A navigation within
 * SAME_ATTEMPT_MS of the last note of the same site is that note's try reported again, unless the note is
 * a visit from the history: then it is a new try, noted after the visit (a site added to the list a moment
 * after it was visited, and tried again at once, gets both).
 */
export function record(attempts, { at, site, opened = false }) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (opened) {
    for (let i = list.length - 1; i >= 0 && at - list[i].at <= OPENED_WITHIN_MS; i -= 1) {
      if (list[i].site !== site) continue;
      if (list[i].opened) return null;
      return [...list.slice(0, i), { ...list[i], opened: true }, ...list.slice(i + 1)];
    }
    return trim([...list, { at, site, opened: true }]);
  }
  const last = list[list.length - 1];
  if (last && last.site === site && !last.from && Math.abs(at - last.at) < SAME_ATTEMPT_MS) return null;
  return trim([...list, { at, site }]);
}

/**
 * Adds visits found in the browser's history, { at, site } each, to the record: in time order, marked as
 * from the history, leaving out any that the record already holds (the same site within two seconds: a
 * try seen as it happened, or a visit added by an earlier look) and repeats among the visits themselves.
 * `sameWithinMs` widens the two seconds: the sweep after a live try passes a few minutes, because the
 * page of a site that got through is written to the history when it finishes loading, not when the try
 * was noted. Returns the new list (or the same one when nothing was added), how many distinct visits
 * there were, and how many were new.
 */
export function mergeVisits(attempts, visits, sameWithinMs = SAME_ATTEMPT_MS) {
  const list = Array.isArray(attempts) ? attempts : [];
  const kept = [...list];
  const sameTry = (entry, visit) => entry.site === visit.site && Math.abs(entry.at - visit.at) < sameWithinMs;
  const distinct = [];
  let added = 0;
  for (const visit of [...visits].filter((v) => Number.isFinite(v.at) && v.site).sort((a, b) => a.at - b.at)) {
    if (distinct.some((other) => sameTry(other, visit))) continue;
    distinct.push(visit);
    if (kept.some((entry) => sameTry(entry, visit))) continue;
    kept.push({ at: visit.at, site: visit.site, from: 'history' });
    added += 1;
  }
  if (added === 0) return { attempts: list, found: distinct.length, added };
  kept.sort((a, b) => a.at - b.at);
  return { attempts: trim(kept), found: distinct.length, added };
}

function trim(list) {
  return list.length > MAX_ATTEMPTS ? list.slice(list.length - MAX_ATTEMPTS) : list;
}

/**
 * The record summed up by site, most tries first: { site, tries, first, last, opened, history, off }, with
 * `first` and `last` the times of the earliest and latest try, `opened` how many got through, `history`
 * how many came from the browser's history (however placed), and `off` how many of those are from times
 * the extension was off (none without `watching`).
 */
export function bySite(attempts, watching) {
  const sites = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const row = sites.get(attempt.site) ?? { site: attempt.site, tries: 0, first: attempt.at, last: attempt.at, opened: 0, history: 0, off: 0 };
    row.tries += 1;
    row.first = Math.min(row.first, attempt.at);
    row.last = Math.max(row.last, attempt.at);
    const what = outcome(attempt, watching);
    if (what === 'opened') row.opened += 1;
    if (FROM_HISTORY.includes(what)) row.history += 1;
    if (what === 'off') row.off += 1;
    sites.set(attempt.site, row);
  }
  return [...sites.values()].sort((a, b) => b.tries - a.tries || b.last - a.last || a.site.localeCompare(b.site));
}

/**
 * The record counted up for the pages' summary lines: how many tries, at how many sites, the latest, how
 * many got through, how many came from the browser's history, and of those how many are from times the
 * extension was off, from before the site was listed, or from after the install but before the extension
 * kept track of when it ran, with the latest of each kind.
 */
export function summarize(attempts, watching) {
  const counts = { tries: 0, sites: 0, latest: null, opened: 0, history: 0, off: 0, unlisted: 0, unseen: 0, latestOff: null, latestUnseen: null };
  const sites = new Set();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    counts.tries += 1;
    sites.add(attempt.site);
    counts.latest = Math.max(counts.latest ?? attempt.at, attempt.at);
    const what = outcome(attempt, watching);
    if (what === 'opened') counts.opened += 1;
    if (FROM_HISTORY.includes(what)) counts.history += 1;
    if (what === 'off') {
      counts.off += 1;
      counts.latestOff = Math.max(counts.latestOff ?? attempt.at, attempt.at);
    }
    if (what === 'unlisted') counts.unlisted += 1;
    if (what === 'unseen') {
      counts.unseen += 1;
      counts.latestUnseen = Math.max(counts.latestUnseen ?? attempt.at, attempt.at);
    }
  }
  counts.sites = sites.size;
  return counts;
}

/** The time the add-on was off (lib/watching.js's `off`, { from, to, pages } each) that a moment falls in, or null. */
export function offDuring(off, at) {
  return (Array.isArray(off) ? off : []).find((time) => at > time.from && at < time.to) ?? null;
}

/**
 * The record and the times the add-on was off (lib/watching.js) as one timeline, by calendar day (in this
 * computer's time zone), newest day first, each day's entries newest first: [{ day: <midnight, ms>, entries }].
 * An entry is a try, { at, attempt, during }, with `during` the time the add-on was off that the try falls
 * in, or null; or a time the add-on was off, { at, off, from, to }: `off` the time as stored, `from` and
 * `to` the part of it that falls in that day, since a time that crosses midnight is an entry in each day it
 * touches, and `at` that part's end, so that the entry comes before the tries made inside it, newest first.
 * A day with only a time the add-on was off is a day all the same.
 */
export function timeline(attempts, watching) {
  const off = normalize(watching).off;
  const days = new Map();
  const entriesOf = (day) => days.get(day) ?? days.set(day, []).get(day);
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    entriesOf(midnightBefore(attempt.at)).push({ at: attempt.at, attempt, during: offDuring(off, attempt.at) });
  }
  for (const time of off) {
    // A time that ends on the stroke of midnight ends in the day before it.
    const last = midnightBefore(time.to > time.from && time.to === midnightBefore(time.to) ? time.to - 1 : time.to);
    for (let day = midnightBefore(time.from); day <= last; day = midnightAfter(day)) {
      const to = Math.min(time.to, midnightAfter(day));
      entriesOf(day).push({ at: to, off: time, from: Math.max(time.from, day), to });
    }
  }
  return [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([day, entries]) => ({ day, entries: entries.sort((a, b) => b.at - a.at) }));
}

/** The midnight that starts the calendar day a moment is in, in this computer's time zone. */
function midnightBefore(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The next midnight after a day's own, a calendar day on (23 or 25 hours when the clocks change). */
function midnightAfter(day) {
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** The record as a CSV file, oldest first: when (ISO 8601, local time zone offset included), site, what happened. */
export function toCsv(attempts, watching) {
  const cell = (text) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = ['when,site,result'];
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    lines.push([localIso(attempt.at), attempt.site, LABELS[outcome(attempt, watching)]].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** 2026-10-18T15:12:03-07:00 rather than UTC, so the file reads like the page. */
function localIso(ms) {
  const date = new Date(ms);
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}
