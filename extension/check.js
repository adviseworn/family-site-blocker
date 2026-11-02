// The hidden pictures checked in bulk (1.18.0), on a page of their own: every hidden picture that has a
// copy kept with the record (lib/pictures.js), together, one tile for each picture however many rows of
// the record show it (the same address, or the same copy: sameGroups), with the two marks on each tile
// and keys for them, so that the filter's mistakes can be found in one pass. Every picture shown here is
// a look, noted on the record with the reason asked for first, as a look from Every try is (tries.js);
// a mark goes to every row showing the picture, which the background script sees to (markAlike). There
// is no password (#58): anyone who can open this page can look, and every look is on the record. This
// page only reads the records, apart from the looks and the marks; nothing here can clear them.
import { element, hiddenWords, plural, showVersion, whenFormat } from './lib/page.js';
import { COPIES, COPIES_KEPT, PICTURES, WHY_LENGTH, borderline, copiesByKey, copyKey, describeHidden, isVideo, sameGroups } from './lib/pictures.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let tiles = []; // one for each picture with a copy kept, newest first: { key, rows: the record's entries showing it, newest first, shown: the one whose copy is shown, mark: the latest mark on any of them, or null }
const copies = new Map(); // copy key -> the copy, a data: address, once read: a copy doesn't change
let reason = ''; // why the pictures are being looked at: asked for before they show, and kept while the page is open
const noted = new Set(); // the keys of the rows whose look from here has been noted: one each, for as long as the page is open
let nextFocus = null; // after a mark, where the keyboard goes on the next redraw: the key of the next tile not yet marked, or NONE_LEFT

const NONE_LEFT = 'none left'; // no tile left to go on to: the keyboard goes to the line that says so, once the grid is empty
const keyOf = (entry) => `${entry.at} ${entry.url}`;
const markOf = (tile) => (tile.mark ? `Marked ${tile.mark.mistake ? 'hidden by mistake' : 'rightly hidden'} at ${whenFormat.format(tile.mark.at)}.` : '');

/** The tiles: one for each group of rows showing one picture (newest first) that has a copy kept, the newest copy shown. */
function tilesOf(groups, index) {
  return groups.flatMap((rows) => {
    if (isVideo(rows[0])) return []; // videos get no copy
    const shown = rows.find((row) => index.has(copyKey(row)));
    if (!shown) return [];
    const marks = rows.map((row) => row.mark).filter((mark) => typeof mark?.mistake === 'boolean').sort((a, b) => b.at - a.at);
    return [{ key: keyOf(shown), rows, shown, mark: marks[0] ?? null }];
  });
}

async function render() {
  const stored = await api.storage.local.get(PICTURES);
  const pictures = Array.isArray(stored[PICTURES]) ? stored[PICTURES] : [];
  const answer = await api.runtime.sendMessage({ type: 'copies-index' });
  if (answer?.error) throw new Error(answer.error);
  const index = copiesByKey(answer);
  const groups = sameGroups(pictures, index);
  tiles = tilesOf(groups, index);
  const wanted = tiles.map((tile) => copyKey(tile.shown)).filter((key) => !copies.has(key));
  if (wanted.length) for (const [key, copy] of Object.entries(await api.storage.local.get(wanted))) if (typeof copy === 'string' && copy) copies.set(key, copy);
  tiles = tiles.filter((tile) => copies.has(copyKey(tile.shown))); // a copy let go since the index was read has nothing to show
  const noCopy = groups.filter((rows) => !isVideo(rows[0])).length - tiles.length;
  const unmarked = tiles.filter((tile) => !tile.mark).length;
  $('summary').textContent = pictures.length
    ? [
        hiddenWords(pictures),
        tiles.length
          ? `${tiles.length === 1 ? '1 picture is' : `${tiles.length} pictures are`} shown here from the copies kept, ${unmarked === 0 ? (tiles.length === 1 ? 'marked already' : 'every one marked already') : `${unmarked === tiles.length ? (tiles.length === 1 ? 'not' : 'none') : unmarked === 1 ? '1 of them not' : `${unmarked} of them not`} yet marked`}.`
          : 'None has a copy kept, so there is nothing to show here.',
        noCopy ? `${noCopy === 1 ? '1 picture' : `${noCopy} pictures`} without a copy kept (hidden before 1.17.4, or past the latest ${COPIES_KEPT}) can be looked at on Every try alone.` : '',
        pictures.some(isVideo) ? 'Videos get no copy.' : '',
      ]
        .filter(Boolean)
        .join(' ')
    : 'No picture hidden so far.';
  show();
}

/** What the page shows as it stands: the question until it is answered, then the tools, the keys and the tiles. */
function show() {
  const any = tiles.length > 0;
  $('why-form').hidden = !any || Boolean(reason);
  $('tools').hidden = !any || !reason;
  $('keys').hidden = !any || !reason;
  $('all').hidden = !any || !reason;
  const unmarked = tiles.filter((tile) => !tile.mark).length;
  $('rest-rightly').hidden = unmarked === 0;
  $('rest-rightly').textContent = `Mark ${unmarked === tiles.length ? (unmarked === 1 ? 'it' : `all ${unmarked}`) : unmarked === 1 ? 'the other one' : `the other ${unmarked}`} as rightly hidden`;
  if (any && reason) {
    renderTiles();
    noteLooks();
  } else {
    $('grid').replaceChildren();
  }
}

function renderTiles() {
  const shown = tiles.filter((tile) => $('show-marked').checked || !tile.mark);
  const back = placeInGrid();
  $('grid').replaceChildren(...shown.map(tileOf));
  $('done').hidden = shown.length > 0;
  if (nextFocus) {
    const to = tileAt(nextFocus) ?? (shown.length === 0 ? $('done') : null);
    nextFocus = null;
    if (to) {
      to.focus({ preventScroll: true });
      to.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  back?.();
}

const tileAt = (key) => [...$('grid').querySelectorAll('.tile')].find((tile) => tile.dataset.key === key) ?? null;

/** A picture's tile: the copy, the site and time, why and the scores, its rows, its mark, and the marks to give it. */
function tileOf(tile) {
  const { rows, shown, mark } = tile;
  const newest = rows[0];
  const article = element('article', null, { class: `tile${mark ? ' marked' : ''}`, tabindex: '0', role: 'listitem' });
  article.dataset.key = tile.key;
  const what = describeHidden(newest).replace(/^Picture hidden/, 'Hidden');
  const where = `${newest.site}, ${whenFormat.format(newest.at)}`;
  const onRows = rows.length > 1 ? `On ${plural(rows.length, 'row')} among every try${new Set(rows.map((row) => row.site)).size > 1 ? `: ${[...new Set(rows.map((row) => row.site))].join(', ')}` : ''}.` : '';
  article.setAttribute('aria-label', [where, what, onRows, markOf(tile)].filter(Boolean).join(' '));
  article.append(element('img', null, { src: copies.get(copyKey(shown)), alt: 'The picture, as it was hidden' }));
  const caption = element('p', null, { class: 'tile-what' });
  caption.append(element('strong', newest.site), ` ${whenFormat.format(newest.at)}`, element('br'), element('small', what));
  if (borderline(newest)) caption.append(element('small', 'borderline', { class: 'borderline-mark' }));
  article.append(caption);
  if (onRows) article.append(element('p', onRows, { class: 'tile-rows' }));
  if (mark) article.append(element('p', markOf(tile), { class: 'tile-mark' }));
  const marks = element('div', null, { class: 'tile-marks' });
  for (const [mistake, label] of [
    [true, 'Hidden by mistake'],
    [false, 'Rightly hidden'],
  ]) {
    const chosen = mark?.mistake === mistake;
    const button = element('button', label, { type: 'button', class: 'secondary small', 'aria-pressed': String(chosen) });
    button.addEventListener('click', () => {
      if (!chosen) markTiles([tile], mistake);
    });
    marks.append(button);
  }
  article.append(marks);
  return article;
}

/**
 * Marks pictures, every row of each, hidden by mistake or rightly hidden: the background script writes
 * the marks (lib/pictures.js markAlike), and the record's change redraws the page with them, the keyboard
 * moved on to the next picture not yet marked.
 */
async function markTiles(marking, mistake) {
  const keys = new Set(marking.map((tile) => tile.key));
  const shown = [...$('grid').querySelectorAll('.tile')].map((tile) => tile.dataset.key);
  const first = Math.min(...marking.map((tile) => shown.indexOf(tile.key)).filter((i) => i >= 0));
  const open = (key) => !keys.has(key) && !tiles.find((tile) => tile.key === key)?.mark;
  nextFocus = shown.slice(first + 1).find(open) ?? shown.slice(0, first).reverse().find(open) ?? NONE_LEFT;
  for (const button of $('grid').querySelectorAll('.tile-marks button')) button.disabled = true;
  try {
    const answer = await api.runtime.sendMessage({ type: 'mark-hidden', keys: marking.flatMap((tile) => tile.rows.map(({ at, url }) => ({ at, url }))), mistake });
    if (answer?.error) throw new Error(answer.error);
    if (!answer?.found) throw new Error(`${marking.length === 1 ? 'it has' : 'they have'} gone from the record, which keeps the latest 500`);
    const rows = (answer.count ?? 0) + (answer.alike ?? 0);
    $('mark-status').textContent = `Marked ${marking.length === 1 ? '' : `${marking.length} pictures `}${mistake ? 'hidden by mistake' : 'rightly hidden'}${rows > marking.length ? `, on ${plural(rows, 'row')} among every try` : ''}.`;
  } catch (error) {
    $('mark-status').textContent = `Couldn’t mark ${marking.length === 1 ? 'it' : 'them'}: ${error.message}.`;
    nextFocus = null;
    for (const button of $('grid').querySelectorAll('.tile-marks button')) button.disabled = false;
  }
}

/** Notes a look, with the reason, on every row of every picture shown that has none noted from here yet. */
async function noteLooks() {
  const fresh = [...$('grid').querySelectorAll('.tile')].map((tile) => tiles.find((item) => item.key === tile.dataset.key)).filter(Boolean).flatMap((tile) => tile.rows).filter((row) => !noted.has(keyOf(row)));
  if (fresh.length === 0) return;
  for (const row of fresh) noted.add(keyOf(row));
  try {
    const answer = await api.runtime.sendMessage({ type: 'note-look', keys: fresh.map(({ at, url }) => ({ at, url })), why: reason });
    if (answer?.error) throw new Error(answer.error);
  } catch (error) {
    $('mark-status').textContent = `The look couldn’t go into the record: ${error.message}.`;
  }
}

/**
 * Where the keyboard is in the grid, so that a redraw, which swaps every tile for a new one, puts it back
 * there: on a tile, or on one of its buttons.
 */
function placeInGrid() {
  const active = document.activeElement;
  const tile = active?.closest('.tile');
  if (!tile) return null;
  const index = [...tile.querySelectorAll('button')].indexOf(active);
  const key = tile.dataset.key;
  return () => {
    const again = tileAt(key);
    if (!again) return;
    (index === -1 ? again : (again.querySelectorAll('button')[index] ?? again)).focus({ preventScroll: true });
  };
}

// The keys: the arrows move from tile to tile (up and down by a row of the grid), Home and End to the
// ends, M and R mark the tile the keyboard is on, or whose button it is on.
$('grid').addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tile = event.target.closest('.tile');
  if (!tile) return;
  const all = [...$('grid').querySelectorAll('.tile')];
  const i = all.indexOf(tile);
  const columns = all.filter((item) => item.offsetTop === all[0].offsetTop).length || 1;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + columns, ArrowUp: i - columns, Home: 0, End: all.length - 1 }[event.key];
  if (to !== undefined) {
    event.preventDefault();
    if (all[to]) all[to].focus();
    return;
  }
  const key = event.key.toLowerCase();
  if (key !== 'm' && key !== 'r') return;
  event.preventDefault();
  const item = tiles.find((candidate) => candidate.key === tile.dataset.key);
  if (item && item.mark?.mistake !== (key === 'm')) markTiles([item], key === 'm');
});

$('why').maxLength = WHY_LENGTH;
$('why-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const why = $('why').value.trim();
  if (!why) {
    $('why-status').textContent = 'Say why you’re looking first.';
    $('why').focus();
    return;
  }
  reason = why;
  show();
  $('grid').querySelector('.tile')?.focus();
});
$('show-marked').addEventListener('change', () => {
  renderTiles();
  noteLooks();
});
$('rest-rightly').addEventListener('click', () => markTiles(tiles.filter((tile) => !tile.mark), false));

// Keep the page current while it is open: the looks and marks redraw it, as does a picture hidden meanwhile.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[PICTURES] || changes[COPIES])) render().catch(() => {});
});

showVersion(api);
render().catch((error) => {
  $('summary').textContent = `Couldn't read the record: ${error.message}`;
});
