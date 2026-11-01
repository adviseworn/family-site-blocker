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
/** How much of a picture's address the record keeps: a data: address (the picture itself) can be far longer, and is cut. */
export const URL_LENGTH = 500;

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
 * reason, scores: { porn, hentai, sexy } rounded }. A hidden video is noted the same way with
 * kind: 'video', its url being the video's own address, its poster's, or failing both the page's: an
 * address someone can open. Returns the new list, oldest first, capped. An entry may later gain `looks`
 * and `mark` (noteLook, markHidden below), which a look at the picture from the add-on's own page adds.
 */
export function recordHidden(record, { at, site, url, reason, scores, kind }) {
  const list = Array.isArray(record) ? record : [];
  const rounded = Object.fromEntries(['porn', 'hentai', 'sexy'].map((name) => [name, Math.round((Number(scores?.[name]) || 0) * 100) / 100]));
  const entry = { at, site, url: String(url ?? '').slice(0, URL_LENGTH), reason, scores: rounded, ...(kind === 'video' ? { kind } : {}) };
  const kept = [...list, entry];
  return kept.length > MAX_PICTURES ? kept.slice(kept.length - MAX_PICTURES) : kept;
}

/** Whether a record entry is a hidden video rather than a picture. */
export const isVideo = (entry) => entry?.kind === 'video';

// --- Looking at a hidden picture ------------------------------------------------------------------------
// A hidden picture can be looked at from its row on the Every try page (tries.js), where the filter doesn't
// run. There is no password (#58): anyone who can open the page can look, and every look goes into the
// record, on the picture's entry, with the time and the reason the page asks for first, as the locked-away
// password's page asks why before unlocking. The mark given after a look, hidden by mistake or rightly
// hidden, goes on the entry too, so that the pages can count the filter's mistakes.

/** How many looks at one hidden picture its entry keeps; the oldest go when there are more. */
export const LOOKS_KEPT = 20;
/** How long a reason for looking may be, in characters. */
export const WHY_LENGTH = 200;

/** Whether a record entry is the one a key names: noted at the same moment, under the same address. */
export const sameHidden = (entry, key) => entry?.at === key?.at && entry?.url === key?.url;

/** Whether a hidden picture has been looked at from the add-on's own page. */
export const lookedAt = (entry) => Array.isArray(entry?.looks) && entry.looks.length > 0;

/** Whether a hidden picture was marked, after a look, as hidden by mistake. */
export const markedMistake = (entry) => entry?.mark?.mistake === true;

/** The entries of a record changed one at a time: `change` applied to the entry `key` names, the rest as they were; the list as it was when none matches. */
function changeHidden(record, key, change) {
  const list = Array.isArray(record) ? record : [];
  const index = list.findIndex((entry) => sameHidden(entry, key));
  return index === -1 ? list : list.map((entry, i) => (i === index ? change(entry) : entry));
}

/**
 * Notes a look at a hidden picture: the entry `key` names ({ at, url }, as noted) gains { at, why } among
 * its `looks`, oldest first, the reason cut to WHY_LENGTH and the oldest looks going past LOOKS_KEPT.
 * Returns the new list, or the list as it was when no entry matches (one that has gone from the record).
 */
export function noteLook(record, key, { at, why }) {
  return changeHidden(record, key, (entry) => {
    const looks = [...(Array.isArray(entry.looks) ? entry.looks : []), { at, why: String(why ?? '').slice(0, WHY_LENGTH) }];
    return { ...entry, looks: looks.slice(-LOOKS_KEPT) };
  });
}

/**
 * Marks a hidden picture, after a look at it, as hidden by mistake (`mistake` true) or rightly hidden: the
 * entry `key` names gets mark { at, mistake }, the latest mark in place of an earlier one. Returns the new
 * list, or the list as it was when no entry matches.
 */
export function markHidden(record, key, { at, mistake }) {
  return changeHidden(record, key, (entry) => ({ ...entry, mark: { at, mistake: mistake === true } }));
}

/** "3 pictures", "1 picture and 2 videos": the record's entries counted by kind, for the summaries. */
export function countHidden(record) {
  const list = Array.isArray(record) ? record : [];
  const videos = list.filter(isVideo).length;
  const pictures = list.length - videos;
  const word = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (videos === 0) return word(pictures, 'picture');
  if (pictures === 0) return word(videos, 'video');
  return `${word(pictures, 'picture')} and ${word(videos, 'video')}`;
}

/** The record summed up by site, most entries first: { site, pictures (pictures and videos together), last }. */
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

/**
 * What a hidden picture's row says among every try (tries.html): "Picture hidden for nudity: nudity 0.92,
 * suggestive 0.02." or "Video hidden as suggestive: nudity 0.10, suggestive 0.35.", the scores being the
 * two the pages show (porn and hentai together, and sexy). A close call is marked by the page, not said here.
 */
export function describeHidden(entry) {
  const score = (name) => Math.max(0, Number(entry?.scores?.[name]) || 0);
  const why = entry?.reason === 'nudity' ? ' for nudity' : entry?.reason === 'suggestive' ? ' as suggestive' : '';
  return `${isVideo(entry) ? 'Video' : 'Picture'} hidden${why}: nudity ${(score('porn') + score('hentai')).toFixed(2)}, suggestive ${score('sexy').toFixed(2)}.`;
}
