// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LABELS, MAX_ATTEMPTS, bookmarksTo, byDay, bySite, hostOf, listedDomain, mergeVisits, outcome as whatHappened, record, toCsv } from '../extension/lib/attempts.js';
import { normalizeDomain, parseDomainList } from '../extension/lib/domains.js';
import { MAX_UNLISTED, looksAdult, siteOf, tallyUnlisted } from '../extension/lib/suspects.js';
import { addToMyList, myList, saveMyList } from '../extension/lib/mylist.js';
import { BLOCK_PAGE, CHUNK_SIZE, buildRules, domainsOf } from '../extension/lib/rules.js';
import { BLOCKLIST_DIR, DOMAINS_PATH, MANIFEST_PATH, MAX_RULESET_BYTES, RULES_DIR, SAFE_SEARCH_PATH, formatManifest, loadBlocklists, loadRules, renderDomains, renderRulesets, renderSafeSearch, ruleResources } from '../scripts/build-rules.mjs';
import { ENGINES, FIRST_ID, YOUTUBE, safeSearchAddress, safeSearchRules } from '../extension/lib/safesearch.js';
import { COMMUNITY_PATH, COMMUNITY_URL, communityList } from '../scripts/update-blocklist.mjs';
import { firefoxManifest, packageFirefox } from '../scripts/package-firefox.mjs';
import { FILTER_LIMIT, PROFILE_PATH, XPI_URL, filterPattern, filterSites, firefoxPolicies, mobileconfig } from '../scripts/firefox-lock.mjs';
import { ICNS_PATH, packageSigned } from '../scripts/package-signed.mjs';
import { readZip } from '../scripts/read-zip.mjs';
import { LATEST_NAME, LATEST_URL, SITE_URL, UPDATES_URL, buildSite, compareVersions, describeXpi, updatesManifest } from '../scripts/updates-manifest.mjs';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const ALL_RULES = loadRules();
const rules = ALL_RULES.filter((rule) => rule.id < FIRST_ID); // the adult rulesets; the safe-search rules have their own tests

// A stand-in for the browser's matcher that follows the documented behaviour of requestDomains:
// the request's host is the listed domain or one of its subdomains, whatever the scheme, port or path.
// It checks the structure of the rules. The settings page re-checks them against the real browser.
function outcome(url, type = 'main_frame') {
  const host = new URL(url).hostname;
  for (const rule of rules) {
    const { requestDomains, resourceTypes, excludedResourceTypes } = rule.condition;
    if (resourceTypes && !resourceTypes.includes(type)) continue;
    if (excludedResourceTypes?.includes(type)) continue;
    if (requestDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return rule.action.type;
    }
  }
  return 'allow';
}

test('test case: navigating to exampleadultsite.com is blocked', () => {
  for (const url of [
    'https://exampleadultsite.com/',
    'http://exampleadultsite.com/',
    'https://exampleadultsite.com',
    'https://EXAMPLEADULTSITE.COM/',
    'https://www.exampleadultsite.com/page?x=1#top',
    'https://cdn.img.exampleadultsite.com:8443/',
    'http://exampleadultsite.com./',
    'https://www.exampleadultsite.com./page',
  ]) {
    assert.equal(outcome(url), 'redirect', url);
  }
});

test('requests embedded in other pages are blocked outright', () => {
  for (const type of ['sub_frame', 'script', 'image', 'xmlhttprequest', 'websocket']) {
    assert.equal(outcome('https://exampleadultsite.com/x', type), 'block', type);
  }
});

test('look-alike and unrelated addresses are not blocked', () => {
  for (const url of [
    'https://example.com/',
    'https://notexampleadultsite.com/',
    'https://exampleadultsite.com.example.org/',
    'https://exampleadultsite.co/',
    'https://example.com/?next=exampleadultsite.com',
    'https://example.com/exampleadultsite.com',
  ]) {
    assert.equal(outcome(url), 'allow', url);
  }
});

test('blocked page loads get redirected somewhere that exists and is web accessible', () => {
  const redirect = rules.find((rule) => rule.action.type === 'redirect').action.redirect.extensionPath;
  assert.equal(redirect, BLOCK_PAGE);
  assert.ok(existsSync(join(EXT, redirect)), `${redirect} exists`);
  const accessible = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(accessible.includes(redirect.slice(1)), `${redirect} is listed in web_accessible_resources`);
});

test('rules follow the declarativeNetRequest constraints', () => {
  const ids = ALL_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 1), 'rule ids are positive integers');
  assert.ok(ALL_RULES.length <= 30000, 'within the guaranteed static rule limit');
  for (const rule of rules) {
    const { requestDomains } = rule.condition;
    assert.ok(requestDomains.length > 0 && requestDomains.length <= CHUNK_SIZE * 2);
    for (const domain of requestDomains) {
      assert.match(domain, /^[a-z0-9.-]+$/, `${domain} is lowercase ASCII with no port or path`);
      const bare = domain.replace(/\.$/, '');
      assert.equal(normalizeDomain(bare), bare, `${domain} is in normalized form`);
    }
  }
});

test('every domain is listed with and without a trailing dot, because Firefox matches them separately', () => {
  for (const rule of rules) {
    const listed = new Set(rule.condition.requestDomains);
    for (const domain of listed) {
      const twin = domain.endsWith('.') ? domain.slice(0, -1) : `${domain}.`;
      assert.ok(listed.has(twin), `${domain} has ${twin} next to it`);
    }
  }
});

test('extension/rules/*.json and manifest.json are up to date with blocklists/ (run npm run build)', () => {
  const { domains } = loadBlocklists();
  assert.ok(domains.includes('exampleadultsite.com'));
  assert.ok(domains.includes('naughtyamerica.com'));
  const rulesets = renderRulesets(domains);
  assert.ok(rulesets.length >= 2, 'the list is big enough to need more than one file');
  for (const { file, text } of rulesets) {
    assert.equal(readFileSync(join(RULES_DIR, file), 'utf8'), text, file);
    assert.ok(Buffer.byteLength(text) <= MAX_RULESET_BYTES, `${file} stays under the size Mozilla's linter reads`);
  }
  assert.deepEqual(readdirSync(RULES_DIR).filter((name) => /^adult/.test(name)).sort(), rulesets.map(({ file }) => file).sort(), 'no stale rule files');
  assert.deepEqual(manifest.declarative_net_request.rule_resources, ruleResources(rulesets));
  assert.equal(readFileSync(MANIFEST_PATH, 'utf8'), formatManifest(manifest), 'manifest.json is written the way the build writes it');
  assert.equal(readFileSync(DOMAINS_PATH, 'utf8'), renderDomains(domains));
  assert.deepEqual(JSON.parse(readFileSync(DOMAINS_PATH, 'utf8')), domains, 'the plain list the background script and settings page read');
  assert.deepEqual(domainsOf(rules), domains, 'the rules block exactly those domains');
});

// The community list widens the built-in list by tens of thousands of sites. A site on the built-in list
// can't be allowed again from the settings page, so a well-known site swept up by mistake would be a real
// nuisance: these must never appear. Add to this list when a mistake turns up, and pick a different list if
// the maintainers don't fix it.
const NEVER_LISTED = [
  'wikipedia.org', 'google.com', 'bing.com', 'duckduckgo.com', 'youtube.com', 'reddit.com', 'tumblr.com', 'twitter.com', 'x.com',
  'imgur.com', 'flickr.com', 'deviantart.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'vimeo.com', 'dailymotion.com',
  'discord.com', 'telegram.org', 'archive.org', 'github.com', 'stackoverflow.com', 'medium.com', 'substack.com', 'patreon.com',
  'fandom.com', 'quora.com', 'wattpad.com', 'twitch.tv', 'spotify.com', 'netflix.com', 'amazon.com', 'ebay.com', 'etsy.com', 'apple.com',
  'plannedparenthood.org', 'webmd.com', 'mayoclinic.org', 'healthline.com', 'scarleteen.com', 'mozilla.org', 'example.com', 'allowed.test',
];

test('blocklists/community.txt is the community list as fetched, with a note of its source, and sweeps up none of the well-known sites', () => {
  const file = readFileSync(COMMUNITY_PATH, 'utf8');
  assert.match(file, /^# Community list: StevenBlack\/hosts/, 'starts with the note');
  assert.ok(file.includes(`# From ${COMMUNITY_URL}`));
  assert.match(file, /^# Fetched \d{4}-\d{2}-\d{2}; \d+ domains\./m);
  const { domains } = parseDomainList(file);
  assert.ok(domains.length > 10_000, `${domains.length} domains`);
  assert.ok(domains.includes('naughtyamerica.com'));
  const listed = new Set(loadBlocklists().domains);
  const mistakes = NEVER_LISTED.filter((site) => listed.has(site) || listed.has(`www.${site}`));
  assert.deepEqual(mistakes, [], 'well-known sites on the built-in list');
  // communityList() is what npm run blocklist writes: the note, then the download unchanged.
  const written = communityList('0.0.0.0 a.test\n'.repeat(1) + Array.from({ length: 12_000 }, (_, i) => `0.0.0.0 site${i}.test`).join('\n'), new Date('2026-10-18T12:00:00Z'));
  assert.match(written, /^# Community list: StevenBlack\/hosts.*\n# From https:.*\n# Fetched 2026-10-18; 12001 domains\./);
  assert.ok(written.endsWith('0.0.0.0 site11999.test\n'));
  assert.throws(() => communityList('0.0.0.0 a.test\n'), /Only 1 domains/);
});

test('renderRulesets packs whole rules into files under the size limit, in order, with ids the manifest lists', () => {
  const many = Array.from({ length: 2600 }, (_, i) => `site-number-${i}.example`);
  const small = renderRulesets(many, 60_000);
  assert.ok(small.length > 1);
  const all = small.flatMap(({ text }) => JSON.parse(text));
  assert.deepEqual(all, buildRules(many), 'every rule, once, in order');
  for (const { file, text } of small) assert.ok(Buffer.byteLength(text) <= 60_000 || JSON.parse(text).length === 1, file);
  assert.deepEqual(small.map(({ id }) => id), small.map((_, i) => `adult-${i + 1}`));
  assert.deepEqual(ruleResources(small.slice(0, 2)), [
    { id: 'adult-1', enabled: true, path: 'rules/adult-1.json' },
    { id: 'adult-2', enabled: true, path: 'rules/adult-2.json' },
    { id: 'safe-search', enabled: true, path: 'rules/safe-search.json' },
  ]);
  assert.equal(renderRulesets(['one.example']).length, 1);
});

test('buildRules splits long lists into chunks with unique ids', () => {
  const many = Array.from({ length: CHUNK_SIZE * 2 + 1 }, (_, i) => `site${i}.com`);
  const built = buildRules(many, 10);
  assert.deepEqual(built.map((rule) => rule.id), [10, 11, 12, 13, 14, 15]);
  assert.equal(buildRules([]).length, 0);
});

test('domainsOf reads back the domains a set of rules was built from, each once', () => {
  const many = Array.from({ length: CHUNK_SIZE + 2 }, (_, i) => `site${i}.com`);
  assert.deepEqual(domainsOf(buildRules(many)), many);
  assert.deepEqual(domainsOf([]), []);
  assert.ok(domainsOf(rules).includes('exampleadultsite.com'));
});

test('safe search: each engine gets an allow rule for addresses already strict and a redirect that adds the setting; YouTube gets its header', () => {
  const safe = safeSearchRules();
  assert.deepEqual(readFileSync(SAFE_SEARCH_PATH, 'utf8'), renderSafeSearch(), 'rules/safe-search.json is up to date (run npm run build)');
  assert.deepEqual(ALL_RULES.filter((rule) => rule.id >= FIRST_ID), safe, 'the manifest loads exactly these');
  assert.equal(safe.length, ENGINES.length * 2 + 1);
  ENGINES.forEach((engine, i) => {
    const [allow, redirect] = safe.slice(i * 2, i * 2 + 2);
    assert.equal(allow.action.type, 'allow');
    assert.equal(redirect.action.type, 'redirect');
    assert.ok(allow.priority > redirect.priority, `${engine.name}: the allow rule wins, so a strict address is not redirected again`);
    assert.deepEqual(redirect.action.redirect.transform.queryTransform.addOrReplaceParams, [{ key: engine.key, value: engine.value }]);
    assert.equal(redirect.condition.regexFilter, engine.pattern);
    assert.ok(allow.condition.regexFilter.startsWith(engine.pattern));
    for (const rule of [allow, redirect]) {
      assert.doesNotMatch(rule.condition.regexFilter, /\(\?[=!<]|\\[1-9]/, `${engine.name}: no lookaround or backreference, which RE2 (Chrome) refuses`);
      assert.ok(rule.condition.regexFilter.length < 2000, 'within the regex length limit');
      assert.ok(rule.condition.regexFilter.split('').every((c) => c.charCodeAt(0) < 128), 'ASCII only');
      new RegExp(rule.condition.regexFilter); // compiles
      assert.deepEqual(rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
    }
    // The example search page is matched; the engine's home page and other pages are not.
    assert.match(engine.example, new RegExp(engine.pattern), engine.name);
    const home = new URL(engine.example).origin + '/';
    assert.doesNotMatch(home, new RegExp(engine.pattern), `${engine.name}: home page left alone`);
    const strict = safeSearchAddress(engine.example);
    assert.equal(new URL(strict).searchParams.get(engine.key), engine.value);
    assert.match(strict, new RegExp(allow.condition.regexFilter), `${engine.name}: the address with the setting is let through as it is`);
    assert.doesNotMatch(engine.example, new RegExp(allow.condition.regexFilter));
  });
  // Address forms people meet.
  for (const [url, key] of [
    ['https://www.google.co.uk/search?q=test&safe=off', 'safe'],
    ['https://google.com/search?client=firefox-b-d&q=test', 'safe'],
    ['https://www.google.com.au/webhp?q=test', 'safe'],
    ['https://www.bing.com/images/search?q=test&form=HDRSC2', 'adlt'],
    ['https://html.duckduckgo.com/html/?q=test', 'kp'],
    ['https://duckduckgo.com/?t=h_&q=test&ia=web', 'kp'],
    ['https://images.search.yahoo.com/search/images?p=test', 'vm'],
    ['https://uk.search.yahoo.com/search?p=test', 'vm'],
    ['https://search.brave.com/images?q=test', 'safesearch'],
  ]) {
    assert.notEqual(safeSearchAddress(url), url, url);
    assert.ok(new URL(safeSearchAddress(url)).searchParams.has(key), url);
  }
  for (const url of ['https://www.google.com/', 'https://www.google.com/maps?q=test', 'https://mail.google.com/mail/?q=test', 'https://duckduckgo.com/', 'https://www.bing.com/', 'https://www.youtube.com/results?search_query=test', 'https://example.com/search?q=test', 'https://notgoogle.com/search?q=test']) {
    assert.equal(safeSearchAddress(url), url, `${url} is left alone`);
  }
  const header = safe.at(-1);
  assert.deepEqual(header.action, { type: 'modifyHeaders', requestHeaders: [{ header: 'YouTube-Restrict', operation: 'set', value: 'Strict' }] });
  assert.deepEqual(header.condition.requestDomains, YOUTUBE.domains);
  assert.ok(header.condition.resourceTypes.includes('main_frame') && header.condition.resourceTypes.includes('xmlhttprequest'), 'page loads and the calls pages make');
  assert.deepEqual(manifest.declarative_net_request.rule_resources.at(-1), { id: 'safe-search', enabled: true, path: 'rules/safe-search.json' });
});

test('blocked attempts: the host of an address, and the listed domain that covers it', () => {
  const listed = new Set(['exampleadultsite.com', 'm.other.test']);
  for (const [url, host, site] of [
    ['http://exampleadultsite.com/', 'exampleadultsite.com', 'exampleadultsite.com'],
    ['https://www.EXAMPLEADULTSITE.com./page?x=1#y', 'www.exampleadultsite.com', 'exampleadultsite.com'],
    ['http://user:pw@a.b.exampleadultsite.com:8080/', 'a.b.exampleadultsite.com', 'exampleadultsite.com'],
    ['http://m.other.test/', 'm.other.test', 'm.other.test'],
    ['http://www.m.other.test/', 'www.m.other.test', 'm.other.test'],
    ['http://other.test/', 'other.test', null],
    ['http://notexampleadultsite.com/', 'notexampleadultsite.com', null],
    ['http://exampleadultsite.com.example.org/', 'exampleadultsite.com.example.org', null],
    ['http://example.org/?next=exampleadultsite.com', 'example.org', null],
  ]) {
    assert.equal(hostOf(url), host, url);
    assert.equal(listedDomain(hostOf(url), listed), site, url);
  }
  // Only web addresses count: a block page, a settings page or a browser page never does.
  for (const url of ['chrome-extension://abcdefghijklmnop/blocked.html', 'moz-extension://1234-5678/blocked.html', 'about:neterror?e=blockedByPolicy', 'chrome://extensions/', 'file:///tmp/x.html', 'not a url', '']) {
    assert.equal(hostOf(url), null, url);
  }
  assert.equal(listedDomain(null, listed), null);
  assert.equal(listedDomain('com', new Set(['com'])), null, 'a single label is never looked up');
});

test('blocked attempts: notes are added oldest first, repeats within two seconds are one attempt, and a page that opens marks its attempt', () => {
  const t = 1_700_000_000_000;
  let list = record(undefined, { at: t, site: 'a.test' });
  assert.deepEqual(list, [{ at: t, site: 'a.test' }]);
  assert.equal(record(list, { at: t + 1500, site: 'a.test' }), null, 'the same site straight away is the same attempt');
  list = record(list, { at: t + 1500, site: 'b.test' });
  list = record(list, { at: t + 3000, site: 'a.test' });
  assert.deepEqual(list.map((entry) => entry.site), ['a.test', 'b.test', 'a.test']);

  // The page of b.test loaded 10 seconds after its attempt: that attempt is marked, nothing is added.
  const marked = record(list, { at: t + 11_500, site: 'b.test', opened: true });
  assert.deepEqual(marked, [{ at: t, site: 'a.test' }, { at: t + 1500, site: 'b.test', opened: true }, { at: t + 3000, site: 'a.test' }]);
  assert.equal(record(marked, { at: t + 12_000, site: 'b.test', opened: true }), null, 'marking it again changes nothing');
  // A page that loads with no attempt noted in the last minute gets a note of its own.
  const late = record(marked, { at: t + 100_000, site: 'a.test', opened: true });
  assert.deepEqual(late.at(-1), { at: t + 100_000, site: 'a.test', opened: true });
  assert.equal(late.length, 4);
  // The browser may report the start of that page load after its end: still the same try.
  assert.equal(record(late, { at: t + 100_500, site: 'a.test' }), null);
  assert.equal(record(late, { at: t + 102_500, site: 'a.test' }).length, 5, 'a later try is new');
  assert.equal(record('not a list', { at: t, site: 'a.test' }).length, 1, 'a damaged record starts over');
});

test("blocked attempts: visits found in the browser's history are added in time order, marked, each once, and never twice", () => {
  const t = 1_700_000_000_000;
  const seen = [{ at: t, site: 'a.test' }, { at: t + 5000, site: 'b.test', opened: true }];
  const visits = [
    { at: t - 86_400_000, site: 'a.test' }, // yesterday: new
    { at: t - 86_400_000 + 1500, site: 'a.test' }, // the same try, a reload
    { at: t + 500, site: 'a.test' }, // the try the record saw live
    { at: t + 60_000, site: 'c.test' }, // new
    { at: NaN, site: 'c.test' }, // nothing without a time
    { at: t + 70_000, site: '' }, // or a site
  ];
  const first = mergeVisits(seen, visits);
  assert.deepEqual({ found: first.found, added: first.added }, { found: 3, added: 2 });
  assert.deepEqual(first.attempts, [
    { at: t - 86_400_000, site: 'a.test', from: 'history' },
    { at: t, site: 'a.test' },
    { at: t + 5000, site: 'b.test', opened: true },
    { at: t + 60_000, site: 'c.test', from: 'history' },
  ]);
  // Looking again finds the same visits and adds nothing; the list comes back unchanged.
  const again = mergeVisits(first.attempts, visits);
  assert.deepEqual({ found: again.found, added: again.added }, { found: 3, added: 0 });
  assert.equal(again.attempts, first.attempts);
  assert.deepEqual(mergeVisits(undefined, []), { attempts: [], found: 0, added: 0 });
  // Only the newest MAX_ATTEMPTS stay, however many the history holds.
  const flood = Array.from({ length: MAX_ATTEMPTS + 10 }, (_, i) => ({ at: t - (i + 1) * 10_000, site: 'old.test' }));
  const full = mergeVisits(seen, flood);
  assert.equal(full.attempts.length, MAX_ATTEMPTS);
  assert.deepEqual(full.attempts.slice(-2), seen, 'the live tries, being newest, stay');
});

test(`blocked attempts: only the newest ${MAX_ATTEMPTS} are kept`, () => {
  let list = [];
  for (let i = 0; i < MAX_ATTEMPTS + 5; i += 1) list = record(list, { at: i * 10_000, site: `site${i}.test` });
  assert.equal(list.length, MAX_ATTEMPTS);
  assert.equal(list[0].site, 'site5.test', 'the oldest went');
  assert.equal(list.at(-1).site, `site${MAX_ATTEMPTS + 4}.test`);
});

test('blocked attempts: the record page sums the record up by site, most tries first, and by day, newest first', () => {
  const noon = new Date(2026, 9, 18, 12, 0, 0).getTime(); // local time, as the pages group by this computer's days
  const day = 86_400_000;
  const attempts = [
    { at: noon - 3 * day, site: 'b.test', from: 'history' },
    { at: noon - day + 60_000, site: 'a.test' },
    { at: noon - day, site: 'b.test', opened: true },
    { at: noon, site: 'a.test' },
    { at: noon + 1000, site: 'c.test' },
    { at: noon + 2000, site: 'a.test', opened: true },
  ];
  assert.deepEqual(bySite(attempts), [
    { site: 'a.test', tries: 3, first: noon - day + 60_000, last: noon + 2000, opened: 1, history: 0 },
    { site: 'b.test', tries: 2, first: noon - 3 * day, last: noon - day, opened: 1, history: 1 },
    { site: 'c.test', tries: 1, first: noon + 1000, last: noon + 1000, opened: 0, history: 0 },
  ]);
  const days = byDay(attempts);
  assert.deepEqual(
    days.map(({ day: start, attempts: list }) => [new Date(start).toDateString(), list.map((a) => a.site)]),
    [
      ['Sun Oct 18 2026', ['a.test', 'c.test', 'a.test']],
      ['Sat Oct 17 2026', ['a.test', 'b.test']],
      ['Thu Oct 15 2026', ['b.test']],
    ],
  );
  assert.equal(new Date(days[0].day).getHours(), 0, 'each day starts at midnight');
  assert.deepEqual(bySite([]), []);
  assert.deepEqual(byDay(undefined), []);
  assert.deepEqual(attempts.map(whatHappened), ['history', 'blocked', 'opened', 'blocked', 'blocked', 'opened']);
  assert.deepEqual(Object.keys(LABELS).sort(), ['blocked', 'history', 'opened']);
});

test('blocked attempts: the bookmarks to listed sites are picked out of the bookmark tree, folders and all', () => {
  const listed = new Set(['exampleadultsite.com', 'custom.test']);
  const tree = [
    {
      id: 'root',
      children: [
        { id: 'toolbar', title: 'Toolbar', children: [{ id: '1', title: 'saved', url: 'https://www.exampleadultsite.com/page' }, { id: '2', url: 'http://allowed.test/' }] },
        { id: 'menu', children: [{ id: 'sep', type: 'separator' }, { id: 'deep', children: [{ id: '3', url: 'http://m.custom.test/x?y' }, { id: '4', url: 'http://notexampleadultsite.com/' }] }] },
        { id: '5', url: 'place:folder=TOOLBAR' },
        { id: '6', url: 'ftp://exampleadultsite.com/' },
      ],
    },
  ];
  assert.deepEqual(bookmarksTo(tree, listed), [
    { id: '1', url: 'https://www.exampleadultsite.com/page', site: 'exampleadultsite.com' },
    { id: '3', url: 'http://m.custom.test/x?y', site: 'custom.test' },
  ]);
  assert.deepEqual(bookmarksTo([], listed), []);
  assert.deepEqual(bookmarksTo(undefined, listed), []);
});

test('blocked attempts: the saved file is CSV, oldest first, with local times that say their time zone', () => {
  const at = new Date(2026, 9, 18, 15, 12, 3).getTime();
  const csv = toCsv([
    { at, site: 'a.test' },
    { at: at + 1000, site: 'b.test', opened: true },
    { at: at + 2000, site: 'odd"name,.test', from: 'history' },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'when,site,result');
  assert.match(lines[1], /^2026-10-18T15:12:03[+-]\d\d:\d\d,a\.test,Blocked$/);
  assert.match(lines[2], /^2026-10-18T15:12:04[+-]\d\d:\d\d,b\.test,"Opened, not blocked"$/);
  assert.match(lines[3], /^2026-10-18T15:12:05[+-]\d\d:\d\d,"odd""name,\.test",Visited \(browser history\)$/);
  assert.deepEqual(lines.slice(4), [''], 'ends with a newline');
  assert.equal(toCsv([]), 'when,site,result\n');
  const offset = lines[1].match(/([+-])(\d\d):(\d\d),/);
  const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
  assert.equal(minutes, 0 - new Date(at).getTimezoneOffset() || 0, "the offset is this computer's");
});

test('sites that look adult by name are told from ordinary names, and ordinary words that hide the same letters are left alone', () => {
  const adult = [
    'sex.com', 'www.sexy-youtubers.com', 'nudesbox.com', 'erothots.to', 'xxxfiles.com', 'hentaihaven.xxx', 'site.porn', 'cam4.com',
    'cams.com', 'stripchat.com', 'babes.com', 'fapello.com', 'thothub.to', 'javhd.com', 'nudify.online', 'undress.app', 'clothoff.io',
    'nsfwlover.com', 'aigirlfriend.wtf', 'lustgf.ai', 'cumshots.xyz', 'kink.com', 'bbwchan.nl', 'rule34.paheal.net', 'm.xhamster2.desi',
    'escort-ads.example', 'hookuptonight.example', 'playboy.com', 'NSFW.EXAMPLE',
  ];
  const ordinary = [
    'essex.gov.uk', 'sussex.ac.uk', 'middlesex.edu', 'peacocktv.com', 'hancock.com', 'stripe.com', 'illustrator.adobe.com', 'cluster.io',
    'camden.gov.uk', 'camera.com', 'cambridge.org', 'analytics.google.com', 'cumberland.edu', 'babel.io', 'java.com', 'javascript.info',
    'javelin.com', 'youtube.com', 'titan.com', 'nakedwines.com', 'girlfriendcollective.com', 'webcams.travel', 'documentcloud.org',
    'circumstance.com', 'exxon.com', 'muah.ai', 'ourdream.ai', 'swappz.com', 'candy.ai', 'classroom.google.com', 'assets.example',
  ];
  assert.deepEqual(adult.filter((host) => !looksAdult(host)), [], 'missed');
  assert.deepEqual(ordinary.filter((host) => looksAdult(host)), [], 'false alarms');
  assert.equal(looksAdult(null), false);
  assert.deepEqual(['www.site.com', 'm.site.co.uk', 'a.b.site.com.au', 'site.ai', 'deep.sub.site.org', 'site.me', 'x.site.me', 'host.'].map(siteOf), [
    'site.com', 'site.co.uk', 'site.com.au', 'site.ai', 'site.org', 'site.me', 'site.me', 'host',
  ]);
});

test('the history scan sums adult-looking unlisted sites up by site, most visited first, leaving listed and ordinary sites out', () => {
  const listed = new Set(['exampleadultsite.com']);
  const items = [
    { url: 'https://www.sex.example/a', visitCount: 3, lastVisitTime: 5 },
    { url: 'https://m.sex.example/b', visitCount: 2, lastVisitTime: 9 },
    { url: 'http://exampleadultsite.com/listed', visitCount: 50, lastVisitTime: 99 },
    { url: 'https://nudesbox.example/', visitCount: 4, lastVisitTime: 1 },
    { url: 'https://essex.gov.uk/', visitCount: 9, lastVisitTime: 99 },
    { url: 'ftp://porn.example/', visitCount: 9 },
    { url: 'https://hentai.example/no-count' },
  ];
  assert.deepEqual(tallyUnlisted(items, listed), [
    { site: 'sex.example', visits: 5, last: 9 },
    { site: 'nudesbox.example', visits: 4, last: 1 },
    { site: 'hentai.example', visits: 1, last: 0 },
  ]);
  assert.deepEqual(tallyUnlisted([], listed), []);
  assert.deepEqual(tallyUnlisted(undefined, listed), []);
  const many = Array.from({ length: MAX_UNLISTED + 10 }, (_, i) => ({ url: `https://porn${i}.example/`, visitCount: i + 1 }));
  const kept = tallyUnlisted(many, listed);
  assert.equal(kept.length, MAX_UNLISTED);
  assert.equal(kept[0].site, `porn${MAX_UNLISTED + 9}.example`, 'the most visited stay');
});

test("the person's own list is the dynamic rules: read back, replaced whole, added to once", async () => {
  // A stand-in for the browser's rule store.
  let rules = [];
  const dnr = {
    getDynamicRules: async () => rules,
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      rules = [...rules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
    },
  };
  assert.deepEqual(await myList(dnr), []);
  await saveMyList(dnr, ['a.test', 'b.test']);
  assert.deepEqual(await myList(dnr), ['a.test', 'b.test']);
  assert.equal(await addToMyList(dnr, 'c.test'), true);
  assert.equal(await addToMyList(dnr, 'b.test'), false, 'already there');
  assert.deepEqual(await myList(dnr), ['a.test', 'b.test', 'c.test']);
  await saveMyList(dnr, ['c.test']);
  assert.deepEqual(await myList(dnr), ['c.test'], 'saving replaces the whole list');
  assert.ok(rules.every((rule, i) => rules.findIndex((other) => other.id === rule.id) === i), 'rule ids stay unique');
});

test('normalizeDomain accepts what people paste and rejects what is not a domain', () => {
  const accepted = [
    ['exampleadultsite.com', 'exampleadultsite.com'],
    ['  ExampleAdultSite.COM  ', 'exampleadultsite.com'],
    ['https://www.exampleadultsite.com/some/path?q=1#x', 'exampleadultsite.com'],
    ['http://user:pw@exampleadultsite.com:8080/', 'exampleadultsite.com'],
    ['*.exampleadultsite.com', 'exampleadultsite.com'],
    ['.exampleadultsite.com.', 'exampleadultsite.com'],
    ['m.exampleadultsite.com', 'm.exampleadultsite.com'],
    ['www.www.exampleadultsite.com', 'exampleadultsite.com'],
    ['BÜCHER.example', 'xn--bcher-kva.example'],
  ];
  for (const [input, expected] of accepted) assert.equal(normalizeDomain(input), expected, input);

  for (const input of ['', '   ', 'com', 'localhost', '127.0.0.1', '[::1]', 'not a domain', 'exa_mple.com', '-bad.com', 'a..b.com', 'http://', 'example.123']) {
    assert.equal(normalizeDomain(input), null, JSON.stringify(input));
  }
});

test('parseDomainList reads plain lists, hosts files and comments', () => {
  const { domains, invalid } = parseDomainList(`
    # a comment
    0.0.0.0 a-site.com b-site.com
    127.0.0.1 localhost
    ::1 ip6-localhost
    https://www.c-site.com/page # trailing comment
    c-site.com
    bad entry here
  `);
  assert.deepEqual(domains, ['a-site.com', 'b-site.com', 'c-site.com']);
  assert.deepEqual(invalid, ['localhost', 'ip6-localhost', 'bad entry here']);
});

test('manifest points at files that exist', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('declarativeNetRequest'));
  assert.ok(manifest.permissions.includes('storage'), 'the lists and the record of attempts are stored');
  assert.ok(manifest.permissions.includes('webNavigation') && manifest.permissions.includes('webRequest'), 'noting blocked attempts needs to see page loads');
  assert.ok(manifest.permissions.includes('history'), "adding earlier visits needs the browser's history");
  assert.ok(manifest.permissions.includes('bookmarks'), 'removing bookmarks to listed sites, so the address bar stops suggesting them');
  assert.ok(manifest.host_permissions.includes('<all_urls>'), 'redirect rules need host access');
  for (const { path } of manifest.declarative_net_request.rule_resources) {
    assert.ok(existsSync(join(EXT, path)), path);
  }
  assert.ok(existsSync(join(EXT, 'rules', 'domains.json')), 'rules/domains.json, which background.js and options.js read');
  for (const file of [manifest.background.service_worker, manifest.options_page]) {
    assert.ok(existsSync(join(EXT, file)), file);
  }
  for (const file of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
    assert.ok(existsSync(join(EXT, file)), file);
  }
});

test('one manifest works in Chrome, Edge, Brave and Firefox', () => {
  const { background, browser_specific_settings: settings } = manifest;
  // Chrome, Edge and Brave run the service worker; Firefox runs the same file as an event page.
  // The extension folder keeps both, so it loads anywhere; the zip for Mozilla leaves out service_worker.
  assert.deepEqual(background.scripts, [background.service_worker]);
  // background.js imports lib/attempts.js and lib/rules.js, which both browsers allow for a module.
  assert.equal(background.type, 'module');
  // Both browsers accept the two keys side by side from version 121 (MDN: manifest.json/background).
  assert.ok(Number(manifest.minimum_chrome_version) >= 121);
  assert.ok(parseFloat(settings.gecko.strict_min_version) >= 121);
  assert.match(settings.gecko.id, /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/, 'Firefox add-on id in the email-like format');
  // addons.mozilla.org won't sign a new add-on without this (Firefox 140 and later understand it).
  assert.deepEqual(settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.ok(parseFloat(settings.gecko.strict_min_version) >= 140);
  // Firefox for Android understands data_collection_permissions from 142 (Mozilla's linter checks this).
  assert.ok(parseFloat(manifest.browser_specific_settings.gecko_android.strict_min_version) >= 142);
  assert.equal(manifest.options_page, 'options.html');
});

test('the add-on updates itself from the update files that scripts/updates-manifest.mjs publishes', () => {
  assert.equal(manifest.browser_specific_settings.gecko.update_url, UPDATES_URL);
  assert.ok(UPDATES_URL.startsWith('https://'), 'Firefox only takes update manifests over https');
  assert.equal(UPDATES_URL, `${SITE_URL}updates.json`);
  // Mozilla's linter rejects update_url on an add-on listed on addons.mozilla.org; this one is self-hosted.
  const check = readFileSync(join(EXT, '..', '.github', 'workflows', 'firefox-package.yml'), 'utf8');
  assert.match(check, /addons-linter .*--self-hosted/, 'the package check tells the linter the add-on is self-hosted');
  const sign = readFileSync(join(EXT, '..', '.github', 'workflows', 'sign-firefox.yml'), 'utf8');
  assert.match(sign, /uses: \.\/\.github\/workflows\/publish-updates\.yml/, 'signing publishes the update files');
});

test("Firefox's manifest leaves out only background.service_worker, which Mozilla's linter warns about", () => {
  const firefox = firefoxManifest(manifest);
  assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
  assert.deepEqual({ ...firefox, background: null }, { ...manifest, background: null }, 'nothing else changes');
  assert.equal(manifest.background.service_worker, 'background.js', 'the extension folder keeps it for Chrome, Edge and Brave');
});

/** Every file under a folder, as zip-style relative paths. */
function filesIn(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => path.split(sep).join('/'))
    .sort();
}

const hasZip = spawnSync('zip', ['-v']).status === 0;

test('npm run package:firefox zips the whole extension, manifest.json at the top, with Firefox\'s manifest', { skip: !hasZip && 'no zip command' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'family-site-blocker-package-'));
  try {
    const { zip } = packageFirefox({ outDir: out });
    const files = readZip(readFileSync(zip));
    const expected = filesIn(EXT).filter((path) => !path.startsWith('_metadata/') && !path.endsWith('.DS_Store'));
    assert.deepEqual([...files.keys()].sort(), expected);
    assert.deepEqual(JSON.parse(files.get('manifest.json').data), firefoxManifest(manifest));
    for (const [name, { data }] of files) {
      if (name !== 'manifest.json') assert.ok(data.equals(readFileSync(join(EXT, name))), `${name} is copied unchanged`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('assets/finder-icon.icns holds the gate icon at every size Finder uses (npm run icons makes it)', () => {
  const icns = readFileSync(ICNS_PATH);
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const found = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
    const png = icns.subarray(at + 8, at + icns.readUInt32BE(at + 4));
    assert.ok(png.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')), 'each entry is a PNG');
    found.push(`${icns.toString('latin1', at, at + 4)}=${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  assert.deepEqual(found, ['icp4=16x16', 'icp5=32x32', 'ic11=32x32', 'ic12=64x64', 'ic07=128x128', 'ic13=256x256', 'ic08=256x256', 'ic14=512x512', 'ic09=512x512', 'ic10=1024x1024']);
});

/** Makes a stand-in for the .xpi Mozilla signs: a zip of the given files. */
function makeXpi(dir, files) {
  const folder = mkdtempSync(join(dir, 'xpi-'));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), contents);
  }
  const xpi = `${folder}.xpi`;
  assert.equal(spawnSync('zip', ['-qrX', xpi, '.'], { cwd: folder }).status, 0);
  return xpi;
}

const signedFiles = (changes = {}) => ({
  'manifest.json': JSON.stringify({ ...manifest, version: '9.8.7', ...changes }),
  'background.js': '// …',
  'META-INF/mozilla.rsa': 'signature',
  'META-INF/cose.sig': 'signature',
});

test('npm run package:signed wraps a signed .xpi with a clear name and the Finder icon', { skip: !hasZip && 'no zip command' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-signed-test-'));
  try {
    const signed = makeXpi(dir, signedFiles());
    const result = packageSigned(signed, { outDir: dir });
    assert.equal(result.zip, join(dir, 'family-site-blocker-9.8.7.zip'));
    const files = readZip(readFileSync(result.zip));
    assert.deepEqual([...files.keys()].sort(), ['__MACOSX/._family-site-blocker-9.8.7.xpi', 'family-site-blocker-9.8.7.xpi']);
    assert.ok(files.get('family-site-blocker-9.8.7.xpi').data.equals(readFileSync(signed)), 'the signed file is stored unchanged');
    for (const [name, { mode }] of files) assert.equal(mode, 0o100644, `${name} is readable by every account`);

    // The sidecar, laid out the way macOS itself stores a file's custom icon (compared on macOS 26).
    const sidecar = files.get('__MACOSX/._family-site-blocker-9.8.7.xpi').data;
    assert.deepEqual([sidecar.readUInt32BE(0), sidecar.readUInt32BE(4), sidecar.readUInt16BE(24)], [0x00051607, 0x00020000, 2], 'AppleDouble with two entries');
    assert.deepEqual([sidecar.readUInt32BE(26), sidecar.readUInt32BE(30), sidecar.readUInt32BE(34)], [9, 50, 32], 'Finder info');
    assert.deepEqual([sidecar.readUInt32BE(38), sidecar.readUInt32BE(42), sidecar.readUInt32BE(46)], [2, 82, sidecar.length - 82], 'resource fork');
    assert.equal(sidecar.readUInt16BE(50 + 8), 0x0400, 'Finder flags: has a custom icon');
    const fork = sidecar.subarray(82);
    const icns = readFileSync(ICNS_PATH);
    const [dataAt, mapAt, dataLength, mapLength] = [0, 4, 8, 12].map((at) => fork.readUInt32BE(at));
    assert.deepEqual([dataAt, mapAt, dataLength, mapLength], [256, 256 + 4 + icns.length, 4 + icns.length, 50]);
    const map = fork.subarray(mapAt);
    assert.ok(map.subarray(0, 16).equals(fork.subarray(0, 16)), 'the map starts with a copy of the header');
    assert.deepEqual([map.readUInt16BE(24), map.readUInt16BE(26), map.readUInt16BE(28)], [28, 50, 0], 'one resource type, no names');
    assert.deepEqual([map.toString('latin1', 30, 34), map.readUInt16BE(34), map.readUInt16BE(36)], ['icns', 0, 10], 'one icns resource');
    assert.deepEqual([map.readInt16BE(38), map.readUInt16BE(40), map.readUInt32BE(42)], [-16455, 0xffff, 0], 'id -16455, where Finder looks');
    assert.equal(fork.readUInt32BE(dataAt), icns.length);
    assert.ok(fork.subarray(dataAt + 4, dataAt + 4 + icns.length).equals(icns), 'the resource is assets/finder-icon.icns');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run package:signed refuses anything but this add-on, signed by Mozilla', { skip: !hasZip && 'no zip command' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-signed-test-'));
  try {
    const { 'META-INF/mozilla.rsa': _, 'META-INF/cose.sig': __, ...unsigned } = signedFiles();
    assert.throws(() => packageSigned(makeXpi(dir, unsigned), { outDir: dir }), /isn't signed by Mozilla/);
    const other = { browser_specific_settings: { gecko: { id: 'someone-else@example.com' } } };
    assert.throws(() => packageSigned(makeXpi(dir, signedFiles(other)), { outDir: dir }), /is a different add-on \(someone-else@example\.com\)/);
    writeFileSync(join(dir, 'notes.xpi'), 'not a zip');
    assert.throws(() => packageSigned(join(dir, 'notes.xpi'), { outDir: dir }), /isn't an add-on file/);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.zip')), [], 'nothing written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/check-signed.mjs accepts the uploaded files, unchanged, plus a signature, and nothing else', { skip: !hasZip && 'no zip command' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-check-test-'));
  try {
    const uploaded = join(dir, 'uploaded');
    mkdirSync(uploaded);
    writeFileSync(join(uploaded, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(uploaded, 'background.js'), '// …');
    writeFileSync(join(uploaded, '.amo-upload-uuid'), '{}'); // web-ext leaves this behind; it is never uploaded
    const check = (files) => spawnSync(process.execPath, [join(EXT, '..', 'scripts', 'check-signed.mjs'), makeXpi(dir, files), uploaded], { encoding: 'utf8' });
    const signature = { 'META-INF/mozilla.rsa': 'signature', 'META-INF/cose.sig': 'signature' };
    const rewritten = JSON.stringify(manifest); // Mozilla rewrites the manifest's whitespace when it signs.

    const ok = check({ 'manifest.json': rewritten, 'background.js': '// …', ...signature });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /the 2 files uploaded, unchanged, plus Mozilla's signature/);
    for (const [files, problem] of [
      [{ 'manifest.json': rewritten, 'background.js': '// changed', ...signature }, /background\.js is different/],
      [{ 'manifest.json': rewritten, ...signature }, /background\.js is missing/],
      [{ 'manifest.json': rewritten, 'background.js': '// …', 'extra.js': '', ...signature }, /extra\.js was added/],
      [{ 'manifest.json': rewritten, 'background.js': '// …' }, /no signature files/],
      [{ 'manifest.json': JSON.stringify({ ...manifest, version: '0.0.1' }), 'background.js': '// …', ...signature }, /manifest\.json is different/],
    ]) {
      const run = check(files);
      assert.equal(run.status, 1, `should fail with ${problem}`);
      assert.match(run.stderr, problem);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the update manifest lists every signed version, oldest first, with its address, hash and Firefox version', { skip: !hasZip && 'no zip command' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-updates-test-'));
  try {
    const xpis = ['1.3.2', '1.10.0', '1.9.1'].map((version) => {
      const name = `family-site-blocker-${version}.xpi`;
      const data = readFileSync(makeXpi(dir, signedFiles({ version })));
      return { name, data };
    });
    const built = updatesManifest(xpis, 'https://example.org/updates/');
    const updates = built.addons[manifest.browser_specific_settings.gecko.id].updates;
    assert.deepEqual(updates.map((update) => update.version), ['1.3.2', '1.9.1', '1.10.0'], 'numeric order, not alphabetical');
    const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
    assert.deepEqual(updates[0], {
      version: '1.3.2',
      update_link: 'https://example.org/updates/family-site-blocker-1.3.2.xpi',
      update_hash: sha256(xpis[0].data),
      // Firefox reads the versions an update needs from "applications", whatever the add-on's manifest calls them.
      applications: { gecko: { strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version } },
    });
    assert.match(updates[1].update_hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(built), ['addons']);

    // The site: the files, the manifest for them, and nothing GitHub Pages would change.
    const xpiDir = join(dir, 'xpis');
    mkdirSync(xpiDir);
    for (const { name, data } of xpis) writeFileSync(join(xpiDir, name), data);
    writeFileSync(join(xpiDir, 'notes.txt'), 'ignored');
    const site = join(dir, 'site');
    assert.deepEqual(buildSite(xpiDir, site), ['1.3.2', '1.9.1', '1.10.0']);
    assert.deepEqual(readdirSync(site).sort(), ['.nojekyll', 'README.md', 'family-site-blocker-1.10.0.xpi', 'family-site-blocker-1.3.2.xpi', 'family-site-blocker-1.9.1.xpi', 'family-site-blocker.xpi', 'index.html', 'updates.json']);
    const published = JSON.parse(readFileSync(join(site, 'updates.json'), 'utf8'));
    const listed = published.addons[manifest.browser_specific_settings.gecko.id].updates;
    assert.equal(listed[2].update_link, `${SITE_URL}family-site-blocker-1.10.0.xpi`);
    assert.equal(listed.length, 3, 'the newest under its fixed name is not listed a second time');
    assert.ok(readFileSync(join(site, 'family-site-blocker-1.9.1.xpi')).equals(xpis[2].data), 'copied unchanged');
    assert.ok(readFileSync(join(site, LATEST_NAME)).equals(xpis[1].data), 'the newest version (1.10.0) under the fixed name, for the lock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the update manifest takes only signed files of this add-on, named for their version', { skip: !hasZip && 'no zip command' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-updates-test-'));
  try {
    const read = (file) => readFileSync(file);
    const { 'META-INF/mozilla.rsa': _, 'META-INF/cose.sig': __, ...unsigned } = signedFiles({ version: '2.0.0' });
    assert.throws(() => describeXpi('family-site-blocker-2.0.0.xpi', read(makeXpi(dir, unsigned))), /isn't signed by Mozilla/);
    const other = { browser_specific_settings: { gecko: { id: 'someone-else@example.com' } }, version: '2.0.0' };
    assert.throws(() => describeXpi('family-site-blocker-2.0.0.xpi', read(makeXpi(dir, signedFiles(other)))), /is a different add-on \(someone-else@example\.com\)/);
    assert.throws(() => describeXpi('family-site-blocker-2.0.0.xpi', read(makeXpi(dir, signedFiles({ version: '2.0.1' })))), /holds version 2\.0\.1/);
    assert.throws(() => describeXpi('family-site-blocker.xpi', read(makeXpi(dir, signedFiles()))), /isn't named family-site-blocker-<version>\.xpi/);
    assert.throws(() => describeXpi('family-site-blocker-1.0.0.xpi', Buffer.from('not a zip')), /can't be read as a zip/);
    assert.throws(() => buildSite(dir, join(dir, 'site')), /No family-site-blocker-<version>\.xpi files/);
    assert.deepEqual(['1.2.0', '1.10.0', '1.9.9', '1.10'].sort(compareVersions), ['1.2.0', '1.9.9', '1.10.0', '1.10'], '1.10 and 1.10.0 are the same version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on a Mac, opening the zip puts the icon on the .xpi', { skip: process.platform !== 'darwin' && 'needs macOS' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-signed-test-'));
  try {
    const signed = makeXpi(dir, signedFiles());
    const { zip } = packageSigned(signed, { outDir: dir });
    // ditto unpacks zips the way Archive Utility does when you double-click one in Finder.
    assert.equal(spawnSync('ditto', ['-x', '-k', zip, join(dir, 'opened')]).status, 0);
    const opened = join(dir, 'opened', 'family-site-blocker-9.8.7.xpi');
    assert.ok(readFileSync(opened).equals(readFileSync(signed)), 'the .xpi comes out unchanged');
    const xattr = (name) => spawnSync('xattr', ['-px', name, opened], { encoding: 'utf8' }).stdout.replace(/\s/g, '').toLowerCase();
    assert.equal(xattr('com.apple.FinderInfo').slice(16, 20), '0400', 'Finder flags: has a custom icon');
    const sidecar = readZip(readFileSync(zip)).get('__MACOSX/._family-site-blocker-9.8.7.xpi').data;
    assert.equal(xattr('com.apple.ResourceFork'), sidecar.subarray(82).toString('hex'), 'the icon is in the resource fork');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Firefox lock installs and locks this add-on and closes the ways round it', () => {
  const policies = firefoxPolicies();
  // The newest signed version on the update site, under a name that never changes, over https.
  assert.equal(XPI_URL, `${SITE_URL}${LATEST_NAME}`);
  assert.equal(XPI_URL, LATEST_URL);
  assert.ok(XPI_URL.startsWith('https://'));
  assert.deepEqual(policies.Extensions, { Install: [XPI_URL], Locked: [manifest.browser_specific_settings.gecko.id] });
  assert.deepEqual(firefoxPolicies('http://updates.test/x.xpi').Extensions.Install, ['http://updates.test/x.xpi'], 'the tests install from their stand-in site');
  for (const key of ['DisablePrivateBrowsing', 'DisableSafeMode', 'BlockAboutConfig', 'DisableProfileRefresh', 'ExtensionUpdate']) {
    assert.equal(policies[key], true, key);
  }
  assert.deepEqual(policies.Preferences, { 'extensions.dnr.enabled': { Value: true, Status: 'locked' } });
});

test("the Firefox lock leaves alone the policy other blockers lock their own add-ons with", () => {
  // Firefox takes each policy from one place: if the profile set ExtensionSettings, another blocker's
  // ExtensionSettings (Plucky's, for one) would be dropped, and its add-ons with it.
  assert.deepEqual(Object.keys(firefoxPolicies()).sort(), [
    'BlockAboutConfig', 'DisablePrivateBrowsing', 'DisableProfileRefresh', 'DisableSafeMode', 'ExtensionUpdate', 'Extensions', 'Preferences', 'WebsiteFilter',
  ]);
});

test("the Firefox lock gives Firefox its own copy of the built-in list, which blocks with add-ons off (Troubleshoot Mode)", () => {
  const { WebsiteFilter } = firefoxPolicies();
  const { domains } = loadBlocklists();
  const starter = parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'starter.txt'), 'utf8')).domains;
  assert.deepEqual(Object.keys(WebsiteFilter), ['Block'], 'no exceptions');
  assert.equal(WebsiteFilter.Block[0], '*://*.exampleadultsite.com/*', 'the test case comes first');
  assert.deepEqual(WebsiteFilter.Block.slice(0, starter.length), starter.map(filterPattern), 'then the rest of starter.txt');
  assert.equal(WebsiteFilter.Block.length, Math.min(domains.length, FILTER_LIMIT));
  const builtIn = new Set(domains.map(filterPattern));
  for (const pattern of WebsiteFilter.Block) assert.ok(builtIn.has(pattern), `${pattern} is a built-in site`);
});

test("Firefox's own copy takes starter.txt first, then the other lists, and stops at Firefox's limit of 1,000", () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-lists-'));
  try {
    writeFileSync(join(dir, 'a-community.txt'), Array.from({ length: 1200 }, (_, i) => `0.0.0.0 site${i}.com`).join('\n'));
    writeFileSync(join(dir, 'starter.txt'), '# mine\nexampleadultsite.com\nwww.second.com\nsite5.com\n');
    const { sites, leftOut } = filterSites(dir);
    assert.deepEqual(sites.slice(0, 4), ['exampleadultsite.com', 'second.com', 'site5.com', 'site0.com']);
    assert.equal(sites.length, FILTER_LIMIT);
    assert.equal(new Set(sites).size, FILTER_LIMIT, 'each site once');
    assert.equal(sites.length + leftOut.length, 1202, 'site5.com counted once');
    assert.equal(leftOut.length, 202);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mac/family-site-blocker-firefox.mobileconfig is up to date with blocklists/ (run npm run build)', () => {
  const profile = readFileSync(PROFILE_PATH, 'utf8');
  assert.equal(profile, mobileconfig());
  assert.match(profile, /<key>PayloadScope<\/key>\s*<string>System<\/string>/, 'applies to every account');
  assert.match(profile, /<key>EnterprisePoliciesEnabled<\/key>\s*<true\/>/, 'Firefox only reads its Mac settings with this');
  assert.match(profile, /<key>WebsiteFilter<\/key>\s*<dict>\s*<key>Block<\/key>\s*<array>\s*<string>\*:\/\/\*\.exampleadultsite\.com\/\*<\/string>/);
});

test('every file the pages reference exists', () => {
  const pages = readdirSync(EXT).filter((name) => name.endsWith('.html'));
  assert.deepEqual(pages.sort(), ['attempts.html', 'blocked.html', 'options.html']);
  for (const page of pages) {
    const html = readFileSync(join(EXT, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      assert.ok(existsSync(join(EXT, ref)), `${page} references missing ${ref}`);
    }
  }
});

test('module imports resolve', () => {
  for (const file of ['background.js', 'options.js', 'attempts.js', 'lockbox.js', 'lockbox-worker.js', 'lib/attempts.js', 'lib/domains.js', 'lib/mylist.js', 'lib/rules.js', 'lib/safesearch.js', 'lib/suspects.js', 'lib/timelock.js']) {
    const source = readFileSync(join(EXT, file), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      assert.ok(existsSync(resolve(EXT, dirname(file), specifier)), `${file} imports missing ${specifier}`);
    }
  }
});

test('extension scripts have no syntax errors', () => {
  for (const file of ['background.js', 'blocked.js', 'options.js', 'attempts.js', 'lockbox.js', 'lockbox-worker.js', 'lib/attempts.js', 'lib/domains.js', 'lib/mylist.js', 'lib/rules.js', 'lib/safesearch.js', 'lib/suspects.js', 'lib/timelock.js']) {
    const run = spawnSync(process.execPath, ['--check', join(EXT, file)], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  }
});
