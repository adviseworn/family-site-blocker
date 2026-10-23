// Helpers for testing the picture filter in a real browser without explicit pictures: a copy of the
// extension whose classifier judges a picture by its address instead of its pixels, and the pages and
// pictures the tests show.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_DIR } from './browser.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The scores the stand-in gives, by a word in the picture's address; anything else is an ordinary photo. */
export const STAND_IN_SCORES = {
  nude: { drawing: 0.01, hentai: 0.02, neutral: 0.05, porn: 0.9, sexy: 0.02 },
  lingerie: { drawing: 0.01, hentai: 0.01, neutral: 0.3, porn: 0.08, sexy: 0.6 },
  drawn: { drawing: 0.3, hentai: 0.5, neutral: 0.15, porn: 0.03, sexy: 0.02 },
  photo: { drawing: 0.001, hentai: 0, neutral: 0.999, porn: 0, sexy: 0 },
};

const STAND_IN = `// A stand-in for classifier.js, for the tests: judges a picture by its address, not its pixels.
const SCORES = ${JSON.stringify(STAND_IN_SCORES)};
export const SIZE = 224;
export async function loadModel() {}
export const backendInUse = () => 'stand-in';
export async function judgeBytes(blob, url = '') {
  if (!blob || blob.size === 0) throw new Error('not a picture');
  const word = Object.keys(SCORES).find((name) => url.includes(name)) ?? 'photo';
  return SCORES[word];
}
`;

/**
 * A copy of the extension with the stand-in classifier, in a temporary folder (real path, because Chrome
 * works out an unpacked extension's id from it). Remove it with the returned function.
 */
export function extensionWithStandInClassifier() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-site-blocker-stand-in-')));
  cpSync(EXTENSION_DIR, dir, { recursive: true, filter: (source) => basename(source) !== '_metadata' });
  writeFileSync(join(dir, 'classifier.js'), STAND_IN);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Serves the fixture photos from the stub internet under any name: pics.test/pics/<name>.jpg. */
export function servePictures(stub, names) {
  const jpeg = { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' } };
  const photos = { cat: readFileSync(join(FIXTURES, 'cat.jpg')), coffee: readFileSync(join(FIXTURES, 'coffee.jpg')) };
  for (const name of names) stub.page(`/pics/${name}.jpg`, name.includes('coffee') ? photos.coffee : photos.cat, jpeg);
}

/** A page showing pictures: an icon, then one <img> per name, 300 px wide. */
export function galleryPage(names, extra = '') {
  return `<!doctype html><meta charset="utf-8"><title>Gallery</title><h1>Gallery</h1>
    <img id="icon" src="http://pics.test/icon.gif" width="16" height="16">
    ${names.map((name) => `<img id="${name}" src="http://pics.test/pics/${name}.jpg" width="300">`).join('\n')}
    ${extra}`;
}

/** What each picture on a page is marked as, and whether it can be seen: { id: [mark, visibility] }. */
export const MARKS = `[...document.querySelectorAll('img')].map((img) => [img.id || img.src, [img.getAttribute('data-family-site-blocker'), getComputedStyle(img).visibility]])`;
