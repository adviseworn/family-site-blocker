// The locked-away password, on a page of its own (lockbox.html; the settings page shows one line on where
// it stands and links here). The password is kept only inside a time-lock puzzle (lib/timelock.js);
// getting it back means letting lockbox-worker.js work through the puzzle with this page open. Progress
// is saved as it goes, so closing the page pauses the work rather than losing it.
import { BOX, PROGRESS, duration, loadBox } from './lib/lockbox.js';
import { showVersion } from './lib/page.js';
import { START, isBox, modulusOf, open, seal } from './lib/timelock.js';

const api = globalThis.browser ?? globalThis.chrome;
const store = api.storage.local;
const $ = (id) => document.getElementById(id);

const SAVE_EVERY_MS = 5000;

let worker = null;
let lastSaved = 0;

function say(text) {
  $('lockbox-status').textContent = text;
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

function showProgress(box, done, rate) {
  $('lockbox-progress-area').hidden = false;
  $('lockbox-progress').value = done / box.steps;
  const percent = Math.floor((done / box.steps) * 100);
  $('lockbox-progress-text').textContent = `${percent}% done, about ${duration((box.steps - done) / rate)} to go.`;
}

async function render() {
  const { box, progress } = await load();
  if (!box) {
    showOnly('lockbox-empty');
    return;
  }
  showOnly('lockbox-locked');
  const locked = new Date(box.lockedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  $('lockbox-summary').textContent =
    `A password is locked away (since ${locked}). Getting it back takes about ${duration(box.steps / box.rate)} ` +
    'of computing with this page open and the computer awake. If the page is closed or the computer sleeps, ' +
    'the work pauses and carries on where it left off.';

  const running = worker !== null;
  $('lockbox-start').hidden = running;
  $('lockbox-start').textContent = progress ? 'Carry on unlocking' : 'Start unlocking';
  $('lockbox-stop').hidden = !running && !progress;
  $('lockbox-delete').hidden = running;
  if (progress) showProgress(box, progress.done, box.rate);
  else $('lockbox-progress-area').hidden = true;
}

async function lock() {
  const secret = $('lockbox-secret').value;
  if (!secret) {
    say('Type the password to lock away first.');
    return;
  }
  const delay = Number($('lockbox-delay').value);
  $('lockbox-lock').disabled = true;
  say('Timing this computer to set the wait…');
  try {
    const rate = await measureRate();
    const box = await seal(secret, { steps: Math.max(1, Math.round(delay * rate)), delay, rate });
    await store.set({ [BOX]: box });
    await store.remove(PROGRESS);
    $('lockbox-secret').value = '';
    await render();
    say(`Locked away. Save a backup file so it isn’t lost if the extension is removed.`);
  } catch (error) {
    say(`Couldn’t lock it away: ${error.message}`);
  } finally {
    $('lockbox-lock').disabled = false;
  }
}

async function startUnlocking() {
  const { box, progress } = await load();
  if (!box || worker) return;
  const n = modulusOf(box);
  worker = startWorker();
  say('');
  await render();
  showProgress(box, progress?.done ?? 0, box.rate);

  worker.onmessage = async ({ data }) => {
    if (data.type === 'progress') {
      showProgress(box, data.done, data.rate || box.rate);
      if (Date.now() - lastSaved >= SAVE_EVERY_MS) {
        lastSaved = Date.now();
        await store.set({ [PROGRESS]: { n: box.n, x: data.x.toString(16), done: data.done } });
      }
    } else if (data.type === 'finished') {
      stopWorker();
      await reveal(box, data.x);
    }
  };
  worker.onerror = async (event) => {
    stopWorker();
    await render();
    say(`Unlocking stopped: ${event.message || 'the worker failed'}. Progress so far is kept.`);
  };
  worker.postMessage({
    type: 'run',
    n,
    x: progress ? BigInt(`0x${progress.x}`) : START,
    done: progress?.done ?? 0,
    steps: box.steps,
  });
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

// Shows the password, and locks it away again straight away with the same wait, timed afresh.
async function reveal(box, answer) {
  let secret;
  try {
    secret = await open(box, answer);
  } catch {
    await store.remove(PROGRESS);
    await render();
    say('The puzzle’s answer didn’t open the password, so the saved progress was wrong. Start unlocking again.');
    return;
  }
  $('lockbox-revealed').value = secret;
  showOnly('lockbox-open');
  say('Locking it away again…');
  try {
    const rate = await measureRate();
    const again = await seal(secret, { steps: Math.max(1, Math.round(box.delay * rate)), delay: box.delay, rate });
    await store.set({ [BOX]: again });
    await store.remove(PROGRESS);
    say('');
  } catch (error) {
    // The old box is still stored, so the password stays locked away, but unlocking it starts from the beginning.
    await store.remove(PROGRESS).catch(() => {});
    say(`Couldn’t lock it away again with a fresh puzzle (${error.message}), so the old one is kept.`);
  }
}

async function stopUnlocking() {
  const { progress } = await load();
  const sofar = progress || worker ? ' The work done so far will be lost.' : '';
  if (!confirm(`Stop unlocking?${sofar}`)) return;
  stopWorker();
  await store.remove(PROGRESS);
  await render();
  say('Unlocking stopped. The password is still locked away.');
}

async function remove() {
  if (!confirm('Delete the locked-away password? It can’t be got back afterwards, except from a backup file.')) return;
  await store.remove([BOX, PROGRESS]);
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
  await store.set({ [BOX]: box });
  await store.remove(PROGRESS);
  await render();
  say('Restored from the backup file. It is still locked away.');
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

function hide() {
  $('lockbox-revealed').value = '';
  render();
}

async function copy() {
  await navigator.clipboard.writeText($('lockbox-revealed').value);
  say('Copied.');
}

$('lockbox-lock').addEventListener('click', lock);
$('lockbox-make').addEventListener('click', makeOne);
$('lockbox-start').addEventListener('click', startUnlocking);
$('lockbox-stop').addEventListener('click', stopUnlocking);
$('lockbox-delete').addEventListener('click', remove);
$('lockbox-backup').addEventListener('click', backup);
$('lockbox-restore').addEventListener('change', restore);
$('lockbox-hide').addEventListener('click', hide);
$('lockbox-copy').addEventListener('click', copy);

showVersion(api);
render().catch((error) => say(`Couldn’t read the locked-away password: ${error.message}`));
