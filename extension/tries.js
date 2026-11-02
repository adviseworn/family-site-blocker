// Every try in the record of blocked attempts, grouped by day, newest first, on a page of its own: the
// record's one timeline. Laid in among the tries are the times the add-on was off (lib/watching.js), a
// band in its day with the visits to listed sites from then under it; the pictures and videos the picture
// filter kept hidden (lib/pictures.js), a row each with why, the judge's scores and the address, where the
// picture can be looked at (below); and the locked-away password's record (lib/lockbox.js), a row each in
// the words of the password's page.
// The record page (attempts.html) shows the record summed up and links here, for the whole record, for one
// site (tries.html#site=<the site>, from the by-site table there) or for the times the add-on was off
// alone (tries.html#off, from "Was it ever off?" there); the pictures page links here for the pictures
// alone (tries.html#pictures, and #site=<the site>&pictures for one site's), and the password's page for
// its entries alone (tries.html#password). Like the other pages, this one only reads the records, apart
// from noting the looks at hidden pictures; nothing here can clear them (see lib/attempts.js).
import { ATTEMPTS, LABELS, offDuring, outcome, summarize, timeline, toCsv } from './lib/attempts.js';
import { EVENTS, EVENTS_SINCE, beginningOf, describeEvent, describeRecord, loadBox } from './lib/lockbox.js';
import { dayFormat, element, hiddenWords, lookWords, offVisitsWords, offWords, plural, showVersion, timeFormat, timeOn, tries as triesWord, whenFormat } from './lib/page.js';
import { COPIES_KEPT, PICTURES, URL_LENGTH, WHY_LENGTH, borderline, copyKey, countHidden, describeHidden, isData, isVideo, lookedAt, scoresOf } from './lib/pictures.js';
import { WATCHING, normalize } from './lib/watching.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const PASSWORD = 'Locked-away password'; // what the password's rows say in the site column

let attempts = []; // the record as stored: oldest first
let pictures = []; // the pictures and videos hidden, as stored: oldest first
let watching = null; // when the extension was running (lib/watching.js): places the visits from the history, and holds the times it was off
let lockbox = { events: [], since: null }; // the locked-away password's record: its entries, oldest first, and when it began

/**
 * What the address asks for: one site (tries.html#site=example.com), or null for every site; only the
 * times the add-on was off (tries.html#off); only the pictures hidden (tries.html#pictures, with a site
 * or not); or only the locked-away password's record (tries.html#password).
 */
function asked() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { site: params.get('site') || null, onlyOff: params.has('off'), onlyPictures: params.has('pictures'), onlyPassword: params.has('password') };
}

/** The pictures hidden as entries for the timeline, newest first: { at, picture: the record's entry }. */
const pictureEntries = (list) => list.map((picture) => ({ at: picture.at, picture })).reverse();

/**
 * The password's record as entries for the timeline, newest first: { at, password: the entry } for each,
 * then { at, began } for the row that says when the record began, which the timeline keeps last among
 * entries at the same moment.
 */
function passwordEntries({ events, since }) {
  const entries = events.map((entry) => ({ at: Date.parse(entry.at), password: entry })).reverse();
  const beginning = beginningOf({ events, since });
  if (beginning) entries.push({ at: Date.parse(beginning.at), began: beginning });
  return entries;
}

function dayHeading(day, { tries, hidden, password }) {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const name = day === midnight ? 'Today' : day === midnight - 86_400_000 ? 'Yesterday' : null;
  const heading = element('h3', name ? `${name}, ` : '');
  const counts = [tries ? triesWord(tries) : '', hidden.length ? `${countHidden(hidden)} hidden` : '', password ? `${password} password ${password === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean);
  heading.append(element('span', dayFormat.format(day)), ' ', element('small', counts.join(', ') || 'no tries'));
  return heading;
}

/** The band for a time the add-on was off, in a day's table: times alone for that day, the day named at an end that falls in another. */
function bandWords(day, { off }) {
  const when = timeOn(day);
  const pages = off.pages ? `: ${plural(off.pages, 'page')} visited meanwhile` : '';
  return `Add-on off from ${when(off.from)} until ${when(off.to)}${pages}.`;
}

/**
 * A hidden picture's or video's row in its day's table: when, the site, and what the record says, with the
 * judge's scores beside it, the mark of a close call, and the address under them, to copy or to look at;
 * then what the record says of the looks at it and its mark (times alone for that day, as on the bands),
 * the picture itself once looked at here, and the marks to give it.
 */
function pictureRow({ at, picture }, day) {
  const close = borderline(picture);
  const key = keyOf(picture);
  const row = element('tr', null, { class: ['picture', isVideo(picture) ? 'video' : '', close ? 'borderline' : ''].filter(Boolean).join(' ') });
  row.dataset.key = key;
  const what = element('td', describeHidden(picture));
  what.append(element('small', scoresOf(picture), { class: 'picture-scores' }));
  if (close) what.append(element('small', 'borderline', { class: 'borderline-mark' }));
  const where = element('div', null, { class: 'picture-where' });
  const copy = element('button', 'Copy address', { type: 'button', class: 'secondary small' });
  copy.addEventListener('click', () => copyAddress(picture.url, copy));
  const look = element('button', 'Look at it', { type: 'button', class: 'secondary small look' });
  look.addEventListener('click', () => lookAt(picture));
  const actions = element('span', null, { class: 'picture-actions' });
  actions.append(copy, look);
  // A data: address is the picture itself, written out, and reads as nothing: its start and its length stand for it.
  const address = isData(picture.url) ? `${picture.url.slice(0, 40)}… (${picture.url.length.toLocaleString()} characters)` : picture.url;
  where.append(element('small', address, { class: 'picture-url', title: picture.url }), actions);
  what.append(where);
  const notes = lookWords(picture, day);
  if (notes) what.append(element('p', notes, { class: 'picture-notes' }));
  if (shown.has(key)) what.append(lookBox(picture, shown.get(key)));
  if (lookedAt(picture)) what.append(marksFor(picture));
  row.append(element('td', timeFormat.format(at)), element('td', picture.site), what);
  return row;
}

// --- Looking at a hidden picture ----------------------------------------------------------------------
// A hidden picture can be looked at here, where the filter doesn't run (content scripts run in web pages,
// not in the add-on's own): from the smaller copy kept apart from the record when it was hidden (1.17.4,
// lib/pictures.js), or, for one hidden before that or among the oldest, from a copy the background script
// makes now, fetching the address the way it fetched the picture to judge it; a video, which gets no copy,
// is fetched here from its address. There is no password (#58): anyone who can open this page can look, and every look goes into
// the record on the picture's row, with the time and the reason asked for first (once, for as long as the
// page is open, as the locked-away password's page asks why before unlocking), and the mark given after it,
// hidden by mistake or rightly hidden. The reason is asked for in the row, under the button pressed, so
// the page stays where it was (1.17.4; asked for at the top of the page, as at first, it scrolled there).
// The background script writes both (lib/pictures.js noteLook and markHidden), in turn with its notes of
// pictures just hidden. What a look fetched, and a question still open, are kept here across the redraws
// the record's changes bring, so a picture stays shown once it is, and the question stays asked.
const shown = new Map(); // key -> { asking: true, draft } while the reason is asked for, { fetching } while the picture is on its way, then { kind: 'picture' | 'video', url: a data: or object URL, copied: 'kept' | 'now' | undefined } or { kind: 'page', url } or { error }
const keyOf = (picture) => `${picture.at} ${picture.url}`;
const FETCH_WAIT_MS = 20_000; // how long a video's address is given to answer
const NO_COPY = `no copy of it is kept (only the latest ${COPIES_KEPT} hidden have one)`; // hidden before 1.17.4, or let go since
const rowOf = (key) => [...document.querySelectorAll('.day tr.picture')].find((row) => row.dataset.key === key) ?? null;
let reason = ''; // why the pictures are being looked at: asked for at the first look, and kept for the rest while the page is open

async function lookAt(picture, why = reason) {
  const key = keyOf(picture);
  if (!why) {
    if (!shown.get(key)?.asking) {
      shown.set(key, { asking: true, draft: '' });
      showBox(key);
    }
    const field = rowOf(key)?.querySelector('.look-why');
    if (!field) return;
    field.focus({ preventScroll: true });
    field.closest('.picture-look').scrollIntoView({ block: 'nearest' }); // not at all unless the row sits at the window's bottom edge, and then only as far as the question needs
    return;
  }
  reason = why;
  const before = shown.get(key);
  if (before && !before.error && !before.asking) return; // shown already, or on its way: one look is one note
  shown.set(key, { fetching: true });
  showBox(key);
  rowOf(key)?.querySelector('button.look')?.focus({ preventScroll: true }); // from the question, gone with its box, back to the row's button
  try {
    const answer = await api.runtime.sendMessage({ type: 'note-look', at: picture.at, url: picture.url, why });
    if (answer?.error) throw new Error(answer.error);
    if (!answer?.found) throw new Error('it has gone from the record, which keeps the latest 500');
  } catch (error) {
    shown.set(key, { error: `the look couldn’t go into the record (${error.message})` });
    showBox(key);
    return;
  }
  // The note redraws the page (storage.onChanged), with the look on the row and the picture's box there meanwhile.
  try {
    shown.set(key, await fetchPicture(picture));
  } catch (error) {
    shown.set(key, { error: error.message });
  }
  showBox(key);
}

/**
 * What a hidden picture's row shows: { kind: 'picture', url: a data: address, copied: 'kept' } from the
 * copy kept when it was hidden; failing that, the background script's copy made now from its address,
 * { kind: 'picture', url, copied: 'now' }, or { kind: 'page', url } when the address answers with a page
 * (which a video the page made itself is noted under). A video is fetched here from its address:
 * { kind: 'video' | 'picture', url: an object URL }, or { kind: 'page', url }. Throws, in words for the
 * row, when there is nothing to show.
 */
async function fetchPicture(picture) {
  const { at, url } = picture;
  if (isVideo(picture)) return fetchVideo(url);
  const key = copyKey({ at, url });
  const kept = (await api.storage.local.get(key))[key];
  if (typeof kept === 'string' && kept) return { kind: 'picture', url: kept, copied: 'kept' };
  // A data: address is the picture itself, written out, of which the record keeps only the start.
  if (isData(url) && url.length >= URL_LENGTH) throw new Error(`the record holds only the start of its data: address, and ${NO_COPY}`);
  const answer = await api.runtime.sendMessage({ type: 'copy-picture', url });
  if (answer?.page) return { kind: 'page', url };
  if (answer?.copy) return { kind: 'picture', url: answer.copy, copied: 'now' };
  throw new Error(`${answer?.error ?? 'the background script gave no answer'}, and ${NO_COPY}`);
}

/**
 * A video at an address, fetched as the background script fetched a frame's video to judge it (with the
 * browser's cookies, from its cache when it has it): { kind: 'video' | 'picture', url: an object URL },
 * or { kind: 'page', url } when the address answers with a page. Throws when it can't be fetched.
 */
async function fetchVideo(url) {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), FETCH_WAIT_MS);
  let response;
  try {
    response = await fetch(url, { credentials: 'include', cache: 'force-cache', redirect: 'follow', signal: giveUp.signal });
  } catch (error) {
    throw new Error(giveUp.signal.aborted ? `its address didn’t answer in ${FETCH_WAIT_MS / 1000} seconds` : `its address couldn’t be reached (${error.message})`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`it couldn’t be fetched (${response.status}), and no copy of a video is kept`);
  const blob = await response.blob();
  if (/^text\/html\b/i.test(blob.type)) return { kind: 'page', url };
  return { kind: /^video\//i.test(blob.type) ? 'video' : 'picture', url: URL.createObjectURL(blob) };
}

/** The box in a hidden picture's row that asks why first, then shows the picture, or what stands in its way. */
function lookBox(picture, seen) {
  const box = element('div', null, { class: 'picture-look' });
  if (seen.asking) {
    box.classList.add('asking');
    box.append(whyAsked(picture, seen));
  } else if (seen.fetching) {
    box.append(element('p', 'Fetching it…'));
  } else if (seen.error) {
    box.append(element('p', `Couldn’t show it: ${seen.error}.`));
  } else if (seen.kind === 'page') {
    const note = element('p', isVideo(picture) ? 'The page made the video itself, so only the page’s address is known. ' : 'Its address answers with a page, not a picture. ');
    note.append(element('a', 'Open the page', { href: seen.url, target: '_blank', rel: 'noopener' }), '.');
    box.append(note);
  } else if (seen.kind === 'video') {
    box.append(element('video', null, { src: seen.url, controls: '', preload: 'metadata' }));
  } else {
    const img = element('img', null, { src: seen.url, alt: 'The picture, as it was hidden' });
    img.addEventListener('error', () => img.replaceWith(element('p', 'Couldn’t show it: not a picture this browser can show.')));
    box.append(img);
    // The copy kept when it was hidden is the usual way, and goes without saying; one fetched again says so.
    if (seen.copied === 'now') box.append(element('p', `Fetched again from its address: ${NO_COPY}.`));
  }
  return box;
}

/**
 * The question asked in a picture's row before the first look: the field, with what has been typed so far
 * kept through a redraw, Look (or Enter) to answer it, and Not now (or Escape) to take it away.
 */
function whyAsked(picture, seen) {
  const key = keyOf(picture);
  const asked = element('div', null, { class: 'look-why-row' });
  const label = element('label', null, { class: 'look-why-label' });
  label.append(element('span', 'Why are you looking? Your answer goes into the record.'));
  const field = element('input', null, { type: 'text', class: 'look-why', maxlength: String(WHY_LENGTH), autocomplete: 'off' });
  field.value = seen.draft;
  field.addEventListener('input', () => {
    seen.draft = field.value;
  });
  label.append(field);
  const status = element('p', null, { class: 'look-why-status', role: 'status' });
  const answer = () => {
    const why = field.value.trim();
    if (why) {
      lookAt(picture, why);
      return;
    }
    status.textContent = 'Say why you’re looking first.';
    field.focus({ preventScroll: true });
  };
  const notNow = () => {
    shown.delete(key);
    showBox(key);
    rowOf(key)?.querySelector('button.look')?.focus({ preventScroll: true });
  };
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    if (event.key === 'Enter') answer();
    else notNow();
  });
  const go = element('button', 'Look', { type: 'button', class: 'small look-go' });
  go.addEventListener('click', answer);
  const cancel = element('button', 'Not now', { type: 'button', class: 'secondary small look-cancel' });
  cancel.addEventListener('click', notNow);
  asked.append(label, go, cancel);
  const parts = document.createDocumentFragment();
  parts.append(asked, status);
  return parts;
}

/** Draws a picture's box in its row as the page stands, in place of the one there, or takes it away. */
function showBox(key) {
  const row = rowOf(key);
  if (!row) return;
  const old = row.querySelector('.picture-look');
  const seen = shown.get(key);
  if (!seen) {
    old?.remove();
    return;
  }
  const picture = pictures.find((entry) => keyOf(entry) === key);
  if (!picture) return;
  const box = lookBox(picture, seen);
  const marks = row.querySelector('.picture-marks');
  if (old) old.replaceWith(box);
  else if (marks) marks.before(box);
  else row.cells[2].append(box);
}

/** The two marks a looked-at picture can be given, the one it has pressed in. */
function marksFor(picture) {
  const marks = element('div', null, { class: 'picture-marks' });
  const status = element('p', null, { class: 'mark-status', role: 'status' });
  for (const [mistake, label] of [
    [true, 'Hidden by mistake'],
    [false, 'Rightly hidden'],
  ]) {
    const chosen = picture.mark?.mistake === mistake;
    const button = element('button', label, { type: 'button', class: 'secondary small', 'aria-pressed': String(chosen) });
    button.addEventListener('click', () => {
      if (!chosen) mark(picture, mistake, button, status);
    });
    marks.append(button);
  }
  marks.append(status);
  return marks;
}

async function mark(picture, mistake, button, status) {
  button.disabled = true;
  try {
    const answer = await api.runtime.sendMessage({ type: 'mark-hidden', at: picture.at, url: picture.url, mistake });
    if (answer?.error) throw new Error(answer.error);
    if (!answer?.found) throw new Error('it has gone from the record, which keeps the latest 500');
    // The record's change redraws the page, with the mark on the row.
  } catch (error) {
    status.textContent = `Couldn’t mark it: ${error.message}.`;
    button.disabled = false;
  }
}

/**
 * Where the keyboard is in a hidden picture's row, so that a redraw, which swaps every row for a new one,
 * puts it back there: in the question's field, with what was typed selected as it was, or on a button.
 */
function placeInRow() {
  const active = document.activeElement;
  const row = active?.closest('tr.picture');
  if (!row) return null;
  const index = [...row.querySelectorAll('input, button')].indexOf(active);
  const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  return () => {
    const again = rowOf(row.dataset.key)?.querySelectorAll('input, button')[index];
    if (!again) return;
    again.focus({ preventScroll: true });
    if (selection && again instanceof HTMLInputElement) again.setSelectionRange(...selection);
  };
}

function renderDays(days) {
  const fragment = document.createDocumentFragment();
  for (const { day, entries } of days) {
    const section = element('section', null, { class: 'day' });
    const tries = entries.filter((entry) => entry.attempt).length;
    const hidden = entries.filter((entry) => entry.picture).map((entry) => entry.picture);
    const password = entries.filter((entry) => entry.password).length;
    section.append(dayHeading(day, { tries, hidden, password }));
    const table = element('table', null, { class: 'attempts' });
    if (entries.some((entry) => !entry.off)) {
      const head = element('thead');
      const headRow = element('tr');
      for (const title of ['Time', 'Site', 'Result']) headRow.append(element('th', title, { scope: 'col' }));
      head.append(headRow);
      table.append(head);
    }
    const body = element('tbody');
    for (const entry of entries) {
      if (entry.off) {
        const band = element('tr', null, { class: 'band' });
        band.append(element('td', bandWords(day, entry), { colspan: '3' }));
        body.append(band);
        continue;
      }
      if (entry.picture) {
        body.append(pictureRow(entry, day));
        continue;
      }
      if (entry.password || entry.began) {
        const row = element('tr', null, { class: entry.began ? 'password began' : 'password' });
        row.append(element('td', timeFormat.format(entry.at)), element('td', PASSWORD), element('td', entry.began ? entry.began.what : describeEvent(entry.password)));
        body.append(row);
        continue;
      }
      const what = outcome(entry.attempt, watching);
      const row = element('tr', null, { class: entry.during ? `${what} within` : what });
      row.append(element('td', timeFormat.format(entry.at)), element('td', entry.attempt.site), element('td', LABELS[what]));
      body.append(row);
    }
    table.append(body);
    section.append(table);
    fragment.append(section);
  }
  $('days').replaceChildren(fragment);
}

function renderSummary(shown, { site, onlyOff, onlyPictures, onlyPassword }, off, tracked, hidden) {
  const counts = summarize(shown, watching);
  const summary = $('summary');
  if (onlyPassword) {
    summary.textContent = describeRecord(lockbox) || 'Nothing has been done with the locked-away password on its page yet.';
    return;
  }
  if (onlyPictures) {
    summary.textContent = hiddenWords(hidden, site) || (site ? `No picture hidden on ${site}.` : 'No picture hidden so far.');
    return;
  }
  if (onlyOff) {
    const found = offVisitsWords(off, counts, tracked) || 'Nothing is known yet about when the extension was running.';
    summary.textContent = off.length ? `${offWords(off)} ${found}` : found;
    return;
  }
  if (site && shown.length === 0) {
    // A site with no tries: say so, and what was hidden there, if anything, which is shown below.
    summary.textContent = [attempts.length ? `No tries at ${site} in the record.` : 'No attempts so far.', hiddenWords(hidden, site)].filter(Boolean).join(' ');
    return;
  }
  const record =
    attempts.length === 0
      ? 'No attempts so far.'
      : `${triesWord(counts.tries)}${site ? '' : ` at ${plural(counts.sites, 'site')}`}, the latest at ${whenFormat.format(counts.latest)}.` +
        (counts.opened ? ` ${plural(counts.opened, 'page')} opened instead of being blocked.` : '') +
        (counts.history ? ` ${counts.history} from this browser's history${counts.off ? `, ${counts.off} of them from times the extension was off` : ''}.` : '');
  summary.textContent = [record, offWords(off)].filter(Boolean).join(' ');
}

// What this page shows of the times the add-on was off, so that the minute-by-minute notes of running don't redraw it.
let offShown = '';
const offPart = (state) => JSON.stringify(normalize(state).off);

async function render() {
  const stored = await api.storage.local.get([ATTEMPTS, PICTURES, WATCHING]);
  attempts = Array.isArray(stored[ATTEMPTS]) ? stored[ATTEMPTS] : [];
  pictures = Array.isArray(stored[PICTURES]) ? stored[PICTURES] : [];
  watching = stored[WATCHING] ?? null;
  offShown = offPart(watching);
  lockbox = await loadBox(api.storage.local);
  const { off, periods } = normalize(watching);
  const { site, onlyOff, onlyPictures, onlyPassword } = asked();
  let shown = site ? attempts.filter((attempt) => attempt.site === site) : attempts;
  if (onlyOff) shown = shown.filter((attempt) => offDuring(off, attempt.at));
  if (onlyPictures || onlyPassword) shown = [];
  // The pictures hidden go in among every try and among one site's tries, and are shown alone; the
  // password's entries go in among every try and are shown alone; the times off are shown with the tries alone.
  const hidden = onlyOff || onlyPassword ? [] : site ? pictures.filter((picture) => picture.site === site) : pictures;
  const password = onlyPassword || (!site && !onlyOff && !onlyPictures) ? passwordEntries(lockbox) : [];
  const only = [onlyOff ? 'the times the add-on was off' : '', onlyPictures ? 'the pictures hidden' : '', onlyPassword ? 'the locked-away password' : ''].filter(Boolean);
  $('filter').hidden = !site && only.length === 0;
  $('filter-site').textContent = [site, ...only].filter(Boolean).join(', ');
  $('filter-clear').textContent = site ? 'Show every site' : 'Show every try';
  document.title = `Family Site Blocker record: ${site ?? (onlyOff ? 'while the add-on was off' : onlyPictures ? 'the pictures hidden' : onlyPassword ? 'the locked-away password' : 'every try')}`;
  renderSummary(shown, { site, onlyOff, onlyPictures, onlyPassword }, off, periods.length > 0, hidden);
  $('off-intro').hidden = off.length === 0 || onlyPictures || onlyPassword;
  $('pictures-intro').hidden = hidden.length === 0;
  $('pictures-alone').hidden = onlyPictures;
  $('password-intro').hidden = password.length === 0 || onlyPassword;
  $('save-file').hidden = attempts.length === 0;
  // A site with neither tries nor pictures shows nothing, not even the times the add-on was off; every
  // other view lays those in, except the pictures' and the password's alone.
  const nothing = site && shown.length === 0 && hidden.length === 0;
  const days = nothing ? [] : timeline(shown, onlyPictures || onlyPassword ? null : watching, [...pictureEntries(hidden), ...password]);
  $('all').hidden = days.length === 0;
  const back = placeInRow();
  renderDays(days);
  back?.();
}

async function copyAddress(url, button) {
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Copied';
    $('copy-status').textContent = 'Address copied. Paste it into a browser without the extension.';
  } catch (error) {
    $('copy-status').textContent = `Couldn’t copy: ${error.message}. Select the address in the row instead.`;
  }
  setTimeout(() => {
    button.textContent = 'Copy address';
  }, 2000);
}

function saveFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `family-site-blocker-record-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toCsv(attempts, watching)], { type: 'text/csv' }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  $('save-status').textContent = `Saved ${name} to your downloads: the whole record, oldest first.`;
}

$('save-file').addEventListener('click', saveFile);
window.addEventListener('hashchange', () => render().catch(() => {}));
// Keep the page current while it is open: the records, and the times the add-on was off. (The extension's
// running time is written every minute; a redraw for that would place a visit from the last minute no
// differently, so only a change in the times off counts.)
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ATTEMPTS] || changes[PICTURES] || changes[EVENTS] || changes[EVENTS_SINCE]) render();
  else if (changes[WATCHING] && offPart(changes[WATCHING].newValue) !== offShown) render();
});

showVersion(api);
render()
  // Then have the background script look at the silences since it last did, so the times off are current.
  .then(() => api.runtime.sendMessage({ type: 'check-gaps' }).catch(() => null))
  .then(() => render())
  .catch((error) => {
    $('summary').textContent = `Couldn't read the record: ${error.message}`;
  });
