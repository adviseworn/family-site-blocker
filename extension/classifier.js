// The picture classifier, run by the background script: two of NSFWJS's models (models/, MIT) on
// TensorFlow.js (vendor/, Apache 2.0), all bundled, so no picture and no score leaves the computer. Each
// gives five scores for a picture: drawing, hentai, neutral, porn, sexy (lib/pictures.js turns them into a
// verdict). The first judge is the small MobileNetV2 model: quick (tens of milliseconds a picture), so
// every picture goes through it, but it hides one ordinary photo in twenty by mistake. From 1.20.0 a
// picture it would hide is judged again by the big InceptionV3 model, which is slower (half a second a
// picture) and 22 MB, and that second opinion decides (background.js judgePicture); on 300 ordinary
// photos the pair hid eight where the first judge alone hid eighteen, and one in 300 at thumbnail
// sizes where it hid thirteen, and the pair still hides what both find (see the README's Pictures
// section). Each model is loaded when first needed and kept, and run through WebAssembly (vendor/, the
// same licence), which is quick on any processor.
//
// The tests swap this file for a stand-in that judges by the picture's address, so the rest of the
// filter can be checked without explicit pictures; judgeBytes takes the address for that reason only.
import * as tf from './vendor/tf.fesm.min.js';
import './vendor/tf-global.js'; // the WebAssembly backend below finds TensorFlow.js through a global
import './vendor/tf-backend-wasm.min.js';
import { CLASSES } from './lib/pictures.js';

const api = globalThis.browser ?? globalThis.chrome;
/** The two judges: each model's files and the square its pictures are scaled to, as NSFWJS does. */
export const JUDGES = {
  first: { url: 'models/nsfw-mobilenet-v2/model.json', size: 224 },
  second: { url: 'models/nsfw-inception-v3/model.json', size: 299 },
};
export const SIZE = JUDGES.first.size;
// WebAssembly first: quick on any processor (tens of milliseconds a picture) and ready in a moment,
// where the graphics card (WebGL) is faster once warmed up but takes seconds to get there, isn't always
// there for a background page, and is slow software drawing on some machines. Plain JavaScript last:
// it works everywhere and takes about a second a picture.
const BACKENDS = ['wasm', 'webgl', 'cpu'];

let starting = null; // Promise: TensorFlow.js started on the first backend that works
let backend = null;
const loading = { first: null, second: null }; // Promise<model> for each judge, once asked for

function start() {
  starting ??= (async () => {
    globalThis.tf.wasm?.setWasmPaths(api.runtime.getURL('vendor/'));
    // One thread: the threaded build needs a worker, which a service worker can't make, and shared memory
    // the extension's pages don't have; the single-threaded SIMD build is what is bundled.
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
    for (const name of BACKENDS) {
      try {
        if (await tf.setBackend(name)) {
          await tf.ready();
          backend = tf.getBackend();
          break;
        }
      } catch {
        // Try the next one.
      }
    }
    if (!backend) throw new Error('No TensorFlow.js backend could be started');
  })();
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

/**
 * Loads a judge's model once, from the add-on's own files (the first in a few hundred milliseconds, the
 * second in a few seconds, as it is ten times the size), and warms it up.
 */
export function loadModel(judge = 'first') {
  loading[judge] ??= (async () => {
    await start();
    const { url, size } = JUDGES[judge];
    const model = await tf.loadLayersModel(api.runtime.getURL(url));
    tf.tidy(() => model.predict(tf.zeros([1, size, size, 3])));
    return model;
  })();
  loading[judge].catch(() => {
    loading[judge] = null;
  });
  return loading[judge];
}

/** Which backend is in use ('wasm', 'webgl' or 'cpu'), once a model has loaded; null before. */
export const backendInUse = () => backend;

/**
 * The scores a judge gives a picture's bytes (a Blob): { drawing, hentai, neutral, porn, sexy }, summing
 * to 1. The picture is decoded and scaled to the judge's square, squashing it as NSFWJS does, then
 * normalized to 0–1. Throws when the bytes aren't a picture the browser can decode (an SVG without a
 * size, say).
 */
export async function judgeBytes(blob, url, judge = 'first') {
  const [model, { size }] = [await loadModel(judge), JUDGES[judge]];
  const bitmap = await createImageBitmap(blob);
  let pixels;
  try {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, size, size);
    pixels = context.getImageData(0, 0, size, size);
  } finally {
    bitmap.close();
  }
  const output = tf.tidy(() => {
    const input = tf.browser.fromPixels(pixels).toFloat().div(255).expandDims(0);
    const result = model.predict(input);
    return Array.isArray(result) ? result[0] : result;
  });
  try {
    const data = await output.data();
    return Object.fromEntries(CLASSES.map((name, i) => [name, data[i]]));
  } finally {
    output.dispose();
  }
}
