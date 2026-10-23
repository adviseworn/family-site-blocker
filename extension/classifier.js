// The picture classifier, run by the background script: NSFWJS's MobileNetV2 model (models/, MIT) on
// TensorFlow.js (vendor/, Apache 2.0), both bundled, so no picture and no score leaves the computer. It
// gives five scores for a picture: drawing, hentai, neutral, porn, sexy (lib/pictures.js turns them into a
// verdict). The model is loaded on the first picture and kept, and run through WebAssembly (vendor/, the
// same licence), which is quick on any processor.
//
// The tests swap this file for a stand-in that judges by the picture's address, so the rest of the
// filter can be checked without explicit pictures; judgeBytes takes the address for that reason only.
import * as tf from './vendor/tf.fesm.min.js';
import './vendor/tf-global.js'; // the WebAssembly backend below finds TensorFlow.js through a global
import './vendor/tf-backend-wasm.min.js';
import { CLASSES } from './lib/pictures.js';

const api = globalThis.browser ?? globalThis.chrome;
const MODEL_URL = api.runtime.getURL('models/nsfw-mobilenet-v2/model.json');
export const SIZE = 224; // the model's input: pictures are scaled to this square, as NSFWJS does
// WebAssembly first: quick on any processor (tens of milliseconds a picture) and ready in a moment,
// where the graphics card (WebGL) is faster once warmed up but takes seconds to get there, isn't always
// there for a background page, and is slow software drawing on some machines. Plain JavaScript last:
// it works everywhere and takes about a second a picture.
const BACKENDS = ['wasm', 'webgl', 'cpu'];

let loading = null;
let backend = null;

/** Loads the model once (a few hundred milliseconds from the add-on's own files) and warms it up. */
export function loadModel() {
  loading ??= (async () => {
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
    const model = await tf.loadLayersModel(MODEL_URL);
    tf.tidy(() => model.predict(tf.zeros([1, SIZE, SIZE, 3])));
    return model;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Which backend is in use ('webgl' or 'cpu'), once the model has loaded; null before. */
export const backendInUse = () => backend;

/**
 * The scores for a picture's bytes (a Blob): { drawing, hentai, neutral, porn, sexy }, summing to 1. The
 * picture is decoded and scaled to SIZE×SIZE, squashing it as NSFWJS does, then normalized to 0–1.
 * Throws when the bytes aren't a picture the browser can decode (an SVG without a size, say).
 */
export async function judgeBytes(blob) {
  const model = await loadModel();
  const bitmap = await createImageBitmap(blob);
  let pixels;
  try {
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, SIZE, SIZE);
    pixels = context.getImageData(0, 0, SIZE, SIZE);
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

