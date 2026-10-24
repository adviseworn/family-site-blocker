// Helpers for the real-browser tests: a stand-in "internet" and a Chromium with the extension loaded.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The extension under test is ./extension. Set EXTENSION_DIR to test a different build of it.
export const EXTENSION_DIR = resolve(
  process.env.EXTENSION_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension'),
);

// Unpacked extensions get an id derived from their folder path: sha256 → first 32 hex digits → a-p.
export function extensionIdFor(dir = EXTENSION_DIR) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * A fake internet. Chromium is told to resolve every hostname to this one local server, and Firefox
 * uses it as its proxy, so the tests can use real-looking addresses (exampleadultsite.com) without
 * touching the real network. It records the Host of every request it receives: if a site never shows
 * up in `requests`, the browser stopped the request before it left.
 *
 * Default answer: a page that says "SITE LOADED". Use page() to serve something else.
 */
export async function startStubInternet() {
  const requests = [];
  const pages = new Map();

  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    // Proxied requests carry the full address ("http://site/path"), direct ones only the path.
    const url = new URL(req.url ?? '/', `http://${host || 'localhost'}`);
    const path = url.pathname;
    requests.push({ host, path, search: url.search, headers: req.headers });

    const custom = pages.get(`${host}${path}`) ?? pages.get(path);
    if (custom) {
      const body = custom.body ?? '';
      // A video is fetched in pieces (Range requests), and a browser only seeks or loops one when the
      // server answers them: binary bodies get that.
      const range = Buffer.isBuffer(body) && !custom.status ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') : null;
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1, ...custom.headers });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(custom.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...(Buffer.isBuffer(body) ? { 'accept-ranges': 'bytes', 'content-length': body.length } : {}), ...custom.headers });
      res.end(body);
    } else if (path.endsWith('.gif')) {
      res.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' });
      res.end(PIXEL);
    } else if (path.endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
      res.end('window.__loadedFromBlockedSite = true;');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${host}</title><h1>SITE LOADED</h1><p>${host}${path}</p>`);
    }
  });
  // WebSocket handshakes arrive as "upgrade" events rather than normal requests; log them too.
  server.on('upgrade', (req, socket) => {
    requests.push({ host: String(req.headers.host ?? '').toLowerCase(), path: req.url ?? '/' });
    socket.destroy();
  });
  // Through a proxy, https:// requests start as "CONNECT host:443". Log them; there is no real site to reach.
  server.on('connect', (req, socket) => {
    requests.push({ host: String(req.url ?? '').toLowerCase(), path: '' });
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  return {
    port: server.address().port,
    requests,
    /** Serve custom HTML at "path" (any host) or "host/path". */
    page(key, body, extra = {}) {
      pages.set(key, { body, ...extra });
    },
    /** Did any request for this domain (or one of its subdomains) reach the server? */
    reached(domain) {
      return requests.some(({ host }) => {
        const name = host.replace(/:\d+$/, '').replace(/\.$/, '');
        return name === domain || name.endsWith(`.${domain}`);
      });
    },
    clear() {
      requests.length = 0;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * Starts Chromium with every hostname mapped to the stub internet. With { extension: true } the
 * extension in ./extension is loaded, just like "Load unpacked" on the extensions page.
 */
export async function launchBrowser(stub, { extension = true, extensionDir = EXTENSION_DIR, internet = false } = {}) {
  // The real path, because Chrome works out an unpacked extension's id from it. On macOS the temporary
  // folder is reached through a link (/var is /private/var), which would give a different id.
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'family-site-blocker-')));
  // With { internet: true } the browser reaches the real internet instead of the stub: for the checks
  // that need real websites (test/*.check.mjs), never for the tests.
  const args = internet ? [] : [`--host-resolver-rules=MAP * 127.0.0.1:${stub.port}`, '--no-proxy-server'];

  // Chrome writes an index of the rules into a _metadata folder inside the extension it loads. Load a
  // copy, so a test run leaves ./extension exactly as it was.
  let loadedFrom = null;
  if (extension) {
    loadedFrom = join(profile, 'extension');
    cpSync(extensionDir, loadedFrom, { recursive: true, filter: (source) => basename(source) !== '_metadata' });
    args.push(`--disable-extensions-except=${loadedFrom}`, `--load-extension=${loadedFrom}`);
  }

  // Loaded here, so the Firefox tests can use the stub internet without Playwright installed.
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', // the full Chromium build, which can run extensions in headless mode
    headless: process.env.HEADFUL !== '1',
    args,
  });

  // Read the id from the extension's own background worker; compute it from the path as a fallback.
  let extensionId = null;
  if (loadedFrom) {
    const worker =
      context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ??
      (await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null));
    extensionId = worker ? new URL(worker.url()).host : extensionIdFor(loadedFrom);
  }

  return {
    context,
    extensionId,
    async close() {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Waits for an open tab whose address passes `test`, for tabs the browser or extension opened by themselves. */
export async function findPage(context, test, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = context.pages().find((page) => test(page.url()));
    if (found) return found;
    await new Promise((done) => setTimeout(done, 100));
  }
  return null;
}

/** Opens a URL in a new tab and reports what the person would have ended up looking at. */
export async function visit(context, url, { keepOpen = false } = {}) {
  const page = await context.newPage();
  let error = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (e) {
    error = String(e.message).split('\n')[0];
  }
  const finalUrl = page.url();
  const text = error ? '' : await page.locator('body').innerText().catch(() => '');
  const heading = error ? '' : await page.locator('h1').first().innerText().catch(() => '');

  let outcome = 'other';
  if (/^chrome-extension:\/\/[a-p]{32}\/blocked\.html$/.test(finalUrl)) outcome = 'blocked page';
  else if (error?.includes('ERR_BLOCKED_BY_CLIENT')) outcome = 'blocked by browser';
  else if (text.includes('SITE LOADED')) outcome = 'site loaded';

  if (!keepOpen) await page.close();
  return { url, finalUrl, error, text, heading, outcome, page: keepOpen ? page : null };
}
