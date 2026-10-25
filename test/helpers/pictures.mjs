// Helpers for testing the picture filter in a real browser without explicit pictures: a copy of the
// extension whose classifier judges a picture by its address instead of its pixels (and a video's frame
// by its colour), and the pages, pictures and videos the tests show.
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

const STAND_IN = `// A stand-in for classifier.js, for the tests: judges a picture by its address, not its pixels, and a
// video's frame (which has no address) by its colour: red is "nude", green "lingerie", anything else a photo.
const SCORES = ${JSON.stringify(STAND_IN_SCORES)};
export const SIZE = 224;
export async function loadModel() {}
export const backendInUse = () => 'stand-in';
export async function judgeBytes(blob, url = '') {
  if (!blob || blob.size === 0) throw new Error('not a picture');
  const word = Object.keys(SCORES).find((name) => url.includes(name));
  if (word) return SCORES[word];
  if (url === 'video-frame') {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, 1, 1); // scaled to one pixel: the frame's average colour
    bitmap.close();
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    if (r > 150 && g < 100 && b < 100) return SCORES.nude;
    if (g > 150 && r < 100 && b < 100) return SCORES.lingerie;
  }
  return SCORES.photo;
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

/**
 * Serves the fixture videos (test/fixtures/*.webm: two seconds of one colour, 64 by 64, and
 * blue-then-red, a second of blue and then three of red) from the stub internet, on any host, at
 * /videos/<name>.webm. With { cors: true } they may be read by pages on other sites (a frame of a video
 * from another site can only be judged if the site allows it), from /videos/cors/<name>.webm.
 */
export const VIDEOS = ['red', 'blue', 'blue-then-red'];
export function serveVideos(stub) {
  for (const name of VIDEOS) {
    const bytes = readFileSync(join(FIXTURES, `${name}.webm`));
    stub.page(`/videos/${name}.webm`, bytes, { headers: { 'content-type': 'video/webm', 'cache-control': 'max-age=3600' } });
    stub.page(`/videos/cors/${name}.webm`, bytes, { headers: { 'content-type': 'video/webm', 'cache-control': 'max-age=3600', 'access-control-allow-origin': '*' } });
  }
}

/** A page showing pictures: an icon, then one <img> per name, 300 px wide. */
export function galleryPage(names, extra = '') {
  return `<!doctype html><meta charset="utf-8"><title>Gallery</title><h1>Gallery</h1>
    <img id="icon" src="http://pics.test/icon.gif" width="16" height="16">
    ${names.map((name) => `<img id="${name}" src="http://pics.test/pics/${name}.jpg" width="300">`).join('\n')}
    ${extra}`;
}

/**
 * A page showing videos, 300 px wide, that also keeps every mark the filter sets on each element (in
 * window.__marks[id], oldest first), so a test can see what a video went through. Each entry of `videos`
 * is one <video>'s attributes, with an id.
 */
export function videoPage(videos, extra = '') {
  return `<!doctype html><meta charset="utf-8"><title>Videos</title><h1>Videos</h1>
    <script>window.__marks = {}; new MutationObserver((records) => { for (const r of records) (window.__marks[r.target.id] ??= []).push(r.target.getAttribute('data-family-site-blocker')); }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-family-site-blocker'] });</script>
    ${videos.map((attributes) => `<video ${attributes} width="300"></video>`).join('\n')}
    ${extra}`;
}

/** What each picture and video on a page is marked as, and whether it can be seen: { id: [mark, visibility] }. */
export const MARKS = `[...document.querySelectorAll('img, video')].map((el) => [el.id || el.currentSrc || el.src, [el.getAttribute('data-family-site-blocker'), getComputedStyle(el).visibility]])`;
