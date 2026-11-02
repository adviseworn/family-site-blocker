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

/** Whether an address is the picture itself, written out (data:), of which the record keeps only the start. */
export const isData = (url) => /^data:/i.test(String(url ?? ''));

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

// --- Copies of the hidden pictures ------------------------------------------------------------------------
// The Every try page shows a hidden picture again. Its address, which the record keeps, may not give it
// back: a data: address is the picture itself, written out, of which the record keeps only the start; a
// picture goes from its address, or its address can't be reached from here. So when a picture is hidden a
// smaller copy of it is kept apart from the record (1.17.4): a JPEG at most COPY_SIZE on its longer side,
// as a data: address, under its own key (copyKey) from the picture's moment and address as the record has
// them, with an index of the copies under COPIES. The copies are capped by count and by size together,
// the oldest going first, so that the add-on's storage stays small whatever a site shows. Videos get no
// copy: a video's row is shown from its address.

/** Storage key of the index of the copies, oldest first: { at, url (as the record keeps it), length }. */
export const COPIES = 'pictureCopies';
/** How many copies are kept, and how many characters they may come to in all (about 4 MB of pictures). */
export const COPIES_KEPT = 100;
export const COPIES_LENGTH = 5_000_000;
/** The longer side of a copy, in pixels: enough to tell what a picture was, at the size the page shows it. */
export const COPY_SIZE = 512;

/** The storage key of the copy of the hidden picture a key names ({ at, url }, as the record has them). */
export const copyKey = ({ at, url }) => `pictureCopy:${at}:${hashOf(String(url ?? '').slice(0, URL_LENGTH))}`;

/** A short hash of a string (FNV-1a), as hex: tells two addresses noted at the same moment apart. */
function hashOf(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Keeps a copy of a hidden picture: the index gains { at, url: the address cut as the record cuts it,
 * length: the copy's }, and loses its oldest while there are more than COPIES_KEPT or the copies come to
 * more than COPIES_LENGTH characters (the newest stays whatever its size). Returns { index: the new
 * index, key: the storage key the copy goes under, remove: the keys of the copies let go }.
 */
export function keepCopy(index, { at, url, copy }) {
  const list = Array.isArray(index) ? index : [];
  const entry = { at, url: String(url ?? '').slice(0, URL_LENGTH), length: String(copy ?? '').length };
  const kept = [...list, entry];
  const remove = [];
  let total = kept.reduce((sum, item) => sum + (Number(item?.length) || 0), 0);
  while (kept.length > 1 && (kept.length > COPIES_KEPT || total > COPIES_LENGTH)) {
    const gone = kept.shift();
    total -= Number(gone?.length) || 0;
    remove.push(copyKey(gone));
  }
  return { index: kept, key: copyKey(entry), remove };
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
 * What a hidden picture's row says among every try (tries.html): "Picture hidden for nudity" or "Video
 * hidden as suggestive", with the scores beside it (scoresOf). A close call is marked by the page, not said here.
 */
export function describeHidden(entry) {
  const why = entry?.reason === 'nudity' ? ' for nudity' : entry?.reason === 'suggestive' ? ' as suggestive' : '';
  return `${isVideo(entry) ? 'Video' : 'Picture'} hidden${why}`;
}

/** The judge's scores, beside a hidden picture's words on its row: "nudity 0.92, suggestive 0.02", the two the pages show (porn and hentai together, and sexy). */
export function scoresOf(entry) {
  const score = (name) => Math.max(0, Number(entry?.scores?.[name]) || 0);
  return `nudity ${(score('porn') + score('hentai')).toFixed(2)}, suggestive ${score('sexy').toFixed(2)}`;
}
