// A time-lock puzzle (Rivest, Shamir and Wagner, 1996) for the locked-away password on the settings page.
//
// The password is encrypted with a key that can only be worked out by squaring a number `steps` times in a
// row, modulo n. Each squaring needs the one before it, so the work can't be split across processors, and
// `steps` is chosen so that it takes the chosen delay on this computer. Whoever locks the password knows the
// two primes behind n, which turns the same work into a shortcut of a few milliseconds; they are thrown away
// as soon as the box is made. So the stored box, or a backup file of it, gives nothing away early: reading
// the extension's storage or changing the computer's clock doesn't skip the wait.
//
// The wait can be made longer without the password: the box itself, JSON and all, is locked inside a fresh
// puzzle of as many more squarings as the difference takes (lengthen), so getting the password back means
// solving the outer puzzle, which gives the inner box, and then that one. A box that holds a box is version
// 2, and says what the layers inside it take, so a page can describe the whole wait without opening any of
// it. Making the wait shorter needs the password, which only the whole wait gives.
//
// Shared by the locked-away password's page, its worker (lockbox-worker.js), the settings page and the tests.

const MODULUS_BITS = 2048;
const BASE = 2n;
const FORMAT = 'family-site-blocker-lockbox';

const subtle = () => globalThis.crypto.subtle;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bigFromHex = (text) => BigInt(`0x${text}`);
const bigFromBase64url = (text) => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return bigFromHex(hex(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
};
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** Squares x modulo n `count` times. This is the slow part, and the only way to it without the primes. */
export function square(x, n, count) {
  for (let i = 0; i < count; i += 1) x = (x * x) % n;
  return x;
}

/** The first number squared, before any work is done. */
export const START = BASE;

// The answer, written out at the modulus's full length, hashed into an AES key.
async function keyFrom(answer) {
  const digits = answer.toString(16).padStart(MODULUS_BITS / 4, '0');
  const bytes = Uint8Array.from(digits.match(/../g), (pair) => parseInt(pair, 16));
  const digest = await subtle().digest('SHA-256', bytes);
  return subtle().importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A fresh n = p × q, with p and q kept only long enough to take the shortcut. */
async function freshModulus() {
  const pair = await subtle().generateKey(
    { name: 'RSA-OAEP', modulusLength: MODULUS_BITS, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const { n, p, q } = await subtle().exportKey('jwk', pair.privateKey);
  return { n: bigFromBase64url(n), p: bigFromBase64url(p), q: bigFromBase64url(q) };
}

/** Encrypts `text` under the answer to a fresh puzzle of `steps` squarings: a box, as version 1 has them. */
async function puzzle(text, { steps, delay, rate }) {
  if (!Number.isSafeInteger(steps) || steps < 1) throw new RangeError('steps must be a positive whole number');
  const { n, p, q } = await freshModulus();
  // With the primes, 2^(2^steps) mod n is 2^(2^steps mod φ(n)) mod n: two quick exponentiations.
  const phi = (p - 1n) * (q - 1n);
  const answer = modPow(BASE, modPow(2n, BigInt(steps), phi), n);

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, await keyFrom(answer), new TextEncoder().encode(text));
  return {
    format: FORMAT,
    version: 1,
    n: n.toString(16),
    steps,
    delay,
    rate,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
    lockedAt: new Date().toISOString(),
  };
}

/**
 * Locks `secret` so that opening it takes `steps` squarings. `delay` (seconds) and `rate` (squarings per
 * second on this computer) are kept only to describe the box later.
 */
export const seal = (secret, options) => puzzle(secret, options);

/**
 * Locks `box` inside a fresh puzzle of `steps` more squarings, so that the whole wait becomes `delay`
 * seconds: opening the password then takes these squarings, which give `box` back, and then its own. Only
 * the box's JSON goes in, so the wait can be lengthened without the password. The result is a version-2
 * box: `holds` says it holds a box, `inside` what the layers within take, `lockedAt` stays the password's,
 * and `lengthenedAt` is now.
 */
export async function lengthen(box, { steps, delay, rate }) {
  if (!isBox(box)) throw new TypeError('only a box can be locked inside another');
  const outer = await puzzle(JSON.stringify(box), { steps, delay, rate });
  return { ...outer, version: 2, holds: 'box', inside: layersOf(box), lockedAt: box.lockedAt, lengthenedAt: outer.lockedAt };
}

/**
 * Opens a box with the result of all its squarings: the password, or, for a box that holds a box, the box
 * inside it. Throws if the answer is wrong, or what is inside isn't a box.
 */
export async function open(box, answer) {
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64(box.iv) },
    await keyFrom(answer),
    fromBase64(box.data),
  );
  const text = new TextDecoder().decode(plain);
  if (!holdsBox(box)) return text;
  let inner = null;
  try {
    inner = JSON.parse(text);
  } catch {
    inner = null;
  }
  if (!isBox(inner)) throw new TypeError('what the box holds is not a box');
  return inner;
}

export const modulusOf = (box) => bigFromHex(box.n);

/** Whether a box holds another box (version 2) rather than the password (version 1). */
export const holdsBox = (box) => box.holds === 'box';

/** The puzzles a box takes to open the password, outermost first, as { steps, rate }: its own, then those of the boxes inside it. */
export const layersOf = (box) => [{ steps: box.steps, rate: box.rate }, ...(box.inside ?? [])];

/** How long some layers take in all, in seconds, at the rates timed when each was made. */
export const secondsOf = (layers) => layers.reduce((sum, { steps, rate }) => sum + steps / rate, 0);

/** All the squarings a box takes to open the password. */
export const stepsOf = (box) => layersOf(box).reduce((sum, { steps }) => sum + steps, 0);

/** The whole wait of a box, in seconds. */
export const waitOf = (box) => secondsOf(layersOf(box));

const isLayer = (layer) => Number.isSafeInteger(layer?.steps) && layer.steps > 0 && typeof layer.rate === 'number' && layer.rate > 0;

/**
 * Checks that something read from storage or a backup file is a box this code can open: version 1, which
 * holds the password, or version 2, which holds a box and says what the layers inside it take.
 */
export function isBox(value) {
  if (
    value?.format !== FORMAT ||
    !/^[0-9a-f]{256,}$/.test(value.n) ||
    !Number.isSafeInteger(value.steps) ||
    value.steps < 1 ||
    typeof value.iv !== 'string' ||
    typeof value.data !== 'string'
  ) {
    return false;
  }
  if (value.version === 1) return value.holds === undefined;
  return value.version === 2 && value.holds === 'box' && Array.isArray(value.inside) && value.inside.length > 0 && value.inside.every(isLayer);
}

/** How many squarings this computer does per second, timed for about `ms` milliseconds. */
export function measureRate(ms = 1000) {
  // Any odd number of the right size squares at the same speed as a real modulus.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(MODULUS_BITS / 8));
  bytes[0] |= 0x80;
  bytes[bytes.length - 1] |= 1;
  const n = bigFromHex(hex(bytes));
  let x = BASE;
  let count = 0;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < ms) {
    x = square(x, n, 500);
    count += 500;
    elapsed = performance.now() - start;
  }
  return Math.round((count / elapsed) * 1000);
}
