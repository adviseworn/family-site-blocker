// Fast checks for the time-lock puzzle behind the settings page's locked-away password. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto; // Node 18 has Web Crypto, but not on globalThis

const { START, holdsBox, isBox, layersOf, lengthen, measureRate, modulusOf, open, seal, secondsOf, square, stepsOf, waitOf } = await import('../extension/lib/timelock.js');

const STEPS = 5000;

/** Solves a box's own puzzle: the answer that opens it. */
const solve = (box) => square(START, modulusOf(box), box.steps);

test('the squarings open the box, and give back exactly the password that was locked away', async () => {
  const secret = 'correct horse battery staple ✓';
  const box = await seal(secret, { steps: STEPS, delay: 60, rate: 100 });
  assert.equal(await open(box, square(START, modulusOf(box), STEPS)), secret);
});

test('doing one squaring too few, or too many, does not open it', async () => {
  const box = await seal('secret', { steps: STEPS, delay: 60, rate: 100 });
  const n = modulusOf(box);
  await assert.rejects(open(box, square(START, n, STEPS - 1)));
  await assert.rejects(open(box, square(START, n, STEPS + 1)));
});

test('the work can stop and carry on from the number reached, as the settings page does', async () => {
  const box = await seal('resumed', { steps: STEPS, delay: 60, rate: 100 });
  const n = modulusOf(box);
  const halfway = square(START, n, 1234);
  assert.equal(await open(box, square(halfway, n, STEPS - 1234)), 'resumed');
});

test('the stored box holds neither the password nor anything that shortens the work', async () => {
  const secret = 'hunter2-hunter2-hunter2';
  const box = await seal(secret, { steps: STEPS, delay: 60, rate: 100 });
  const text = JSON.stringify(box);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(Buffer.from(secret).toString('base64')));
  assert.deepEqual(Object.keys(box).sort(), ['data', 'delay', 'format', 'iv', 'lockedAt', 'n', 'rate', 'steps', 'version']);
  assert.equal(BigInt(`0x${box.n}`).toString(2).length, 2048, 'a 2048-bit modulus, too big to factor');
  assert.ok(isBox(box));
  assert.ok(isBox(JSON.parse(text)), 'a backup file reads back as a box');
});

test('each box gets its own modulus, so work done on one box is no help with another', async () => {
  const a = await seal('same', { steps: 10, delay: 60, rate: 1 });
  const b = await seal('same', { steps: 10, delay: 60, rate: 1 });
  assert.notEqual(a.n, b.n);
});

test('anything else read from storage or a backup file is turned away', () => {
  for (const value of [null, undefined, {}, 'text', { format: 'family-site-blocker-lockbox', version: 2 }]) {
    assert.equal(isBox(value), false, JSON.stringify(value));
  }
});

test('lengthening locks the box inside a longer puzzle: the outer one gives the box back, and then that one the password', async () => {
  const secret = 'the administrator password';
  const inner = await seal(secret, { steps: STEPS, delay: 60, rate: 100 });
  const outer = await lengthen(inner, { steps: 2 * STEPS, delay: 180, rate: 100 });

  assert.ok(isBox(outer));
  assert.ok(holdsBox(outer));
  assert.equal(holdsBox(inner), false);
  assert.equal(outer.version, 2);
  assert.notEqual(outer.n, inner.n, 'a puzzle of its own');
  assert.deepEqual(Object.keys(outer).sort(), ['data', 'delay', 'format', 'holds', 'inside', 'iv', 'lengthenedAt', 'lockedAt', 'n', 'rate', 'steps', 'version']);
  assert.equal(outer.lockedAt, inner.lockedAt, 'still says when the password was locked away');
  assert.ok(Date.now() - Date.parse(outer.lengthenedAt) < 60_000, 'and when the wait was lengthened');
  assert.deepEqual(outer.inside, [{ steps: STEPS, rate: 100 }], 'what the layer inside takes');

  // Without the outer puzzle's answer, nothing of the inner box can be read.
  const text = JSON.stringify(outer);
  assert.ok(!text.includes(inner.n) && !text.includes(inner.data) && !text.includes(inner.iv));
  assert.ok(!text.includes(secret));

  const found = await open(outer, solve(outer));
  assert.deepEqual(found, inner, 'the outer puzzle gives the inner box back, as it was');
  assert.equal(await open(found, solve(found)), secret);
  await assert.rejects(open(outer, square(START, modulusOf(outer), 2 * STEPS - 1)), 'one squaring too few opens nothing');
});

test('the layers of a box add up, however many times the wait was lengthened', async () => {
  const one = await seal('x', { steps: 1000, delay: 10, rate: 100 });
  const two = await lengthen(one, { steps: 4000, delay: 30, rate: 200 });
  const three = await lengthen(two, { steps: 9000, delay: 90, rate: 150 });
  assert.deepEqual(layersOf(one), [{ steps: 1000, rate: 100 }]);
  assert.deepEqual(layersOf(three), [{ steps: 9000, rate: 150 }, { steps: 4000, rate: 200 }, { steps: 1000, rate: 100 }], 'outermost first');
  assert.equal(stepsOf(one), 1000);
  assert.equal(stepsOf(three), 14000);
  assert.equal(waitOf(one), 10);
  assert.equal(waitOf(two), 30);
  assert.equal(waitOf(three), 90);
  assert.equal(secondsOf(three.inside), 30, 'what is left once the outer layer is solved');
  assert.equal(three.lockedAt, one.lockedAt);
  assert.deepEqual(await open(three, solve(three)), two);
  assert.ok(isBox(JSON.parse(JSON.stringify(three))), 'a backup file of it reads back as a box');
});

test('a lengthened box that is not what it says is turned away', async () => {
  const box = await seal('secret', { steps: 100, delay: 1, rate: 100 });
  const outer = await lengthen(box, { steps: 100, delay: 2, rate: 100 });
  assert.equal(isBox({ ...outer, inside: [] }), false, 'a box that holds a box says what is inside');
  assert.equal(isBox({ ...outer, inside: [{ steps: 0, rate: 100 }] }), false);
  assert.equal(isBox({ ...outer, inside: [{ steps: 100 }] }), false);
  assert.equal(isBox({ ...outer, holds: 'password' }), false);
  assert.equal(isBox({ ...outer, version: 1 }), false, 'version 1 holds the password, not a box');
  assert.equal(isBox({ ...box, holds: 'box' }), false);
  await assert.rejects(lengthen({ ...box, n: 'abc' }, { steps: 100, delay: 2, rate: 100 }), TypeError);
  // A box marked as holding a box, around a password: the puzzle's answer opens it to no box.
  const pretend = { ...(await seal('not a box', { steps: 100, delay: 1, rate: 100 })), version: 2, holds: 'box', inside: [{ steps: 100, rate: 100 }] };
  assert.ok(isBox(pretend));
  await assert.rejects(open(pretend, solve(pretend)), /not a box/);
});

test('the speed check reports a believable number of squarings per second', () => {
  const rate = measureRate(200);
  assert.ok(rate > 1000 && rate < 100_000_000, String(rate));
});
