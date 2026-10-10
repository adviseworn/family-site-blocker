// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { normalizeDomain, parseDomainList } from '../extension/lib/domains.js';
import { BLOCK_PAGE, CHUNK_SIZE, buildRules } from '../extension/lib/rules.js';
import { RULES_PATH, loadBlocklists, renderRules } from '../scripts/build-rules.mjs';
import { firefoxManifest, packageFirefox } from '../scripts/package-firefox.mjs';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'));

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
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 1), 'rule ids are positive integers');
  assert.ok(rules.length <= 30000, 'within the guaranteed static rule limit');
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

test('extension/rules/adult.json is up to date with blocklists/ (run npm run build)', () => {
  const { domains } = loadBlocklists();
  assert.ok(domains.includes('exampleadultsite.com'));
  assert.equal(readFileSync(RULES_PATH, 'utf8'), renderRules(domains));
});

test('buildRules splits long lists into chunks with unique ids', () => {
  const many = Array.from({ length: CHUNK_SIZE * 2 + 1 }, (_, i) => `site${i}.com`);
  const built = buildRules(many, 10);
  assert.deepEqual(built.map((rule) => rule.id), [10, 11, 12, 13, 14, 15]);
  assert.equal(buildRules([]).length, 0);
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
  assert.ok(manifest.host_permissions.includes('<all_urls>'), 'redirect rules need host access');
  for (const { path } of manifest.declarative_net_request.rule_resources) {
    assert.ok(existsSync(join(EXT, path)), path);
  }
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

test("Firefox's manifest leaves out only background.service_worker, which Mozilla's linter warns about", () => {
  const firefox = firefoxManifest(manifest);
  assert.deepEqual(firefox.background, { scripts: ['background.js'] });
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

/** Reads a zip with nothing but Node: file name → contents. */
function readZip(file) {
  const data = readFileSync(file);
  const end = data.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  const files = new Map();
  let at = data.readUInt32LE(end + 16);
  for (let left = data.readUInt16LE(end + 10); left > 0; left--) {
    const nameLength = data.readUInt16LE(at + 28);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    const local = data.readUInt32LE(at + 42);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const stored = data.subarray(start, start + data.readUInt32LE(at + 20));
    if (!name.endsWith('/')) files.set(name, data.readUInt16LE(at + 10) === 8 ? inflateRawSync(stored) : stored);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return files;
}

const hasZip = spawnSync('zip', ['-v']).status === 0;

test('npm run package:firefox zips the whole extension, manifest.json at the top, with Firefox\'s manifest', { skip: !hasZip && 'no zip command' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'family-site-blocker-package-'));
  try {
    const { zip } = packageFirefox({ outDir: out });
    const files = readZip(zip);
    const expected = filesIn(EXT).filter((path) => !path.startsWith('_metadata/') && !path.endsWith('.DS_Store'));
    assert.deepEqual([...files.keys()].sort(), expected);
    assert.deepEqual(JSON.parse(files.get('manifest.json')), firefoxManifest(manifest));
    for (const [name, contents] of files) {
      if (name !== 'manifest.json') assert.ok(contents.equals(readFileSync(join(EXT, name))), `${name} is copied unchanged`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('every file the pages reference exists', () => {
  const pages = readdirSync(EXT).filter((name) => name.endsWith('.html'));
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    const html = readFileSync(join(EXT, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      assert.ok(existsSync(join(EXT, ref)), `${page} references missing ${ref}`);
    }
  }
});

test('module imports resolve', () => {
  for (const file of ['options.js', 'lib/domains.js', 'lib/rules.js']) {
    const source = readFileSync(join(EXT, file), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      assert.ok(existsSync(resolve(EXT, dirname(file), specifier)), `${file} imports missing ${specifier}`);
    }
  }
});

test('extension scripts have no syntax errors', () => {
  for (const file of ['background.js', 'blocked.js', 'options.js', 'lib/domains.js', 'lib/rules.js']) {
    const run = spawnSync(process.execPath, ['--check', join(EXT, file)], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  }
});
