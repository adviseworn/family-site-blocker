// Family Site Blocker for Android: the add-on's line to the app it is built into.
//
// Only the Android app carries this file: its build adds it to the add-on as a second background script,
// with the two permissions GeckoView wants for it (android/app/build.gradle, copyExtension). It tells the
// app two things, and it keeps the add-on's background page awake.
//
// What the bedtime is (the setting kept under `bedtime`, lib/bedtime.js), so that the app's lock can do
// the phone's part of it: turn the other apps away while it lasts, and hold the clock it goes by
// (lock/BedtimeWatch.kt). The app keeps what it is told and works out the hours for itself, so nothing here
// has to be awake when a bedtime begins.
//
// And whether the add-on's rules have started: the lists of sites, safe search and the rest (rulesStarted
// has what can go wrong). The app opens no web page before it has heard that they have, and starts the
// add-on again when it hears that they have not (AddOnRules.kt).
//
// The app is told when the add-on starts and whenever the bedtime changes, and it answers true once it has
// taken what it was told. It starts listening a moment after the add-on starts; GeckoView holds a message
// sent before that and hands it over then. A telling the app has not answered within ANSWER_MS is given up
// and tried again: a few times at the start, and then with every alarm (the heartbeat's, once a minute),
// so that one answer that never comes cannot keep later news from the app.
//
// Awake: Firefox puts an add-on's background page to sleep after half a minute with nothing to do, and
// starts it again for the next thing it listens for. A listed site does not wait for that, since a rule
// sends it to the block page. But a listed site opened by another road (a web proxy, a translation, an
// archive) is stopped by background.js, and while that was starting the proxy's page stood in the tab: for
// a tenth of a second on a computer, for half a minute on a slow emulated phone. Firefox leaves a background
// page alone while it holds a line open to its app (ext-backgroundPage.js, hasActiveNativeAppPorts), so the
// add-on holds one open for as long as the app runs (stayAwake). Nothing is sent over it. It costs the
// memory of a page that would otherwise be let go, the picture filter's code and models with it, which in
// turn judge the next picture sooner.

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

/**
 * The rule sets the add-on ships switched on (manifest.json, declarative_net_request). The add-on never
 * switches one off, so its rules are in force only with every one of them.
 */
export const RULE_SETS = (api.runtime.getManifest().declarative_net_request?.rule_resources ?? [])
  .filter((set) => set.enabled)
  .map((set) => set.id);

/**
 * Whether the add-on's rules are in force: whether Firefox's rule engine has started for the add-on, with every
 * rule set it ships. Firefox answers the question asked here only once it has read every list, with the names
 * of the ones its matcher holds, and with an error when the engine did not start for this copy of the add-on.
 * That happens when an update of the app brings a new version of the add-on: Firefox starts the version it had,
 * swaps in the new one while the old one is still reading its lists, and the new one then has no rules at all
 * until it is started once more (Firefox 159, ExtensionDNRStore.sys.mjs: "Unexpected queueTask call on closed
 * queue").
 */
export async function rulesStarted() {
  try {
    const inForce = await api.declarativeNetRequest.getEnabledRulesets();
    return RULE_SETS.length > 0 && RULE_SETS.every((id) => inForce.includes(id));
  } catch {
    return false;
  }
}

let rulesTold = null; // what the app last took about the rules
let rulesTurn = Promise.resolve(); // one telling at a time, apart from the bedtime's: Firefox may be long in answering

/** Tells the app whether the rules have started. Rules that have not are told every time: the app mends that. */
async function tellRulesNow() {
  try {
    const started = await rulesStarted();
    if (started && rulesTold === true) return true;
    if ((await send({ type: 'rules', started })) !== true) return false;
    rulesTold = started;
    return true;
  } catch {
    return false;
  }
}

/** Tells the app about the rules, after any such telling under way. */
export function tellRules() {
  rulesTurn = rulesTurn.then(tellRulesNow, tellRulesNow);
  return rulesTurn;
}

/** How long a line to the app must have held for it to be opened again at once when it goes. */
export const HELD_MS = 5000;

let line = null; // the line to the app that is open now

/**
 * Holds a line open to the app, which keeps Firefox from putting this background page to sleep. GeckoView
 * keeps a line asked for before the app listens and hands it over then, as it does a message. A line that
 * goes after it has held is opened again at once. One that goes sooner, or that cannot be opened at all, is
 * left to the next alarm, so that a line the app keeps refusing is not asked for over and over. Says whether
 * a line is open.
 */
export function stayAwake() {
  if (line) return true;
  let opened;
  try {
    opened = api.runtime.connectNative(APP);
  } catch {
    return false;
  }
  const since = Date.now();
  line = opened;
  opened.onDisconnect.addListener(() => {
    if (line !== opened) return;
    line = null;
    if (Date.now() - since >= HELD_MS) stayAwake();
  });
  return true;
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BEDTIME]) tell();
});
api.alarms.onAlarm.addListener(() => {
  stayAwake();
  tell();
  tellRules();
});

/** A first telling, tried again while the app is still starting. */
async function first(telling) {
  if (await telling()) return true;
  for (const wait of TRIES_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (await telling()) return true;
  }
  return false;
}

stayAwake();
/** The first telling of the bedtime. */
export const started = first(tell);
/** The first telling of the rules. */
export const startedRules = first(tellRules);
