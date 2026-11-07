// Checks scripts/amo-backup.mjs, the backup of the signed versions from addons.mozilla.org into the project's
// package registry, against stand-ins for both. Run with: npm test
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
import { target } from '../scripts/release-files.mjs';
import { PACKAGE_NAME } from '../scripts/updates-site.mjs';

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
 * Stand-ins on one port: Mozilla's API, listing `versions` ({ version, status, data }) over two pages and
 * serving their files, and GitLab's package registry, holding the release files of `have` and taking uploads.
 */
async function standIns(versions, have) {
  const uploaded = new Map();
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    requests.push({ method: request.method, path: url.pathname, auth: request.headers.authorization, token: request.headers['job-token'] });
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
    } else if (url.pathname === '/api/v4/projects/42/packages') {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('x-next-page', '');
      response.end(JSON.stringify(have.map((version) => ({ name: PACKAGE_NAME, version, package_type: 'generic' }))));
    } else if (request.method === 'PUT' && url.pathname.startsWith('/api/v4/projects/42/packages/generic/')) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploaded.set(url.pathname, Buffer.concat(chunks));
        response.statusCode = 201;
        response.end('{"message":"201 Created"}');
      });
    } else {
      response.statusCode = 404;
      response.end('{"message":"404 Not Found"}');
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { amo: `${base}/api/v5/`, gitlab: `${base}/api/v4`, uploaded, requests, close: () => new Promise((done) => server.close(done)) };
}

const inPipeline = (gitlab) => target({ CI_API_V4_URL: gitlab, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' });

test('backs up the signed versions the registry lacks, under the names the update files use, and reports the rest', { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const versions = [
    { version: '1.23.0', status: 'public', data: fakeXpi(dir, '1.23.0') },
    { version: '1.24.0', status: 'unreviewed', data: Buffer.alloc(0) },
    { version: '1.1.1', status: 'public', data: fakeXpi(dir, '1.1.1') },
    { version: '1.26.0', status: 'public', data: fakeXpi(dir, '1.26.0') },
    { version: '1.0.9', status: 'disabled', data: Buffer.alloc(0) },
    { version: '1.0.8', status: 'none', data: Buffer.alloc(0) },
  ];
  const stand = await standIns(versions, ['1.26.0']);
  try {
    const folder = join(dir, 'backup');
    const lines = [];
    const results = await backup(folder, KEY, { api: stand.amo, gitlab: inPipeline(stand.gitlab), log: (line) => lines.push(line) });
    assert.deepEqual(
      results,
      [
        { version: '1.0.8', state: 'not signed: no file' },
        { version: '1.0.9', state: 'not signed: disabled' },
        { version: '1.1.1', state: 'backed up' },
        { version: '1.23.0', state: 'backed up' },
        { version: '1.24.0', state: 'not signed: unreviewed' },
        { version: '1.26.0', state: 'kept' },
      ],
      'oldest first, as Firefox orders versions',
    );
    assert.deepEqual(readdirSync(folder).sort(), ['family-site-blocker-1.1.1.xpi', 'family-site-blocker-1.23.0.xpi']);
    assert.ok(readFileSync(join(folder, 'family-site-blocker-1.1.1.xpi')).equals(versions[2].data), 'the file as Mozilla serves it, under the update files\' name');
    const prefix = '/api/v4/projects/42/packages/generic/family-site-blocker/';
    assert.deepEqual([...stand.uploaded.keys()].sort(), [`${prefix}1.1.1/family-site-blocker-1.1.1.xpi`, `${prefix}1.23.0/family-site-blocker-1.23.0.xpi`]);
    assert.ok(stand.uploaded.get(`${prefix}1.23.0/family-site-blocker-1.23.0.xpi`).equals(versions[0].data));
    for (const request of stand.requests.filter((r) => r.path.startsWith('/api/v4/'))) assert.equal(request.token, 'tok', 'the job token goes to GitLab');
    for (const request of stand.requests.filter((r) => !r.path.startsWith('/api/v4/'))) assert.match(request.auth, /^JWT /, 'the key goes to Mozilla');
    assert.deepEqual(lines, results.map(({ version, state }) => `${version}: ${state}`));
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that isn't a signed copy of this add-on, of that version, stops the backup before anything is uploaded", { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const stand = await standIns([{ version: '1.2.0', status: 'public', data: fakeXpi(dir, '1.2.1') }], []);
  try {
    await assert.rejects(backup(join(dir, 'backup'), KEY, { api: stand.amo, gitlab: inPipeline(stand.gitlab) }), /holds version 1\.2\.1/);
    assert.equal(stand.uploaded.size, 0);
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a GitLab token the files are only saved; the command reports what it did, and needs the key', { skip: !hasZip && 'no zip command' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-backup-'));
  const stand = await standIns([{ version: '1.5.0', status: 'public', data: fakeXpi(dir, '1.5.0') }], []);
  try {
    assert.deepEqual(await backup(join(dir, 'only'), KEY, { api: stand.amo, gitlab: target({ CI_API_V4_URL: stand.gitlab, CI_PROJECT_ID: '42' }) }), [{ version: '1.5.0', state: 'saved' }]);
    assert.equal(stand.uploaded.size, 0);
    assert.deepEqual(readdirSync(join(dir, 'only')), ['family-site-blocker-1.5.0.xpi']);
    const cli = await new Promise((resolve) => {
      const env = { ...process.env, AMO_JWT_ISSUER: KEY.issuer, AMO_JWT_SECRET: KEY.secret, AMO_API: stand.amo, CI_API_V4_URL: stand.gitlab, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' };
      const child = spawn(process.execPath, [SCRIPT, join(dir, 'cli')], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^1\.5\.0: backed up\n1 versions on addons\.mozilla\.org: 1 backed up now, 0 saved in .* only, 0 already in the registry, 0 not signed\.\n$/);
    assert.equal(stand.uploaded.size, 1);
    const noKey = spawnSync(process.execPath, [SCRIPT, join(dir, 'x')], { encoding: 'utf8', env: { ...process.env, AMO_JWT_ISSUER: '', AMO_JWT_SECRET: '' } });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /AMO_JWT_ISSUER and AMO_JWT_SECRET/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  } finally {
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
