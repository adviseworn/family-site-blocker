// The Android app's line from the add-on to the app (android/app/src/main/extension/android-bridge.js):
// what it sends about the bedtime and about the rules, and that it keeps trying until the app has answered.
// The script is loaded here with a stand-in for the browser's API; in the app it runs as a second background
// script.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../android/app/src/main/extension/android-bridge.js', import.meta.url));
/** The add-on's own manifest: the bridge reads from it which rule sets have to be in force. */
const MANIFEST = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

/**
 * A stand-in for the parts of the browser's API the bridge uses. `answers` are the app's to what it is told of
 * the bedtime, in turn: a value, or an Error to throw. `rules` is what the browser says when asked for the rule
 * sets in force: their names, an Error, or nothing for a browser that is still reading them and does not answer;
 * `rulesAnswers` are the app's to what it is told of the rules. What is sent about the rules is kept apart
 * (`sentOfRules`), so that `sent` holds the bedtime's messages alone.
 */
function fakeBrowser({ stored, answers = [], rules, rulesAnswers = [true] } = {}) {
  const listeners = { storage: [], alarms: [] };
  const sent = [];
  const sentOfRules = [];
  const state = { stored, rules };
  const next = (list) => {
    const answer = list.length > 1 ? list.shift() : list[0];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const sendNativeMessage = async (app, message) => {
    sent.push({ app, message });
    return next(answers);
  };
  const api = {
    storage: {
      local: { get: async (key) => (state.stored === undefined ? {} : { [key]: state.stored }) },
      onChanged: { addListener: (listener) => listeners.storage.push(listener) },
    },
    alarms: { onAlarm: { addListener: (listener) => listeners.alarms.push(listener) } },
    declarativeNetRequest: {
      getEnabledRulesets: () => {
        if (state.rules === undefined) return new Promise(() => {});
        return state.rules instanceof Error ? Promise.reject(state.rules) : Promise.resolve(state.rules);
      },
    },
    runtime: {
      getManifest: () => MANIFEST,
      // A test may put its own answers to the bedtime in place of `bedtime`; the rules go their own way.
      bedtime: sendNativeMessage,
      sendNativeMessage: async (app, message) => {
        if (message.type !== 'rules') return api.runtime.bedtime(app, message);
        sentOfRules.push({ app, message });
        return next(rulesAnswers);
      },
    },
  };
  return { api, sent, sentOfRules, state, listeners };
}

let loads = 0;
/**
 * Loads a fresh copy of the bridge against a stand-in browser, with timers that fire at once, and waits for the
 * first telling of the bedtime, and with `rules` for the first telling of the rules as well.
 */
async function load(fake, { rules = false } = {}) {
  globalThis.browser = fake.api;
  const realTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (run, ms) => {
    waits.push(ms);
    return realTimeout(run, 0);
  };
  try {
    const bridge = await import(`${pathToFileURL(BRIDGE).href}?load=${(loads += 1)}`);
    const started = await bridge.started;
    const startedRules = rules ? await bridge.startedRules : undefined;
    // `waits` is every timer set; `tries` leaves out the time each telling gives the app to answer.
    return { bridge, started, startedRules, waits, tries: waits.filter((ms) => ms !== bridge.ANSWER_MS) };
  } finally {
    globalThis.setTimeout = realTimeout;
    delete globalThis.browser;
  }
}

const NINE_TO_FIVE = { on: true, from: 1260, to: 300 };

test('the app is told the bedtime when the add-on starts, under the name it listens to', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [true] });
  const { bridge, started, tries } = await load(fake);
  assert.equal(started, true);
  assert.deepEqual(tries, [], 'answered at once: no second try');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].app, 'familySiteBlocker');
  assert.equal(bridge.APP, 'familySiteBlocker');
  assert.equal(fake.sent[0].message.type, 'bedtime');
  assert.deepEqual(JSON.parse(fake.sent[0].message.bedtime), NINE_TO_FIVE);
});

test('only the bedtime and a change that waits are sent, not the reason or what can be undone', async () => {
  const stored = { ...NINE_TO_FIVE, next: { on: false, from: 1260, to: 300, asked: 1, at: 86_400_001, why: 'Travelling' }, undo: { before: { on: false, from: 1260, to: 300 }, until: 5 } };
  const fake = fakeBrowser({ stored, answers: [true] });
  const { bridge } = await load(fake);
  assert.deepEqual(JSON.parse(fake.sent[0].message.bedtime), { ...NINE_TO_FIVE, next: { on: false, from: 1260, to: 300, at: 86_400_001 } });
  assert.equal(bridge.wordsFor(stored), fake.sent[0].message.bedtime);
  assert.equal(bridge.wordsFor(undefined), 'null', 'no bedtime stored yet');
  assert.equal(bridge.wordsFor('nonsense'), 'null');
});

test('with no bedtime stored the app is told so', async () => {
  const fake = fakeBrowser({ answers: [true] });
  await load(fake);
  assert.equal(fake.sent[0].message.bedtime, 'null');
});

test('while the app is not listening yet, the telling is tried again until it answers', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [new Error('Native app not found'), new Error('Native app not found'), true] });
  const { bridge, started, tries } = await load(fake);
  assert.equal(started, true);
  assert.equal(fake.sent.length, 3);
  assert.deepEqual(tries, bridge.TRIES_MS.slice(0, 2));
});

test('an app that never answers is tried a few times at the start, then with every alarm', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [new Error('Native app not found')] });
  const { bridge, started, tries } = await load(fake);
  assert.equal(started, false);
  assert.deepEqual(tries, bridge.TRIES_MS);
  assert.equal(fake.sent.length, bridge.TRIES_MS.length + 1);
  // The heartbeat's alarm: one more try, and this time the app answers.
  fake.api.runtime.bedtime = async (app, message) => {
    fake.sent.push({ app, message });
    return true;
  };
  fake.listeners.alarms[0]({ name: 'heartbeat' });
  assert.equal(await bridge.tell(), true);
  assert.equal(fake.sent.length, bridge.TRIES_MS.length + 2);
});

test('only a plain true from the app counts as an answer', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [false, undefined, { ok: true }, 'true', true] });
  const { started } = await load(fake);
  assert.equal(started, true);
  assert.equal(fake.sent.length, 5);
});

test('an answer that never comes is given up, and later news still reaches the app', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE });
  let asked = 0;
  // The first telling is never answered; the ones after it are.
  fake.api.runtime.bedtime = (app, message) => {
    fake.sent.push({ app, message });
    asked += 1;
    return asked === 1 ? new Promise(() => {}) : Promise.resolve(true);
  };
  const { bridge, started, waits } = await load(fake);
  assert.equal(started, true);
  assert.deepEqual(waits, [bridge.ANSWER_MS, bridge.TRIES_MS[0], bridge.ANSWER_MS], 'the wait for the answer, the wait before the next try, and that try\'s own');
  assert.equal(fake.sent.length, 2);

  fake.state.stored = { on: true, from: 1320, to: 300 };
  fake.listeners.storage[0]({ bedtime: { newValue: fake.state.stored } }, 'local');
  assert.equal(await bridge.tell(), true);
  assert.deepEqual(JSON.parse(fake.sent[2].message.bedtime), { on: true, from: 1320, to: 300 });
});

test('the app is told again when the bedtime changes, and not when it is the same', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [true] });
  const { bridge } = await load(fake);
  assert.equal(fake.sent.length, 1);

  // An alarm with nothing new: nothing is sent.
  fake.listeners.alarms[0]({ name: 'heartbeat' });
  await bridge.tell();
  assert.equal(fake.sent.length, 1);

  // Something else in storage changes: nothing is sent.
  fake.listeners.storage[0]({ attempts: { newValue: [] } }, 'local');
  await bridge.tell();
  assert.equal(fake.sent.length, 1);

  // The bedtime changes: the app hears the new one.
  fake.state.stored = { on: true, from: 1320, to: 300 };
  fake.listeners.storage[0]({ bedtime: { newValue: fake.state.stored } }, 'local');
  await bridge.tell();
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(JSON.parse(fake.sent[1].message.bedtime), { on: true, from: 1320, to: 300 });

  // The same key in another storage area is not the setting.
  fake.state.stored = { on: false, from: 1320, to: 300 };
  fake.listeners.storage[0]({ bedtime: { newValue: fake.state.stored } }, 'session');
  assert.equal(fake.sent.length, 2);
});

/** The rule sets the add-on ships switched on. */
const LISTS = MANIFEST.declarative_net_request.rule_resources.filter((set) => set.enabled).map((set) => set.id);

test('the bridge knows from the manifest which rule sets have to be in force', async () => {
  const { bridge } = await load(fakeBrowser({ answers: [true] }));
  assert.deepEqual(bridge.RULE_SETS, LISTS);
  for (const needed of ['adult-1', 'adult-2', 'safe-search', 'proxies']) assert.ok(LISTS.includes(needed), needed);
});

test('the app is told that the rules have started once the browser has read them, and not again', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [true], rules: LISTS });
  const { bridge, startedRules, tries } = await load(fake, { rules: true });
  assert.equal(startedRules, true);
  assert.deepEqual(tries, []);
  assert.deepEqual(fake.sentOfRules, [{ app: 'familySiteBlocker', message: { type: 'rules', started: true } }]);
  assert.equal(await bridge.rulesStarted(), true);

  fake.listeners.alarms[0]({ name: 'heartbeat' });
  assert.equal(await bridge.tellRules(), true);
  assert.equal(fake.sentOfRules.length, 1, 'the app knows: an alarm sends nothing new');
  assert.equal(fake.sent.length, 1, 'and the bedtime went out once, by itself');
});

test('the rules have started only when every rule set the add-on ships is in force', async () => {
  for (const [inForce, started] of [
    [[], false],
    [LISTS.slice(1), false],
    [LISTS.slice(0, -1), false],
    [undefined, false],
    [[...LISTS].reverse(), true],
    [[...LISTS, 'another'], true],
  ]) {
    const fake = fakeBrowser({ answers: [true], rules: LISTS });
    const { bridge } = await load(fake, { rules: true });
    fake.api.declarativeNetRequest.getEnabledRulesets = async () => inForce;
    assert.equal(await bridge.rulesStarted(), started, JSON.stringify(inForce));
  }
  // A browser that answers with nothing in force is told to the app as one whose rules have not started.
  const fake = fakeBrowser({ answers: [true], rules: [] });
  const { startedRules } = await load(fake, { rules: true });
  assert.equal(startedRules, true, 'the app took the telling');
  assert.deepEqual(fake.sentOfRules[0].message, { type: 'rules', started: false });
});

test('rules the browser did not start are told so, and told again with every alarm until they have', async () => {
  const fake = fakeBrowser({ answers: [true], rules: new Error('An unexpected error occurred') });
  const { bridge, startedRules } = await load(fake, { rules: true });
  assert.equal(startedRules, true, 'the app took the telling');
  assert.equal(await bridge.rulesStarted(), false);
  assert.deepEqual(fake.sentOfRules, [{ app: 'familySiteBlocker', message: { type: 'rules', started: false } }]);

  // The heartbeat's alarm says it again, and so does every telling after it.
  fake.listeners.alarms[0]({ name: 'heartbeat' });
  await bridge.tellRules();
  assert.deepEqual(fake.sentOfRules.map((one) => one.message.started), [false, false, false]);

  // Started after all: told once more, then no more.
  fake.state.rules = LISTS;
  await bridge.tellRules();
  await bridge.tellRules();
  assert.deepEqual(fake.sentOfRules.map((one) => one.message.started), [false, false, false, true]);
});

test('a telling of the rules the app does not take is tried again until it does', async () => {
  const fake = fakeBrowser({ answers: [true], rules: LISTS, rulesAnswers: [false, new Error('Native app not found'), true] });
  const { bridge, startedRules, tries } = await load(fake, { rules: true });
  assert.equal(startedRules, true);
  assert.equal(fake.sentOfRules.length, 3);
  assert.deepEqual(tries, bridge.TRIES_MS.slice(0, 2));
});

test('a browser that is still reading the rules holds nothing else up: the bedtime is told meanwhile', async () => {
  const fake = fakeBrowser({ stored: NINE_TO_FIVE, answers: [true] });
  const { started } = await load(fake);
  assert.equal(started, true);
  assert.equal(fake.sent.length, 1);
  assert.deepEqual(fake.sentOfRules, [], 'nothing is said of the rules before the browser has answered');
});
