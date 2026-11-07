// Checks the scripts the pipelines on GitLab run (.gitlab-ci.yml): the suite summary, the fetching of released
// files from the package registry, and the release as it is posted. Run with: npm test
import { after, before, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failures, judge, totals } from '../scripts/ci-summary.mjs';
import { download, newest, releasedVersions, target, upload, xpiName } from '../scripts/release-files.mjs';
import { PROFILE_NAME, notes, release } from '../scripts/release-json.mjs';
import { PAGE_URL } from '../scripts/amo-metadata.mjs';
import { PACKAGE_NAME, PROJECT_PATH, SITE_URL } from '../scripts/updates-site.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const run = (name, args, env = {}) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
// For a script that talks to this process's stand-in server: spawnSync would block the server's answers, so this waits without blocking.
const runWhileServing = (name, args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script(name), ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

const PASSING = ['TAP version 13', 'ok 1 - one', 'ok 2 - two', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5'].join('\n');
const uploaded = new Map(); // what the stand-in registry was given with PUT, by path
const MIXED = ['TAP version 13', 'ok 1 - one', 'not ok 2 - two', '  ---', '  ...', 'ok 3 - three # SKIP needs a Mac', '# tests 3', '# pass 1', '# fail 1', '# cancelled 0', '# skipped 1', '# todo 0'].join('\n');

describe('the suite summary', () => {
  test('reads the totals and the failures from TAP output', () => {
    assert.deepEqual(totals(PASSING), { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0 });
    assert.deepEqual(failures(MIXED), ['two']);
    assert.deepEqual(failures(PASSING), []);
  });

  test('passes a suite only when every test ran and passed, skips within what is allowed', () => {
    assert.equal(judge('fast', PASSING).ok, true);
    assert.equal(judge('fast', PASSING).line, 'fast: 2 tests, 2 passed, 0 failed, 0 cancelled, 0 skipped');
    assert.equal(judge('fast', MIXED).ok, false);
    assert.equal(judge('fast', MIXED.replace('not ok 2', 'ok 2').replace('# pass 1', '# pass 2').replace('# fail 1', '# fail 0')).ok, false, 'a skip fails without an allowance');
    assert.equal(judge('fast', MIXED.replace('not ok 2', 'ok 2').replace('# pass 1', '# pass 2').replace('# fail 1', '# fail 0'), 1).ok, true, 'one skip allowed');
    assert.equal(judge('fast', null).ok, false, 'a missing file');
    assert.equal(judge('fast', 'TAP version 13\nok 1 - one\n').ok, false, 'a run that never printed its totals');
    assert.equal(judge('fast', PASSING.replace('# tests 2', '# tests 0').replace('# pass 2', '# pass 0')).ok, false, 'nothing ran');
    assert.equal(judge('fast', PASSING.replace('# cancelled 0', '# cancelled 1').replace('# pass 2', '# pass 1')).ok, false, 'a cancelled test');
  });

  test('the script prints each suite and exits 1 when one did not pass whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-summary-'));
    try {
      writeFileSync(join(dir, 'a.tap'), PASSING);
      writeFileSync(join(dir, 'b.tap'), MIXED);
      const good = run('ci-summary.mjs', [`a=${join(dir, 'a.tap')}`]);
      assert.equal(good.status, 0, good.stdout + good.stderr);
      assert.match(good.stdout, /^a: 2 tests, 2 passed, 0 failed, 0 cancelled, 0 skipped$/m);
      const bad = run('ci-summary.mjs', ['--allow-skips=1', `a=${join(dir, 'a.tap')}`, `b=${join(dir, 'b.tap')}`, `c=${join(dir, 'missing.tap')}`]);
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /^b: 3 tests, 1 passed, 1 failed, 0 cancelled, 1 skipped: not every test ran and passed$/m);
      assert.match(bad.stdout, /^ {2}not ok: two$/m);
      assert.match(bad.stdout, /^c: did not run: not every test ran and passed$/m);
      assert.equal(run('ci-summary.mjs', ['what']).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the released files', () => {
  // A stand-in for GitLab's API: the generic packages of the project, two pages of them, and their files.
  const versions = ['1.9.0', '1.10.0', '1.3.2', '1.25.0'];
  const seen = [];
  let server;
  let api;
  before(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://x');
      seen.push({ path: url.pathname + url.search, token: request.headers['job-token'] });
      if (request.method === 'PUT') {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          uploaded.set(url.pathname, Buffer.concat(chunks));
          response.statusCode = 201;
          response.end('{"message":"201 Created"}');
        });
        return;
      }
      if (url.pathname === '/projects/42/packages') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const all = [...versions.map((version) => ({ name: PACKAGE_NAME, version, package_type: 'generic' })), { name: 'something-else', version: '9.9.9', package_type: 'generic' }];
        const pages = [all.slice(0, 3), all.slice(3)];
        response.setHeader('content-type', 'application/json');
        if (page < pages.length) response.setHeader('x-next-page', String(page + 1));
        else response.setHeader('x-next-page', '');
        response.end(JSON.stringify(pages[page - 1] ?? []));
        return;
      }
      const file = /^\/projects\/42\/packages\/generic\/family-site-blocker\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (file && versions.includes(file[1]) && file[2] === xpiName(file[1])) {
        response.end(`signed ${file[1]}`);
        return;
      }
      response.statusCode = 404;
      response.end('{"message":"404 Not Found"}');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    api = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('the target is the pipeline\'s project with its token, or the project with a personal token, or with none', () => {
    assert.deepEqual(target({ CI_API_V4_URL: 'https://gitlab.example/api/v4/', CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' }), { api: 'https://gitlab.example/api/v4', project: '42', headers: { 'JOB-TOKEN': 'tok' } });
    assert.deepEqual(target({ GITLAB_TOKEN: 'pat' }), { api: 'https://gitlab.com/api/v4', project: encodeURIComponent(PROJECT_PATH), headers: { 'PRIVATE-TOKEN': 'pat' } }, 'outside a pipeline the private project takes a personal access token');
    assert.deepEqual(target({}), { api: 'https://gitlab.com/api/v4', project: encodeURIComponent(PROJECT_PATH), headers: {} });
    assert.equal(xpiName('1.25.0'), 'family-site-blocker-1.25.0.xpi');
  });

  test('lists every released version through the pages, oldest first as Firefox orders versions', async () => {
    const env = { CI_API_V4_URL: api, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' };
    assert.deepEqual(await releasedVersions(target(env)), ['1.3.2', '1.9.0', '1.10.0', '1.25.0']);
    assert.ok(seen.every((request) => request.token === 'tok'), 'the job token goes with each request');
    assert.deepEqual(newest(['1.3.2', '1.9.0', '1.10.0', '1.25.0'], 2), ['1.10.0', '1.25.0']);
    assert.deepEqual(newest(['1.3.2'], 5), ['1.3.2']);
    assert.deepEqual(newest(['1.3.2', '1.9.0']), ['1.3.2', '1.9.0']);
  });

  test('saves the newest files under the names the update manifest expects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
    try {
      const paths = await download(['1.10.0', '1.25.0'], join(dir, 'xpis'), target({ CI_API_V4_URL: api, CI_PROJECT_ID: '42' }));
      assert.deepEqual(paths, [join(dir, 'xpis', 'family-site-blocker-1.10.0.xpi'), join(dir, 'xpis', 'family-site-blocker-1.25.0.xpi')]);
      assert.equal(readFileSync(paths[1], 'utf8'), 'signed 1.25.0');
      const cli = await runWhileServing('release-files.mjs', [join(dir, 'two'), '2'], { CI_API_V4_URL: api, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' });
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /Saved 2 of 4 released versions in .*: 1\.10\.0, 1\.25\.0/);
      assert.ok(existsSync(join(dir, 'two', 'family-site-blocker-1.25.0.xpi')) && !existsSync(join(dir, 'two', 'family-site-blocker-1.9.0.xpi')));
      await assert.rejects(download(['1.0.0'], join(dir, 'none'), target({ CI_API_V4_URL: api, CI_PROJECT_ID: '42' })), /404/);
      assert.equal(run('release-files.mjs', []).status, 2);
      assert.equal(run('release-files.mjs', [join(dir, 'x'), 'two']).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('puts a file in the registry under its version, where the release files live', async () => {
    const where = target({ CI_API_V4_URL: api, CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' });
    const url = await upload('1.26.0', xpiName('1.26.0'), Buffer.from('signed 1.26.0'), where);
    assert.equal(url, `${api}/projects/42/packages/generic/${PACKAGE_NAME}/1.26.0/family-site-blocker-1.26.0.xpi`);
    assert.equal(uploaded.get('/projects/42/packages/generic/family-site-blocker/1.26.0/family-site-blocker-1.26.0.xpi')?.toString(), 'signed 1.26.0');
    assert.equal(seen.at(-1).token, 'tok', 'with the job token');
  });

  test('says when nothing has been released yet', async () => {
    const empty = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('[]');
    });
    await new Promise((done) => empty.listen(0, '127.0.0.1', done));
    try {
      const cli = await runWhileServing('release-files.mjs', ['nowhere'], { CI_API_V4_URL: `http://127.0.0.1:${empty.address().port}`, CI_PROJECT_ID: '42' });
      assert.equal(cli.status, 3);
      assert.match(cli.stderr, /Nothing has been released/);
    } finally {
      empty.close();
    }
  });
});

describe('the release', () => {
  test('names the tag on the commit, the files in the package registry and the page on Mozilla\'s site', () => {
    const made = release({ version: '1.25.0', commit: 'abc123', packageUrl: 'https://gitlab.com/api/v4/projects/42/packages/generic/family-site-blocker/1.25.0/' });
    assert.equal(made.tag_name, 'v1.25.0');
    assert.equal(made.ref, 'abc123');
    assert.equal(made.name, 'Family Site Blocker 1.25.0');
    assert.equal(made.description, notes('1.25.0'));
    assert.deepEqual(made.assets.links.map((link) => link.name), ['family-site-blocker-1.25.0.xpi', 'family-site-blocker-1.25.0.zip', PROFILE_NAME]);
    for (const link of made.assets.links) assert.equal(link.url, `https://gitlab.com/api/v4/projects/42/packages/generic/family-site-blocker/1.25.0/${link.name}`);
    assert.ok(notes('1.25.0').includes(PAGE_URL), 'the notes give the page on Mozilla\'s site');
    assert.ok(notes('1.25.0').includes('family-site-blocker-1.25.0.xpi') && notes('1.25.0').includes(PROFILE_NAME));
    assert.doesNotMatch(notes('1.25.0'), /\.pkg|Option key/, 'no installer package: GitLab has no Mac to build it on');
    assert.doesNotMatch(JSON.stringify(made), /github/i);
    assert.ok(SITE_URL.startsWith('https://adviseworn.gitlab.io/'), 'the update files are on GitLab Pages');
  });

  test('the script prints what the sign job posts', () => {
    const cli = run('release-json.mjs', ['1.25.0', 'abc123', 'https://gitlab.example/api/v4/projects/42/packages/generic/family-site-blocker/1.25.0']);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), release({ version: '1.25.0', commit: 'abc123', packageUrl: 'https://gitlab.example/api/v4/projects/42/packages/generic/family-site-blocker/1.25.0' }));
    assert.equal(run('release-json.mjs', ['1.25.0']).status, 1);
  });
});
