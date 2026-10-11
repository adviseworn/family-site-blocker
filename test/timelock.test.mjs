// Fast checks for the time-lock puzzle behind the settings page's locked-away password. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto; // Node 18 has Web Crypto, but not on globalThis

const { START, isBox, measureRate, modulusOf, open, seal, square } = await import('../extension/lib/timelock.js');

const STEPS = 5000;

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

test('the speed check reports a believable number of squarings per second', () => {
  const rate = measureRate(200);
  assert.ok(rate > 1000 && rate < 100_000_000, String(rate));
});
