// The picture filter's half that runs in every page (and every frame): keeps each picture hidden until
// the background script has judged it, then shows it or keeps it hidden. content.css does the hiding,
// by the attribute this script sets on each <img> and <video>:
//   (none) or "checking"  hidden, not judged yet
//   "small"               shown without being judged: an icon, a button, a tracking pixel
//   "ok"                  judged and shown
//   "hidden"              judged and kept hidden
// Pictures are judged when they come near the view, so a long page costs only what is looked at. A video
// is judged by its poster and by its frames: the first frame before it can be seen, then one every so
// often while it plays, so a video that turns out to show something is hidden, and paused, within a
// moment. A video of the device's own camera is the exception: it shows what is in front of the computer,
// which can't be hidden from the person sitting there, so it is shown without being judged. A picture an
// element's own style sets as its background is judged like an <img>, and the element has no background
// until then (X shows a tweet's picture that way, under a see-through <img>). Backgrounds set in
// stylesheets and pictures inside shadow roots are not covered, and a video whose frames the page itself
// isn't allowed to read (served from another site without permission) is judged by its poster alone.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const ATTR = 'data-family-site-blocker';
  const MIN_AREA = 64 * 64; // lib/pictures.js MIN_SIZE squared: smaller pictures are icons, not pictures
  const FRAME_SIZE = 224; // classifier.js SIZE: a frame is sent at the size the classifier scales to anyway
  const FRAME_EVERY_MS = 1500; // while a video plays, one frame in this long is judged
  const FRAME_RETRY_MS = 100; // how soon to ask again for a frame the browser hadn't handed over yet
  const FRAME_WAIT_MS = 3000; // a video that promised a frame and shows none in this long has nothing to see
  const HAVE_NOTHING = 0; // HTMLMediaElement.readyState: nothing is known yet
  const HAVE_METADATA = 1; // the size and length are known, no frame yet
  const HAVE_CURRENT_DATA = 2; // the frame at the current position is there
  const NETWORK_LOADING = 2; // HTMLMediaElement.networkState: fetching
  const judged = new WeakMap(); // img -> the address it was last judged by
  const marked = new WeakMap(); // element -> the mark this script set last, to tell its own writes from the page's
  const pending = new Map(); // address -> the judgment under way, shared by pictures with the same address
  const videos = new WeakMap(); // video -> what is known about judging its current source (videoState)

  const mark = (element, state) => {
    marked.set(element, state);
    if (element.getAttribute(ATTR) !== state) element.setAttribute(ATTR, state);
  };

  const fetchable = (url) => /^(?:https?|data):/i.test(url); // what the background script can fetch

  function judge(url) {
    if (!pending.has(url)) {
      const request = Promise.resolve(api.runtime.sendMessage({ type: 'judge-picture', url }))
        .catch(() => null)
        .finally(() => pending.delete(url));
      pending.set(url, request);
    }
    return pending.get(url);
  }

  // --- Pictures ----------------------------------------------------------------------------------------

  async function check(img) {
    const url = img.currentSrc || img.src || '';
    if (!(img.complete && img.naturalWidth > 0)) {
      // Not loaded yet: judged when it is (the load listener below). Small or not isn't known before.
      mark(img, 'checking');
      return;
    }
    if (judged.get(img) === url) return;
    judged.set(img, url);
    if (img.naturalWidth * img.naturalHeight < MIN_AREA) {
      mark(img, 'small');
      return;
    }
    // Only addresses the background script can fetch; a blob: picture made by the page is shown as it is.
    if (!fetchable(url)) {
      mark(img, 'ok');
      return;
    }
    mark(img, 'checking');
    const result = await judge(url);
    if (judged.get(img) !== url) return; // the picture changed meanwhile; the new one is being judged
    mark(img, result?.hide ? 'hidden' : 'ok');
  }

  // --- Backgrounds -------------------------------------------------------------------------------------
  // An element whose style attribute names a url( is treated by content.css as having a background picture:
  // no background until it is marked. The addresses in its own background-image are judged as a picture's
  // is, each of them (gradients and image-set() included), and the element is hidden if any is. A url( in
  // a mask or a custom property, or a background from a stylesheet, gives no address here: such an element
  // is marked ok, and a stylesheet's background isn't seen at all.

  const backgrounds = new WeakMap(); // element -> the addresses (joined) it was last judged by
  const smallBackgrounds = new WeakMap(); // element -> the addresses it was found too small for
  const checkingBackgrounds = new WeakMap(); // element -> the addresses a check is under way for
  const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/gi;

  /** Whether content.css treats an element as having a background picture: its style attribute names a url(. */
  const hasBackground = (node) => node instanceof HTMLElement && /url\(/i.test(node.getAttribute('style') ?? '');

  /** The addresses in an element's own background-image that the background script can fetch, resolved. */
  function backgroundUrls(element) {
    const urls = [];
    for (const match of (element.style.backgroundImage || '').matchAll(CSS_URL)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!raw) continue;
      try {
        const url = new URL(raw, document.baseURI).href;
        if (fetchable(url)) urls.push(url);
      } catch {
        // not an address
      }
    }
    return urls;
  }

  const areas = new Map(); // address -> the picture's area in pixels, once looked up (a sprite shared by many icons is looked up once)

  /** A picture's area in pixels, found by loading it (the browser has it already, as the element's background); 0 if it can't be loaded. */
  function naturalArea(url) {
    if (!areas.has(url)) {
      areas.set(
        url,
        new Promise((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(probe.naturalWidth * probe.naturalHeight);
          probe.onerror = () => resolve(0);
          probe.src = url;
        }),
      );
    }
    return areas.get(url);
  }

  function forgetBackground(element) {
    backgrounds.delete(element);
    smallBackgrounds.delete(element);
  }

  async function checkBackground(element) {
    const urls = backgroundUrls(element);
    if (urls.length === 0) {
      // Nothing of ours in it: a url( in a mask or a custom property, a gradient, a blob: picture the page made.
      forgetBackground(element);
      mark(element, 'ok');
      return;
    }
    const key = urls.join(' ');
    if (backgrounds.get(element) === key || checkingBackgrounds.get(element) === key) return; // judged, or being judged
    // Small as an <img> is small: an element under 64 by 64 showing pictures that are all under 64 by 64 (an
    // icon, a sprite) is shown without being judged; a small box showing a big picture is judged.
    const bigBox = element.offsetWidth * element.offsetHeight >= MIN_AREA;
    if (!bigBox && smallBackgrounds.get(element) === key) return; // found small already, and no bigger now
    checkingBackgrounds.set(element, key);
    try {
      mark(element, 'checking');
      const picture = bigBox || (await Promise.all(urls.map(naturalArea))).some((area) => area >= MIN_AREA);
      if (backgroundUrls(element).join(' ') !== key) return; // changed meanwhile; the new one is being judged
      if (!picture) {
        smallBackgrounds.set(element, key);
        mark(element, 'small');
        return;
      }
      backgrounds.set(element, key);
      const results = await Promise.all(urls.map(judge));
      if (backgrounds.get(element) !== key) return;
      mark(element, results.some((result) => result?.hide) ? 'hidden' : 'ok');
    } finally {
      if (checkingBackgrounds.get(element) === key) checkingBackgrounds.delete(element);
    }
  }

  // An element found too small to be a picture is looked at again if it grows.
  const grown =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const entry of entries) if (smallBackgrounds.has(entry.target)) checkBackground(entry.target);
        })
      : null;

  // --- Video -------------------------------------------------------------------------------------------
  // What a video shows changes as it plays, so it is judged more than once: its poster (by address, like
  // a picture) and its first frame out of sight, then a frame every FRAME_EVERY_MS while it plays and one
  // after each seek. The first frame is read once the browser says it has put a frame up
  // (requestVideoFrameCallback), not as soon as readyState says the frame's data is there: until a frame
  // has reached the compositor, drawImage paints black, and black would pass for a photo, showing a video
  // that should stay hidden until its next frame is judged (#119: GitHub's Macs take a moment over the
  // first frame). A verdict to hide sticks for as long as the video keeps its source, and a hidden
  // video is paused: what can't be seen shouldn't play on. A video's source is an address or an object
  // the page gives it (srcObject): a stream from the device's own camera, from another person's camera in
  // a call, or from the page's own drawing. The device's own camera is shown without being judged.

  let frameCanvas = null; // one small canvas frames are copied through, shared by the page's videos

  const isStream = (object) => typeof MediaStream === 'function' && object instanceof MediaStream;

  /** Whether a video still has the source a state was made for: the same address and the same object. */
  const sameSource = (state, video) => state.src === (video.currentSrc || video.src || '') && state.object === (video.srcObject ?? null);

  /** What is known about judging a video's current source; a new source starts afresh. */
  function videoState(video) {
    let state = videos.get(video);
    if (!state || !sameSource(state, video)) {
      stopWaiting(video, state);
      const object = video.srcObject ?? null;
      state = {
        src: video.currentSrc || video.src || '',
        object, // the stream or other object the page gave the video, if any
        camera: isStream(object) ? null : false, // whether the stream is the device's own camera: null until looked at
        near: state?.near ?? false, // within a screen of the view (the observer below)
        hidden: false, // judged and kept hidden: sticks for this source
        settled: false, // something of this source (poster or frame) has been judged, or nothing can be
        firstFrameJudged: false,
        presented: false, // the browser has put a frame of this source up, so its pixels can be read (awaitPresented)
        presenting: null, // the request to be told when it has (requestVideoFrameCallback's handle), while it waits
        posterJudged: null, // the poster address judged, so it is judged once
        unreadable: false, // the page may not read this source's frames: judged by its poster alone
        lastFrameAt: 0,
        busy: null, // the judgment under way
        waiting: null, // the timer that gives up waiting for a first frame
        retry: null, // the timer that asks again for a frame the browser hadn't handed over yet
      };
      videos.set(video, state);
      awaitPresented(video, state);
    }
    return state;
  }

  /** Stops what a state waits for: its timers, and its request to be told of a presented frame. */
  function stopWaiting(video, state) {
    if (!state) return;
    clearTimeout(state.waiting);
    clearTimeout(state.retry);
    if (state.presenting !== null) video.cancelVideoFrameCallback(state.presenting);
  }

  /**
   * Asks the browser to say when it has put a frame of the video's source up (requestVideoFrameCallback,
   * which Chrome, Edge, Brave and Firefox have), which is when the frame's pixels can be read: before a
   * frame has reached the compositor, drawImage paints black, however much readyState promises, and black
   * would be judged a photo. A browser without it is taken at readyState's word.
   */
  function awaitPresented(video, state) {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      state.presented = true;
      return;
    }
    state.presenting = video.requestVideoFrameCallback(() => {
      state.presenting = null;
      if (videos.get(video) !== state) return; // a frame of a source since replaced
      state.presented = true;
      if (state.near && !state.hidden) checkVideo(video); // the first frame: judged now, before it can be seen
    });
  }

  const cameras = new WeakMap(); // stream -> whether it is the device's own camera (a promise), looked up once per stream

  /**
   * Whether a stream is the device's own camera: every video track of it comes from a camera this browser
   * lists for the page (the track's deviceId is one of the listed cameras', as it is for a track from
   * getUserMedia). A stream from elsewhere has no such track: another person's camera in a call (its
   * track's deviceId is its own id, in Chrome, or none), a stream the page made from a canvas, a shared
   * screen. False too when the page can't list cameras at all (an insecure page can't have one). Null,
   * and not remembered, for a stream with no video track yet: looked at again when it has one.
   */
  function ownCamera(stream) {
    if (!cameras.has(stream)) {
      const looked = (async () => {
        const tracks = stream.getVideoTracks();
        if (tracks.length === 0) return null;
        const ids = tracks.map((track) => track.getSettings().deviceId).filter((id) => typeof id === 'string' && id !== '');
        if (ids.length !== tracks.length) return false;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const listed = new Set(devices.filter((device) => device.kind === 'videoinput').map((device) => device.deviceId));
        return ids.every((id) => listed.has(id));
      })().catch(() => false);
      cameras.set(stream, looked);
      looked.then((camera) => {
        if (camera === null && cameras.get(stream) === looked) cameras.delete(stream);
      });
    }
    return cameras.get(stream);
  }

  /**
   * A small JPEG of the video's current frame, as a data: address. Null when the browser drew nothing: it
   * has no frame to hand over yet (the first one takes a moment after the data is there), or never will
   * (protected video). Throws when the page may not read this video's frames.
   */
  function frameOf(video) {
    if (!frameCanvas) {
      frameCanvas = document.createElement('canvas');
      frameCanvas.width = frameCanvas.height = FRAME_SIZE;
    }
    const context = frameCanvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);
    context.drawImage(video, 0, 0, FRAME_SIZE, FRAME_SIZE);
    let pixels;
    try {
      pixels = context.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE).data;
    } catch (error) {
      frameCanvas = null; // a frame the page may not read taints the canvas for good: the next one is new
      throw error;
    }
    // A frame covers the whole canvas; where nothing was drawn, every pixel is still clear.
    let drawn = false;
    for (let i = 3; i < pixels.length && !drawn; i += 4 * 101) drawn = pixels[i] !== 0;
    return drawn ? frameCanvas.toDataURL('image/jpeg', 0.85) : null;
  }

  function hideVideo(video) {
    mark(video, 'hidden');
    if (!video.paused) video.pause();
  }

  // Nothing more is coming for a video that isn't fetching and hasn't been told to: a preload="none" video
  // before anyone presses play. It shows an empty box (with the controls, if any), and is judged when it loads.
  const idle = (video) => video.readyState === HAVE_NOTHING && video.networkState !== NETWORK_LOADING && video.preload === 'none' && !video.autoplay;

  /** Whether a frame is there to read: its data has arrived, and the browser has put it up. */
  const frameReady = (video, state) => video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0 && state.presented && !state.unreadable;

  /** Gives up waiting for a first frame: when none is coming, there is nothing to see, and nothing to hide. */
  function giveUp(video, state) {
    state.waiting = null;
    if (videos.get(video) !== state || state.hidden || state.settled) return;
    if (video.networkState === NETWORK_LOADING && video.readyState < HAVE_CURRENT_DATA) {
      state.waiting = setTimeout(() => giveUp(video, state), FRAME_WAIT_MS); // still on its way
      return;
    }
    if (!state.presented && video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0 && !state.unreadable) {
      // The frame's data is there, but the browser hasn't said it put the frame up (it did so before this
      // script asked, or never says): the frame is read as it is, rather than shown unjudged.
      state.presented = true;
      if (!state.busy) checkVideo(video);
      return;
    }
    state.settled = true;
    mark(video, 'ok');
  }

  async function checkVideo(video) {
    const state = videoState(video);
    if (state.hidden) {
      hideVideo(video); // the page started it again: it stays hidden, and stops again
      return;
    }
    if (state.busy) return; // one judgment at a time; the next tick looks again
    if (state.camera === null) {
      // A stream: find out first whether it is the device's own camera, out of sight like a first frame. A
      // stream with no video track yet is judged as a video with no frame is, and looked at again later.
      mark(video, 'checking');
      state.busy = ownCamera(state.object);
      const camera = await state.busy;
      state.busy = null;
      if (videos.get(video) !== state) return; // the source changed meanwhile; the new one is being judged
      if (camera !== null) state.camera = camera;
    }
    if (state.camera) {
      state.settled = true; // the device's own camera: shown as it is, and never judged
      mark(video, 'ok');
      return;
    }
    const checks = [];
    const poster = video.poster || '';
    if (poster && fetchable(poster) && state.posterJudged !== poster) {
      state.posterJudged = poster;
      checks.push(judge(poster));
    }
    let frame = null;
    if (frameReady(video, state)) {
      try {
        frame = frameOf(video);
      } catch {
        state.unreadable = true; // judged by its poster alone, like a picture the background script can't fetch
      }
      if (frame) {
        state.lastFrameAt = performance.now();
        checks.push(Promise.resolve(api.runtime.sendMessage({ type: 'judge-video-frame', frame, src: state.src, poster })).catch(() => null));
      } else if (!state.settled && !state.unreadable) {
        // The browser drew nothing yet: ask again in a moment.
        state.retry ??= setTimeout(() => {
          state.retry = null;
          if (videos.get(video) === state && !state.busy) checkVideo(video);
        }, FRAME_RETRY_MS);
      }
    }
    if (checks.length === 0) {
      if (state.settled) return; // judged already, and there is no new frame
      if (state.unreadable) {
        state.settled = true; // frames the page may not read, and no poster: shown as it is
        mark(video, 'ok');
      } else if (idle(video)) {
        mark(video, 'ok');
      } else {
        // A frame is on its way (or the browser is still to put the first one up, or to hand it over):
        // stay hidden until it has been judged, or until it is clear that none is coming.
        mark(video, 'checking');
        state.waiting ??= setTimeout(() => giveUp(video, state), FRAME_WAIT_MS);
      }
      return;
    }
    // The first look at a source, and the first frame, happen out of sight; later frames are judged
    // while the video shows.
    if (!state.settled || (frame && !state.firstFrameJudged)) mark(video, 'checking');
    state.busy = Promise.all(checks);
    const results = await state.busy;
    state.busy = null;
    if (videos.get(video) !== state) return; // the source changed meanwhile; the new one is being judged
    if (results.some((result) => result?.hide)) {
      state.hidden = true;
      hideVideo(video);
      return;
    }
    if (frame) {
      state.settled = true;
      state.firstFrameJudged = true;
    } else if (frameReady(video, state)) {
      checkVideo(video); // a frame was put up while the poster was judged: judged now, still out of sight
      return;
    } else if (!(video.readyState >= HAVE_METADATA || video.networkState === NETWORK_LOADING) || idle(video) || video.videoWidth === 0) {
      state.settled = true; // the poster was judged, and no frame is coming
    } else {
      state.waiting ??= setTimeout(() => giveUp(video, state), FRAME_WAIT_MS); // the poster was judged; a frame is still to come
    }
    mark(video, 'ok');
  }

  // Media events don't bubble, so they are caught on the way down. A video is looked at again when it has
  // a frame, starts, is seeked, or plays on; a new source starts over.
  const VIDEO_EVENTS = ['loadstart', 'emptied', 'loadedmetadata', 'loadeddata', 'play', 'playing', 'seeked', 'timeupdate'];
  function onVideoEvent(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !videos.has(video)) return; // scan() looks at new ones
    if (event.type === 'loadstart' || event.type === 'emptied') {
      rewatch(video);
      return;
    }
    const state = videoState(video);
    if (state.hidden) {
      hideVideo(video);
      return;
    }
    if (!state.near) return; // judged when it comes near the view
    if (state.camera) return; // the device's own camera: shown as it is
    if (state.unreadable && state.settled) return; // only the poster could be judged, and it has been
    if (event.type === 'timeupdate' && (video.paused || performance.now() - state.lastFrameAt < FRAME_EVERY_MS)) return;
    checkVideo(video);
  }
  for (const type of VIDEO_EVENTS) document.addEventListener(type, onVideoEvent, true);

  // --- Watching the page ---------------------------------------------------------------------------------

  // Judge a picture when it comes within a screen's height of the view, and again whenever its address
  // or state changes. A video is judged while it is that near, as it plays.
  const near = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLVideoElement) {
          videoState(entry.target).near = entry.isIntersecting;
          if (entry.isIntersecting) checkVideo(entry.target);
        } else if (entry.isIntersecting) {
          if (entry.target instanceof HTMLImageElement) check(entry.target);
          else checkBackground(entry.target);
        }
      }
    },
    { rootMargin: '100% 0px' },
  );

  function watch(element) {
    if (!element.hasAttribute(ATTR)) mark(element, 'checking');
    if (element instanceof HTMLVideoElement) videoState(element);
    else if (!(element instanceof HTMLImageElement)) grown?.observe(element);
    near.observe(element);
  }

  // Judge again from scratch: a new address, a new load, or the page's script touching the mark. A hidden
  // video whose source hasn't changed stays hidden: taking the mark off doesn't bring it back.
  function rewatch(element) {
    judged.delete(element);
    forgetBackground(element);
    if (element instanceof HTMLVideoElement) {
      const state = videos.get(element);
      if (state && sameSource(state, element) && state.hidden) {
        hideVideo(element);
      } else {
        stopWaiting(element, state);
        videos.delete(element);
        videoState(element).near = state?.near ?? false;
        mark(element, 'checking');
      }
    }
    near.unobserve(element); // observing again makes the observer report the element once more
    watch(element);
  }

  const isMedia = (node) => node instanceof HTMLImageElement || node instanceof HTMLVideoElement;
  const isWatched = (node) => isMedia(node) || hasBackground(node);
  const WATCHED = 'img, video, [style*="url(" i]';

  function scan(root) {
    if (isWatched(root)) watch(root);
    if (root.querySelectorAll) for (const element of root.querySelectorAll(WATCHED)) watch(element);
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const element = record.target;
        if (record.attributeName === 'style') {
          // A background picture given to an element, changed or taken away. A style change that leaves
          // the addresses as they were (a transform, say) is nothing new.
          if (isMedia(element) || !(element instanceof HTMLElement)) continue;
          if (!hasBackground(element)) {
            if (backgrounds.has(element) || smallBackgrounds.has(element) || checkingBackgrounds.has(element)) {
              forgetBackground(element);
              mark(element, 'ok');
            }
            continue;
          }
          const key = backgroundUrls(element).join(' ');
          if (backgrounds.get(element) === key || smallBackgrounds.get(element) === key || checkingBackgrounds.get(element) === key) continue;
          mark(element, 'checking');
          rewatch(element);
          continue;
        }
        if (!isWatched(element)) continue;
        // A mark this script set itself is nothing new. The page taking the mark off or changing it, or
        // giving the picture a new address, means judging again (the background script remembers
        // verdicts, so a known picture costs nothing).
        if (record.attributeName === ATTR && element.getAttribute(ATTR) === marked.get(element)) continue;
        rewatch(element);
        continue;
      }
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }
  }).observe(document.documentElement ?? document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'poster', 'style', ATTR],
  });

  // A picture that finishes loading while near the view is judged straight away; load events don't
  // bubble, so they are caught on the way down.
  document.addEventListener(
    'load',
    (event) => {
      if (event.target instanceof HTMLImageElement) rewatch(event.target);
    },
    true,
  );

  scan(document.documentElement ?? document);
})();
