// The picture filter: how scores become verdicts and a record (lib/pictures.js), the files it ships, and
// the classifier itself run in Node on two ordinary photos, which must come out as "neutral". There is no
// explicit photo here to check the other way; the real-browser tests use a stand-in classifier for that,
// and the Real pictures check (test/real-pictures.check.mjs) runs the model on real pictures at GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { BORDERLINE, CLASSES, DEFAULT_STRICTNESS, MAX_PICTURES, MIN_SIZE, STRICTNESS_CHOICES, THRESHOLD, borderline, hiddenBySite, recordHidden, strictnessOf, verdict } from '../extension/lib/pictures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

test('pictures: nudity is hidden under both settings, suggestive only under the strict one, and the rest shown', () => {
  const nude = { drawing: 0.01, hentai: 0.02, neutral: 0.1, porn: 0.85, sexy: 0.02 };
  const drawn = { drawing: 0.3, hentai: 0.45, neutral: 0.2, porn: 0.03, sexy: 0.02 };
  const lingerie = { drawing: 0.01, hentai: 0.01, neutral: 0.3, porn: 0.08, sexy: 0.6 };
  const borderline = { drawing: 0.05, hentai: 0.05, neutral: 0.55, porn: 0.15, sexy: 0.2 }; // nudity 0.2, with sexy 0.4
  const cat = { drawing: 0.001, hentai: 0, neutral: 0.999, porn: 0, sexy: 0 };
  assert.deepEqual(verdict(nude, 'strict'), { hide: true, reason: 'nudity' });
  assert.deepEqual(verdict(nude, 'nudity'), { hide: true, reason: 'nudity' });
  assert.deepEqual(verdict(drawn, 'nudity'), { hide: true, reason: 'nudity' }, 'porn and hentai count together');
  assert.deepEqual(verdict(lingerie, 'strict'), { hide: true, reason: 'suggestive' });
  assert.deepEqual(verdict(lingerie, 'nudity'), { hide: false, reason: null });
  assert.deepEqual(verdict(borderline, 'strict'), { hide: true, reason: 'suggestive' }, `at the threshold (${THRESHOLD}) it is hidden`);
  assert.deepEqual(verdict(borderline, 'nudity'), { hide: false, reason: null });
  assert.deepEqual(verdict(cat, 'strict'), { hide: false, reason: null });
  assert.deepEqual(verdict(cat), verdict(cat, DEFAULT_STRICTNESS), 'the default setting');
  assert.deepEqual(verdict(undefined, 'strict'), { hide: false, reason: null }, 'no scores: shown');
  assert.deepEqual(verdict({ porn: 'x', sexy: NaN }, 'strict'), { hide: false, reason: null }, 'nonsense scores: shown');
  assert.equal(DEFAULT_STRICTNESS, 'strict', 'suggestive pictures are hidden unless the setting is changed');
  assert.deepEqual(STRICTNESS_CHOICES.map((c) => c.value), ['strict', 'nudity']);
  assert.equal(strictnessOf('nudity'), 'nudity');
  assert.equal(strictnessOf('off'), DEFAULT_STRICTNESS, 'there is no off');
  assert.equal(strictnessOf(undefined), DEFAULT_STRICTNESS);
  assert.deepEqual(CLASSES, ['drawing', 'hentai', 'neutral', 'porn', 'sexy'], "the model's output order");
  assert.equal(MIN_SIZE, 64);
});

test('pictures: a hidden picture is borderline when the score that decided it was under 0.6, the likelier mistake', () => {
  assert.equal(BORDERLINE, 0.6);
  assert.ok(THRESHOLD < BORDERLINE);
  assert.equal(borderline({ reason: 'nudity', scores: { porn: 0.9, hentai: 0.02, sexy: 0.02 } }), false);
  assert.equal(borderline({ reason: 'nudity', scores: { porn: 0.3, hentai: 0.23, sexy: 0.4 } }), true, 'nudity decided at 0.53; sexy does not count for it');
  assert.equal(borderline({ reason: 'suggestive', scores: { porn: 0.08, hentai: 0.01, sexy: 0.6 } }), false, 'suggestive decided at 0.69');
  assert.equal(borderline({ reason: 'suggestive', scores: { porn: 0.1, hentai: 0, sexy: 0.35 } }), true, 'suggestive decided at 0.45');
  assert.equal(borderline({ reason: 'suggestive', scores: {} }), true, 'no scores at all: nothing to be sure of');
});

test('pictures: the record of hidden pictures keeps rounded scores, caps its length, and sums up by site', () => {
  let record = recordHidden(undefined, { at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'suggestive', scores: { porn: 0.123456, hentai: 0.01, sexy: 0.5, neutral: 0.3, drawing: 0.01 } });
  assert.deepEqual(record, [{ at: 1000, site: 'a.test', url: 'https://a.test/x.jpg', reason: 'suggestive', scores: { porn: 0.12, hentai: 0.01, sexy: 0.5 } }]);
  record = recordHidden(record, { at: 2000, site: 'b.test', url: 'x'.repeat(900), reason: 'nudity', scores: { porn: 0.9 } });
  assert.equal(record[1].url.length, 500, 'long addresses are cut');
  assert.deepEqual(record[1].scores, { porn: 0.9, hentai: 0, sexy: 0 });
  record = recordHidden(record, { at: 3000, site: 'a.test', url: 'https://a.test/y.jpg', reason: 'nudity', scores: { porn: 0.7 } });
  assert.deepEqual(hiddenBySite(record), [
    { site: 'a.test', pictures: 2, last: 3000 },
    { site: 'b.test', pictures: 1, last: 2000 },
  ]);
  let many = [];
  for (let i = 0; i < MAX_PICTURES + 3; i += 1) many = recordHidden(many, { at: i, site: 's.test', url: `u${i}`, reason: 'nudity', scores: {} });
  assert.equal(many.length, MAX_PICTURES);
  assert.equal(many[0].url, 'u3', 'the oldest go');
  assert.deepEqual(hiddenBySite(undefined), []);
});

test('pictures: the content script runs in every page and frame from the start, and the model and its runtime ship with the add-on', () => {
  const [script] = manifest.content_scripts;
  assert.deepEqual(script, { matches: ['<all_urls>'], js: ['content.js'], css: ['content.css'], run_at: 'document_start', all_frames: true });
  assert.match(manifest.content_security_policy.extension_pages, /^script-src 'self' 'wasm-unsafe-eval'; object-src 'self';$/, 'WebAssembly allowed, nothing else loosened; no upgrade-insecure-requests, so a picture is fetched the way the page fetched it');
  for (const file of ['content.js', 'content.css', 'classifier.js', 'lib/pictures.js', 'vendor/tf.fesm.min.js', 'vendor/tf-global.js', 'vendor/tf-backend-wasm.min.js', 'vendor/tfjs-backend-wasm.wasm', 'vendor/tfjs-backend-wasm-simd.wasm', 'vendor/LICENSES.md', 'models/nsfw-mobilenet-v2/model.json']) {
    assert.ok(existsSync(join(EXT, file)), `${file} exists`);
  }
  const model = JSON.parse(readFileSync(join(EXT, 'models/nsfw-mobilenet-v2/model.json'), 'utf8'));
  for (const path of model.weightsManifest.flatMap((group) => group.paths)) {
    const size = readFileSync(join(EXT, 'models/nsfw-mobilenet-v2', path)).length;
    assert.ok(size > 0 && size < 4_000_000, `${path}: ${size} bytes, under the 4 MB Mozilla's linter allows a file`);
  }
  const licenses = readFileSync(join(EXT, 'vendor/LICENSES.md'), 'utf8');
  assert.ok(licenses.includes('Apache License') && licenses.includes('MIT License'), 'both licences are shipped');
  const css = readFileSync(join(EXT, 'content.css'), 'utf8');
  assert.match(css, /img:not\(\[data-family-site-blocker="ok"\]\):not\(\[data-family-site-blocker="small"\]\)\s*\{\s*visibility:\s*hidden\s*!important;/);
  assert.doesNotMatch(readFileSync(join(EXT, 'vendor/tf.fesm.min.js'), 'utf8').slice(0, 20000), /\bimport\s+[\w$]+\s+from\s*"/, 'the runtime is self-contained');
});

test('pictures: the classifier, run here on two ordinary photos, finds them neutral (the model loads and is read the way the add-on reads it)', { timeout: 120_000 }, async () => {
  const tf = await import('@tensorflow/tfjs');
  const dir = join(EXT, 'models/nsfw-mobilenet-v2');
  const json = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
  const weightData = Buffer.concat(json.weightsManifest.flatMap((group) => group.paths).map((path) => readFileSync(join(dir, path))));
  const model = await tf.loadLayersModel({
    load: async () => ({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights),
      weightData: weightData.buffer.slice(weightData.byteOffset, weightData.byteOffset + weightData.byteLength),
    }),
  });
  for (const file of ['cat.jpg', 'coffee.jpg']) {
    const { data, width, height } = jpeg.decode(readFileSync(join(ROOT, 'test/fixtures', file)), { useTArray: true });
    const scores = tf.tidy(() => {
      const rgb = tf.tensor3d(data, [height, width, 4], 'int32').slice([0, 0, 0], [height, width, 3]).toFloat().div(255);
      const out = model.predict(tf.image.resizeBilinear(rgb, [224, 224], true).expandDims(0));
      return (Array.isArray(out) ? out[0] : out).dataSync();
    });
    const named = Object.fromEntries(CLASSES.map((name, i) => [name, scores[i]]));
    assert.ok(named.neutral > 0.9, `${file}: ${JSON.stringify(named)}`);
    assert.deepEqual(verdict(named, 'strict'), { hide: false, reason: null }, file);
  }
  model.dispose();
});
