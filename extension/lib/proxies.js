// Web proxies (1.31.0). A web proxy is a site that fetches another site's pages and shows them under its
// own address, so the rules, which go by the site a request is sent to, never see the site behind it: a
// listed site opened through one loaded. So did a listed site read through a translation or an archive
// service, which carry a page the same way. Three things stop them:
//
//  - The well-known proxy sites are on the built-in list (blocklists/proxies.txt), blocked like any other.
//  - The proxy programs most of those sites run make addresses of a shape nothing else has, whatever site
//    runs them and whatever page is asked for. Rules of their own stop every address of such a shape
//    (SHAPES, proxyRules): npm run build writes them to rules/proxies.json, a ruleset in manifest.json
//    next to the adult-N.json files and safe-search.json. A proxy on an address no list has, a bare IP
//    address say, is stopped by these.
//  - An address that names a listed site inside it is that site's page by another road: the proxy's own
//    coding of it, a translation of it, an archived copy. The rules can't read an address that closely,
//    so the background script does (namedIn, siteAt), for every page a tab opens and every frame inside
//    one, and sends the tab to the block page (background.js "Web proxies").
//
// What is left is in the README's Limits: a proxy that no list has, that runs a program of its own and
// that hides the address it fetches.
import { listedDomain } from './attempts.js';
import { BLOCK_PAGE, PAGE_BLOCK_PRIORITY } from './rules.js';

/**
 * The proxy programs known by the shape of the addresses they make: each a pattern matched against the
 * whole address (a regular expression in RE2 syntax, for Chrome, letter case ignored), with an address it
 * fits. Each was read off a live proxy or off the program's source in November 2026:
 *
 *  - CroxyProxy's program (also behind BlockAway, Proxyium, ProxyPal and many sites on bare IP addresses)
 *    starts a visit at /__cpi.php and marks every address after that with a __cpo parameter, the site
 *    behind it in base64.
 *  - Ultraviolet (most "unblocker" sites) writes the address behind after its own prefix, every second
 *    letter changed: "https://" always comes out as "hvtrs8%2F-" and "http://" as "hvtr%3A-%2F".
 *  - Rammerhead puts a session name of 32 letters and digits first, then the address behind, shuffled by
 *    a key of the session's own and marked "_rhs": the mark tells it, after a name of 16 or more.
 *  - Glype names its script browse.php, with the address behind in u and its settings, a number, in b.
 *  - CGIProxy's script is nph-proxy.cgi, the address behind following it.
 *
 * A pattern is here only if nothing but the proxy makes such addresses: a rule built from it stops every
 * page that fits, whatever site it is on.
 *
 * Chrome takes a pattern only if it compiles small (2 KB), and leaves out a rule whose pattern doesn't,
 * with no more than a warning on its extensions page: a count such as {32} is written out that many times
 * and soon passes that. So the counts here are kept short (MAX_COUNT), well under what Chrome was found to
 * take (28 for Rammerhead's, 11 for Glype's), and the browser tests ask Chrome itself about every pattern.
 */
export const SHAPES = [
  { name: 'CroxyProxy', pattern: '^https?://[^/?#]+/[^?#]*\\?(?:[^#]*&)?__cpo=', example: 'https://203.0.113.7/page?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ' },
  { name: 'CroxyProxy', pattern: '^https?://[^/?#]+/(?:[^?#]*/)?__cpi\\.php(?:[?#]|$)', example: 'https://203.0.113.7/__cpi.php?s=UVNCdFlXUmxM&r=aHR0cHM6Ly9leGFtcGxlLmNvbQ%3D%3D&__cpo=1' },
  { name: 'Ultraviolet', pattern: '^https?://[^/?#]+/(?:[^?#]*/)?hvtr(?:s8%2F-|%3A-%2F)', example: 'https://proxy.example/service/hvtrs8%2F-ezaopne%2Ccmm-' },
  { name: 'Rammerhead', pattern: '^https?://[^/?#]+/[a-z0-9]{16}[^/?#]*/_rhs', example: 'https://proxy.example/0123456789abcdef0123456789abcdef/_rhsQ3c0Xm~fDpbL1u' },
  { name: 'Glype', pattern: '^https?://[^/?#]+/(?:[^?#]*/)?browse\\.php\\?u=[^&#]{6,}&b=[0-9]{1,3}(?:&f=[a-z]+)?(?:#|$)', example: 'https://proxy.example/browse.php?u=Oi8vZXhhbXBsZS5jb20v&b=0&f=norefer' },
  { name: 'CGIProxy', pattern: '^https?://[^/?#]+/(?:[^?#]*/)?nph-proxy\\.(?:cgi|pl)(?:[/?#]|$)', example: 'https://proxy.example/cgi-bin/nph-proxy.cgi/000000A/https/example.com/' },
];

/** The largest count a pattern may hold, as in {16}: see above. */
export const MAX_COUNT = 16;

export const FIRST_ID = 2001; // the adult rulesets count up from 1 and safe search from 1001; these stay out of their way

/**
 * The whole ruleset, in the browsers' declarativeNetRequest form. Two rules for each shape, as for a chunk
 * of listed domains (lib/rules.js buildRules): a page of that shape goes to the "Site blocked" page, and
 * anything else of that shape (a frame, a script, a picture, a fetch) is blocked outright.
 */
export function proxyRules() {
  const rules = [];
  let id = FIRST_ID;
  for (const { pattern } of SHAPES) {
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: BLOCK_PAGE } },
      condition: { regexFilter: pattern, resourceTypes: ['main_frame'] },
    });
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: { regexFilter: pattern, excludedResourceTypes: ['main_frame'] },
    });
  }
  return rules;
}

/**
 * Rules that block a proxy's page outright, for a browser that hasn't given the extension access to
 * websites, where the redirect above is dropped and the page would load (lib/rules.js pageBlockRules has
 * the whole story). The background script keeps them as session rules while access is missing, next to the
 * listed sites' own, their ids beyond those.
 */
export const PROXY_PAGE_BLOCK_FIRST_ID = 2_000_001;

export function proxyPageBlockRules() {
  return SHAPES.map(({ pattern }, index) => ({
    id: PROXY_PAGE_BLOCK_FIRST_ID + index,
    priority: PAGE_BLOCK_PRIORITY,
    action: { type: 'block' },
    condition: { regexFilter: pattern, resourceTypes: ['main_frame'] },
  }));
}

const SHAPE_TESTS = SHAPES.map(({ name, pattern }) => ({ name, test: new RegExp(pattern, 'i') }));

/** The proxy program whose shape an address has, by name, or null: a stand-in for the rules, for the background script and the tests. */
export function shapeOf(url) {
  const address = String(url ?? '');
  return SHAPE_TESTS.find(({ test }) => test.test(address))?.name ?? null;
}

// --- A listed site named inside an address ---------------------------------------------------------------
// An address can carry another address in its path, its query or after its #, as it is or coded. A proxy,
// a translation or an archive service that fetches a page for someone has to be told which, and the address
// is where it is told. What is looked for is an address with its scheme, "https://site…": that is how a
// service is handed a page to fetch, and it is not how a site is mentioned in passing, so a search for
// a site's name, a page about it, or "?next=site.com" are all left alone. A service known to take a site
// without its scheme is listed with where it takes it (CARRIERS).
//
// The codings read, each as a proxy was seen to use it:
//  - percent coding, once or twice over;
//  - base64, plain or the address-safe kind, wherever in the text the address starts, and codings inside
//    it (the address this was written for holds an address in base64 that holds the site in base64);
//  - a site alone, or with "://" before it, in base64 as the whole of a value (Proxyium, Glype);
//  - Ultraviolet's coding, every second letter changed;
//  - rot13 (PHProxy);
//  - the scheme as a part of the path, "/https/site/" (CGIProxy);
//  - the site with dashes for its dots, as the first name of the host (Google Translate, the AMP cache).

const MAX_LENGTH = 200_000; // of an address's path, query and fragment looked through; a longer one is cut there
const MAX_RUN = 20_000; // of a stretch of base64 decoded at a time
const MAX_BARE = 1024; // of a value in base64 that may be a site alone: a name and a path, not a document
const MAX_DEPTH = 3; // codings inside codings followed

// A host name as it stands in an address: letters, digits, dots and dashes (and letters beyond ASCII, for a
// name not yet in its xn-- form), ended by whatever else comes next.
const HOST_CHARS = /^[a-z0-9¡-￼._-]+/i;
// An address with its scheme. One slash is taken too: servers that fold "//" into "/" leave "https:/site".
const ADDRESS = /https?:\/{1,3}([^/?#\s"'<>\\]+)/gi;
// The scheme as a part of the path: /https/site/…
const SCHEME_PART = /(?:^|\/)https?\/((?:[a-z0-9-]+\.)+[a-z0-9-]{2,})(?=[/?#:]|$)/gi;
// A site alone, as the whole of a decoded value: with or without a scheme (Glype leaves "://site", having cut "http" off).
const BARE = /^(?:[a-z][a-z0-9+.-]*:|:)?\/{0,3}((?:[a-z0-9-]+\.)+[a-z0-9-]{2,})(?![a-z0-9.-])/i;
// A site at the start of a path, as the services in CARRIERS take one.
const LEADING_SITE = /^((?:[a-z0-9-]+\.)+[a-z0-9-]{2,})(?![a-z0-9.-])/i;
const BASE64_RUN = /[A-Za-z0-9+/_-]{8,}/g;

// Where an address starts inside a stretch of base64. Base64 writes each three letters as four, so "http"
// comes out in one of three ways, by where its "h" falls among the three: "aHR0c", "h0dH" or "odHRw". A
// stretch that holds one of them is decoded from the start of that group of four; every other stretch (a
// word of a path, a hash, a token) is not decoded at all, which is most of them. The same is worked out
// for "aHR0c" itself and for its own base64, so that base64 inside base64 is followed too.
const WORDS = ['http'];
for (let i = 0; i < MAX_DEPTH - 1; i += 1) WORDS.push(btoa(`${WORDS.at(-1)}\0\0`).slice(0, Math.floor((WORDS.at(-1).length * 8) / 6)));
const SIGNS = new Map(); // the letters to look for -> how far into its group of four the first of them stands
for (const word of WORDS) {
  for (let before = 0; before < 3; before += 1) {
    const from = Math.ceil((before * 8) / 6);
    SIGNS.set(btoa(`${'\0'.repeat(before)}${word}\0\0`).slice(from, Math.floor(((before + word.length) * 8) / 6)), from);
  }
}
const SIGN = new RegExp([...SIGNS.keys()].join('|'), 'g');

// The value of each base64 letter, of either kind, for a look at what a stretch starts with before it is decoded.
const SIX_BITS = new Int8Array(128).fill(-1);
[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((letter, value) => (SIX_BITS[letter.charCodeAt(0)] = value));
SIX_BITS['-'.charCodeAt(0)] = 62;
SIX_BITS['_'.charCodeAt(0)] = 63;
const inAName = (byte) => (byte >= 0x2d && byte <= 0x3a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a); // - . / 0-9 : a-z A-Z

/** Whether a stretch of base64 starts with three letters a site's name, or "://" before one, could start with: the rest is decoded only then. */
function startsLikeAName(piece) {
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => SIX_BITS[piece.charCodeAt(i)]);
  return inAName((a << 2) | (b >> 4)) && inAName(((b & 15) << 4) | (c >> 2)) && inAName(((c & 3) << 6) | d);
}
// Ultraviolet's coding of "https://" or "http://", as written into an address (percent-coded) or decoded.
const XOR_RUN = /hvtr(?:s8(?:%2F|\/)-|(?:%3A|:)-(?:%2F|\/))\S*/gi;
const ROT13 = /uggcf?:\/{1,3}/i;

/** A host name in the form the lists hold: lowercase, no trailing dot, xn-- for letters beyond ASCII; null when it isn't one. */
function listForm(name) {
  let host = name.toLowerCase().replace(/\.+$/, '');
  if (/[^a-z0-9._-]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      return null;
    }
  }
  return host || null;
}

/**
 * The listed site an address's authority (what stands between "https://" and the next slash) names, or
 * null. The host is what follows a "user@", if there is one; but the text around an address inside another
 * can hold an @ of its own ("https://site.com&mail=me@example.org"), so what stands first counts too.
 */
function listedIn(authority, listed) {
  for (const part of new Set([authority, authority.slice(authority.lastIndexOf('@') + 1)])) {
    const name = HOST_CHARS.exec(part)?.[0];
    const site = name ? listedDomain(listForm(name), listed) : null;
    if (site) return site;
  }
  return null;
}

/** Percent coding undone once: properly where the text allows, else one byte at a time. */
function unescaped(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-9a-f]{2})/gi, (whole, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

/** Base64 undone, plain or the address-safe kind, with or without its padding; null when it can't be. Bytes that are no text come out as U+FFFD. */
function fromBase64(run) {
  const clean = run.replace(/-/g, '+').replace(/_/g, '/');
  const whole = clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0));
  let bytes;
  try {
    bytes = atob(whole);
  } catch {
    return null;
  }
  return /[^\x00-\x7f]/.test(bytes) ? new TextDecoder().decode(Uint8Array.from(bytes, (char) => char.charCodeAt(0))) : bytes;
}

/** Ultraviolet's coding undone: percent coding, then every second letter changed back. */
function fromXor(run) {
  const text = unescaped(run);
  let result = '';
  for (let i = 0; i < text.length; i += 1) result += i % 2 ? String.fromCharCode(text.charCodeAt(i) ^ 2) : text[i];
  return result;
}

const fromRot13 = (text) => text.replace(/[a-z]/gi, (letter) => String.fromCharCode(((letter.charCodeAt(0) & 31) + 12) % 26 + 1 + (letter.charCodeAt(0) & ~31)));

/** The listed site a text names as an address with its scheme, or null. */
function plainly(text, listed) {
  if (!/http/i.test(text)) return null;
  for (const match of text.matchAll(ADDRESS)) {
    const site = listedIn(match[1], listed);
    if (site) return site;
  }
  for (const match of text.matchAll(SCHEME_PART)) {
    const site = listedDomain(listForm(match[1]), listed);
    if (site) return site;
  }
  return null;
}

/** The listed site a text names in one of the codings, or null. */
function coded(text, listed, depth) {
  for (const [run] of text.matchAll(XOR_RUN)) {
    const site = plainly(fromXor(run.slice(0, MAX_RUN)), listed);
    if (site) return site;
  }
  if (ROT13.test(text)) {
    const site = plainly(fromRot13(text), listed);
    if (site) return site;
  }
  for (const [run] of text.matchAll(BASE64_RUN)) {
    // An address somewhere in the stretch (see SIGNS). A slash can be a letter of plain base64 or the end
    // of a piece of the address-safe kind that is one part of a path, so the stretch is decoded both to
    // its end and to the next slash.
    for (const sign of run.matchAll(SIGN)) {
      const start = sign.index - SIGNS.get(sign[0]);
      if (start < 0) continue;
      const slash = run.indexOf('/', sign.index);
      for (const piece of slash < 0 ? [run.slice(start, start + MAX_RUN)] : [run.slice(start, start + MAX_RUN), run.slice(start, slash)]) {
        const decoded = fromBase64(piece);
        const site = decoded ? within(decoded, listed, depth + 1) : null;
        if (site) return site;
      }
    }
    // A site alone, as the whole of a value or of one part of a path.
    for (const piece of run.includes('/') ? run.split('/') : [run]) {
      if (piece.length < 8 || piece.length > MAX_BARE || !startsLikeAName(piece)) continue;
      const site = listedDomain(listForm(BARE.exec(fromBase64(piece)?.trim() ?? '')?.[1] ?? ''), listed);
      if (site) return site;
    }
  }
  return null;
}

/** The listed site a text names, as it is or in a coding, or null. */
function within(text, listed, depth) {
  if (text.length < 8) return null;
  const texts = [text];
  for (let last = text; texts.length < 3 && last.includes('%'); ) {
    const decoded = unescaped(last);
    if (decoded === last) break;
    texts.push(decoded);
    last = decoded;
  }
  for (const one of texts) {
    const site = plainly(one, listed);
    if (site) return site;
  }
  if (depth >= MAX_DEPTH) return null;
  for (const one of texts) {
    const site = coded(one, listed, depth);
    if (site) return site;
  }
  return null;
}

// Hosts that carry the site in their own first name, a dash for each dot and two for a dash:
// exampleadultsite-com.translate.goog is Google Translate's copy of exampleadultsite.com.
const DASHED = [/^([a-z0-9-]+)\.translate\.goog$/, /^([a-z0-9-]+)\.cdn\.ampproject\.org$/];

function dashed(host, listed) {
  for (const pattern of DASHED) {
    const name = pattern.exec(host)?.[1];
    if (!name) continue;
    const site = listedDomain(name.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-'), listed);
    if (site) return site;
  }
  return null;
}

/**
 * The services known to fetch a site named without its scheme, each with where it takes the name: a part
 * of the path (`path`, a pattern whose first group is what follows) or a parameter (`params`). With its
 * scheme a site is found at any service, listed here or not.
 */
export const CARRIERS = [
  // The Wayback Machine: /web/<when>/<site>, /web/<site>, /save/<site>.
  { name: 'Wayback Machine', host: /^(?:[a-z0-9-]+\.)?archive\.org$/, path: /^\/(?:web|save)\/(?:[0-9*]{1,14}[a-z_]{0,4}\/)?(.+)$/i, example: 'https://web.archive.org/web/2020/example.com/' },
  // archive.today under its names: /<site>, /newest/<site>, /<when>/<site>, and its form's ?url=<site>.
  { name: 'archive.today', host: /^archive\.(?:today|ph|is|li|vn|fo|md)$/, path: /^\/(?:(?:newest|oldest|[0-9]{4,14}|\*)\/)?(.+)$/i, params: ['url', 'q'], example: 'https://archive.ph/newest/example.com' },
  // Google Translate's page for a whole site, and Google's AMP viewer.
  { name: 'Google Translate', host: /^translate\.google\.[a-z.]{2,6}$/, params: ['u'], example: 'https://translate.google.com/translate?sl=auto&tl=en&u=example.com' },
  { name: 'Google AMP', host: /^(?:www\.)?google\.[a-z.]{2,6}$/, path: /^\/amp\/(?:s\/)?(.+)$/i, example: 'https://www.google.com/amp/s/example.com/page' },
  { name: 'AMP cache', host: /\.cdn\.ampproject\.org$/, path: /^\/[a-z]{1,3}\/(?:s\/)?(.+)$/i, example: 'https://example-com.cdn.ampproject.org/c/s/example.com/page' },
  // Yandex Translate, and the host its translated pages are served from.
  { name: 'Yandex Translate', host: /^translate\.yandex\.[a-z.]{2,6}$/, params: ['url'], example: 'https://translate.yandex.com/translate?url=example.com&lang=en-ru' },
  { name: 'Yandex Translate', host: /^translated\.turbopages\.org$/, path: /^\/proxy_u\/[^/]+\/(?:https?\/)?(.+)$/i, example: 'https://translated.turbopages.org/proxy_u/en-ru.en.0a1b2c3d-4e5f/example.com/' },
];

function carried(host, address, listed) {
  for (const { host: pattern, path, params } of CARRIERS) {
    if (!pattern.test(host)) continue;
    const named = [path?.exec(address.pathname)?.[1], ...(params ?? []).map((name) => address.searchParams.get(name))];
    for (const text of named) {
      const site = text ? listedDomain(listForm(LEADING_SITE.exec(unescaped(text).trim())?.[1] ?? ''), listed) : null;
      if (site) return site;
    }
  }
  return null;
}

/** namedIn's work, for an address already read: `host` its host in the lists' form. */
function named(address, host, listed) {
  return dashed(host, listed) ?? carried(host, address, listed) ?? within(`${address.pathname}${address.search}${address.hash}`.slice(0, MAX_LENGTH), listed, 0);
}

/** A web address read, with its host in the lists' form (lib/attempts.js hostOf has the same form); null for anything but http(s). */
function webAddress(url) {
  let address;
  try {
    address = new URL(url);
  } catch {
    return null;
  }
  if (address.protocol !== 'http:' && address.protocol !== 'https:') return null;
  const host = address.hostname.toLowerCase().replace(/\.$/, '');
  return host ? { address, host } : null;
}

/**
 * The listed site an address names other than as its own host, or null: see "A listed site named inside
 * an address" above. `listed` is the lists as a Set of domains (background.js listedDomains).
 */
export function namedIn(url, listed) {
  const read = webAddress(url);
  return read ? named(read.address, read.host, listed) : null;
}

/**
 * What an address is to the lists, or null when it is nothing to them:
 *   { site }               a listed site's own page, `site` the listed domain;
 *   { site, via }          a listed site's page by another road: `via` is the host that carries it;
 *   { site, proxy: true }  a proxy's page, known by its shape, for a site no list has: `site` is the proxy's host.
 * Only web pages count (http and https).
 */
export function siteAt(url, listed) {
  const read = webAddress(url);
  if (!read) return null;
  const own = listedDomain(read.host, listed);
  if (own) return { site: own };
  const site = named(read.address, read.host, listed);
  if (site) return { site, via: read.host };
  return shapeOf(url) ? { site: read.host, proxy: true } : null;
}

/** Whether what siteAt found is a page by another road, which the background script has to stop itself: the rules know only a site's own pages and a proxy's shape. */
export const byAnotherRoad = (found) => Boolean(found && (found.via || found.proxy));
