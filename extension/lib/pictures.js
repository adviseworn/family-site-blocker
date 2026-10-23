// The picture filter's rules and record. A list of sites can't touch one picture on an ordinary site, so
// the extension also judges pictures themselves: the background script runs a classifier on each picture
// a page shows (classifier.js), and the page's content script (content.js) keeps a picture hidden until it
// has been judged, then shows it or keeps it hidden. This file holds what both sides and the pages share:
// how scores become a verdict, and the record of what was hidden.
//
// The classifier (NSFWJS's MobileNetV2 model) gives five scores that sum to 1: drawing, hentai, neutral,
// porn, sexy. "Sexy" is its word for suggestive but not explicit: lingerie, swimwear, poses.

export const CLASSES = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];

/** Storage keys. */
export const STRICTNESS = 'pictureStrictness'; // 'strict' (the default) or 'nudity'
export const PICTURES = 'pictures'; // the record of hidden pictures, oldest first
export const MAX_PICTURES = 500;

/** The settings the person can choose, in the order the settings page lists them. */
export const STRICTNESS_CHOICES = [
  { value: 'strict', label: 'Nudity and anything suggestive, such as lingerie or swimwear' },
  { value: 'nudity', label: 'Nudity only' },
];
export const DEFAULT_STRICTNESS = 'strict';

/** Pictures smaller than this on both sides (icons, emoji, buttons) are shown without being judged. */
export const MIN_SIZE = 64;

/** Scores at or above which a picture is hidden: the explicit classes together, and with "sexy" added. */
export const THRESHOLD = 0.4;

/**
 * Whether a picture with these scores is hidden under a setting, and why: { hide, reason }, with reason
 * 'nudity' (porn and hentai together reach the threshold), 'suggestive' (only with sexy added, under the
 * strict setting) or null.
 */
export function verdict(scores, strictness = DEFAULT_STRICTNESS) {
  const score = (name) => Math.max(0, Number(scores?.[name]) || 0);
  const nudity = score('porn') + score('hentai');
  if (nudity >= THRESHOLD) return { hide: true, reason: 'nudity' };
  if (strictness === 'strict' && nudity + score('sexy') >= THRESHOLD) return { hide: true, reason: 'suggestive' };
  return { hide: false, reason: null };
}

/** A hidden picture whose deciding score was under this is marked borderline: the likelier mistake. */
export const BORDERLINE = 0.6;

/**
 * Whether a hidden picture's verdict was a close one: the score that decided it (porn and hentai together
 * for nudity; with sexy added for suggestive) was under BORDERLINE. A harmless picture hidden by mistake
 * usually sits here.
 */
export function borderline({ reason, scores }) {
  const score = (name) => Math.max(0, Number(scores?.[name]) || 0);
  const deciding = reason === 'suggestive' ? score('porn') + score('hentai') + score('sexy') : score('porn') + score('hentai');
  return deciding < BORDERLINE;
}

/** The setting as stored, or the default when nothing valid is stored. */
export function strictnessOf(stored) {
  return STRICTNESS_CHOICES.some((choice) => choice.value === stored) ? stored : DEFAULT_STRICTNESS;
}

/**
 * Notes a hidden picture in the record: { at, site: <the page's host>, url: <the picture's address>,
 * reason, scores: { porn, hentai, sexy } rounded }. Returns the new list, oldest first, capped.
 */
export function recordHidden(record, { at, site, url, reason, scores }) {
  const list = Array.isArray(record) ? record : [];
  const rounded = Object.fromEntries(['porn', 'hentai', 'sexy'].map((name) => [name, Math.round((Number(scores?.[name]) || 0) * 100) / 100]));
  const entry = { at, site, url: String(url ?? '').slice(0, 500), reason, scores: rounded };
  const kept = [...list, entry];
  return kept.length > MAX_PICTURES ? kept.slice(kept.length - MAX_PICTURES) : kept;
}

/** The record summed up by site, most pictures first: { site, pictures, last }. */
export function hiddenBySite(record) {
  const sites = new Map();
  for (const entry of Array.isArray(record) ? record : []) {
    const row = sites.get(entry.site) ?? { site: entry.site, pictures: 0, last: 0 };
    row.pictures += 1;
    row.last = Math.max(row.last, entry.at);
    sites.set(entry.site, row);
  }
  return [...sites.values()].sort((a, b) => b.pictures - a.pictures || b.last - a.last || a.site.localeCompare(b.site));
}
