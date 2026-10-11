// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDomain, parseDomainList } from '../extension/lib/domains.js';
import { BLOCK_PAGE, CHUNK_SIZE, buildRules } from '../extension/lib/rules.js';
import { RULES_PATH, loadBlocklists, renderRules } from '../scripts/build-rules.mjs';
import { firefoxManifest, packageFirefox } from '../scripts/package-firefox.mjs';
import { ICNS_PATH, packageSigned } from '../scripts/package-signed.mjs';
import { readZip } from '../scripts/read-zip.mjs';

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
