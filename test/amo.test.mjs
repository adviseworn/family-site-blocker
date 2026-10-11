// Checks scripts/amo-signed.mjs against a stand-in for addons.mozilla.org's API. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDON_ID, downloadSigned, token } from '../scripts/amo-signed.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/amo-signed.mjs', import.meta.url));
const KEY = { issuer: 'user:12345:67', secret: 'a-test-secret' };
const SIGNED = Buffer.from('the signed file');

/** The claims of a token, after checking it is HS256 and signed with the test secret. */
function claims(authorization) {
  const [scheme, jwt] = authorization.split(' ');
  assert.equal(scheme, 'JWT');
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.equal(signature, createHmac('sha256', KEY.secret).update(`${header}.${payload}`).digest('base64url'), 'signed with the secret');
  return JSON.parse(Buffer.from(payload, 'base64url'));
}

/**
 * A stand-in for the API: lists `versions` over two pages, the last one first, and serves the signed file.
 * The file of each version reports `status` until it has been asked about `pendingFor` times.
 */
async function fakeAmo(versions, { status = 'public', pendingFor = 0 } = {}) {
  const requests = [];
  let lists = 0;
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization });
    const url = new URL(request.url, 'http://amo');
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname === `/api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/`) {
      lists += 1;
      const page = Number(url.searchParams.get('page') ?? 1);
      const results = versions.filter((_, index) => index % 2 === page - 1).map((version, index) => ({
        id: index + 1,
        version,
        file: { status: lists > pendingFor ? status : 'unreviewed', url: `${base}/firefox/downloads/file/1/a138dee9ad3f4f03aa63-${version}.xpi` },
      }));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ results, next: page === 1 ? `${base}${url.pathname}?filter=all_with_unlisted&page=2` : null }));
    } else if (url.pathname.startsWith('/firefox/downloads/file/')) {
      response.end(SIGNED);
    } else {
      response.statusCode = 404;
      response.end('{"detail":"Not found."}');
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { api: `http://127.0.0.1:${server.address().port}/api/v5/`, requests, close: () => new Promise((done) => server.close(done)) };
}

test('token() makes the short-lived HS256 token addons.mozilla.org asks for', () => {
  const now = Math.floor(Date.now() / 1000);
  const { iss, jti, iat, exp } = claims(`JWT ${token(KEY.issuer, KEY.secret, now)}`);
  assert.deepEqual({ iss, iat, exp }, { iss: KEY.issuer, iat: now, exp: now + 60 });
  assert.match(jti, /^[0-9a-f-]{36}$/);
  assert.notEqual(claims(`JWT ${token(KEY.issuer, KEY.secret)}`).jti, jti, 'a new id for every request');
});

test('a version Mozilla has signed is found, also on a later page, and downloaded with the key', async () => {
  const amo = await fakeAmo(['1.1.0', '1.1.1', '1.1.2']);
  const folder = mkdtempSync(join(tmpdir(), 'family-site-blocker-amo-'));
  try {
    const path = await downloadSigned('1.1.1', folder, KEY, { api: amo.api, pollMs: 10 });
    assert.equal(path, join(folder, 'a138dee9ad3f4f03aa63-1.1.1.xpi'));
    assert.ok(readFileSync(path).equals(SIGNED));
    assert.match(amo.requests[0].url, /\/versions\/\?filter=all_with_unlisted&/, 'asks for unlisted versions too');
    assert.ok(amo.requests.some(({ url }) => url.includes('page=2')), 'follows the next page');
    assert.match(amo.requests.at(-1).url, /^\/firefox\/downloads\/file\//);
    for (const { auth } of amo.requests) assert.equal(claims(auth).iss, KEY.issuer, 'every request carries the key');
  } finally {
    await amo.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a version Mozilla is still signing is waited for', async () => {
  const amo = await fakeAmo(['1.1.2'], { pendingFor: 2 });
  const folder = mkdtempSync(join(tmpdir(), 'family-site-blocker-amo-'));
  try {
    const path = await downloadSigned('1.1.2', folder, KEY, { api: amo.api, pollMs: 10 });
    assert.ok(readFileSync(path).equals(SIGNED));
    assert.equal(amo.requests.filter(({ url }) => url.includes('/versions/')).length, 3, 'asked until the third answer said signed');
  } finally {
    await amo.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the command exits with 3 when Mozilla has no such version, so the workflow uploads it', async () => {
  const amo = await fakeAmo(['1.1.0', '1.1.1']);
  const folder = mkdtempSync(join(tmpdir(), 'family-site-blocker-amo-'));
  try {
    const run = await new Promise((done) => {
      const child = spawn(process.execPath, [SCRIPT, '1.1.2', folder], {
        env: { ...process.env, AMO_API: amo.api, AMO_JWT_ISSUER: KEY.issuer, AMO_JWT_SECRET: KEY.secret },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code, stderr }));
    });
    assert.equal(run.code, 3);
    assert.match(run.stderr, /Mozilla has no version 1\.1\.2 of this add-on yet/);
  } finally {
    await amo.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a refused key is reported, not mistaken for a missing version', async () => {
  const amo = await fakeAmo([]);
  try {
    await assert.rejects(downloadSigned('1.1.2', tmpdir(), KEY, { api: `${amo.api}nowhere/` }), /answered 404/);
  } finally {
    await amo.close();
  }
});
