// The picture filter's half that runs in every page (and every frame): keeps each picture hidden until
// the background script has judged it, then shows it or keeps it hidden. content.css does the hiding,
// by the attribute this script sets on each <img>:
//   (none) or "checking"  hidden, not judged yet
//   "small"               shown without being judged: an icon, a button, a tracking pixel
//   "ok"                  judged and shown
//   "hidden"              judged and kept hidden
// Pictures are judged when they come near the view, so a long page costs only what is looked at. Only
// <img> pictures are covered: backgrounds set in CSS, video, and pictures inside shadow roots are not.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const ATTR = 'data-family-site-blocker';
  const MIN_AREA = 64 * 64; // lib/pictures.js MIN_SIZE squared: smaller pictures are icons, not pictures
  const judged = new WeakMap(); // img -> the address it was last judged by
  const marked = new WeakMap(); // img -> the mark this script set last, to tell its own writes from the page's
  const pending = new Map(); // address -> the judgment under way, shared by pictures with the same address

  const mark = (img, state) => {
    marked.set(img, state);
    if (img.getAttribute(ATTR) !== state) img.setAttribute(ATTR, state);
  };

  function judge(url) {
    if (!pending.has(url)) {
      const request = Promise.resolve(api.runtime.sendMessage({ type: 'judge-picture', url }))
        .catch(() => null)
        .finally(() => pending.delete(url));
      pending.set(url, request);
    }
    return pending.get(url);
  }

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
    if (!/^(?:https?|data):/i.test(url)) {
      mark(img, 'ok');
      return;
    }
    mark(img, 'checking');
    const result = await judge(url);
    if (judged.get(img) !== url) return; // the picture changed meanwhile; the new one is being judged
    mark(img, result?.hide ? 'hidden' : 'ok');
  }

  // Judge a picture when it comes within a screen's height of the view, and again whenever its address
  // or state changes.
  const near = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) check(entry.target);
    },
    { rootMargin: '100% 0px' },
  );

  function watch(img) {
    if (!img.hasAttribute(ATTR)) mark(img, 'checking');
    near.observe(img);
  }

  // Judge again from scratch: a new address, a new load, or the page's script touching the mark.
  function rewatch(img) {
    judged.delete(img);
    near.unobserve(img); // observing again makes the observer report the picture once more
    watch(img);
  }

  function scan(root) {
    if (root instanceof HTMLImageElement) watch(root);
    if (root.querySelectorAll) for (const img of root.querySelectorAll('img')) watch(img);
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const img = record.target;
        if (!(img instanceof HTMLImageElement)) continue;
        // A mark this script set itself is nothing new. The page taking the mark off or changing it, or
        // giving the picture a new address, means judging again (the background script remembers
        // verdicts, so a known picture costs nothing).
        if (record.attributeName === ATTR && img.getAttribute(ATTR) === marked.get(img)) continue;
        rewatch(img);
        continue;
      }
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }
  }).observe(document.documentElement ?? document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', ATTR],
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
