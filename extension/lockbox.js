// The locked-away password, on a page of its own (lockbox.html; the settings page shows one line on where
// it stands and links here). The password is kept only inside a time-lock puzzle (lib/timelock.js);
// getting it back means letting lockbox-worker.js work through the puzzle with this page open: layer by
// layer when the wait has been lengthened, each layer's puzzle giving the box inside it and the last the
// password. Progress is saved as it goes, so closing the page pauses the work rather than losing it.
// Everything done here is written to a record (lib/lockbox.js, EVENTS) that stays when the password is
// deleted or replaced (#75): this page sums it up in a line, and its entries are rows among every try on
// tries.html (tries.html#password shows them alone). The boxes that
// have held each password are noted too (WAITS), with the wait last set for it, so that a backup file
// saved before the wait was lengthened is lengthened to it as it is restored here (1.13.0).
import { BOX, PROGRESS, describeRecord, duration, fractionDone, layerUnderWork, loadBox, longerWaitFor, noteBox, recordEvent, sinceText } from './lib/lockbox.js';
import { element, showVersion } from './lib/page.js';
import { START, isBox, lengthen, modulusOf, open, seal, secondsOf, stepsOf, waitOf } from './lib/timelock.js';

const api = globalThis.browser ?? globalThis.chrome;
const store = api.storage.local;
const $ = (id) => document.getElementById(id);

const SAVE_EVERY_MS = 5000;
// What a longer wait can't undo, said when the password is locked away again with one from the open panel
// (the locked panel's note says it before the wait is lengthened there). "Anywhere but here": this profile
// lengthens such a file as it is restored (restore), but the file itself is as it was.
const OLD_BACKUPS =
  'A backup file saved before this still opens after the old wait anywhere but here: delete it (and empty the Trash) or make up a new password, and save a new backup file.';
// How the password shown leaves the page, said under it: Hide and Lock it away again clear it from the clipboard
// (clearClipboard); closing the page can't, since the browser only lets the page write to the clipboard after a click.
const STAYS = 'It stays on this page until you click Hide or close the page. Hide and Lock it away again also clear it from the clipboard if it was copied here; closing the page doesn’t.';

let worker = null;
let lastSaved = 0;
let startedAt = null; // when the unlocking under way was started, for the progress record and the `shown` entry
let why = null; // why it was started, as typed when it began: kept with the progress and given with the `shown` entry (1.13.2)
let latestDone = 0; // the squarings done so far by the worker, over every layer, which is ahead of the progress saved
// Whether the password is on the clipboard from this page (Copy, or ⌘C/Ctrl+C on one of its boxes) and hasn't been
// cleared from it since: what clearClipboard() goes by, since reading the clipboard would take a permission of its own.
let onClipboard = false;
// A failure to write the record must not stop what the person asked for; it is noted in the console.
const record = (event, details) =>
  recordEvent(store, event, details).catch((error) => {
    console.warn(`Family Site Blocker: couldn’t record "${event}" for the locked-away password: ${error.message}`);
    return { at: new Date().toISOString(), event, ...details };
  });
// Likewise noting a box among those that have held its password (lib/lockbox.js noteBox).
const note = (box, details) =>
  noteBox(store, box, details).catch((error) => console.warn(`Family Site Blocker: couldn’t note the locked-away password’s box: ${error.message}`));

function say(text) {
  $('lockbox-status').textContent = text;
}

/**
 * Clears the clipboard when the password is on it from this page, so that locking it away or hiding it doesn't
 * leave it there to paste. Called first thing from the click, before anything is awaited: without a permission of
 * its own, the browser only lets the page write to the clipboard for a few seconds after a click on it, which is
 * also why closing the page can't clear it. Resolves to what the status line should add: nothing when there was
 * nothing to clear.
 */
async function clearClipboard() {
  if (!onClipboard) return '';
  try {
    await navigator.clipboard.writeText('');
    onClipboard = false;
    $('lockbox-copied').hidden = true;
    return ' Cleared from the clipboard too.';
  } catch (error) {
    return ` It couldn’t be cleared from the clipboard (${error.message}): copy something else to replace it.`;
  }
}

function startWorker() {
  return new Worker(api.runtime.getURL('lockbox-worker.js'), { type: 'module' });
}

/** Squarings per second on this computer, timed in a worker like the real work. */
function measureRate() {
  const measuring = startWorker();
  return new Promise((resolve, reject) => {
    measuring.onmessage = ({ data }) => resolve(data.rate);
    measuring.onerror = (event) => reject(new Error(event.message || 'the worker failed'));
    measuring.postMessage({ type: 'measure', ms: 1000 });
  }).finally(() => measuring.terminate());
}

const load = () => loadBox(store);

function showOnly(id) {
  for (const part of ['lockbox-empty', 'lockbox-locked', 'lockbox-open']) $(part).hidden = part !== id;
}

/**
 * Times this computer, locks `secret` away with a wait of `delay` seconds in place of whatever is stored, and
 * throws any unlocking progress away. `whose` says which password the new box holds and whether the wait was
 * chosen for it (noteBox): the box it was in before as `previous`, and `delay` when chosen.
 */
async function lockAway(secret, delay, whose = {}) {
  const rate = await measureRate();
  const box = await seal(secret, { steps: Math.max(1, Math.round(delay * rate)), delay, rate });
  await store.set({ [BOX]: box });
  await store.remove(PROGRESS);
  await note(box, whose);
  return box;
}

/** Picks the option of `select` worth `seconds`, when there is one. */
function choose(select, seconds) {
  const option = [...select.options].find((candidate) => Number(candidate.value) === seconds);
  if (option) option.selected = true;
}

/** Leaves only the waits longer than `present` seconds to choose from in `select`; false when there is none. */
function offerLonger(select, present) {
  const longer = [...select.options].filter((option) => {
    option.disabled = Number(option.value) <= Math.round(present);
    return !option.disabled;
  });
  if (longer.length && select.selectedOptions[0]?.disabled !== false) longer[0].selected = true;
  return longer.length > 0;
}

/** The progress bar and its line: how far through all the squarings, and about how long to go at `rate`. */
function showProgress(box, progress, rate) {
  const layer = layerUnderWork({ box, progress });
  const fraction = fractionDone({ box, progress });
  $('lockbox-progress-area').hidden = false;
  $('lockbox-progress').value = fraction;
  // The rest of this layer at the rate seen, then the layers inside it at the rates they were timed at.
  const toGo = (layer.steps - progress.done) / rate + secondsOf(layer.inside ?? []);
  $('lockbox-progress-text').textContent = `${Math.floor(fraction * 100)}% done, about ${duration(toGo)} to go.`;
}

/** The record summed up in a line (lib/lockbox.js describeRecord), with a link to its entries among every try; nothing with no record. */
function renderEvents({ events, since }) {
  const section = $('lockbox-record');
  section.hidden = events.length === 0;
  const line = $('lockbox-record-line');
  line.replaceChildren();
  if (events.length === 0) return;
  line.append(`${describeRecord({ events, since })} `, element('a', `See ${events.length === 1 ? 'it' : 'them'} among every try`, { href: 'tries.html#password' }), '.');
}

async function render() {
  const loaded = await load();
  const { box, progress, events } = loaded;
  renderEvents(loaded);
  if (!box) {
    showOnly('lockbox-empty');
    return;
  }
  showOnly('lockbox-locked');
  $('lockbox-summary').textContent =
    `A password is locked away (${sinceText({ box, events })}). Getting it back takes about ${duration(waitOf(box))} ` +
    'of computing with this page open and the computer awake. If the page is closed or the computer sleeps, ' +
    'the work pauses and carries on where it left off.';

  const running = worker !== null;
  $('lockbox-start').hidden = running;
  $('lockbox-start').textContent = progress ? 'Carry on unlocking' : 'Start unlocking';
  $('lockbox-why-area').hidden = running || Boolean(progress); // the reason was given when it began
  $('lockbox-stop').hidden = !running && !progress;
  $('lockbox-delete').hidden = running;
  $('lockbox-lengthen-area').hidden = running;
  const canLengthen = offerLonger($('lockbox-longer'), waitOf(box));
  $('lockbox-longer').disabled = !canLengthen;
  $('lockbox-lengthen').disabled = !canLengthen;
  $('lockbox-longest').hidden = canLengthen;
  if (progress) showProgress(box, progress, layerUnderWork({ box, progress }).rate);
  else $('lockbox-progress-area').hidden = true;
}

async function lock() {
  const secret = $('lockbox-secret').value;
  if (!secret) {
    say('Type the password to lock away first.');
    return;
  }
  const clearing = clearClipboard(); // now, while the click still lets the page write to the clipboard
  const delay = Number($('lockbox-delay').value);
  $('lockbox-lock').disabled = true;
  say('Timing this computer to set the wait…');
  try {
    await lockAway(secret, delay, { delay });
    await record('locked', { delay });
    $('lockbox-secret').value = '';
    await render();
    say(`Locked away.${await clearing} Save a backup file so it isn’t lost if the extension is removed.`);
  } catch (error) {
    say(`Couldn’t lock it away: ${error.message}.${await clearing}`);
  } finally {
    $('lockbox-lock').disabled = false;
  }
}

// Locks the stored box inside a longer puzzle, so that the whole wait becomes the one chosen. The password
// isn't needed for that, so there is no unlocking; any unlocking under way would have to start again.
async function lengthenWait() {
  const { box, progress } = await load();
  if (!box || worker) return;
  const target = Number($('lockbox-longer').value);
  const present = waitOf(box);
  if (!(target > Math.round(present))) {
    say('Choose a wait longer than the present one.');
    return;
  }
  if (progress && !confirm('Lengthening the wait throws away the unlocking done so far. Carry on?')) return;
  $('lockbox-lengthen').disabled = true;
  say('Timing this computer to set the wait…');
  let said;
  try {
    const rate = await measureRate();
    if (worker) throw new Error('unlocking was started meanwhile');
    const longer = await lengthen(box, { steps: Math.max(1, Math.round((target - present) * rate)), delay: target, rate });
    await store.set({ [BOX]: longer });
    await store.remove(PROGRESS);
    await note(longer, { previous: box, delay: target });
    await record('lengthened', { from: box.delay, to: target });
    said = `The wait is now ${duration(waitOf(longer))}. Save a new backup file: one saved before this still opens after the old wait anywhere but here.`;
  } catch (error) {
    said = `Couldn’t lengthen the wait: ${error.message}`;
  }
  await render();
  say(said);
}

async function startUnlocking() {
  const { box, progress } = await load();
  if (!box || worker) return;
  // Starting needs a reason, which goes into the record (1.13.2); carrying on paused work was given one when it began.
  const reason = $('lockbox-why').value.trim();
  if (!progress && !reason) {
    say('Say why you’re unlocking it first. Your answer goes into the record.');
    $('lockbox-why').focus();
    return;
  }
  worker = startWorker();
  // The record says it was started, or carried on and from where. Work carried on keeps the time it was
  // first started (progress saved before 1.9.0 has none: then the time it was carried on stands in) and the
  // reason it was started for (none before 1.13.2).
  latestDone = progress ? progress.before + progress.done : 0;
  if (progress) {
    const resumed = await record('resumed', { done: latestDone, steps: stepsOf(box) });
    startedAt = typeof progress.startedAt === 'string' ? progress.startedAt : resumed.at;
    why = typeof progress.why === 'string' ? progress.why : null;
  } else {
    why = reason;
    startedAt = (await record('started', { why })).at;
    $('lockbox-why').value = '';
  }
  say('');
  await render();
  work(box, progress?.before ?? 0, progress?.inner, progress ? BigInt(`0x${progress.x}`) : START, progress?.done ?? 0);
}

/**
 * Sets the worker on one layer of the stored `box`: the box itself, or `inner`, a box inside it that the
 * work has reached; from the number `x` reached after `done` of its squarings, with `before` squarings done
 * in the layers already opened. Once the layer's puzzle is solved, carries on with the box inside it, or
 * shows the password.
 */
function work(box, before, inner, x, done) {
  const layer = inner ?? box;
  const progressOf = (reached, count) => ({ n: box.n, ...(inner && { inner }), x: reached.toString(16), done: count, before, startedAt, ...(why !== null && { why }), workedAt: new Date().toISOString() });
  worker.onmessage = async ({ data }) => {
    if (data.type === 'progress') {
      latestDone = before + data.done;
      showProgress(box, { before, inner, done: data.done }, data.rate || layer.rate);
      if (Date.now() - lastSaved >= SAVE_EVERY_MS) {
        lastSaved = Date.now();
        await store.set({ [PROGRESS]: progressOf(data.x, data.done) });
      }
    } else if (data.type === 'finished') {
      let found;
      try {
        found = await open(layer, data.x);
      } catch {
        stopWorker();
        await store.remove(PROGRESS);
        await render();
        say('The puzzle’s answer didn’t open the box, so the saved progress was wrong. Start unlocking again.');
        return;
      }
      if (typeof found === 'string') {
        stopWorker();
        await reveal(box, found);
        return;
      }
      // A box inside: its puzzle comes next. Saved at once, so that closing the page now keeps the layer just done.
      // The box inside held this password too (a backup file of it may be about), which the stored box couldn't say.
      const opened = before + layer.steps;
      latestDone = opened;
      lastSaved = Date.now();
      await store.set({ [PROGRESS]: { n: box.n, inner: found, x: START.toString(16), done: 0, before: opened, startedAt, ...(why !== null && { why }), workedAt: new Date().toISOString() } });
      await note(found, { previous: box });
      work(box, opened, found, START, 0);
    }
  };
  worker.onerror = async (event) => {
    stopWorker();
    await render();
    say(`Unlocking stopped: ${event.message || 'the worker failed'}. Progress so far is kept.`);
  };
  worker.postMessage({ type: 'run', n: modulusOf(layer), x, done, steps: layer.steps });
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

// Shows the password, and locks it away again straight away with the same wait, timed afresh.
async function reveal(box, secret) {
  $('lockbox-revealed').value = secret;
  $('lockbox-copied').hidden = true;
  $('lockbox-again').textContent = `Locking it away again with the same wait (${duration(box.delay)})…`;
  showOnly('lockbox-open');
  choose($('lockbox-new-wait'), box.delay);
  await record('shown', { startedAt, ...(why !== null && { why }) });
  say('Locking it away again…');
  try {
    await lockAway(secret, box.delay, { previous: box });
    await record('sealed', { delay: box.delay });
    $('lockbox-again').textContent = `It’s already locked away again with the same wait (${duration(box.delay)}). ${STAYS}`;
    say('');
  } catch (error) {
    // The old box is still stored, so the password stays locked away, but unlocking it starts from the beginning.
    $('lockbox-again').textContent = `The old puzzle is kept, so it’s still locked away. ${STAYS}`;
    await store.remove(PROGRESS).catch(() => {});
    await record('seal-failed');
    say(`Couldn’t lock it away again with a fresh puzzle (${error.message}), so the old one is kept.`);
  }
  renderEvents(await load());
}

// Locks the password shown away again with the wait chosen on the open panel, in place of the box just made.
async function relock() {
  const secret = $('lockbox-revealed').value;
  if (!secret) return;
  const clearing = clearClipboard(); // now, while the click still lets the page write to the clipboard
  const delay = Number($('lockbox-new-wait').value);
  const { box } = await load();
  const longer = box !== null && delay > Math.round(waitOf(box));
  $('lockbox-relock').disabled = true;
  say('Timing this computer to set the wait…');
  try {
    await lockAway(secret, delay, { previous: box, delay });
    await record('sealed', { delay, previous: box?.delay });
    $('lockbox-again').textContent = `It’s locked away again with a wait of ${duration(delay)}. ${STAYS}`;
    say(`Locked away again with a wait of ${duration(delay)}.${await clearing}${longer ? ` ${OLD_BACKUPS}` : ''}`);
  } catch (error) {
    say(`Couldn’t lock it away again with that wait: ${error.message}.${await clearing}`);
  } finally {
    $('lockbox-relock').disabled = false;
  }
  renderEvents(await load());
}

async function stopUnlocking() {
  const { box, progress } = await load();
  const sofar = progress || worker ? ' The work done so far will be lost.' : '';
  if (!confirm(`Stop unlocking?${sofar}`)) return;
  stopWorker();
  await store.remove(PROGRESS);
  await record('stopped', { done: Math.max(progress ? progress.before + progress.done : 0, latestDone), steps: box ? stepsOf(box) : 0 });
  await render();
  say('Unlocking stopped. The password is still locked away.');
}

async function remove() {
  if (!confirm('Delete the locked-away password? It can’t be got back afterwards, except from a backup file.')) return;
  await store.remove([BOX, PROGRESS]);
  await record('deleted');
  await render();
  say('Deleted.');
}

async function backup() {
  const { box } = await load();
  if (!box) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(box, null, 2)], { type: 'application/json' }));
  link.download = 'locked-away-password.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  say('Backup file saved to your downloads. It stays locked with the same wait.');
}

async function restore(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  let box;
  try {
    box = JSON.parse(await file.text());
  } catch {
    box = null;
  }
  if (!isBox(box)) {
    say('That file isn’t a backup of a locked-away password.');
    return;
  }
  // A box stored here before, whose password has had its wait lengthened since (or been locked away again
  // with a longer one): the file can't know, so the box goes inside a longer puzzle, as Lengthen the wait
  // does, before it is stored. The file itself is as it was, and opens after its own wait anywhere else.
  const longer = await longerWaitFor(store, box);
  let stored = box;
  if (longer) {
    say('Timing this computer to set the wait…');
    try {
      const rate = await measureRate();
      stored = await lengthen(box, { steps: Math.max(1, Math.round((longer.delay - longer.from) * rate)), delay: longer.delay, rate });
    } catch (error) {
      say(`Couldn’t restore it: the wait set here for this password is ${duration(longer.delay)}, and lengthening the file’s ${duration(longer.from)} to it failed (${error.message}). Try again.`);
      return;
    }
  }
  await store.set({ [BOX]: stored });
  await store.remove(PROGRESS);
  await note(stored, longer ? { previous: box } : {});
  await record('restored', { lockedAt: box.lockedAt, ...(longer && { from: longer.from, to: longer.delay }) });
  await render();
  say(
    longer
      ? `Restored from the backup file, and the wait lengthened from ${duration(longer.from)} to the ${duration(longer.delay)} set here since the file was saved. It is still locked away. The file itself still opens after ${duration(longer.from)} anywhere else: delete it (and empty the Trash) and save a new one.`
      : 'Restored from the backup file. It is still locked away.',
  );
}

// Letters and digits that can't be mistaken for each other (no 0/O, 1/l/I), in groups of four.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random password, such as k7Qm-x3Fa-PZ9e-wHt2-cR4n: about 115 bits, too long to guess or remember at a glance. */
function makePassword(groups = 5) {
  const chars = [];
  while (chars.length < groups * 4) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte < 256 - (256 % ALPHABET.length)) chars.push(ALPHABET[byte % ALPHABET.length]);
  }
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-');
}

function makeOne() {
  const field = $('lockbox-secret');
  if (field.value && !confirm('Replace the password in the box with a new one? If you have already made it the administrator password, click Cancel.')) return;
  field.value = makePassword();
  field.focus();
  field.select();
  say('Copy it (⌘C or Ctrl+C) and make it the administrator password first, then come back and lock it away.');
}

async function hide() {
  const clearing = clearClipboard(); // now, while the click still lets the page write to the clipboard
  $('lockbox-revealed').value = '';
  await render();
  const note = await clearing;
  if (note) say(`Hidden.${note}`);
}

// Says "Copied" beside the button, not on the status line at the foot of the panel, where it was easy to miss.
async function copy() {
  try {
    await navigator.clipboard.writeText($('lockbox-revealed').value);
    onClipboard = true;
    $('lockbox-copied').hidden = false;
  } catch (error) {
    say(`Couldn’t copy it: ${error.message}. Select the password and copy it (⌘C or Ctrl+C).`);
  }
}

$('lockbox-lock').addEventListener('click', lock);
$('lockbox-make').addEventListener('click', makeOne);
$('lockbox-lengthen').addEventListener('click', lengthenWait);
$('lockbox-start').addEventListener('click', startUnlocking);
$('lockbox-stop').addEventListener('click', stopUnlocking);
$('lockbox-delete').addEventListener('click', remove);
$('lockbox-backup').addEventListener('click', backup);
$('lockbox-restore').addEventListener('change', restore);
$('lockbox-hide').addEventListener('click', hide);
$('lockbox-copy').addEventListener('click', copy);
$('lockbox-relock').addEventListener('click', relock);
// Copying out of either box by hand (⌘C or Ctrl+C, or the menu) puts the password on the clipboard as Copy does.
for (const id of ['lockbox-secret', 'lockbox-revealed']) {
  for (const type of ['copy', 'cut']) {
    $(id).addEventListener(type, ({ target }) => {
      if (target.selectionEnd > target.selectionStart) onClipboard = true;
    });
  }
}

showVersion(api);
render().catch((error) => say(`Couldn’t read the locked-away password: ${error.message}`));
