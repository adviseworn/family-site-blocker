// Run with: npm test
// Web proxies (1.31.0): the rules for the shape of a proxy's addresses, the listed site named inside an
// address, and the road a try took in the record. What a real browser does with them is in the browser
// suites (test/browser.e2e.mjs, test/firefox.e2e.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LABELS, bookmarksTo, mergeVisits, record, roadWords, toCsv } from '../extension/lib/attempts.js';
import { parseDomainList } from '../extension/lib/domains.js';
import { CARRIERS, FIRST_ID, MAX_COUNT, PROXY_PAGE_BLOCK_FIRST_ID, SHAPES, byAnotherRoad, namedIn, proxyPageBlockRules, proxyRules, shapeOf, siteAt } from '../extension/lib/proxies.js';
import { BEDTIME_FIRST_ID, BLOCK_PAGE, PAGE_BLOCK_FIRST_ID, PAGE_BLOCK_PRIORITY, isBedtimeRule } from '../extension/lib/rules.js';
import { FIRST_ID as SAFE_SEARCH_FIRST_ID, safeSearchRules } from '../extension/lib/safesearch.js';
import { BLOCKLIST_DIR, DOMAINS_PATH, MANIFEST_PATH, PROXIES_PATH, loadNever, loadRules, renderProxies } from '../scripts/build-rules.mjs';

const SITE = 'exampleadultsite.com';
const LISTED = new Set([SITE, 'my-site.example', 'xn--bcher-kva.example']);

// The address this was written for, as it was reported but for its s, which the proxy makes for one visit
// (a made-up one of the same shape stands in): a proxy on a bare IP address, with the site behind it two
// codings deep (r is an address in base64 whose __cpo is the site in base64).
const REPORTED =
  'https://208.87.240.203/__cpi.php?s=UVNCdFlXUmxMWFZ3SUhSdmEyVnVJRzltSUhSb1pTQnphR0Z3WlNCMGFHVWdjSEp2ZUhrZ1oybDJaWE1nYjI1bElIWnBjMmwwT2lCdWIzUm9hVzVuSUc5bUlHRWdjbVZoYkNCMmFYTnBkQzQ9&r=aHR0cHM6Ly8yMDguODcuMjQwLjIwMy8%2FX19jcG89YUhSMGNITTZMeTlsZUdGdGNHeGxZV1IxYkhSemFYUmxMbU52YlE%3D&__cpo=1';
// Where the proxy sends the browser next: the page itself, the site in __cpo.
const REPORTED_PAGE = 'https://208.87.240.203/?__cpo=aHR0cHM6Ly9leGFtcGxlYWR1bHRzaXRlLmNvbQ';

const base64 = (text) => Buffer.from(text).toString('base64');
const base64url = (text) => Buffer.from(text).toString('base64url');
// Ultraviolet's coding, as its source has it (src/rewrite/codecs.js, xor): every second letter changed, then percent-coded.
const ultraviolet = (text) => encodeURIComponent([...text].map((char, i) => (i % 2 ? String.fromCharCode(char.charCodeAt(0) ^ 2) : char)).join(''));
const rot13 = (text) => text.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) & 31) + 12) % 26 + 1 + (c.charCodeAt(0) & ~31)));

// A stand-in for the browser's matcher, for the proxies' ruleset: regexFilter is matched against the whole
// address, letter case ignored (both browsers' default). It checks the structure of the rules; the browser
// suites check them in the real thing.
function outcome(rules, url, type = 'main_frame') {
  for (const rule of rules) {
    const { regexFilter, resourceTypes, excludedResourceTypes } = rule.condition;
    if (resourceTypes && !resourceTypes.includes(type)) continue;
    if (excludedResourceTypes?.includes(type)) continue;
    if (new RegExp(regexFilter, 'i').test(url)) return rule.action.type;
  }
  return 'allow';
}

test('the reported address: a proxy on a bare IP address with the listed site coded inside is known for both', () => {
  // The decoding, spelled out: this is what the address holds.
  const r = new URL(REPORTED).searchParams.get('r');
  const inner = Buffer.from(r, 'base64').toString();
  assert.equal(inner, 'https://208.87.240.203/?__cpo=aHR0cHM6Ly9leGFtcGxlYWR1bHRzaXRlLmNvbQ');
  assert.equal(Buffer.from(new URL(inner).searchParams.get('__cpo'), 'base64').toString(), `https://${SITE}`);

  for (const url of [REPORTED, REPORTED_PAGE]) {
    assert.equal(shapeOf(url), 'CroxyProxy', url);
    assert.equal(outcome(proxyRules(), url), 'redirect', 'the rules send the page to the block page');
    assert.equal(namedIn(url, LISTED), SITE);
    assert.deepEqual(siteAt(url, LISTED), { site: SITE, via: '208.87.240.203' });
  }
  // With the built-in list as it ships, too.
  const builtIn = new Set(JSON.parse(readFileSync(DOMAINS_PATH, 'utf8')));
  assert.deepEqual(siteAt(REPORTED, builtIn), { site: SITE, via: '208.87.240.203' });
});

test("the proxies' ruleset: two rules a shape, a page to the block page and everything else blocked; rules/proxies.json and the manifest are up to date", () => {
  const rules = proxyRules();
  assert.deepEqual(readFileSync(PROXIES_PATH, 'utf8'), renderProxies(), 'rules/proxies.json is up to date (run npm run build)');
  assert.deepEqual(loadRules().filter((rule) => rule.id >= FIRST_ID), rules, 'the manifest loads exactly these');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.deepEqual(manifest.declarative_net_request.rule_resources.at(-1), { id: 'proxies', enabled: true, path: 'rules/proxies.json' });

  assert.equal(rules.length, SHAPES.length * 2);
  assert.deepEqual(rules.map((rule) => rule.id), rules.map((_, i) => FIRST_ID + i), 'ids count up from FIRST_ID');
  assert.ok(FIRST_ID > SAFE_SEARCH_FIRST_ID + safeSearchRules().length, 'clear of the safe-search rules');
  assert.ok(rules.at(-1).id < BEDTIME_FIRST_ID, 'and of the dynamic and session rules');
  SHAPES.forEach((shape, i) => {
    const [page, rest] = rules.slice(i * 2, i * 2 + 2);
    assert.deepEqual(page.action, { type: 'redirect', redirect: { extensionPath: BLOCK_PAGE } });
    assert.deepEqual(page.condition, { regexFilter: shape.pattern, resourceTypes: ['main_frame'] });
    assert.deepEqual(rest.action, { type: 'block' });
    assert.deepEqual(rest.condition, { regexFilter: shape.pattern, excludedResourceTypes: ['main_frame'] });
    assert.equal(page.priority, 1);
    assert.equal(rest.priority, 1);
    // What Chrome's matcher (RE2) takes, as for the safe-search rules.
    assert.doesNotMatch(shape.pattern, /\(\?[=!<]|\\[1-9]/, `${shape.name}: no lookaround or backreference, which RE2 (Chrome) refuses`);
    // Chrome also wants a pattern to compile small, and writes a count such as {32} out that many times: one
    // that doesn't is left out of the ruleset with no error (so was Rammerhead's, with {32}, before 1.31.0
    // shipped). The browser tests ask Chrome about each pattern; here the counts are kept short.
    assert.ok(shape.pattern.length < 200, 'a short pattern');
    for (const [count, least, most = least] of shape.pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
      assert.ok(Number(least) <= MAX_COUNT && Number(most || least) <= MAX_COUNT, `${shape.name}: ${count} is written out that many times, more than Chrome may take`);
    }
    assert.ok([...shape.pattern].every((c) => c.charCodeAt(0) < 128), 'ASCII only');
    assert.ok(shape.pattern.startsWith('^https?://[^/?#]+/'), `${shape.name}: any host, and nothing but web pages`);
    assert.match(shape.example, new RegExp(shape.pattern, 'i'), `${shape.name}: its example fits`);
    assert.equal(shapeOf(shape.example), shape.name);
    assert.equal(outcome(rules, shape.example), 'redirect');
    for (const type of ['sub_frame', 'script', 'image', 'xmlhttprequest', 'media', 'other']) assert.equal(outcome(rules, shape.example, type), 'block', `${shape.name}: ${type}`);
  });
});

test('without access to websites a rule blocks each shape of page outright, ahead of its redirect', () => {
  const rules = proxyPageBlockRules();
  assert.equal(rules.length, SHAPES.length);
  rules.forEach((rule, i) => {
    assert.equal(rule.id, PROXY_PAGE_BLOCK_FIRST_ID + i);
    assert.deepEqual(rule.action, { type: 'block' });
    assert.deepEqual(rule.condition, { regexFilter: SHAPES[i].pattern, resourceTypes: ['main_frame'] });
    assert.equal(rule.priority, PAGE_BLOCK_PRIORITY);
    assert.ok(rule.priority > proxyRules()[0].priority, 'picked before the redirect, which the browser would drop');
    assert.ok(!isBedtimeRule(rule), "not taken for one of bedtime's");
  });
  // background.js syncAccess takes off every session rule from PAGE_BLOCK_FIRST_ID up: these are among them,
  // and beyond any id the listed sites' own page-blocking rules can reach (129 of them for 64,000 sites).
  assert.ok(PROXY_PAGE_BLOCK_FIRST_ID > PAGE_BLOCK_FIRST_ID + 100_000);
});

test('shapes: addresses the proxy programs make, on any host, are known; ordinary addresses that look a little like them are not', () => {
  const xored = ultraviolet('https://www.google.com/');
  assert.equal(xored, 'hvtrs8%2F-wuw%2Cgmoelg.aoo%2F', "Ultraviolet's coding, as its own tests have it");
  for (const [url, name] of [
    // CroxyProxy: as reported, as seen at Proxyium (a bare IP address) and ProxyPal, and deeper in a site.
    [REPORTED, 'CroxyProxy'],
    [REPORTED_PAGE, 'CroxyProxy'],
    ['https://195.3.220.74/__cpi.php?s=x&r=ZXhhbXBsZS5jb20%3D&__cpo=1', 'CroxyProxy'],
    ['https://azureserv.com/__cpi.php?s=x&r=aHR0cHM6Ly9leGFtcGxlLmNvbQ%3D%3D&__cpo=1', 'CroxyProxy'],
    ['http://203.0.113.7:8080/watch/video.mp4?quality=hd&__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ', 'CroxyProxy'],
    ['https://203.0.113.7/a/b?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ&x=1#top', 'CroxyProxy'],
    ['https://PROXY.example/?__CPO=aHR0cHM6Ly9leGFtcGxlLmNvbQ', 'CroxyProxy'],
    // Ultraviolet: under its own prefix, an older one, a made-up one, and an http site behind it.
    [`https://proxy.example/service/${xored}`, 'Ultraviolet'],
    [`https://proxy.example/uv/service/${ultraviolet('https://example.com/a?b=c#d')}`, 'Ultraviolet'],
    [`https://proxy.example/~/x/${ultraviolet('http://example.com/')}`, 'Ultraviolet'],
    [`https://proxy.example/${xored.toLowerCase()}`, 'Ultraviolet'],
    // Rammerhead: the session's name, then the shuffled address; with the marks it adds for a frame.
    ['https://proxy.example/0123456789abcdef0123456789abcdef/_rhsQ3c0Xm~fDpbL1u', 'Rammerhead'],
    ['https://proxy.example/0123456789abcdef0123456789abcdef!i/_rhsQ3c0Xm~fDpbL1u', 'Rammerhead'],
    ['http://203.0.113.7:8080/0123456789ABCDEF0123456789abcdef*1700000000000!f!utf-8/_rhsQ3c0Xm', 'Rammerhead'],
    // Glype: as seen at GenMirror, and in a folder.
    ['https://www.genmirror.com/browse.php?u=K7Zw9Qp1xY%2BJm3Lr8vT2bA%3D%3D&b=0&f=norefer', 'Glype'],
    ['http://proxy.example/glype/browse.php?u=Oi8vZXhhbXBsZS5jb20v&b=28#top', 'Glype'],
    // CGIProxy.
    ['https://proxy.example/cgi-bin/nph-proxy.cgi/000000A/https/example.com/', 'CGIProxy'],
    ['https://proxy.example/nph-proxy.pl', 'CGIProxy'],
  ]) {
    assert.equal(shapeOf(url), name, url);
    assert.equal(outcome(proxyRules(), url), 'redirect', url);
    assert.equal(outcome(proxyRules(), url, 'sub_frame'), 'block', url);
  }
  for (const url of [
    'https://example.com/',
    'https://example.com/?cpo=1&x__cpo=2',
    'https://example.com/page?a=__cpo',
    'https://example.com/#?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ',
    'https://example.com/__cpi.phps',
    'https://example.com/docs/__cpi.php.txt',
    'https://example.com/?file=/__cpi.php',
    'https://example.com/hvtr',
    'https://example.com/search?q=hvtrs8%2F-',
    'https://example.com/0123456789abcdef0123456789abcdef/photo.jpg',
    'https://example.com/0123456789abcdef0123456789abcdef/https://cdn.example.com/photo.jpg',
    'https://example.com/0123456789abcde/_rhs',
    'https://example.com/photos/_rhs.jpg',
    'https://example.com/0123456789abcdef0123456789abcdef/x/_rhsQ3c0Xm',
    'https://example.com/browse.php',
    'https://example.com/browse.php?u=12&b=1',
    'https://example.com/browse.php?u=someone-else&b=1&page=2',
    'https://example.com/browse.php?category=books&u=aaaaaaaaaaaa&b=1',
    'https://example.com/mybrowse.php?u=aaaaaaaaaaaa&b=1',
    'https://example.com/nph-proxy.cgi.html',
    'https://example.com/?q=nph-proxy.cgi',
    'https://github.com/scramjetorg/scramjet/blob/main/README.md',
    'ftp://203.0.113.7/?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ',
    `chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html#${REPORTED_PAGE}`,
    '',
    null,
  ]) {
    assert.equal(shapeOf(url), null, String(url));
    if (url) assert.equal(outcome(proxyRules(), url), 'allow', url);
  }
});

test('a listed site named inside an address is found in every coding the proxies use', () => {
  const page = `https://${SITE}/watch?v=1&t=2`;
  for (const [url, why] of [
    // As it is, percent-coded, and percent-coded twice.
    [`https://proxy.example/fetch?url=https://${SITE}/`, 'as it is'],
    [`https://proxy.example/fetch?url=${encodeURIComponent(page)}`, 'percent-coded'],
    [`https://proxy.example/fetch?url=${encodeURIComponent(encodeURIComponent(page))}`, 'percent-coded twice'],
    [`https://proxy.example/scramjet/${encodeURIComponent(page)}`, 'Scramjet: percent-coded, in the path'],
    [`https://proxy.example/main/https://www.${SITE}/`, 'in the path'],
    [`https://proxy.example/proxy/http:/${SITE}/`, 'one slash left of two'],
    [`https://proxy.example/#https://${SITE}/`, 'after the #'],
    [`https://proxy.example/go?to=HTTPS://WWW.EXAMPLEADULTSITE.COM/`, 'upper case'],
    [`https://proxy.example/go?to=https://${SITE}.:8443/x`, 'a trailing dot and a port'],
    [`https://proxy.example/go?to=https://user:pw@${SITE}/x`, 'a user name and password'],
    [`https://proxy.example/go?to=https://${SITE}&mail=me@example.org`, 'an @ further along'],
    [`https://proxy.example/go?to=https%3A%2F%2Fa.b.c.${SITE}%2F`, 'a subdomain'],
    ['https://proxy.example/go?to=https://my-site.example/', 'a site with a dash'],
    ['https://proxy.example/go?to=https://b%C3%BCcher.example/', 'a site with letters beyond ASCII, listed in its xn-- form'],
    ['https://proxy.example/go?to=https://xn--bcher-kva.example/', 'the same in its xn-- form'],
    // Base64, plain and address-safe, wherever it starts, and inside other codings.
    [`https://proxy.example/go/${base64url(page)}`, 'base64 in the path'],
    [`https://proxy.example/go?u=${encodeURIComponent(base64(page))}`, 'base64 in the query'],
    [`https://proxy.example/go?u=${base64(`https://${SITE}/a??`)}`, 'plain base64 with a slash in it, not percent-coded'],
    [`https://proxy.example/go/${base64(encodeURIComponent(page))}`, "Ultraviolet's base64 coding: percent-coded, then base64"],
    [`https://proxy.example/a/b/c/${base64url(page)}/more/path`, 'base64 between other parts of a path'],
    [`https://proxy.example/x${base64url(page)}`, 'base64 after another letter'],
    [`https://proxy.example/xy${base64url(page)}`, 'after two'],
    [`https://proxy.example/xyz${base64url(page)}`, 'after three'],
    [`https://proxy.example/go?u=${base64(base64(page))}`, 'base64 of base64'],
    [`https://proxy.example/go?data=${base64(JSON.stringify({ target: page }))}`, 'base64 of some JSON that holds it'],
    [`https://195.3.220.74/__cpi.php?s=x&r=${encodeURIComponent(base64(SITE))}&__cpo=1`, 'Proxyium: the site alone, in base64'],
    [`https://proxy.example/go?r=${base64url(`www.${SITE}/page`)}`, 'the site and a path, in base64'],
    [`https://proxy.example/browse.php?u=${encodeURIComponent(base64(`://${SITE}/`))}&b=0`, 'Glype: "http" cut off, in base64'],
    [`https://proxy.example/browse.php?u=${encodeURIComponent(base64(`s://${SITE}/`))}&b=0`, 'Glype, for an https site'],
    // The reported address and its next step are in the test above.
    // Ultraviolet.
    [`https://proxy.example/service/${ultraviolet(page)}`, "Ultraviolet's coding"],
    [`https://proxy.example/service/${ultraviolet('https://my-site.example/')}`, "Ultraviolet's coding of a dash, which comes out as a slash"],
    [`https://proxy.example/service/${ultraviolet(`http://www.${SITE}/`)}?x=1`, "Ultraviolet's coding of an http address"],
    [`https://proxy.example/go?to=${encodeURIComponent(`/service/${ultraviolet(page)}`)}`, "Ultraviolet's coding, percent-coded again"],
    // rot13 and the scheme as a part of the path.
    [`https://proxy.example/index.php?q=${rot13(`https://${SITE}/`)}&hl=3e5`, 'rot13'],
    [`https://proxy.example/cgi-bin/nph-proxy.cgi/000000A/https/${SITE}/`, 'CGIProxy: /https/site/'],
    [`https://proxy.example/x/http/www.${SITE}`, '/http/site at the end'],
  ]) {
    assert.equal(namedIn(url, LISTED) && (namedIn(url, LISTED) === SITE || LISTED.has(namedIn(url, LISTED))), true, `${why}: ${url}`);
    assert.equal(siteAt(url, LISTED).via, new URL(url).hostname, why);
  }
  assert.equal(namedIn(`https://proxy.example/go?to=https%3A%2F%2Fa.b.c.${SITE}%2F`, LISTED), SITE, 'the listed domain, not the subdomain');
  assert.equal(namedIn('https://proxy.example/go?to=https://b%C3%BCcher.example/', LISTED), 'xn--bcher-kva.example');
});

test('translations and archives of a listed site are found, with or without the scheme', () => {
  for (const url of [
    // Google Translate: the site in the host, a dash for each dot; and its page that takes a whole site.
    `https://exampleadultsite-com.translate.goog/?_x_tr_sl=auto&_x_tr_tl=en`,
    'https://www-exampleadultsite-com.translate.goog/page?_x_tr_sl=auto&_x_tr_tl=en',
    'https://my--site-example.translate.goog/',
    `https://translate.google.com/translate?sl=auto&tl=en&u=${SITE}`,
    `https://translate.google.co.uk/translate?sl=auto&tl=en&u=https://${SITE}/`,
    // The AMP cache and viewer.
    `https://exampleadultsite-com.cdn.ampproject.org/c/s/${SITE}/page`,
    `https://other-example.cdn.ampproject.org/c/s/${SITE}/page`,
    `https://www.google.com/amp/s/${SITE}/page`,
    // Yandex Translate.
    `https://translate.yandex.com/translate?url=${SITE}&lang=en-ru`,
    `https://translated.turbopages.org/proxy_u/en-ru.en.0a1b2c3d-4e5f/${SITE}/page`,
    `https://translated.turbopages.org/proxy_u/en-ru.en.0a1b2c3d-4e5f/https/${SITE}/page`,
    // The Wayback Machine.
    `https://web.archive.org/web/2020/${SITE}/`,
    `https://web.archive.org/web/20200101000000/https://${SITE}/`,
    `https://web.archive.org/web/20200101000000if_/http://www.${SITE}/page`,
    `https://web.archive.org/web/*/${SITE}*`,
    `https://web.archive.org/web/${SITE}`,
    `https://web.archive.org/save/${SITE}/page`,
    `https://archive.org/web/2020/${SITE}`,
    // archive.today under its names.
    `https://archive.ph/${SITE}`,
    `https://archive.ph/newest/${SITE}/page`,
    `https://archive.today/20200101/${SITE}`,
    `https://archive.is/?run=1&url=${SITE}`,
    `https://archive.md/https://${SITE}/`,
  ]) {
    assert.ok(namedIn(url, LISTED), url);
    assert.deepEqual(siteAt(url, LISTED), { site: namedIn(url, LISTED), via: new URL(url).hostname }, url);
  }
  // The same services with a site no list has, and their own pages, are left alone.
  for (const url of [
    'https://example-com.translate.goog/',
    'https://translate.google.com/translate?sl=auto&tl=en&u=example.com',
    'https://translate.google.com/?sl=en&tl=fr&text=exampleadultsite.com&op=translate',
    'https://web.archive.org/web/2020/https://example.com/',
    'https://web.archive.org/',
    `https://archive.org/details/${SITE}`,
    `https://archive.org/search?query=${SITE}`,
    'https://archive.ph/AbCdE',
    'https://archive.ph/faq',
    'https://www.google.com/amp/s/example.com/page',
  ]) {
    assert.equal(siteAt(url, LISTED), null, url);
  }
  // Each service's own example names a site, and is found once that site is listed.
  for (const carrier of CARRIERS) {
    assert.equal(namedIn(carrier.example, new Set(['example.com'])), 'example.com', carrier.name);
    assert.equal(namedIn(carrier.example, LISTED), null, `${carrier.name}: nothing listed in it`);
  }
});

test('a site merely mentioned, a look-alike, and an ordinary address with a long coded part are left alone', () => {
  for (const url of [
    // Mentions without a scheme: a search, a page about the site, a parameter.
    `https://example.com/?next=${SITE}`,
    `https://example.com/${SITE}`,
    `https://www.google.com/search?q=${SITE}`,
    `https://www.google.com/search?q=is+${SITE}+safe`,
    `https://en.wikipedia.org/wiki/${SITE}`,
    `https://example.com/whois/${SITE}`,
    `https://example.com/report?domain=${SITE}&reason=adult`,
    `https://example.com/#${SITE}`,
    `mailto:someone@${SITE}`,
    // Look-alikes, with their scheme.
    `https://example.com/?u=https://${SITE}.example.org/`,
    `https://example.com/?u=https://not${SITE}/`,
    'https://example.com/?u=https://exampleadultsite.co/',
    'https://example.com/?u=https://exampleadultsite.community/',
    `https://example.com/?u=https://example.org/${SITE}`,
    `https://example.com/?u=https://example.org/?x=${SITE}`,
    `https://example.com/?u=${base64('https://example.org/')}`,
    `https://example.com/?u=${base64(`not${SITE}`)}`,
    `https://example.com/?u=${base64(`https://${SITE}.example.org/`)}`,
    // Ordinary addresses with long stretches of letters, tokens and hashes.
    'https://example.com/questions/12345678/how-do-i-centre-a-div-in-css-without-flexbox',
    'https://example.com/auth?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIiwic3ViIjoiMSJ9.c2lnbmF0dXJl',
    'https://example.com/recaptcha/api2/anchor?k=6Lc&co=aHR0cHM6Ly9leGFtcGxlLmNvbTo0NDM.&v=x',
    'https://example.com/d41d8cd98f00b204e9800998ecf8427e/file.bin',
    'https://example.com/',
    'https://example.com',
  ]) {
    assert.equal(siteAt(url, LISTED), null, url);
  }
  // A proxy's page for a site no list has names nothing, though its shape gives it away (the test above).
  assert.equal(namedIn(`https://example.com/service/${ultraviolet('https://example.org/')}`, LISTED), null);
  // Anything but a web page is nothing to the lists, whatever it names.
  for (const url of [`chrome-extension://abc/blocked.html#https://${SITE}/`, `moz-extension://abc/bedtime.html#https://${SITE}/`, `view-source:https://${SITE}/`, 'about:blank', `data:text/html,https://${SITE}/`, '', null, undefined, 'not an address']) {
    assert.equal(siteAt(url, LISTED), null, String(url));
    assert.equal(namedIn(url, LISTED), null, String(url));
  }
});

test('siteAt says what an address is to the lists: a listed site, one by another road, a proxy, or nothing', () => {
  assert.deepEqual(siteAt(`https://www.${SITE}./page`, LISTED), { site: SITE }, "the site's own page");
  assert.deepEqual(siteAt(`https://www.${SITE}/go?to=https://my-site.example/`, LISTED), { site: SITE }, "a listed site's own page, whatever it names");
  assert.deepEqual(siteAt(REPORTED_PAGE, LISTED), { site: SITE, via: '208.87.240.203' }, 'a listed site through a proxy: the site, and the host that carries it');
  assert.deepEqual(siteAt(`https://web.archive.org/web/2020/${SITE}/`, LISTED), { site: SITE, via: 'web.archive.org' });
  assert.deepEqual(siteAt('https://203.0.113.7/page?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ', LISTED), { site: '203.0.113.7', proxy: true }, "a proxy's page for a site no list has: the proxy's own host");
  assert.deepEqual(siteAt('https://Proxy.Example./browse.php?u=K7Zw9Qp1xYJm3Lr8vT2bA&b=0', LISTED), { site: 'proxy.example', proxy: true }, 'a proxy that hides the site behind it');
  assert.equal(siteAt('https://example.com/', LISTED), null);

  assert.equal(byAnotherRoad({ site: SITE }), false, "a listed site's own page is the rules' to stop");
  assert.equal(byAnotherRoad({ site: SITE, via: 'web.archive.org' }), true);
  assert.equal(byAnotherRoad({ site: '203.0.113.7', proxy: true }), true);
  assert.equal(byAnotherRoad(null), false);
});

test('a very long address, or one made to be slow, is looked through quickly; ten thousand ordinary ones take well under a second', () => {
  const long = `https://proxy.example/?pad=${'A1b2C3d4'.repeat(20_000)}&u=https://${SITE}/`;
  let started = performance.now();
  assert.equal(namedIn(long, LISTED), SITE, 'found after 160,000 letters of padding');
  assert.ok(performance.now() - started < 2000, `a long address took ${Math.round(performance.now() - started)} ms`);

  // Base64 of base64 of base64 of base64: a coding deeper than is followed, and all of it valid at each step.
  let nested = `https://${SITE}/`;
  for (let i = 0; i < 6; i += 1) nested = base64(nested);
  started = performance.now();
  assert.equal(namedIn(`https://proxy.example/?u=${nested}`, LISTED), null, 'six codings deep is deeper than any proxy goes, and is not followed');
  assert.equal(namedIn(`https://proxy.example/?u=${base64(base64(base64(`https://${SITE}/`)))}`, LISTED), SITE, 'three deep is');
  assert.ok(performance.now() - started < 1000);

  const ordinary = Array.from({ length: 10_000 }, (_, i) => `https://www.example${i % 50}.com/articles/2026/11/${i}/a-long-headline-about-nothing-in-particular?utm_source=newsletter&utm_campaign=c${i}&id=${base64url(`article-${i}-of-many`)}#section-${i}`);
  started = performance.now();
  for (const url of ordinary) assert.equal(siteAt(url, LISTED), null);
  const took = performance.now() - started;
  assert.ok(took < 3000, `10,000 ordinary addresses took ${Math.round(took)} ms`);
});

test("the record keeps the road a try took, and the pages' words and the saved file say it", () => {
  const at = Date.UTC(2026, 10, 13, 18, 5);
  // A try through a proxy at a listed site, a try at a proxy's page for a site no list has, and a plain one.
  let list = record([], { at, ...siteAt(REPORTED, LISTED) });
  assert.deepEqual(list, [{ at, site: SITE, via: '208.87.240.203' }]);
  assert.equal(record(list, { at: at + 300, ...siteAt(REPORTED_PAGE, LISTED) }), null, 'the proxy sending the browser on is the same try');
  list = record(list, { at: at + 5000, ...siteAt('https://203.0.113.7/page?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ', LISTED) });
  list = record(list, { at: at + 10_000, site: SITE });
  assert.deepEqual(list.slice(1), [{ at: at + 5000, site: '203.0.113.7', proxy: true }, { at: at + 10_000, site: SITE }]);
  assert.deepEqual(list.map(roadWords), [', through 208.87.240.203', ', a web proxy', '']);
  assert.equal(roadWords(null), '');

  // A page that loaded after all marks its try, road and all; with no try noted, it is noted with its road.
  const opened = record(list.slice(0, 1), { at: at + 900, site: SITE, via: '208.87.240.203', opened: true });
  assert.deepEqual(opened, [{ at, site: SITE, via: '208.87.240.203', opened: true }]);
  assert.deepEqual(record([], { at, site: SITE, via: 'web.archive.org', opened: true }), [{ at, site: SITE, via: 'web.archive.org', opened: true }]);
  // Only what a road is made of is kept.
  assert.deepEqual(record([], { at, site: SITE, via: '', proxy: false, url: 'https://x.example/', extra: 1 }), [{ at, site: SITE }]);
  assert.deepEqual(record([], { at, site: SITE, via: 42 }), [{ at, site: SITE }]);

  // Visits found in the history keep their road too.
  const merged = mergeVisits([], [{ at, site: SITE, via: 'web.archive.org' }, { at: at + 60_000, site: '203.0.113.7', proxy: true }, { at: at + 120_000, site: SITE }]);
  assert.deepEqual(merged.attempts, [
    { at, site: SITE, via: 'web.archive.org', from: 'history' },
    { at: at + 60_000, site: '203.0.113.7', proxy: true, from: 'history' },
    { at: at + 120_000, site: SITE, from: 'history' },
  ]);

  // The saved file: the road follows what happened, in the result column.
  const csv = toCsv([...list, { at: at + 20_000, site: SITE, via: 'web.archive.org', opened: true }], null).trim().split('\n');
  assert.equal(csv[0], 'when,site,result,address,nudity,suggestive,mark');
  assert.deepEqual(csv.slice(1).map((line) => line.replace(/^[^,]+,/, '')), [
    `${SITE},"${LABELS.blocked}, through 208.87.240.203",,,,`,
    `203.0.113.7,"${LABELS.blocked}, a web proxy",,,,`,
    `${SITE},${LABELS.blocked},,,,`,
    `${SITE},"${LABELS.opened}, through web.archive.org",,,,`,
  ]);
});

test('bookmarks: one to a listed site by another road, or to a proxy page, is found when the finder knows the roads', () => {
  const tree = [
    {
      id: '0',
      children: [
        { id: '1', url: `https://${SITE}/` },
        { id: '2', url: REPORTED },
        { id: '3', url: `https://web.archive.org/web/2020/${SITE}/` },
        { id: '4', url: 'https://203.0.113.7/page?__cpo=aHR0cHM6Ly9leGFtcGxlLmNvbQ' },
        { id: '5', url: 'https://example.com/' },
        { id: '6', url: `https://example.com/?next=${SITE}` },
        { id: '7', url: 'javascript:void(0)' },
      ],
    },
  ];
  assert.deepEqual(bookmarksTo(tree, LISTED).map(({ id }) => id), ['1'], 'by default: the host alone');
  const found = bookmarksTo(tree, LISTED, (url) => siteAt(url, LISTED)?.site ?? null);
  assert.deepEqual(found.map(({ id, site }) => [id, site]), [['1', SITE], ['2', SITE], ['3', SITE], ['4', '203.0.113.7']]);
});

test('blocklists/proxies.txt: every line a domain, on the built-in list, none of them a site that must stay off it', () => {
  const { domains, invalid } = parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'proxies.txt'), 'utf8'));
  assert.deepEqual(invalid, []);
  assert.ok(domains.length >= 30, `${domains.length} proxy sites`);
  assert.equal(new Set(domains).size, domains.length, 'each once');
  const builtIn = new Set(JSON.parse(readFileSync(DOMAINS_PATH, 'utf8')));
  const never = loadNever();
  for (const domain of domains) {
    assert.ok(builtIn.has(domain), `${domain} is on the built-in list (run npm run build)`);
    assert.ok(!never.has(domain), `${domain} is not in never.txt`);
  }
  for (const domain of ['croxyproxy.com', 'blockaway.net', 'proxyium.com', 'proxysite.com']) assert.ok(domains.includes(domain), domain);
  // Services with other uses carry a listed site's page too, but stay reachable: they are stopped by the address, not by name.
  for (const domain of ['archive.org', 'web.archive.org', 'archive.ph', 'translate.goog', 'translate.google.com', 'google.com', 'yandex.com', 'ampproject.org', 'startpage.com', 'github.com', 'github.io']) {
    assert.ok(!builtIn.has(domain), `${domain} is not on the built-in list`);
  }
});
