// Family Site Blocker for Android: the add-on's line to the app it is built into.
//
// Only the Android app carries this file: its build adds it to the add-on as a second background script,
// with the two permissions GeckoView wants for it (android/app/build.gradle, copyExtension). It tells the
// app what the bedtime is (the setting kept under `bedtime`, lib/bedtime.js), so that the app's lock can do
// the phone's part of it: turn the other apps away while it lasts, and hold the clock it goes by
// (lock/BedtimeWatch.kt). The app keeps what it is told and works out the hours for itself, so nothing here
// has to be awake when a bedtime begins.
//
// The app is told when the add-on starts and whenever the setting changes, and it answers true once it has
// taken what it was told. It starts listening a moment after the add-on starts; GeckoView holds a message
// sent before that and hands it over then. A telling the app has not answered within ANSWER_MS is given up
// and tried again: a few times at the start, and then with every alarm (the heartbeat's, once a minute),
// so that one answer that never comes cannot keep later news from the app.

const api = globalThis.browser ?? globalThis.chrome;
/** The name the app listens under (AddOnBridge.kt). */
export const APP = 'familySiteBlocker';
const BEDTIME = 'bedtime';
/** How long after the add-on starts the telling is tried again, while the app has not answered. */
export const TRIES_MS = [500, 1500, 4000, 10000];
/** How long the app has to answer one telling. */
export const ANSWER_MS = 8000;

/**
 * The part of the stored setting the app has a use for, as JSON text: the bedtime, and a change that waits
 * with the moment it takes effect. The app reads it as the add-on does and leaves out what isn't well-formed.
 */
export function wordsFor(stored) {
  if (stored == null || typeof stored !== 'object') return 'null';
  const { on, from, to, next } = stored;
  const change = next != null && typeof next === 'object' ? { on: next.on, from: next.from, to: next.to, at: next.at } : undefined;
  return JSON.stringify({ on, from, to, next: change });
}

let told = null; // the bedtime the app last took, as text
let turn = Promise.resolve(); // one telling at a time

/** Sends the app a message and gives its answer, or undefined when none comes within ANSWER_MS or the sending fails. */
function send(message) {
  return new Promise((resolve) => {
    const giveUp = setTimeout(resolve, ANSWER_MS);
    const done = (answer) => {
      clearTimeout(giveUp);
      resolve(answer);
    };
    api.runtime.sendNativeMessage(APP, message).then(done, () => done(undefined));
  });
}

/** Tells the app the bedtime as it is stored now, unless that is what it took last. Says whether the app has it. */
async function tellNow() {
  try {
    const bedtime = wordsFor((await api.storage.local.get(BEDTIME))[BEDTIME]);
    if (bedtime === told) return true;
    if ((await send({ type: 'bedtime', bedtime })) !== true) return false;
    told = bedtime;
    return true;
  } catch {
    return false;
  }
}

/** Tells the app, after any telling under way. */
export function tell() {
  turn = turn.then(tellNow, tellNow);
  return turn;
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BEDTIME]) tell();
});
api.alarms.onAlarm.addListener(() => {
  tell();
});

/** The first telling, tried again while the app is still starting. */
export const started = (async () => {
  if (await tell()) return true;
  for (const wait of TRIES_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (await tell()) return true;
  }
  return false;
})();
