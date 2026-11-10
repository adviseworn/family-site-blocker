// Checks the scripts the pipelines on GitLab run (.gitlab-ci.yml): the suite summary, the fetching of released
// files from the package registry, and the release as it is posted. Run with: npm test
import { after, before, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// GitLab's free plan gives 400 pipeline minutes a month, and November 2026's were all but gone by the 9th: 158
// went to the sign job waiting 25 minutes for a reviewer who takes days, and a fifth to running the tests a
// second time on main.
describe('the pipeline spends few minutes', () => {
  const pipeline = readFileSync(fileURLToPath(new URL('../.gitlab-ci.yml', import.meta.url)), 'utf8');
  /** One job's text in .gitlab-ci.yml: from its name at the start of a line to the next job's. */
  const job = (name) => pipeline.match(new RegExp(`\\n${name.replace('.', '\\.')}:\\n(?:(?![\\w.-]+:\\n)[^\\n]*\\n)*`))?.[0] ?? '';

  it('runs the tests on a branch and not again for the push that merges it into main', () => {
    const tests = job('.tests');
    assert.match(tests, /\n {4}- if: \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH && \$CI_PIPELINE_SOURCE == "push"\n {6}when: never[^\n]*\n {4}- if: \$CI_COMMIT_BRANCH\n/);
    for (const name of ['checks', 'browsers']) assert.match(job(name), /\n {2}extends: \.tests\n/, `${name} follows that rule`);
    // The sign job can't wait for jobs its pipeline doesn't have.
    assert.match(job('sign'), /\n {2}needs: \[\]/);
    assert.doesNotMatch(job('sign'), /needs: \[checks/);
  });

  it('runs the browser suites only for a branch that changes something they load or run, and whenever a pipeline is started by hand', () => {
    const browsers = job('browsers');
    // A job's own rules replace the ones it extends, so the browsers job repeats the two that keep the tests out.
    const never = (text) => text.match(/\n {2}rules:\n((?: {4}- if: [^\n]+\n {6}when: never[^\n]*\n)+)/)?.[1];
    assert.ok(never(browsers), 'the browsers job has rules of its own');
    assert.equal(never(browsers), never(job('.tests')), 'out of the same pipelines as the checks job');
    const rule = browsers.match(/when: never[^\n]*\n {4}- if: \$CI_COMMIT_BRANCH && \$CI_PIPELINE_SOURCE != "push"\n {4}- if: \$CI_COMMIT_BRANCH\n {6}changes:\n {8}compare_to: refs\/heads\/main\n {8}paths:\n((?: {10}- [^\n]+\n)+) {2}script:\n/);
    assert.ok(rule, 'by hand always; for a push, only when the branch differs from main in a listed file');
    const paths = rule[1].trim().split('\n').map((line) => line.trim().replace(/^- /, ''));
    for (const path of paths) assert.match(path, /^[\w.-]+(\/\*\*\/\*)?$/, `${path}: a file at the top of the project, or a folder and all it holds`);
    const listed = paths.map((path) => path.split('/')[0]);
    // What the suites load or run: the add-on, themselves and their helpers, and the scripts they import.
    for (const needed of ['extension', 'test', 'scripts', 'package.json', '.gitlab-ci.yml']) assert.ok(listed.includes(needed), `${needed} is listed`);
    // What they never touch. Everything else at the top of the project has to be listed, so a new folder can't
    // slip past the suites unnoticed: add it to the job's paths, or here if the suites don't load or run it.
    const untouched = ['android', 'README.md', '.gitignore'];
    for (const name of untouched) assert.ok(!listed.includes(name), `${name} is not listed`);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    const tracked = git.status === 0 ? [...new Set(git.stdout.split('\0').filter(Boolean).map((path) => path.split('/')[0]))] : [];
    // Without git (the source unpacked from an archive), the folders there are, less the ones .gitignore names.
    const ignored = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((line) => line.trim().replace(/\/$/, ''));
    const folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== '.git' && !ignored.includes(entry.name)).map((entry) => entry.name);
    const top = tracked.length ? tracked : folders;
    assert.ok(top.includes('extension') && top.includes('test'), 'found the top of the project');
    for (const name of top) {
      assert.ok(listed.includes(name) || untouched.includes(name), `${name} is new at the top of the project: add it to the browsers job's paths in .gitlab-ci.yml, or to the list here if the browser suites don't load or run it`);
    }
    for (const name of listed) assert.ok(existsSync(join(root, name)), `${name} exists`);
  });

  it("waits for Mozilla's approval a few minutes at most, and not at all before the add-on's first approval", () => {
    const sign = job('sign');
    assert.match(sign, /if curl -fs -o \/dev\/null "https:\/\/addons\.mozilla\.org\/api\/v5\/addons\/addon\/family-site-blocker\/"; then\n\s+export AMO_WAIT_MINUTES="\$\{APPROVAL_WAIT_MINUTES:-5\}"\n\s+else\n\s+export AMO_WAIT_MINUTES=0\n/);
    assert.ok(PAGE_URL.endsWith('/addon/family-site-blocker/'), 'the address asked is the page of scripts/amo-metadata.mjs');
    assert.match(sign, / sign --channel=listed [^\n]* --approval-timeout=\$\(\(AMO_WAIT_MINUTES \* 60000\)\) /, 'the upload waits that long');
    assert.doesNotMatch(pipeline, /--approval-timeout=\d/, 'and no fixed time');
    assert.match(sign, /elif \[ "\$found" = 4 \]; then\n[^\n]*Not signed yet[^\n]*\n\s+exit 1\n/, 'a version Mozilla holds ends the job, as scripts/amo-signed.mjs reports it');
    assert.match(sign, /if ! ls web-ext-artifacts\/\*\.xpi > \/dev\/null 2>&1; then\n[^\n]*Uploaded, not signed yet[^\n]*\n\s+exit 1\n/, 'and so does an upload that was not waited for');
  });
});

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
