// The record of blocked attempts: which listed sites someone tried to open, and when. The background
// script writes it, the settings page shows it, and the tests check both through these functions.
//
// It lives in the extension's storage under ATTEMPTS as a list, oldest first, of
//   { at: <milliseconds since 1970>, site: <the listed domain>, opened?: true, from?: 'history' }
// `opened` means the site's page actually loaded instead of being blocked: the extension had no access
// to websites, say, or its rules were off. `from: 'history'` means the visit was found in the browser's
// own history rather than seen as it happened: from before the extension was installed, or before the
// site was listed (mergeVisits). Nothing on the settings page removes entries; only the oldest go, once
// there are more than MAX_ATTEMPTS. HISTORY_SCAN holds when the history was last looked through, and
// what that found.

export const ATTEMPTS = 'attempts';
export const HISTORY_SCAN = 'historyScan';
export const MAX_ATTEMPTS = 10_000; // a few hundred kilobytes at most; the browser's history can add hundreds at a time

/** What an entry says happened, and the words the pages use for it. */
export const outcome = (attempt) => (attempt.from === 'history' ? 'history' : attempt.opened ? 'opened' : 'blocked');
export const LABELS = { blocked: 'Blocked', opened: 'Opened, not blocked', history: 'Visited (browser history)' };

// Two notes of the same site this close together are one attempt: the browser reports each navigation
// more than once (see background.js), in no fixed order, and a reload is not a new try.
const SAME_ATTEMPT_MS = 2000;
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
 * that finished loading, which marks the attempt it belongs to rather than adding one.
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
  if (last && last.site === site && Math.abs(at - last.at) < SAME_ATTEMPT_MS) return null;
  return trim([...list, { at, site }]);
}

/**
 * Adds visits found in the browser's history, { at, site } each, to the record: in time order, marked as
 * from the history, leaving out any that the record already holds (the same site within two seconds: a
 * try seen as it happened, or a visit added by an earlier look) and repeats among the visits themselves.
 * Returns the new list (or the same one when nothing was added), how many distinct visits there were,
 * and how many were new.
 */
export function mergeVisits(attempts, visits) {
  const list = Array.isArray(attempts) ? attempts : [];
  const kept = [...list];
  const sameTry = (entry, visit) => entry.site === visit.site && Math.abs(entry.at - visit.at) < SAME_ATTEMPT_MS;
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
 * The record summed up by site, most tries first: { site, tries, first, last, opened, history }, with
 * `first` and `last` the times of the earliest and latest try, `opened` how many got through, and
 * `history` how many came from the browser's history.
 */
export function bySite(attempts) {
  const sites = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const row = sites.get(attempt.site) ?? { site: attempt.site, tries: 0, first: attempt.at, last: attempt.at, opened: 0, history: 0 };
    row.tries += 1;
    row.first = Math.min(row.first, attempt.at);
    row.last = Math.max(row.last, attempt.at);
    const what = outcome(attempt);
    if (what === 'opened') row.opened += 1;
    if (what === 'history') row.history += 1;
    sites.set(attempt.site, row);
  }
  return [...sites.values()].sort((a, b) => b.tries - a.tries || b.last - a.last || a.site.localeCompare(b.site));
}

/**
 * The record by calendar day (in this computer's time zone), newest day first, each day's tries newest
 * first: [{ day: <midnight, ms>, attempts }].
 */
export function byDay(attempts) {
  const days = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const date = new Date(attempt.at);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(attempt);
  }
  return [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([day, list]) => ({ day, attempts: list.sort((a, b) => b.at - a.at) }));
}

/** The record as a CSV file, oldest first: when (ISO 8601, local time zone offset included), site, what happened. */
export function toCsv(attempts) {
  const cell = (text) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = ['when,site,result'];
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    lines.push([localIso(attempt.at), attempt.site, LABELS[outcome(attempt)]].map(cell).join(','));
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
