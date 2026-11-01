// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FROM_HISTORY, LABELS, MAX_ATTEMPTS, SAME_ATTEMPT_MS, bookmarksTo, bySite, hostOf, listedDomain, mergeVisits, offDuring, outcome as whatHappened, record, summarize, timeline, toCsv } from '../extension/lib/attempts.js';
import { offVisitsWords, offWords, spanWords } from '../extension/lib/page.js';
import { GAP_MS, MAX_OFF, MAX_PERIODS, WRITE_EVERY_MS, beat, earliestLiveTry, gapsOf, kindOfVisit, normalize, noteGaps, started, wasRunning } from '../extension/lib/watching.js';
import { normalizeDomain, parseDomainList } from '../extension/lib/domains.js';
import { MAX_UNLISTED, looksAdult, siteOf, tallyUnlisted } from '../extension/lib/suspects.js';
import { addToMyList, myList, saveMyList } from '../extension/lib/mylist.js';
import { BLOCK_PAGE, CHUNK_SIZE, buildRules, domainsOf } from '../extension/lib/rules.js';
import { BLOCKLIST_DIR, DOMAINS_PATH, MANIFEST_PATH, MAX_RULESET_BYTES, NEVER_FILE, RULES_DIR, SAFE_SEARCH_PATH, formatManifest, listFiles, loadBlocklists, loadNever, loadRules, renderDomains, renderRulesets, renderSafeSearch, ruleResources } from '../scripts/build-rules.mjs';
import { ENGINES, FIRST_ID, YOUTUBE, safeSearchAddress, safeSearchRules } from '../extension/lib/safesearch.js';
import { BANDS, COMMUNITY_PATH, COMMUNITY_URL, LINKS_URL, POPULAR_PATH, POPULAR_SIZE, POPULAR_URL, communityList, inOrder, linkRanks, looksAdult as nameLooksAdult, popularList, rankSites, worthALook } from '../scripts/update-blocklist.mjs';
import { firefoxManifest, packageFirefox } from '../scripts/package-firefox.mjs';
import { AGENT_LABEL, AGENT_PATH, FILTER_LIMIT, PROFILE_PATH, SAFE_MODE_KEY_VARIABLE, STAMP_PATH, VERSION as LOCK_VERSION, WHOLE_DOMAINS, XPI_URL, filterEntries, filterPattern, filterSites, firefoxPolicies, launchAgent, lockStamp, mobileconfig, onWholeDomain } from '../scripts/firefox-lock.mjs';
import { STAMP } from '../extension/lib/lock.js';
import { AGENT_INSTALLED_PATH, PKG_IDENTIFIER, TITLE, VERSION as INSTALLER_VERSION, buildInstaller, conclusion, distribution, pkgName, postinstall, welcome } from '../scripts/mac-installer.mjs';
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
// nuisance: these must never appear, nor the sites blocklists/never.txt names, which the build takes out
// (ordinary sites the list does carry). Add to one or the other when a mistake turns up, and pick a
// different list if the maintainers don't fix it.
const NEVER_LISTED = [
  'wikipedia.org', 'google.com', 'bing.com', 'duckduckgo.com', 'youtube.com', 'reddit.com', 'tumblr.com', 'twitter.com', 'x.com',
  'imgur.com', 'flickr.com', 'deviantart.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'vimeo.com', 'dailymotion.com',
  'discord.com', 'telegram.org', 'archive.org', 'github.com', 'stackoverflow.com', 'medium.com', 'substack.com', 'patreon.com',
  'fandom.com', 'quora.com', 'wattpad.com', 'twitch.tv', 'spotify.com', 'netflix.com', 'amazon.com', 'ebay.com', 'etsy.com', 'apple.com',
  'plannedparenthood.org', 'webmd.com', 'mayoclinic.org', 'healthline.com', 'scarleteen.com', 'mozilla.org', 'example.com', 'allowed.test',
  'b-cdn.net', 'cloudfront.net', 'akamaihd.net', 'googleusercontent.com', 'blogspot.com', 'wordpress.com', 'github.io',
  ...loadNever(),
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

test('blocklists/never.txt takes its sites out of the built-in list, each one alone, and is not a list of sites to block', () => {
  const never = loadNever();
  assert.ok(never.has('b-cdn.net'), 'the content network the community list sweeps up as www.b-cdn.net');
  assert.ok(never.has('refinery29.com'));
  assert.ok(!listFiles().includes(NEVER_FILE), 'never.txt is not read as a blocklist');
  const { domains, never: takenOut } = loadBlocklists();
  for (const site of never) assert.ok(!domains.includes(site), `${site} is off the list`);
  assert.ok(takenOut.includes('b-cdn.net'), 'reported as taken out');
  assert.ok(domains.includes('javpub.b-cdn.net'), 'a host listed under it on its own stays blocked');
  assert.ok(domains.includes('xxx.startpagina.nl'));
  assert.equal(outcome('https://cdn.example-shop.b-cdn.net/style.css', 'stylesheet'), 'allow', 'Bunny CDN loads');
  assert.equal(outcome('https://javpub.b-cdn.net/x.jpg', 'image'), 'block');
  assert.equal(outcome('https://www.refinery29.com/'), 'allow');
  assert.equal(outcome('https://xxx.startpagina.nl/'), 'redirect');
  // A folder with no never.txt, and one whose never.txt names a site no list has.
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-never-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'one.test\ntwo.test\nwww.cdn.test\nporn.cdn.test\n');
    assert.deepEqual(loadBlocklists(dir), { files: ['a.txt'], domains: ['cdn.test', 'one.test', 'porn.cdn.test', 'two.test'], invalid: [], never: [] });
    writeFileSync(join(dir, NEVER_FILE), '# why\ncdn.test  # a content network\nnot-listed.test\n');
    assert.deepEqual(loadBlocklists(dir), { files: ['a.txt'], domains: ['one.test', 'porn.cdn.test', 'two.test'], invalid: [], never: ['cdn.test'] });
    assert.deepEqual([...loadNever(dir)], ['cdn.test', 'not-listed.test']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rankSites gives each listed site the best band of the ranked origins on or under it, credited to the shortest listed domain", () => {
  const csv = [
    'origin,rank',
    'https://www.google.com,1000',
    'https://es.pornhub.com,1000', // counts for pornhub.com, which blocks it too
    'https://pornhub.com,5000',
    'https://tik.porn,5000',
    'https://only-sub.example.net,10000', // only the subdomain is listed
    'https://deep.only-sub.example.net,50000',
    'http://plain.test,100000',
    'https://unlisted.test,1000',
    'not an origin,1000',
    'https://odd.test,42', // not a band
    '',
  ].join('\n');
  const listed = new Set(['pornhub.com', 'es.pornhub.com', 'tik.porn', 'only-sub.example.net', 'plain.test', 'quiet.test']);
  const ranks = rankSites(csv, listed);
  assert.deepEqual([...ranks], [['pornhub.com', 1000], ['tik.porn', 5000], ['only-sub.example.net', 10_000], ['plain.test', 100_000]]);
  assert.deepEqual(BANDS, [1000, 5000, 10_000, 50_000, 100_000, 500_000, 1_000_000]);
  // Within a band, the Majestic Million decides (linkRanks, credited the same way), unranked sites last.
  const majestic = [
    'GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs',
    '2980,2400,pornhub.com,com,1,1,pornhub.com,com,1,1,1,1',
    '563058,229228,toppornsites.com,com,254,277,toppornsites.com,com,-1,-1,-1,-1',
    '700,600,google.com,com,1,1,google.com,com,1,1,1,1',
    '9000,100,es.pornhub.com,com,1,1,es.pornhub.com,com,1,1,1,1', // counts for pornhub.com, which already has better
    '12,1,deep.only-sub.example.net,net,1,1,x,net,1,1,1,1',
    'bad line',
    '',
  ].join('\n');
  const links = linkRanks(majestic, new Set([...listed, 'toppornsites.com']));
  assert.deepEqual([...links], [['pornhub.com', 2980], ['toppornsites.com', 563_058], ['only-sub.example.net', 12]]);
  const band = new Map([['zzz.test', 50_000], ['toppornsites.com', 50_000], ['aaa.test', 50_000], ['pornhub.com', 1000], ['bbb.test', 100_000]]);
  assert.deepEqual(inOrder(band, links).map(([domain]) => domain), ['pornhub.com', 'toppornsites.com', 'aaa.test', 'zzz.test', 'bbb.test'], 'band, then links, then the alphabet');
  assert.deepEqual(inOrder(band).map(([domain]) => domain), ['pornhub.com', 'aaa.test', 'toppornsites.com', 'zzz.test', 'bbb.test'], 'with no link ranks, the alphabet');
  // popularList() is what npm run blocklist writes: a note with the sources, then the sites in order with their bands.
  const many = new Map(Array.from({ length: 150 }, (_, i) => [`site${String(i).padStart(3, '0')}.test`, BANDS[i % BANDS.length]]));
  const written = popularList(many, new Map([['site063.test', 777]]), new Date('2026-10-23T12:00:00Z'), 10);
  assert.match(written, /^# Popular sites: .*\n# Made by npm run blocklist from the Chrome UX Report/);
  assert.ok(written.includes(POPULAR_URL) && written.includes(LINKS_URL));
  assert.match(written, /^# Fetched 2026-10-23; 10 of the 150 built-in sites Chrome ranks, 1 of them in the Majestic Million\.$/m);
  const lines = written.trimEnd().split('\n').filter((line) => !line.startsWith('#') && line);
  assert.equal(lines.length, 10);
  assert.match(lines[0], /^site063\.test\s+# top 1,000; links 777$/, 'the one with a link rank leads its band');
  assert.match(lines[1], /^site000\.test\s+# top 1,000$/);
  assert.match(lines[9], /^site056\.test\s+# top 1,000$/, 'the ten in the first band');
  assert.deepEqual(parseDomainList(written).domains, lines.map((line) => line.split(/\s/)[0]));
  assert.throws(() => popularList(new Map([['a.test', 1000]])), /Only 1 built-in sites/);
  // worthALook: the sites in the top bands with nothing adult in their names, never.txt's aside.
  const ranked = new Map([['refinery29.com', 1000], ['pornhub.com', 1000], ['kinopoisk.ru', 5000], ['xhamster.com', 1000], ['plain.test', 50_000], ['dmm.co.jp', 10_000]]);
  assert.deepEqual(worthALook(ranked, new Set(['kinopoisk.ru'])), ['refinery29.com', 'dmm.co.jp']);
  for (const name of ['refinery29.com', 'kinopoisk.ru', 'yandex.by', 'startpagina.nl', 'postimage.org', 'btc.com', 'findicons.com', 'xyzprinting.com', 'aquoid.com', 'gmpg.org', 'b-cdn.net']) {
    assert.equal(nameLooksAdult(name), false, `${name} would be shown`);
  }
  for (const name of ['pornhub.com', 'xvideos.com', 'chaturbate.com', 'spankbang.com', 'tik.porn', 'sex.com', 'x-art.com']) assert.equal(nameLooksAdult(name), true, name);
});

test('blocklists/popular.txt orders built-in sites by how much they are visited, for the lock, and adds none', () => {
  const file = readFileSync(POPULAR_PATH, 'utf8');
  assert.match(file, /^# Popular sites: /);
  assert.match(file, /^# Fetched \d{4}-\d{2}-\d{2}; \d+ of the \d+ built-in sites Chrome ranks, \d+ of them in the Majestic Million\.$/m);
  const popular = parseDomainList(file).domains;
  assert.ok(popular.length > 1000 && popular.length <= POPULAR_SIZE, `${popular.length} sites`);
  const starter = new Set(parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'starter.txt'), 'utf8')).domains);
  const community = new Set(parseDomainList(readFileSync(COMMUNITY_PATH, 'utf8')).domains);
  const never = loadNever();
  for (const site of popular) {
    assert.ok(starter.has(site) || community.has(site), `${site} is on a list already`);
    assert.ok(!never.has(site), `${site} is not in never.txt`);
  }
  assert.ok(popular.includes('pornhub.com') && popular.includes('xvideos.com') && popular.includes('tik.porn'));
  const notes = file.match(/# top ([\d,]+)(?:; links ([\d,]+))?$/gm);
  assert.equal(notes.length, popular.length, 'each site has its band');
  const bands = notes.map((note) => Number(note.match(/top ([\d,]+)/)[1].replace(/,/g, '')));
  const linkRank = (note) => (note.includes('links') ? Number(note.match(/links ([\d,]+)/)[1].replace(/,/g, '')) : Infinity);
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i] >= bands[i - 1], 'best band first');
    if (bands[i] === bands[i - 1]) assert.ok(linkRank(notes[i]) >= linkRank(notes[i - 1]), `within a band, best link rank first (${notes[i - 1]} / ${notes[i]})`);
  }
  assert.equal(bands[0], 1000);
  // #64: a site in the last band that fits owes its place to its link rank, not the alphabet.
  assert.ok(filterSites().sites.includes('toppornsites.com'), "toppornsites.com is in Firefox's copy");
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

test('blocked attempts: notes are added oldest first, repeats within two seconds are one attempt (a visit from the history is not one), and a page that opens marks its attempt', () => {
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
  // A visit found in the history (mergeVisits) a moment before a try is not the browser reporting that try
  // again: the try is noted after it (#125). The other order, the history's copy of a live try, is left out
  // by mergeVisits, below.
  const visited = [{ at: t, site: 'a.test', from: 'history' }];
  const tried = record(visited, { at: t + 700, site: 'a.test' });
  assert.deepEqual(tried, [{ at: t, site: 'a.test', from: 'history' }, { at: t + 700, site: 'a.test' }], 'a try right after a visit from the history is new');
  assert.equal(record(tried, { at: t + 900, site: 'a.test' }), null, 'and its second report is the same try');
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
    { site: 'a.test', tries: 3, first: noon - day + 60_000, last: noon + 2000, opened: 1, history: 0, off: 0 },
    { site: 'b.test', tries: 2, first: noon - 3 * day, last: noon - day, opened: 1, history: 1, off: 0 },
    { site: 'c.test', tries: 1, first: noon + 1000, last: noon + 1000, opened: 0, history: 0, off: 0 },
  ]);
  // With the times the extension was running known, a visit from the history in a silence counts as from a time it was off.
  const watching = { since: noon - 4 * day, periods: [{ from: noon - 4 * day, to: noon - 3 * day - 3600_000 }, { from: noon - 3 * day + 3600_000, to: noon + 5000 }] };
  assert.equal(bySite(attempts, watching)[1].off, 1, 'b.test was visited while the extension was off');
  assert.deepEqual(summarize(attempts, watching), {
    tries: 6, sites: 3, latest: noon + 2000, opened: 2, history: 1, off: 1, unlisted: 0, unseen: 0, latestOff: noon - 3 * day, latestUnseen: null,
  });
  assert.deepEqual(summarize([]), { tries: 0, sites: 0, latest: null, opened: 0, history: 0, off: 0, unlisted: 0, unseen: 0, latestOff: null, latestUnseen: null });
  const days = timeline(attempts);
  assert.deepEqual(
    days.map(({ day: start, entries }) => [new Date(start).toDateString(), entries.map((entry) => entry.attempt.site)]),
    [
      ['Sun Oct 18 2026', ['a.test', 'c.test', 'a.test']],
      ['Sat Oct 17 2026', ['a.test', 'b.test']],
      ['Thu Oct 15 2026', ['b.test']],
    ],
  );
  assert.equal(new Date(days[0].day).getHours(), 0, 'each day starts at midnight');
  assert.ok(days.every(({ entries }) => entries.every((entry) => entry.attempt && entry.during === null)), 'with no time off known, every entry is a try');
  assert.deepEqual(bySite([]), []);
  assert.deepEqual(timeline(undefined), []);
  assert.deepEqual(attempts.map((attempt) => whatHappened(attempt)), ['history', 'blocked', 'opened', 'blocked', 'blocked', 'opened']);
  assert.deepEqual(Object.keys(LABELS).sort(), ['blocked', 'history', 'off', 'opened', 'unlisted', 'unseen']);
  assert.deepEqual([...FROM_HISTORY].sort(), ['history', 'off', 'unlisted', 'unseen']);
});

test('the timeline lays the times the add-on was off among the tries, by day, newest first, each before the tries made inside it', () => {
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, in this computer's time zone
  const off = [
    { from: at(20, 21, 12), to: at(20, 23, 40), pages: 24 }, // an evening
    { from: at(22, 23), to: at(23, 1, 12), pages: 3 }, // across midnight
    { from: at(25, 0), to: at(26, 0), pages: 1 }, // a whole day, ending on the stroke of midnight
  ];
  const watching = {
    since: at(1, 9),
    periods: [{ from: at(1, 9), to: at(20, 21, 12) }, { from: at(20, 23, 40), to: at(22, 23) }, { from: at(23, 1, 12), to: at(25, 0) }, { from: at(26, 0), to: at(27, 12) }],
    off,
  };
  const attempts = [
    { at: at(20, 20), site: 'a.test' },
    { at: at(20, 22), site: 'a.test', from: 'history' },
    { at: at(20, 23, 50), site: 'b.test' },
    { at: at(22, 23, 30), site: 'a.test', from: 'history' },
    { at: at(23, 0, 30), site: 'a.test', from: 'history' },
    { at: at(27, 11), site: 'a.test' },
  ];
  const days = timeline(attempts, watching);
  const stamp = (ms) => `${new Date(ms).getDate()}@${new Date(ms).getHours()}`;
  const shape = (entry) => (entry.attempt ? `${entry.attempt.site}${entry.during ? ' (off)' : ''}` : `off ${stamp(entry.from)}-${stamp(entry.to)}`);
  assert.deepEqual(
    days.map(({ day, entries }) => [new Date(day).toDateString(), entries.map(shape)]),
    [
      ['Tue Oct 27 2026', ['a.test']],
      ['Sun Oct 25 2026', ['off 25@0-26@0']],
      ['Fri Oct 23 2026', ['off 23@0-23@1', 'a.test (off)']],
      ['Thu Oct 22 2026', ['off 22@23-23@0', 'a.test (off)']],
      ['Tue Oct 20 2026', ['b.test', 'off 20@21-20@23', 'a.test (off)', 'a.test']],
    ],
  );
  assert.deepEqual(days[1].entries[0].off, off[2], 'the time as stored');
  assert.equal(days[1].entries[0].at, at(26, 0), 'sorted by the end of its part of the day');
  assert.deepEqual(days[2].entries[0].off, off[1]);
  assert.deepEqual(days[3].entries[0].off, off[1], 'the same time, in the other day it touches');
  assert.deepEqual([days[3].entries[0].from, days[3].entries[0].to], [at(22, 23), at(23, 0)]);
  assert.deepEqual(days[4].entries[2].during, off[0], 'a try inside a time the add-on was off says which');
  assert.equal(days[4].entries[0].during, null, 'a try after it');
  assert.deepEqual(timeline([], watching).map(({ entries }) => entries.length), [1, 1, 1, 1], 'days with only a time off are days all the same, the one across midnight in two');
  assert.deepEqual(timeline(attempts, null).map(({ entries }) => entries.length), [1, 1, 1, 3], 'with nothing known, tries alone');
  assert.deepEqual(offDuring(off, at(20, 22)), off[0]);
  assert.equal(offDuring(off, at(20, 21, 12)), null, 'the stroke it went off is the last beat of the add-on running');
  assert.equal(offDuring(off, at(20, 23, 40)), null, 'and the stroke it came back is the first');
  assert.equal(offDuring(off, at(21, 12)), null);
  assert.equal(offDuring(undefined, at(20, 22)), null);
});

test('the words for the times the add-on was off, shared by the record page and Every try', () => {
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
  const one = [{ from: at(20, 21, 12), to: at(20, 23, 40), pages: 24 }];
  assert.equal(spanWords(one[0].from, one[0].to), `${when.format(one[0].from)} until ${time.format(one[0].to)}`);
  assert.equal(spanWords(at(22, 23), at(23, 1)), `${when.format(at(22, 23))} until ${when.format(at(23, 1))}`, 'the day of the end, when it is another');
  assert.equal(offWords([]), '');
  assert.equal(offWords(one), `Off once, from ${when.format(one[0].from)} until ${time.format(one[0].to)}: 24 pages visited meanwhile.`);
  const two = [...one, { from: at(22, 23), to: at(23, 1), pages: 1 }];
  assert.equal(offWords(two), `Off twice, the latest from ${when.format(at(22, 23))} until ${when.format(at(23, 1))}: 1 page visited meanwhile.`);
  const three = [{ from: at(25, 0), to: at(25, 2), pages: 0 }, ...two]; // in no order, the latest without pages
  assert.equal(offWords(three), `Off 3 times, the latest from ${when.format(at(25, 0))} until ${time.format(at(25, 2))}.`);
  const none = { off: 0, latestOff: null };
  assert.equal(offVisitsWords([], none, false), '', 'before the add-on kept track of when it was running');
  assert.equal(offVisitsWords([], none, true), "No time found when this browser was in use while the extension wasn't running.");
  assert.equal(offVisitsWords(one, none, true), 'No visit to a listed site found from then.');
  assert.equal(offVisitsWords(two, none, true), 'No visit to a listed site found from those times.');
  assert.equal(offVisitsWords(one, { off: 2, latestOff: at(20, 22) }, true), `2 visits to listed sites while the extension was off, the latest on ${when.format(at(20, 22))}.`);
  assert.equal(offVisitsWords([], { off: 1, latestOff: at(20, 22) }, false), `1 visit to a listed site while the extension was off, the latest on ${when.format(at(20, 22))}.`);
});

test('watching: the first start is noted once, exactly on an install and as "at least" for a profile that had an earlier version', () => {
  const t = 1_700_000_000_000;
  assert.deepEqual(started(undefined, t), { since: t, periods: [], off: [] });
  assert.deepEqual(started({ since: t }, t + 5, { atLeast: true }), { since: t, periods: [], off: [] }, 'known already: unchanged');
  assert.deepEqual(started(null, t - 86_400_000, { atLeast: true }), { since: t - 86_400_000, atLeast: true, periods: [], off: [] });
  assert.deepEqual(started({}, NaN), { periods: [], off: [] }, 'no time, no start');
  // The earliest try an earlier version noted as it happened stands in for the install date; visits from the history don't count.
  assert.equal(earliestLiveTry([{ at: t - 10, site: 'a.test', from: 'history' }, { at: t + 500, site: 'b.test' }, { at: t + 100, site: 'a.test', opened: true }]), t + 100);
  assert.equal(earliestLiveTry([{ at: t, site: 'a.test', from: 'history' }]), null);
  assert.equal(earliestLiveTry(undefined), null);
  // Whatever is stored comes back well formed.
  assert.deepEqual(normalize({ since: t, atLeast: 1, periods: [{ from: t, to: t - 1 }, { from: t, to: t + 1, extra: true }, 'junk'], off: [{ from: t, to: t + 1 }] }), {
    since: t, atLeast: true, periods: [{ from: t, to: t + 1 }], off: [{ from: t, to: t + 1, pages: 0 }],
  });
  assert.deepEqual(normalize('not a state'), { periods: [], off: [] });
});

test('watching: beats within the gap extend the current stretch, and a longer silence starts a new one; stretches are written sparingly', () => {
  const t = 1_700_000_000_000;
  // The background script writes the state only when `changed` says so, and reads it back before each beat.
  let stored;
  const beatAt = (now) => {
    const { state, changed } = beat(stored, now);
    if (changed) stored = state;
    return { state, changed };
  };
  let { state, changed } = beatAt(t);
  assert.deepEqual(state, { periods: [{ from: t, to: t }], off: [] });
  assert.equal(changed, true, 'a new stretch is always written');
  ({ state, changed } = beatAt(t + 5000));
  assert.deepEqual(state.periods, [{ from: t, to: t + 5000 }]);
  assert.equal(changed, false, 'a stretch that grew by less than WRITE_EVERY_MS can wait');
  assert.deepEqual(stored.periods, [{ from: t, to: t }]);
  ({ state, changed } = beatAt(t + WRITE_EVERY_MS));
  assert.equal(changed, true);
  assert.deepEqual(stored.periods, [{ from: t, to: t + WRITE_EVERY_MS }]);
  ({ state, changed } = beatAt(t + WRITE_EVERY_MS + GAP_MS)); // exactly the gap after the stored end: still the same stretch
  assert.deepEqual(state.periods, [{ from: t, to: t + WRITE_EVERY_MS + GAP_MS }]);
  assert.equal(changed, true);
  ({ state, changed } = beatAt(t + WRITE_EVERY_MS + 2 * GAP_MS + 1));
  const second = t + WRITE_EVERY_MS + 2 * GAP_MS + 1;
  assert.deepEqual(state.periods, [{ from: t, to: t + WRITE_EVERY_MS + GAP_MS }, { from: second, to: second }], 'a silence longer than the gap ends the stretch');
  assert.equal(changed, true);
  assert.deepEqual(beat(state, second - 60_000).state, state, 'a clock set back changes nothing');
  assert.deepEqual(beat(state, NaN), { state, changed: false });
  assert.deepEqual(beat({ since: t, periods: [] }, t).state, { since: t, periods: [{ from: t, to: t }], off: [] }, 'what else is known stays');
  // Only the newest MAX_PERIODS stretches are kept.
  let many = undefined;
  for (let i = 0; i < MAX_PERIODS + 3; i += 1) many = beat(many, t + i * (GAP_MS + 1) * 2).state;
  assert.equal(many.periods.length, MAX_PERIODS);
  assert.equal(many.periods[0].from, t + 3 * (GAP_MS + 1) * 2, 'the oldest went');
});

test('watching: the silences between stretches are gaps; one with pages in it is a time the add-on was off, one without is closed up', () => {
  const t = 1_700_000_000_000;
  const h = 3600_000;
  const state = { since: t, periods: [{ from: t, to: t + h }, { from: t + 2 * h, to: t + 3 * h }, { from: t + 4 * h, to: t + 5 * h }, { from: t + 6 * h, to: t + 7 * h }] };
  assert.deepEqual(gapsOf(state), [{ from: t + h, to: t + 2 * h }, { from: t + 3 * h, to: t + 4 * h }, { from: t + 5 * h, to: t + 6 * h }]);
  assert.deepEqual(gapsOf(undefined), []);
  assert.deepEqual(gapsOf({ periods: [{ from: t, to: t + h }] }), []);
  // The first silence: the browser was closed. The second: 14 pages visited, the add-on off. The third: the
  // history holds nothing, but the record has a visit to a listed site from then (taken out of the history).
  const noted = noteGaps(state, [
    { from: t + h, to: t + 2 * h, pages: 0, listed: 0 },
    { from: t + 3 * h, to: t + 4 * h, pages: 14, listed: 2 },
    { from: t + 5 * h, to: t + 6 * h, pages: 0, listed: 1 },
    { from: t + 8 * h, to: t + 9 * h, pages: 5, listed: 0 }, // not a silence the state has: ignored
    { from: 'x', to: t, pages: 1 }, // not a span: ignored
  ]);
  assert.deepEqual(noted, {
    since: t,
    periods: [{ from: t, to: t + 3 * h }, { from: t + 4 * h, to: t + 5 * h }, { from: t + 6 * h, to: t + 7 * h }],
    off: [{ from: t + 3 * h, to: t + 4 * h, pages: 14 }, { from: t + 5 * h, to: t + 6 * h, pages: 0 }],
  });
  assert.deepEqual(gapsOf(noted), [{ from: t + 3 * h, to: t + 4 * h }, { from: t + 5 * h, to: t + 6 * h }], 'the times it was off stay gaps');
  // Looked at again: the same findings change nothing, and the same object comes back.
  assert.equal(noteGaps(noted, [{ from: t + 3 * h, to: t + 4 * h, pages: 14, listed: 2 }]), noted);
  // More pages found (an earlier look happened before the history had been written out): the note is brought up to date.
  assert.deepEqual(noteGaps(noted, [{ from: t + 3 * h, to: t + 4 * h, pages: 20, listed: 2 }]).off[0], { from: t + 3 * h, to: t + 4 * h, pages: 20 });
  // The history cleared since: a time the add-on was off is not forgotten, and the silence is not closed up.
  const cleared = noteGaps(noted, [{ from: t + 3 * h, to: t + 4 * h, pages: 0, listed: 0 }]);
  assert.equal(cleared, noted);
  assert.deepEqual(noteGaps(undefined, []), { periods: [], off: [] });
  // Only the newest MAX_OFF are kept.
  const manyPeriods = Array.from({ length: MAX_OFF + 4 }, (_, i) => ({ from: t + i * 2 * h, to: t + i * 2 * h + h }));
  const full = noteGaps({ periods: manyPeriods }, gapsOf({ periods: manyPeriods }).map((gap) => ({ ...gap, pages: 1, listed: 0 })));
  assert.equal(full.off.length, MAX_OFF);
  assert.equal(full.off[0].from, manyPeriods[3].to, 'the oldest went');
});

test('watching: a visit from the history is placed by when the add-on was running: before the install, off, running (so the site was not listed), or not known', () => {
  const t = 1_700_000_000_000;
  const h = 3600_000;
  const exact = { since: t, periods: [{ from: t, to: t + h }, { from: t + 2 * h, to: t + 3 * h }] };
  assert.equal(wasRunning(exact, t - 1), null, 'before anything was kept');
  assert.equal(wasRunning(exact, t), true);
  assert.equal(wasRunning(exact, t + h), true, 'the end of a stretch is in it');
  assert.equal(wasRunning(exact, t + h + 1), false);
  assert.equal(wasRunning(exact, t + 3 * h + GAP_MS), true, "just after the last stretch's stored end: the stretch is still going, its end not written yet");
  assert.equal(wasRunning(exact, t + 3 * h + GAP_MS + 1), false, 'longer after it than the gap: a silence');
  assert.equal(wasRunning(undefined, t), null);
  assert.equal(wasRunning(exact, NaN), null);
  assert.deepEqual([t - 1, t + 30 * 60_000, t + 90 * 60_000, t + 4 * h].map((at) => kindOfVisit(exact, at)), ['before', 'unlisted', 'off', 'off']);
  // A profile that had an earlier version: the first try it noted is the earliest the add-on is known to
  // have run, and this version started keeping track later; between the two, nothing is known.
  const atLeast = { since: t - 5 * h, atLeast: true, periods: [{ from: t, to: t + h }] };
  assert.deepEqual([t - 6 * h, t - h, t + 1, t + 2 * h].map((at) => kindOfVisit(atLeast, at)), ['before', 'unseen', 'unlisted', 'off']);
  assert.equal(kindOfVisit(undefined, t), 'before', 'nothing known: as it was before 1.11.0');
  assert.equal(kindOfVisit({ periods: [{ from: t, to: t + h }] }, t + 1), 'before', 'no first start known either');
  // outcome() carries the kinds, and toCsv names them.
  const attempts = [
    { at: t - 1, site: 'a.test', from: 'history' },
    { at: t + 1, site: 'a.test', from: 'history' },
    { at: t + 90 * 60_000, site: 'a.test', from: 'history' },
    { at: t + 90 * 60_000 + 5000, site: 'a.test' },
    { at: t + 2 * h + 1, site: 'a.test', opened: true },
  ];
  assert.deepEqual(attempts.map((attempt) => whatHappened(attempt, exact)), ['history', 'unlisted', 'off', 'blocked', 'opened']);
  assert.deepEqual(attempts.map((attempt) => whatHappened(attempt, atLeast)), ['unseen', 'unlisted', 'off', 'blocked', 'opened']);
  const csv = toCsv(attempts, exact).split('\n');
  assert.match(csv[1], /,a\.test,Visited \(browser history\)$/);
  assert.match(csv[2], /,a\.test,Visited before the site was listed$/);
  assert.match(csv[3], /,a\.test,Visited while the add-on was off$/);
  assert.match(toCsv(attempts, atLeast).split('\n')[1], /,a\.test,Visited after the add-on was installed$/);
  // mergeVisits with a wider window, as the sweep after a live try uses: the page of a site that got through
  // is written to the history when it finishes loading, and that is the same try.
  const live = [{ at: t, site: 'a.test', opened: true }];
  assert.equal(mergeVisits(live, [{ at: t + 70_000, site: 'a.test' }]).added, 1, 'two seconds: a new visit');
  assert.equal(mergeVisits(live, [{ at: t + 70_000, site: 'a.test' }], 300_000).added, 0, 'five minutes: the same try');
  assert.equal(mergeVisits(live, [{ at: t - 400_000, site: 'a.test' }], 300_000).added, 1);
  assert.equal(SAME_ATTEMPT_MS, 2000);
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
  // The developer tools are turned off by locking this pref, not with DisableDeveloperTools, which would also
  // lock remote.policy.disabled and so disable Marionette, which the lock's own e2e tests drive Firefox through (#86).
  assert.deepEqual(policies.Preferences, {
    'extensions.dnr.enabled': { Value: true, Status: 'locked' },
    'devtools.policy.disabled': { Value: true, Status: 'locked' },
  });
  assert.equal(policies.DisableDeveloperTools, undefined, 'not the broad policy: it would disable Marionette too');
  // The stamp that says which copy of the lock this is, as the add-on's managed storage (lib/lock.js reads it).
  assert.deepEqual(policies['3rdparty'], { Extensions: { [manifest.browser_specific_settings.gecko.id]: { [STAMP]: { version: manifest.version, entries: FILTER_LIMIT } } } });
  assert.equal(LOCK_VERSION, manifest.version, 'stamped with the version of the add-on it is built with');
  assert.deepEqual(lockStamp(['*://*.a.test/*', '*://*.b.test/*'], '9.8.7'), { version: '9.8.7', entries: 2 });
  assert.deepEqual(firefoxPolicies(XPI_URL, ['*://*.a.test/*'])['3rdparty'].Extensions[manifest.browser_specific_settings.gecko.id][STAMP].entries, 1, 'counts the entries it carries');
});

test("the Firefox lock leaves alone the policy other blockers lock their own add-ons with", () => {
  // Firefox takes each policy from one place: if the profile set ExtensionSettings, another blocker's
  // ExtensionSettings (Plucky's, for one) would be dropped, and its add-ons with it.
  assert.deepEqual(Object.keys(firefoxPolicies()).sort(), [
    '3rdparty', 'BlockAboutConfig', 'DisablePrivateBrowsing', 'DisableProfileRefresh', 'DisableSafeMode', 'ExtensionUpdate', 'Extensions', 'Preferences', 'WebsiteFilter',
  ]);
  // 3rdparty carries the stamp, for this add-on only. Firefox takes it whole from one place too, so another
  // program's 3rdparty (settings for its own add-ons) would be dropped: a limit the README states. Plucky doesn't set it.
  assert.deepEqual(Object.keys(firefoxPolicies()['3rdparty'].Extensions), [manifest.browser_specific_settings.gecko.id]);
});

test("the Firefox lock gives Firefox its own copy of the built-in list, which blocks with add-ons off (Troubleshoot Mode)", () => {
  const { WebsiteFilter } = firefoxPolicies();
  const { domains } = loadBlocklists();
  const starter = parseDomainList(readFileSync(join(BLOCKLIST_DIR, 'starter.txt'), 'utf8')).domains;
  const popular = parseDomainList(readFileSync(POPULAR_PATH, 'utf8')).domains;
  assert.deepEqual(Object.keys(WebsiteFilter), ['Block'], 'no exceptions');
  assert.deepEqual(WebsiteFilter.Block, filterEntries());
  assert.equal(WebsiteFilter.Block.length, FILTER_LIMIT, 'full');
  assert.equal(new Set(WebsiteFilter.Block).size, FILTER_LIMIT, 'each entry once');
  // Whole adult domains first, one entry each; then the test case and the rest of starter.txt.
  assert.deepEqual(WHOLE_DOMAINS, ['xxx', 'porn', 'sex', 'adult', 'sexy']);
  assert.deepEqual(WebsiteFilter.Block.slice(0, 5), ['*://*.xxx/*', '*://*.porn/*', '*://*.sex/*', '*://*.adult/*', '*://*.sexy/*']);
  assert.equal(WebsiteFilter.Block[5], '*://*.exampleadultsite.com/*', 'the test case comes first among the sites');
  const starterSites = starter.filter((site) => !onWholeDomain(site));
  assert.deepEqual(WebsiteFilter.Block.slice(5, 5 + starterSites.length), starterSites.map(filterPattern), 'then the rest of starter.txt');
  // Then popular.txt, in its order, leaving out the sites the whole domains cover (tik.porn is one).
  const rest = WebsiteFilter.Block.slice(5 + starterSites.length);
  const expected = popular.filter((site) => !starter.includes(site) && !onWholeDomain(site)).slice(0, rest.length).map(filterPattern);
  assert.deepEqual(rest, expected, 'then popular.txt in order');
  assert.ok(rest.length > 900, `${rest.length} from popular.txt`);
  assert.ok(popular.includes('tik.porn') && !WebsiteFilter.Block.includes('*://*.tik.porn/*'), 'covered by *.porn');
  const builtIn = new Set(domains.map(filterPattern));
  for (const pattern of WebsiteFilter.Block.slice(5)) assert.ok(builtIn.has(pattern), `${pattern} is a built-in site`);
  assert.ok(!builtIn.has(filterPattern('b-cdn.net')) && !WebsiteFilter.Block.includes(filterPattern('refinery29.com')), "never.txt's sites are out");
  assert.ok(onWholeDomain('tik.porn') && onWholeDomain('a.b.xxx') && !onWholeDomain('xxx.com') && !onWholeDomain('porn.example.com'));
});

test("Firefox's own copy takes the whole domains, then starter.txt, popular.txt and the other lists, and stops at Firefox's limit of 1,000", () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-lists-'));
  try {
    writeFileSync(join(dir, 'a-community.txt'), Array.from({ length: 1200 }, (_, i) => `0.0.0.0 site${i}.com`).join('\n') + '\n0.0.0.0 tik.porn\n0.0.0.0 ordinary.com\n');
    writeFileSync(join(dir, 'starter.txt'), '# mine\nexampleadultsite.com\nwww.second.com\nsite5.com\nfirst.xxx\n');
    writeFileSync(join(dir, 'popular.txt'), '# most visited\nsite9.com  # top 1,000\nsite8.com  # top 5,000\nsite5.com\nalso.porn\n');
    writeFileSync(join(dir, NEVER_FILE), 'ordinary.com\n');
    const { sites, leftOut, covered } = filterSites(dir);
    assert.deepEqual(sites.slice(0, 6), ['exampleadultsite.com', 'second.com', 'site5.com', 'site9.com', 'site8.com', 'site0.com']);
    assert.equal(sites.length, FILTER_LIMIT - WHOLE_DOMAINS.length, 'room for the whole domains');
    assert.equal(new Set(sites).size, sites.length, 'each site once');
    assert.equal(sites.length + leftOut.length, 1202, 'site5.com counted once, the covered and never.txt sites not at all');
    assert.equal(covered, 3, 'first.xxx, also.porn, tik.porn');
    assert.ok(!sites.includes('ordinary.com') && !leftOut.includes('ordinary.com'));
    const entries = filterEntries(dir);
    assert.equal(entries.length, FILTER_LIMIT);
    assert.deepEqual(entries.slice(0, 6), ['*://*.xxx/*', '*://*.porn/*', '*://*.sex/*', '*://*.adult/*', '*://*.sexy/*', '*://*.exampleadultsite.com/*']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mac/family-site-blocker-firefox.mobileconfig is up to date with blocklists/ (run npm run build)', () => {
  const profile = readFileSync(PROFILE_PATH, 'utf8');
  assert.equal(profile, mobileconfig());
  assert.match(profile, /<key>PayloadScope<\/key>\s*<string>System<\/string>/, 'applies to every account');
  assert.match(profile, /<key>EnterprisePoliciesEnabled<\/key>\s*<true\/>/, 'Firefox only reads its Mac settings with this');
  assert.match(profile, /<key>WebsiteFilter<\/key>\s*<dict>\s*<key>Block<\/key>\s*<array>\s*<string>\*:\/\/\*\.xxx\/\*<\/string>\s*<string>\*:\/\/\*\.porn\/\*<\/string>/);
  assert.ok(profile.includes('<string>*://*.exampleadultsite.com/*</string>'));
  assert.ok(profile.includes('whole adult domains such as .porn and .xxx'), 'the description says what the copy holds');
  // The stamp, as managed storage for the add-on, and the version in the description Device Management shows.
  assert.match(profile, new RegExp(`<key>3rdparty</key>\\s*<dict>\\s*<key>Extensions</key>\\s*<dict>\\s*<key>${manifest.browser_specific_settings.gecko.id.replace('.', '\\.')}</key>\\s*<dict>\\s*<key>${STAMP}</key>\\s*<dict>\\s*<key>version</key>\\s*<string>${manifest.version.replaceAll('.', '\\.')}</string>\\s*<key>entries</key>\\s*<integer>${FILTER_LIMIT}</integer>\\s*</dict>`));
  assert.ok(profile.includes(`This is the copy from version ${manifest.version} of Family Site Blocker, with 1,000 entries in Firefox\u2019s own list`), 'the description names the version');
  assert.equal(readFileSync(STAMP_PATH, 'utf8'), `${JSON.stringify(lockStamp(), null, 2)}\n`, 'extension/rules/lock.json carries the same stamp');
});

test('the launch agent that closes the Option key is up to date and sets the variable Firefox checks (run npm run build)', () => {
  const agent = readFileSync(AGENT_PATH, 'utf8');
  assert.equal(agent, launchAgent());
  assert.equal(AGENT_PATH.split(sep).slice(-2).join('/'), `mac/${AGENT_LABEL}.plist`, 'named after its label, as launch agents are');
  assert.equal(SAFE_MODE_KEY_VARIABLE, 'MOZ_DISABLE_SAFE_MODE_KEY', 'the variable toolkit/xre/SafeMode.h checks');
  assert.match(agent, /<key>Label<\/key>\s*<string>local\.parental-controls\.family-site-blocker\.firefox-troubleshoot-key<\/string>/);
  assert.match(agent, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/bin\/launchctl<\/string>\s*<string>setenv<\/string>\s*<string>MOZ_DISABLE_SAFE_MODE_KEY<\/string>\s*<string>1<\/string>\s*<\/array>/);
  assert.match(agent, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(!agent.includes('<key>KeepAlive</key>'), 'runs once at login');
  if (process.platform === 'darwin') {
    const check = spawnSync('plutil', ['-lint', AGENT_PATH], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
});

test("the installer package for the launch agent: what pkgbuild and productbuild are given", () => {
  assert.equal(INSTALLER_VERSION, manifest.version, 'the package carries the add-on version');
  assert.equal(pkgName('1.5.4'), 'family-site-blocker-firefox-troubleshoot-key-1.5.4.pkg');
  assert.equal(PKG_IDENTIFIER, AGENT_LABEL, "the receipt is named after the agent's label");
  assert.equal(AGENT_INSTALLED_PATH, `/Library/LaunchAgents/${AGENT_LABEL}.plist`);
  const xml = distribution('1.5.4');
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<installer-gui-script minSpecVersion="2">/);
  assert.ok(xml.includes(`<title>${TITLE}</title>`));
  assert.match(xml, /<options customize="never" rootVolumeOnly="true" hostArchitectures="x86_64,arm64"\/>/, 'one choice, Intel and Apple silicon');
  assert.match(xml, /<domains enable_localSystem="true"\/>/, 'installs for every account');
  assert.ok(xml.includes(`<pkg-ref id="${PKG_IDENTIFIER}" version="1.5.4" onConclusion="none">component.pkg</pkg-ref>`));
  assert.match(xml, /<welcome file="welcome.txt" mime-type="text\/plain"\/>\s*<conclusion file="conclusion.txt" mime-type="text\/plain"\/>/);
  const script = postinstall();
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.ok(script.includes(`PLIST="${AGENT_INSTALLED_PATH}"`));
  assert.ok(script.includes('chown root:wheel "$PLIST"') && script.includes('chmod 644 "$PLIST"'));
  assert.ok(script.includes('launchctl bootstrap "gui/$uid" "$PLIST"'), 'loads the agent for each account logged in');
  assert.ok(script.includes(`launchctl setenv ${SAFE_MODE_KEY_VARIABLE} 1`), 'and closes the key at once');
  assert.ok(script.includes('dscl . -list /Users UniqueID') && script.includes('launchctl print "gui/$uid" >/dev/null 2>&1 || continue'), 'only the accounts logged in');
  assert.ok(script.trimEnd().endsWith('exit 0'), 'nothing in it fails the install');
  for (const text of [welcome(), conclusion()]) assert.ok(/^[\x20-\x7e\n]+$/.test(text), 'plain ASCII, for Installer');
  assert.ok(welcome().includes(SAFE_MODE_KEY_VARIABLE) && welcome().includes(AGENT_INSTALLED_PATH) && welcome().includes('--safe-mode'));
  if (process.platform !== 'darwin') assert.throws(() => buildInstaller({ out: join(tmpdir(), 'family-site-blocker-pkg') }), /needs a Mac/);
});

test('every file the pages reference exists', () => {
  const pages = readdirSync(EXT).filter((name) => name.endsWith('.html'));
  assert.deepEqual(pages.sort(), ['attempts.html', 'blocked.html', 'lockbox.html', 'options.html', 'pictures.html', 'tries.html', 'unlisted.html']);
  for (const page of pages) {
    const html = readFileSync(join(EXT, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      assert.ok(existsSync(join(EXT, ref)), `${page} references missing ${ref}`);
    }
  }
});

test("every link in the settings page's contents line lands on a section of the page, under the heading's own name", () => {
  const html = readFileSync(join(EXT, 'options.html'), 'utf8');
  const links = [...html.matchAll(/<li><a href="#([\w-]+)">([^<]+)<\/a><\/li>/g)].map((m) => ({ id: m[1], text: m[2] }));
  assert.equal(links.length, 5, 'one link per section');
  for (const { id, text } of links) {
    const section = html.match(new RegExp(`<section id="${id}"[^>]*>\\s*<h2[^>]*>([^<]+)</h2>`));
    assert.ok(section, `#${id} is not a section of the page`);
    assert.equal(section[1], text, `the link to #${id} should carry the heading's name`);
  }
});

test('module imports resolve', () => {
  for (const file of ['background.js', 'options.js', 'attempts.js', 'tries.js', 'pictures.js', 'unlisted.js', 'lockbox.js', 'lockbox-worker.js', 'lib/attempts.js', 'lib/domains.js', 'lib/lockbox.js', 'lib/mylist.js', 'lib/page.js', 'lib/pictures.js', 'lib/rules.js', 'lib/safesearch.js', 'lib/suspects.js', 'lib/timelock.js', 'lib/watching.js']) {
    const source = readFileSync(join(EXT, file), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      assert.ok(existsSync(resolve(EXT, dirname(file), specifier)), `${file} imports missing ${specifier}`);
    }
  }
});

test('extension scripts have no syntax errors', () => {
  for (const file of ['background.js', 'blocked.js', 'options.js', 'attempts.js', 'tries.js', 'pictures.js', 'unlisted.js', 'lockbox.js', 'lockbox-worker.js', 'lib/attempts.js', 'lib/domains.js', 'lib/lockbox.js', 'lib/mylist.js', 'lib/page.js', 'lib/pictures.js', 'lib/rules.js', 'lib/safesearch.js', 'lib/suspects.js', 'lib/timelock.js', 'lib/watching.js']) {
    const run = spawnSync(process.execPath, ['--check', join(EXT, file)], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  }
});
