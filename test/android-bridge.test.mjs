// The Android app's line from the add-on to the app (android/app/src/main/extension/android-bridge.js):
// what it sends, and that it keeps trying until the app has answered. The script is loaded here with a
// stand-in for the browser's API; in the app it runs as a second background script.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../android/app/src/main/extension/android-bridge.js', import.meta.url));

/** A stand-in for the parts of the browser's API the bridge uses. `answers` are the app's, in turn: a value, or an Error to throw. */
function fakeBrowser({ stored, answers = [] } = {}) {
  const listeners = { storage: [], alarms: [] };
  const sent = [];
  const state = { stored };
  const api = {
    storage: {
      local: { get: async (key) => (state.stored === undefined ? {} : { [key]: state.stored }) },
      onChanged: { addListener: (listener) => listeners.storage.push(listener) },
    },
    alarms: { onAlarm: { addListener: (listener) => listeners.alarms.push(listener) } },
    runtime: {
      sendNativeMessage: async (app, message) => {
        sent.push({ app, message });
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  return { api, sent, state, listeners };
}

let loads = 0;
/** Loads a fresh copy of the bridge against a stand-in browser, with timers that fire at once. */
async function load(fake) {
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
    // `waits` is every timer set; `tries` leaves out the time each telling gives the app to answer.
    return { bridge, started, waits, tries: waits.filter((ms) => ms !== bridge.ANSWER_MS) };
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
  fake.api.runtime.sendNativeMessage = async (app, message) => {
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
  fake.api.runtime.sendNativeMessage = (app, message) => {
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
