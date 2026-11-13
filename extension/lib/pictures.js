// The picture filter's rules and record. A list of sites can't touch one picture on an ordinary site, so
// the extension also judges pictures themselves: the background script runs a classifier on each picture
// a page shows (classifier.js), and the page's content script (content.js) keeps a picture hidden until it
// has been judged, then shows it or keeps it hidden. This file holds what both sides and the pages share:
// how scores become a verdict, and the record of what was hidden.
//
// The classifier (NSFWJS's MobileNetV2 model, and from 1.20.0 its InceptionV3 model for a second opinion
// on what the first would hide) gives five scores that sum to 1: drawing, hentai, neutral, porn, sexy.
// "Sexy" is its word for suggestive but not explicit: lingerie, swimwear, poses.

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
export function borderline(entry) {
  return decidingSum(entry) < BORDERLINE;
}

/** The sum that decided a hidden picture: porn and hentai together, and sexy with them for one hidden as suggestive. */
function decidingSum({ reason, scores }) {
  const score = (name) => Math.max(0, Number(scores?.[name]) || 0);
  return reason === 'suggestive' ? score('porn') + score('hentai') + score('sexy') : score('porn') + score('hentai');
}

/** The score that decided, beside a hidden picture's words on its row on Every try (1.21.0): "0.92", the sum borderline compares with BORDERLINE. */
export const decidingScore = (entry) => decidingSum(entry ?? {}).toFixed(2);

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

/** A short hash of a string (FNV-1a), as hex: tells two addresses noted at the same moment apart, and two copies alike. */
export function hashOf(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Keeps a copy of a hidden picture: the index gains { at, url: the address cut as the record cuts it,
 * length: the copy's, hash: the copy's (from 1.18.0; by which two copies of one picture are told alike,
 * samePicture below) }, and loses its oldest while there are more than COPIES_KEPT or the copies come to
 * more than COPIES_LENGTH characters (the newest stays whatever its size). Returns { index: the new
 * index, key: the storage key the copy goes under, remove: the keys of the copies let go }.
 */
export function keepCopy(index, { at, url, copy }) {
  const list = Array.isArray(index) ? index : [];
  const made = String(copy ?? '');
  const entry = { at, url: String(url ?? '').slice(0, URL_LENGTH), length: made.length, hash: hashOf(made) };
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

// --- The same picture on more than one row ---------------------------------------------------------------
// A picture hidden again, on the next visit to the page or on another page, is a row of its own in the
// record. Two rows show the same picture when their addresses are the same (not data: ones, of which the
// record keeps only the start, which two different pictures can share), or when the copies kept of them
// are the same picture, which the index tells by a copy's length and hash. A mark given to one row goes
// to the rest (1.18.0, markAlike), and the page that checks the hidden pictures in bulk (check.js) shows
// each picture once. Videos are left out: a video is noted under its own address, its poster's or the
// page's, and two different videos on one page share the page's.

/** The index of the copies as a Map from each copy's storage key to its index entry, for samePicture. */
export const copiesByKey = (index) => new Map((Array.isArray(index) ? index : []).map((entry) => [copyKey(entry), entry]));

/** Whether two record entries show the same picture (see above); `copies` is the index by key (copiesByKey). */
export function samePicture(a, b, copies) {
  if (a === b) return true;
  if (!a || !b || isVideo(a) || isVideo(b)) return false;
  if (a.url === b.url && !isData(a.url)) return true;
  const copyA = copies?.get(copyKey(a));
  const copyB = copies?.get(copyKey(b));
  return Boolean(copyA?.hash && copyB?.hash && copyA.hash === copyB.hash && copyA.length === copyB.length);
}

/**
 * The record's entries grouped by the picture they show: each group the rows of one picture, newest
 * first, the groups newest first too. Two rows that share neither an address nor a copy are one picture
 * when a third shares one with each.
 */
export function sameGroups(record, copies) {
  let groups = [];
  for (const entry of Array.isArray(record) ? record : []) {
    const alike = groups.filter((members) => members.some((member) => samePicture(member, entry, copies)));
    groups = [...groups.filter((members) => !alike.includes(members)), [...alike.flat(), entry]];
  }
  return groups.map((members) => members.sort((a, b) => b.at - a.at)).sort((a, b) => b[0].at - a[0].at);
}

/**
 * Marks hidden pictures, and with each every other row that shows the same picture (sameGroups): the
 * entries `keys` name ({ at, url } each, as noted) and their likes get mark { at, mistake }, the latest
 * mark in place of an earlier one. Returns { record: the new list, found: how many of the keys name an
 * entry (one gone from the record is passed over), alike: how many other rows were marked with them }.
 */
export function markAlike(record, keys, { at, mistake }, copies) {
  const list = Array.isArray(record) ? record : [];
  const named = new Set((Array.isArray(keys) ? keys : []).map((key) => list.find((entry) => sameHidden(entry, key))).filter(Boolean));
  const marked = new Set(named);
  if (named.size) for (const members of sameGroups(list, copies)) if (members.some((member) => named.has(member))) for (const member of members) marked.add(member);
  const mark = { at, mistake: mistake === true };
  const changed = marked.size ? list.map((entry) => (marked.has(entry) ? { ...entry, mark } : entry)) : list;
  return { record: changed, found: named.size, alike: marked.size - named.size, marked: changed.filter((entry) => entry.mark === mark) };
}

// --- Pictures shown again ----------------------------------------------------------------------------------
// A picture marked hidden by mistake is shown again from then on (1.19.0): on the pages open, whose content
// scripts are told to judge again what they hid, and on any page that shows it later, which the judge
// (background.js) lets through when the picture is on the list kept here. A picture is known by its
// address, unless that is a data: one (the picture itself written out, of which the record keeps only the
// start), and by its kept copy's hash and length, as two rows are told alike above, so the same picture
// at another address, or written out, is known too. Marking it rightly hidden takes it off the list, and
// it is hidden again from the next page load. A video's mark stays a note: a video is judged by its
// frames, under an address that may be its poster's or its page's. The list is kept apart from the
// record, which lets its oldest rows go, so a picture stays shown when its row has gone.

/** Storage key of the list, oldest first: { at, url: the address as the record keeps it ('' for a data: one), copy: { hash, length } of a kept copy, or null }. */
export const SHOWN = 'picturesShown';
/** How many pictures the list keeps; the oldest go when there are more. */
export const SHOWN_KEPT = 1000;

/** What a record entry's picture is known by, { url, copy } as the list keeps them, or null for a video or a picture known by nothing (a data: address with no copy kept). */
function knownBy(entry, copies) {
  if (!entry || isVideo(entry)) return null;
  const url = isData(entry.url) ? '' : String(entry.url ?? '').slice(0, URL_LENGTH);
  const kept = copies?.get(copyKey(entry));
  const copy = typeof kept?.hash === 'string' && kept.hash ? { hash: kept.hash, length: Number(kept.length) || 0 } : null;
  return url || copy ? { url, copy } : null;
}

/** Whether two of the list's entries, or one and a picture, are the same picture: the same address, or the same copy. */
const sameShown = (a, b) => Boolean(a && b && ((a.url && a.url === b.url) || (a.copy && b.copy && a.copy.hash === b.copy.hash && a.copy.length === b.copy.length)));

/**
 * The list with the pictures of the record entries given (as marked hidden by mistake) on it, from `at`:
 * one entry for each address, and one for each copy among the pictures with no address (data: ones); an
 * entry already there for the address is made anew, keeping the copy it knew when the row has none. The
 * oldest go past SHOWN_KEPT. Videos, and a picture known by nothing, are passed over. `copies` is the
 * index of the copies by key (copiesByKey).
 */
export function showAgain(list, entries, copies, at) {
  let kept = Array.isArray(list) ? list.filter(Boolean) : [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const known = knownBy(entry, copies);
    if (!known) continue;
    const alike = kept.filter((item) => (known.url ? item.url === known.url : !item.url && sameShown(item, known)));
    kept = [...kept.filter((item) => !alike.includes(item)), { at, url: known.url, copy: known.copy ?? alike.find((item) => item.copy)?.copy ?? null }];
  }
  return kept.length > SHOWN_KEPT ? kept.slice(kept.length - SHOWN_KEPT) : kept;
}

/** The list without the pictures of the record entries given (as marked rightly hidden): hidden again as before. */
export function hideAgain(list, entries, copies) {
  const known = (Array.isArray(entries) ? entries : []).map((entry) => knownBy(entry, copies)).filter(Boolean);
  return (Array.isArray(list) ? list.filter(Boolean) : []).filter((item) => !known.some((picture) => sameShown(item, picture)));
}

/**
 * Whether a picture is on the list, to be shown again: by its address (`url`, the picture's, cut as the
 * record cuts it; a data: one tells nothing) or by its copy (`copy`, the copy itself as smallCopyOf makes
 * it, or { hash, length }), either given.
 */
export function shownAgain(list, { url, copy }) {
  const known = {
    url: isData(url) ? '' : String(url ?? '').slice(0, URL_LENGTH),
    copy: typeof copy === 'string' ? (copy ? { hash: hashOf(copy), length: copy.length } : null) : (copy ?? null),
  };
  return (Array.isArray(list) ? list : []).some((item) => sameShown(item, known));
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
 * hidden as suggestive", with the score that decided beside it on Every try (decidingScore) and both scores on the
 * check page's tiles (scoresOf). A close call is marked by the page, not said here.
 */
export function describeHidden(entry) {
  const why = entry?.reason === 'nudity' ? ' for nudity' : entry?.reason === 'suggestive' ? ' as suggestive' : '';
  return `${isVideo(entry) ? 'Video' : 'Picture'} hidden${why}`;
}

/** The judge's scores, beside a hidden picture's words on the check page's tiles (and on its row on Every try until 1.21.0): "nudity 0.92, suggestive 0.02", the two the pages show (porn and hentai together, and sexy). */
export function scoresOf(entry) {
  const score = (name) => Math.max(0, Number(entry?.scores?.[name]) || 0);
  return `nudity ${(score('porn') + score('hentai')).toFixed(2)}, suggestive ${score('sexy').toFixed(2)}`;
}

// --- Pictures that waited for a verdict -----------------------------------------------------------------
// A picture stays hidden until the background script has judged it (content.js), however long that takes. A
// verdict can be slow (a big picture fetched again from a slow site, the second judge's model loading) or
// never come at all, which once left a captcha's tiles blank (1.26.1). So from 1.27.0 the content script
// says when a picture it asked about has had no verdict after WAIT_MS (its own constant, 20 seconds), and
// the background script notes it here: the page's site, the picture's address, how long it had waited and
// what the background script was doing for it at that moment (fetching it, judging it, asking the second
// judge, or nothing, the request never having reached it); and when the verdict comes after all, how long
// it took and what it was. The rows are laid among every try (tries.html) and go into the saved file, so a
// picture left blank can be understood. The picture itself stays hidden until judged, as before: showing
// it unjudged after a wait would be a change of strictness, not a note.

/** Storage key of the record, oldest first; the latest MAX_WAITING are kept. */
export const WAITING = 'picturesWaiting';
export const MAX_WAITING = 200;
/** The same picture on the same site is one note within this long (each frame of a page asks about its own). */
export const NOTE_WAITING_WITHIN_MS = 60_000;

/** What the background script can be doing for a picture (background.js stageOf), and the row's words for it. */
export const STAGES = {
  fetching: 'being fetched',
  judging: 'with the first judge',
  second: 'with the second judge',
  copying: 'being copied for the record',
  noting: 'being noted in the record',
};
const NO_STAGE = 'no judgment under way';

const seconds = (ms) => Math.max(0, Math.round((Number(ms) || 0) / 1000));

/**
 * Notes a picture that has waited `waited` milliseconds for a verdict without one: { at, site: the page's
 * host, url: the picture's address (cut as the record cuts them), waited: in whole seconds, stage: one of
 * STAGES' keys or null, kind: 'video' for a video's frame, left out for a picture }. The same picture on the
 * same site, noted within NOTE_WAITING_WITHIN_MS and not judged since, is not noted again. Returns the new
 * list, oldest first, capped, or the list as it was.
 */
export function recordWaiting(record, { at, site, url, waited, stage, kind }) {
  const list = Array.isArray(record) ? record : [];
  const kept = String(url ?? '').slice(0, URL_LENGTH);
  const last = list[list.length - 1];
  if (last && last.site === site && last.url === kept && !last.judged && at - last.at < NOTE_WAITING_WITHIN_MS) return list;
  const entry = { at, site, url: kept, waited: seconds(waited), stage: typeof stage === 'string' && stage in STAGES ? stage : null, ...(kind === 'video' ? { kind } : {}) };
  const all = [...list, entry];
  return all.length > MAX_WAITING ? all.slice(all.length - MAX_WAITING) : all;
}

/**
 * Notes that the verdict came after all: the latest entry for the picture on the site that is still waiting
 * gains judged: { after: how long it took, in whole seconds, outcome: 'shown', 'hidden' or 'unjudged' (the
 * judgment failed, and the picture was shown as it is) }. Returns the new list, or the list as it was when
 * no entry waits for it.
 */
export function settleWaiting(record, { site, url, waited, outcome }) {
  const list = Array.isArray(record) ? record : [];
  const kept = String(url ?? '').slice(0, URL_LENGTH);
  const index = list.findLastIndex((entry) => entry?.site === site && entry?.url === kept && !entry?.judged);
  if (index === -1) return list;
  const result = ['shown', 'hidden', 'unjudged'].includes(outcome) ? outcome : 'unjudged';
  return list.map((entry, i) => (i === index ? { ...entry, judged: { after: seconds(waited), outcome: result } } : entry));
}

/** The record's entries that are well-formed, oldest first, as stored; junk is passed over. */
export function waitingList(stored) {
  return (Array.isArray(stored) ? stored : []).filter((entry) => Number.isFinite(entry?.at) && typeof entry.site === 'string' && typeof entry.url === 'string');
}

/**
 * What a row says of a picture that waited: "Picture unjudged after 20 s: being fetched" while no verdict
 * has come, "Picture judged after 47 s: shown" (or hidden) once it has, and "Picture shown unjudged after
 * 47 s" when the judgment failed; "Video" for a video's frame.
 */
export function describeWaiting(entry) {
  const what = entry?.kind === 'video' ? 'Video' : 'Picture';
  const judged = entry?.judged;
  if (judged && typeof judged === 'object') {
    const after = `${Math.max(0, Number(judged.after) || 0)} s`;
    if (judged.outcome === 'unjudged') return `${what} shown unjudged after ${after}`;
    return `${what} judged after ${after}: ${judged.outcome === 'hidden' ? 'hidden' : 'shown'}`;
  }
  return `${what} unjudged after ${Math.max(0, Number(entry?.waited) || 0)} s: ${STAGES[entry?.stage] ?? NO_STAGE}`;
}

// --- Fetching a picture or a video whole ---------------------------------------------------------------
// The background script fetches a picture whole to judge it and to copy it, and the Every try page fetches
// a video whole to show it again. A body is read only up to a cap (1.18.3), so that a huge file, or an
// address that answers with one, can't fill the add-on's memory: in Firefox every one of the add-on's
// pages shares one process with the background script, and a process out of memory takes the pages with
// it. A page is told from the answer's content type before a byte of it is read.

/** How many bytes a picture may be to be judged or copied, and a video to be shown again from its address. */
export const PICTURE_LENGTH = 20_000_000;
export const VIDEO_LENGTH = 50_000_000;

/** Whether an answer's content type is a page's (text/html), which a picture's or a video's address can answer with. */
export const isPage = (type) => /^text\/html\b/i.test(String(type ?? ''));

/** Whether an answer's content type is a video's. */
export const isVideoType = (type) => /^video\//i.test(String(type ?? ''));

/**
 * An answer's body as a Blob of its content type, read only up to `limit` bytes: null when the body is
 * longer, by its Content-Length header before a byte is read, or by its bytes as they come (the rest is
 * left unread). An answer without a body gives an empty Blob.
 */
export async function bodyUpTo(response, limit) {
  const type = response.headers?.get?.('content-type') ?? '';
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }
  if (!response.body) return new Blob([], { type });
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type });
}
