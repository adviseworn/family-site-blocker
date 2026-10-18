// The record of blocked attempts: which listed sites someone tried to open, and when. The background
// script writes it, the settings page shows it, and the tests check both through these functions.
//
// It lives in the extension's storage under ATTEMPTS as a list, oldest first, of
//   { at: <milliseconds since 1970>, site: <the listed domain>, opened?: true }
// `opened` means the site's page actually loaded instead of being blocked: the extension had no access
// to websites, say, or its rules were off. Nothing on the settings page removes entries; only the
// oldest go, once there are more than MAX_ATTEMPTS.

export const ATTEMPTS = 'attempts';
export const MAX_ATTEMPTS = 1000;

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

function trim(list) {
  return list.length > MAX_ATTEMPTS ? list.slice(list.length - MAX_ATTEMPTS) : list;
}
