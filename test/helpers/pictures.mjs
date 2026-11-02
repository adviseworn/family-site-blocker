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
    if (g > 120 && r < 100 && b < 100) return SCORES.lingerie; // Chromium's fake camera is a green of 138 to 164
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

/** A page showing a picture written out as a data: address (the cat, named in the address so that the stand-in hides it). */
export function inlinePage() {
  const cat = readFileSync(join(FIXTURES, 'cat.jpg')).toString('base64');
  return `<!doctype html><meta charset="utf-8"><title>Inline</title><h1>Inline</h1><img id="inline" src="data:image/jpeg;name=nude;base64,${cat}" width="300">`;
}

/**
 * A page of elements whose own style sets a picture as their background, the way X shows a tweet's picture
 * (a div with the picture as its background, under a see-through <img> with the same address): one to
 * hide, one fine (with words on it), one with three layers, an icon, a small thumbnail of a big picture, a
 * span whose style names a url( only in its mask, the X-like pair, and one given its background by script
 * later; the fine one is swapped for one to hide after that, and the hidden one's transform changes.
 */
export function backgroundsPage() {
  const box = 'width: 300px; height: 200px; margin: 4px;';
  return `<!doctype html><meta charset="utf-8"><title>Backgrounds</title><h1>Backgrounds</h1>
    <div id="bg-nude" style="${box} background-image: url(http://pics.test/pics/nude.jpg?bg)"></div>
    <div id="bg-photo" style="${box} background: url('http://pics.test/pics/photo.jpg?bg') center / cover no-repeat"><p id="words">Words on the picture</p></div>
    <div id="bg-layers" style="${box} background-image: linear-gradient(white, white), url(&quot;http://pics.test/pics/photo.jpg?layer&quot;), url(http://pics.test/pics/lingerie.jpg?layer)"></div>
    <span id="bg-icon" style="display: inline-block; width: 16px; height: 16px; background-image: url(http://pics.test/icon.gif)"></span>
    <span id="bg-thumb" style="display: inline-block; width: 40px; height: 40px; background: url(http://pics.test/pics/nude.jpg?thumb) center / cover"></span>
    <span id="bg-mask" style="display: inline-block; width: 100px; height: 100px; background: red; mask-image: url(http://pics.test/icon.gif)"></span>
    <div id="x" style="position: relative; ${box}">
      <div id="x-bg" style="position: absolute; inset: 0px; background-image: url(&quot;http://pics.test/pics/lingerie.jpg?x&quot;); background-size: cover"></div>
      <img id="x-img" alt="Image" draggable="true" src="http://pics.test/pics/lingerie.jpg?x" style="position: absolute; inset: 0px; width: 100%; height: 100%; opacity: 0">
    </div>
    <div id="bg-late" style="${box}"></div>
    <script>
      setTimeout(() => { document.getElementById('bg-late').style.backgroundImage = 'url(http://pics.test/pics/nude.jpg?late-bg)'; }, 300);
      setTimeout(() => { document.getElementById('bg-photo').style.backgroundImage = 'url(http://pics.test/pics/nude.jpg?swapped-bg)'; }, 600);
      setTimeout(() => { document.getElementById('bg-nude').style.transform = 'translateX(1px)'; }, 600);
    </script>`;
}

/** What each element with a background picture on a page is marked as, and what background it shows: { id: [mark, background-image] }. */
export const BACKGROUND_MARKS = `[...document.querySelectorAll('[style*="url(" i]')].map((el) => [el.id, [el.getAttribute('data-family-site-blocker'), getComputedStyle(el).backgroundImage]])`;

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

/**
 * The command-line switches that give Chromium a fake camera (its picture is green, "lingerie" to the
 * stand-in classifier), hand it over without asking, and let a page on camera.test use it, as only a
 * secure page may; the stand-in internet speaks plain http.
 */
export const FAKE_CAMERA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--unsafely-treat-insecure-origin-as-secure=http://camera.test'];

/**
 * The settings that do the same for Firefox (its fake camera's picture starts green and drifts through blue
 * to red), and let a peer connection reach one in the same Firefox over the loopback address, which needs
 * no permission to use the local network.
 */
export const FAKE_CAMERA_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'dom.securecontext.allowlist': 'camera.test',
  'media.peerconnection.ice.loopback': true,
};

/**
 * A page showing the device's camera in a <video> straight from getUserMedia, as the NZeTA passport-photo
 * page does (#84): the device's own camera, shown as it is. With { streams: true } two more videos show
 * streams from elsewhere, which are judged: the camera's own picture copied frame by frame through a
 * canvas into a stream the page made (as a blob: video the page made is), and a green picture (one the
 * stand-in hides) sent through a loopback RTCPeerConnection, as another person's camera arrives in a call;
 * green rather than the camera's picture because Firefox's fake camera drifts from green to blue within
 * seconds, and a connection that is slow to come up would carry a picture the stand-in passes.
 * window.__ready says when every stream is in place, window.__error what went wrong, window.__peer how
 * the receiving peer connection stands, and every mark is kept, as videoPage keeps them.
 */
export function cameraPage({ streams = false } = {}) {
  return videoPage(
    ['id="camera" autoplay muted playsinline', ...(streams ? ['id="copy" autoplay muted playsinline', 'id="peer" autoplay muted playsinline'] : [])],
    `<script>
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const camera = document.getElementById('camera');
      camera.srcObject = stream;
      if (${streams}) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        await new Promise((resolve) => { camera.onloadeddata = resolve; });
        setInterval(() => context.drawImage(camera, 0, 0, 64, 64), 50);
        document.getElementById('copy').srcObject = canvas.captureStream(10);
        const green = document.createElement('canvas');
        green.width = green.height = 64;
        const paint = green.getContext('2d');
        paint.fillStyle = 'rgb(0, 200, 0)';
        setInterval(() => paint.fillRect(0, 0, 64, 64), 50); // painted again and again, so frames keep coming
        const sent = green.captureStream(10);
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate); };
        b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };
        b.onconnectionstatechange = () => { window.__peer = b.connectionState; };
        b.ontrack = (e) => { document.getElementById('peer').srcObject = e.streams[0] ?? new MediaStream([e.track]); };
        for (const track of sent.getTracks()) a.addTrack(track, sent);
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
      }
      window.__ready = true;
    })().catch((e) => { window.__error = String(e); });
    </script>`,
  );
}

/** What each picture and video on a page is marked as, and whether it can be seen: { id: [mark, visibility] }. */
export const MARKS = `[...document.querySelectorAll('img, video')].map((el) => [el.id || el.currentSrc || el.src, [el.getAttribute('data-family-site-blocker'), getComputedStyle(el).visibility]])`;
