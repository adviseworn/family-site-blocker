// Checks scripts/amo-backup.mjs, the backup of the signed versions from addons.mozilla.org into the releases on
// GitHub, against stand-ins for both. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from '../scripts/amo-backup.mjs';
import { ADDON_ID } from '../scripts/amo-signed.mjs';
import { target, xpiName } from '../scripts/release-files.mjs';
import { backupNotes } from '../scripts/release-notes.mjs';
import { startGitHub } from './helpers/github.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/amo-backup.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const KEY = { issuer: 'user:12345:67', secret: 'a-test-secret' };
const hasZip = spawnSync('zip', ['-v']).status === 0;

/** A signed-looking .xpi of this add-on, of `version`. */
function fakeXpi(dir, version) {
  const folder = mkdtempSync(join(dir, 'xpi-'));
  const files = { 'manifest.json': JSON.stringify({ ...manifest, version }), 'background.js': '// …', 'META-INF/mozilla.rsa': 'signature', 'META-INF/cose.sig': 'signature' };
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), contents);
  }
  assert.equal(spawnSync('zip', ['-qrX', `${folder}.xpi`, '.'], { cwd: folder }).status, 0);
  return readFileSync(`${folder}.xpi`);
}

/**
 * Stand-ins: Mozilla's API, listing `versions` ({ version, status, data }) over two pages and serving their
 * files, and GitHub (test/helpers/github.mjs) with the releases and tags given.
 */
async function standIns(versions, github = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    requests.push({ method: request.method, path: url.pathname, auth: request.headers.authorization });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname === `/api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/`) {
      const page = Number(url.searchParams.get('page') ?? 1);
      const results = versions
        .filter((_, index) => index % 2 === page - 1)
        .map(({ version, status }, index) => ({ id: index + 1, version, file: status === 'none' ? null : { status, url: `${base}/firefox/downloads/file/${index}/a138dee9ad3f4f03aa63-${version}.xpi` } }));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ results, next: page === 1 ? `${base}${url.pathname}?filter=all_with_unlisted&page=2` : null }));
    } else if (url.pathname.startsWith('/firefox/downloads/file/')) {
      const version = /-([\d.]+)\.xpi$/.exec(url.pathname)[1];
      response.end(versions.find((entry) => entry.version === version).data);
    } else {
      response.statusCode = 404;
      response.end('{"detail":"Not found."}');
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const hub = await startGitHub(github);
  return { amo: `http://127.0.0.1:${server.address().port}/api/v5/`, hub, requests, close: () => Promise.all([new Promise((done) => server.close(done)), hub.close()]) };
}

const inWorkflow = (hub) => target({ GITHUB_API_URL: hub.api, GITHUB_REPOSITORY: hub.repository, GITHUB_TOKEN: 'tok' });
const released = (version) => ({ tag: `v${version}`, files: { [xpiName(version)]: `signed ${version}` } });

test('backs up the signed versions the releases lack, under the names the update files use, and reports the rest', { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const versions = [
    { version: '1.23.0', status: 'public', data: fakeXpi(dir, '1.23.0') },
    { version: '1.24.0', status: 'unreviewed', data: Buffer.alloc(0) },
    { version: '1.1.1', status: 'public', data: fakeXpi(dir, '1.1.1') },
    { version: '1.26.0', status: 'public', data: fakeXpi(dir, '1.26.0') },
    { version: '1.0.9', status: 'disabled', data: Buffer.alloc(0) },
    { version: '1.0.8', status: 'none', data: Buffer.alloc(0) },
    { version: '1.29.0', status: 'public', data: fakeXpi(dir, '1.29.0') },
    { version: '1.0.7', status: 'public', data: fakeXpi(dir, '1.0.7') },
  ];
  // 1.26.0 is released whole; 1.23.0 has a release that lacks its signed file; 1.1.1 has a tag and no release;
  // 1.29.0 has neither, and a commit that made it; 1.0.7 is from before the history, with nowhere to go.
  const stand = await standIns(versions, { releases: [released('1.26.0'), { tag: 'v1.23.0', files: { 'family-site-blocker-1.23.0.zip': 'zip' } }], tags: ['v1.1.1'] });
  try {
    const folder = join(dir, 'backup');
    const lines = [];
    const asked = [];
    const commitOf = (version) => {
      asked.push(version);
      return version === '1.29.0' ? 'c0ffee' : null;
    };
    const results = await backup(folder, KEY, { api: stand.amo, github: inWorkflow(stand.hub), commitOf, log: (line) => lines.push(line) });
    assert.deepEqual(
      results,
      [
        { version: '1.0.7', state: 'saved: no release, tag or commit to put it in' },
        { version: '1.0.8', state: 'not signed: no file' },
        { version: '1.0.9', state: 'not signed: disabled' },
        { version: '1.1.1', state: 'backed up' },
        { version: '1.23.0', state: 'backed up' },
        { version: '1.24.0', state: 'not signed: unreviewed' },
        { version: '1.26.0', state: 'kept' },
        { version: '1.29.0', state: 'backed up' },
      ],
      'oldest first, as Firefox orders versions',
    );
    assert.deepEqual(readdirSync(folder).sort(), ['family-site-blocker-1.0.7.xpi', 'family-site-blocker-1.1.1.xpi', 'family-site-blocker-1.23.0.xpi', 'family-site-blocker-1.29.0.xpi']);
    assert.ok(readFileSync(join(folder, 'family-site-blocker-1.1.1.xpi')).equals(versions[2].data), "the file as Mozilla serves it, under the update files' name");
    assert.deepEqual([...stand.hub.uploaded.keys()].sort(), ['v1.1.1/family-site-blocker-1.1.1.xpi', 'v1.23.0/family-site-blocker-1.23.0.xpi', 'v1.29.0/family-site-blocker-1.29.0.xpi']);
    assert.ok(stand.hub.uploaded.get('v1.23.0/family-site-blocker-1.23.0.xpi').equals(versions[0].data));
    const made = (tag) => stand.hub.releases().find((release) => release.tag_name === tag);
    assert.deepEqual(made('v1.23.0').files, ['family-site-blocker-1.23.0.zip', 'family-site-blocker-1.23.0.xpi'], 'a release that lacked the file takes it, and keeps what it had');
    assert.deepEqual({ target: made('v1.1.1').target_commitish, latest: made('v1.1.1').make_latest, body: made('v1.1.1').body }, { target: undefined, latest: 'false', body: backupNotes('1.1.1') }, 'a tag without a release: the release is made on the tag, and an old version is never the latest');
    assert.deepEqual({ target: made('v1.29.0').target_commitish, latest: made('v1.29.0').make_latest, name: made('v1.29.0').name }, { target: 'c0ffee', latest: 'true', name: 'Family Site Blocker 1.29.0' }, 'no tag: the release is made on the commit that made the version, and a version newer than every release is the latest');
    assert.deepEqual(asked, ['1.0.7', '1.29.0'], 'the history is asked only for a version with neither release nor tag');
    for (const request of stand.hub.requests) assert.equal(request.auth, 'Bearer tok', "the workflow's token goes to GitHub");
    for (const request of stand.requests) assert.match(request.auth, /^JWT /, 'the key goes to Mozilla');
    assert.deepEqual(lines, results.map(({ version, state }) => `${version}: ${state}`));
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that isn't a signed copy of this add-on, of that version, stops the backup before anything is uploaded", { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const stand = await standIns([{ version: '1.2.0', status: 'public', data: fakeXpi(dir, '1.2.1') }]);
  try {
    await assert.rejects(backup(join(dir, 'backup'), KEY, { api: stand.amo, github: inWorkflow(stand.hub), commitOf: () => 'c0ffee' }), /holds version 1\.2\.1/);
    assert.equal(stand.hub.uploaded.size, 0);
    assert.deepEqual(stand.hub.releases(), [], 'and no release is made');
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a GitHub token the files are only saved; the command reports what it did, and needs the key', { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const { version } = manifest; // a version this checkout's history has a commit for, when it is a checkout
  const stand = await standIns([{ version, status: 'public', data: fakeXpi(dir, version) }], { tags: [`v${version}`] });
  try {
    assert.deepEqual(await backup(join(dir, 'only'), KEY, { api: stand.amo, github: target({ GITHUB_API_URL: stand.hub.api, GITHUB_REPOSITORY: stand.hub.repository }) }), [{ version, state: 'saved' }]);
    assert.equal(stand.hub.uploaded.size, 0);
    assert.deepEqual(readdirSync(join(dir, 'only')), [xpiName(version)]);
    const cli = await new Promise((resolve) => {
      const env = { ...process.env, AMO_JWT_ISSUER: KEY.issuer, AMO_JWT_SECRET: KEY.secret, AMO_API: stand.amo, GITHUB_API_URL: stand.hub.api, GITHUB_REPOSITORY: stand.hub.repository, GITHUB_TOKEN: 'tok', GH_TOKEN: '' };
      const child = spawn(process.execPath, [SCRIPT, join(dir, 'cli')], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.split('\n')[0], `${version}: backed up`);
    assert.match(cli.stdout, /\n1 versions on addons\.mozilla\.org: 1 backed up now, 0 saved in .* only, 0 already in their releases, 0 not signed\.\n$/);
    assert.equal(stand.hub.uploaded.size, 1);
    const noKey = spawnSync(process.execPath, [SCRIPT, join(dir, 'x')], { encoding: 'utf8', env: { ...process.env, AMO_JWT_ISSUER: '', AMO_JWT_SECRET: '' } });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /AMO_JWT_ISSUER and AMO_JWT_SECRET/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
