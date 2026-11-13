// Checks the workflow that tests and releases on GitHub (.github/workflows/pipeline.yml) and the scripts it
// runs: the plan of a run, the suite summary, the fetching of released files, the release notes and the commit
// a version was made on. GitHub is a stand-in (test/helpers/github.mjs). Run with: npm test
import { after, before, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failures, judge, totals } from '../scripts/ci-summary.mjs';
import { BROWSER_PATHS, MANIFEST, WORKFLOW, alreadyTested, changedFiles, explain, plan, treeOf } from '../scripts/ci-plan.mjs';
import { download, newest, releasedVersions, releases, tagged, target, upload, versionOf, xpiName } from '../scripts/release-files.mjs';
import { PROFILE_NAME, backupNotes, notes } from '../scripts/release-notes.mjs';
import { versionCommit } from '../scripts/version-commit.mjs';
import { PAGE_URL } from '../scripts/amo-metadata.mjs';
import { REPOSITORY, SITE_BRANCH, SITE_REPOSITORY, SITE_URL } from '../scripts/updates-site.mjs';
import { startGitHub } from './helpers/github.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const run = (name, args, env = {}, cwd = ROOT) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
// For a script that talks to this process's stand-in server: spawnSync would block the server's answers, so this waits without blocking.
const runWhileServing = (name, args, env = {}, cwd = ROOT) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script(name), ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

// A script run here must not take the place it asks, or a token, from the machine's own environment.
const NO_GITHUB = { GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_API_URL: '', GITHUB_REPOSITORY: '', GITHUB_OUTPUT: '', GITHUB_EVENT_PATH: '', GITHUB_EVENT_NAME: '', GITHUB_REF_NAME: '', GITHUB_SHA: '' };

const hasGit = spawnSync('git', ['--version']).status === 0;

/** A small repository of its own, to ask git about: returns { dir, git, commit }, commit(files, message) giving the new commit's id. */
function scratchRepository(dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-repo-'))) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'A test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (files, message) => {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), contents);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

const PASSING = ['TAP version 13', 'ok 1 - one', 'ok 2 - two', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5'].join('\n');
const MIXED = ['TAP version 13', 'ok 1 - one', 'not ok 2 - two', '  ---', '  ...', 'ok 3 - three # SKIP needs a Mac', '# tests 3', '# pass 1', '# fail 1', '# cancelled 0', '# skipped 1', '# todo 0'].join('\n');

const workflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
const pipeline = workflow(WORKFLOW);
/** One job's text in the workflow: from its name, two spaces in, to the next job's. */
const job = (name) => pipeline.match(new RegExp(`\\n {2}${name}:\\n(?:(?! {2}[\\w-]+:\\n)[^\\n]*\\n)*`))?.[0] ?? '';

// A run's minutes are counted (a private repository gets 2,000 a month, and GitLab's 400 ran out in nine days
// of November 2026), so a run does only what its push needs.
describe('a run does only what its push needs', () => {
  const ALL = { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' };

  it('tests a branch, with the browser suites only when it changes something they load or run', () => {
    const push = (changed) => plan({ event: 'push', branch: 'bedtime', changed });
    assert.deepEqual(push(['extension/options.js']), ALL);
    assert.deepEqual(push(['README.md', 'android/app/build.gradle', '.gitignore']), { ...ALL, browsers: 'no' }, 'the guide and the Android app: the checks alone');
    assert.deepEqual(push(['package.json']), ALL, 'the Playwright version is in package.json');
    assert.deepEqual(push(['package.json.md', 'extension.md']), { ...ALL, browsers: 'no' }, 'a file is listed by its whole name, a folder by its slash');
    assert.deepEqual(push([`.github/workflows/${WORKFLOW}`]), ALL, 'a change to the workflow is tried in full');
    assert.deepEqual(push(['.github/workflows/android.yml']), { ...ALL, browsers: 'no' });
    assert.deepEqual(push([]), { checks: 'no', browsers: 'no', sign: 'no', site: 'no' }, 'a branch that holds nothing main lacks has nothing to test');
    assert.deepEqual(push(null), ALL, "when the changes can't be told, everything counts as changed");
    assert.deepEqual(plan({ event: 'push', branch: 'bedtime', changed: [MANIFEST] }), ALL, 'a version is never signed from a branch');
  });

  it("doesn't test a second time what passed as the head of its pull request, and signs and publishes when the version changes", () => {
    const merged = (changed, tested) => plan({ event: 'push', branch: 'main', changed, tested });
    assert.deepEqual(merged(['extension/options.js', MANIFEST], true), { checks: 'no', browsers: 'no', sign: 'yes', site: 'yes' });
    assert.deepEqual(merged(['extension/options.js', MANIFEST], false), { checks: 'yes', browsers: 'yes', sign: 'yes', site: 'yes' }, 'anything else that reaches main is tested there');
    assert.deepEqual(merged(['README.md'], false), { checks: 'yes', browsers: 'no', sign: 'no', site: 'no' });
    assert.deepEqual(merged(['android/README.md'], true), { checks: 'no', browsers: 'no', sign: 'no', site: 'no' });
    // A forced push replaces main's history, and what main was is then not there to compare with. Everything is tested, and nothing is
    // signed by itself: otherwise the push would send whatever version main holds to Mozilla, one kept back on purpose included.
    assert.deepEqual(merged(null, false), { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' }, "a push whose change can't be told never signs by itself");
    assert.deepEqual(merged(null, true), { checks: 'no', browsers: 'no', sign: 'no', site: 'no' });
    assert.deepEqual(plan({ event: 'push', branch: 'trunk', defaultBranch: 'trunk', changed: [MANIFEST], tested: true }).sign, 'yes', 'whatever the main branch is called');
  });

  it('runs every suite when started by hand, or only the signing and publishing it is asked for, and those only on main', () => {
    const byHand = (options) => plan({ event: 'workflow_dispatch', branch: 'main', changed: null, ...options });
    assert.deepEqual(byHand({}), ALL);
    assert.deepEqual(plan({ event: 'workflow_dispatch', branch: 'bedtime' }), ALL, 'on a branch too');
    assert.deepEqual(byHand({ sign: true }), { checks: 'no', browsers: 'no', sign: 'yes', site: 'no' });
    assert.deepEqual(byHand({ publish: true }), { checks: 'no', browsers: 'no', sign: 'no', site: 'yes' });
    assert.deepEqual(byHand({ sign: true, publish: true }), { checks: 'no', browsers: 'no', sign: 'yes', site: 'yes' });
    assert.throws(() => plan({ event: 'workflow_dispatch', branch: 'bedtime', sign: true }), /for main: this run is on bedtime/);
    assert.throws(() => plan({ event: 'workflow_dispatch', branch: 'bedtime', publish: true }), /for main/);
  });

  it('says what it decided in words', () => {
    const input = { event: 'push', branch: 'main', changed: ['extension/options.js', MANIFEST], testedAs: { head: '0123456789abcdef', pull: 58 } };
    const lines = explain(input, plan({ ...input, tested: true }));
    assert.match(lines.join('\n'), /the same files as 0123456, the head of pull request #58, which passed them/);
    assert.equal(lines.at(-1), 'checks: no, browsers: no, sign: yes, update-files: yes');
    assert.match(explain({ event: 'push', branch: 'bedtime', changed: ['README.md'] }, plan({ event: 'push', branch: 'bedtime', changed: ['README.md'] })).join('\n'), /it changes 1 file\.\nThe checks run; the browser suites stay out/);
    assert.match(explain({ event: 'workflow_dispatch', branch: 'main' }, plan({ event: 'workflow_dispatch', branch: 'main', sign: true, publish: true })).join('\n'), /Started by hand on main to sign and publish: the tests stay out\./);
  });

  it('lists everything at the top of the project as loaded by the browser suites, or as known not to matter', () => {
    for (const path of BROWSER_PATHS) assert.match(path, /^[\w.-]+(\/|(\/[\w.-]+)*)$/, `${path}: a file, or a folder with its slash`);
    const listed = BROWSER_PATHS.map((path) => path.split('/')[0]);
    // What the suites load or run: the add-on, themselves and their helpers, and the scripts they import.
    for (const needed of ['extension', 'test', 'scripts', 'package.json', '.github']) assert.ok(listed.includes(needed), `${needed} is listed`);
    assert.ok(BROWSER_PATHS.includes(`.github/workflows/${WORKFLOW}`), 'the workflow that runs them');
    // What they never touch. Everything else at the top of the project has to be listed, so a new folder can't
    // slip past the suites unnoticed: add it to BROWSER_PATHS, or here if the suites don't load or run it.
    const untouched = ['android', 'README.md', '.gitignore'];
    for (const name of untouched) assert.ok(!listed.includes(name), `${name} is not listed`);
    const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    const tracked = git.status === 0 ? [...new Set(git.stdout.split('\0').filter(Boolean).map((path) => path.split('/')[0]))] : [];
    // Without git (the source unpacked from an archive), the folders there are, less the ones .gitignore names.
    const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim().replace(/\/$/, ''));
    const folders = readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== '.git' && !ignored.includes(entry.name)).map((entry) => entry.name);
    const top = tracked.length ? tracked : folders;
    assert.ok(top.includes('extension') && top.includes('test'), 'found the top of the project');
    for (const name of top) {
      assert.ok(listed.includes(name) || untouched.includes(name), `${name} is new at the top of the project: add it to BROWSER_PATHS in scripts/ci-plan.mjs, or to the list here if the browser suites don't load or run it`);
    }
    for (const path of BROWSER_PATHS) assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
  });

  it('the workflow runs the jobs the plan names, the sign job after the tests of its run', () => {
    assert.match(pipeline, /\non:\n {2}push:\n {4}branches: \['\*\*'\][^\n]*\n {2}workflow_dispatch:\n {4}inputs:\n {6}sign:\n[^]*?\n {8}type: boolean\n {8}default: false\n {6}publish:\n[^]*?\n {8}type: boolean\n {8}default: false\n/, 'every push to a branch, and by hand with two boxes');
    assert.doesNotMatch(pipeline, /\n {2}pull_request/, "a pull request's checks are its branch's own run");
    const planJob = job('plan');
    assert.match(planJob, /fetch-depth: 0/, 'the plan compares the push with main, so it needs the history');
    assert.match(planJob, /\n {10}SIGN: \$\{\{ inputs\.sign \}\}\n {10}PUBLISH: \$\{\{ inputs\.publish \}\}\n {8}run: node scripts\/ci-plan\.mjs\n/);
    for (const name of ['checks', 'browsers', 'sign', 'site']) assert.match(planJob, new RegExp(`\\n {6}${name}: \\$\\{\\{ steps\\.plan\\.outputs\\.${name} \\}\\}\\n`), `the plan hands on ${name}`);
    assert.match(planJob, /pull-requests: read[^\n]*\n {6}actions: read/, 'it may ask which pull request a commit came from, and whether its tests passed');
    for (const name of ['checks', 'browsers']) assert.match(job(name), new RegExp(`^\\n {2}${name}:\\n {4}needs: plan\\n {4}if: needs\\.plan\\.outputs\\.${name} == 'yes'\\n`), `${name} runs when the plan says so`);
    const sign = job('sign');
    assert.match(sign, /\n {4}needs: \[plan, checks, browsers\]\n/);
    assert.match(sign, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.sign == 'yes' && \(needs\.checks\.result == 'success' \|\| needs\.checks\.result == 'skipped'\) && \(needs\.browsers\.result == 'success' \|\| needs\.browsers\.result == 'skipped'\) \}\}\n/, 'a test job that failed or was stopped keeps the version from being signed');
    assert.match(sign, /\n {4}concurrency:\n {6}group: sign-with-mozilla\b/, 'one signing at a time');
    const site = job('update-files');
    assert.match(site, /\n {4}needs: \[plan, sign\]\n/);
    assert.match(site, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.site == 'yes' && \(needs\.sign\.result == 'success' \|\| \(needs\.sign\.result == 'skipped' && needs\.plan\.outputs\.sign == 'no'\)\) \}\}\n/, 'after a signing that went well, or alone when only publishing was asked for');
    assert.match(pipeline, /\nconcurrency:\n {2}group: tests-and-release-\$\{\{ github\.ref_name == github\.event\.repository\.default_branch && github\.run_id \|\| github\.ref_name \}\}\n {2}cancel-in-progress: true\n/, 'a newer push stops the older run of a branch, and never a run on main');
    assert.match(pipeline, /\npermissions:\n {2}contents: read\n/, 'a job gets no more than it asks for');
    assert.match(sign, /\n {4}permissions:\n {6}contents: write[^\n]*\n/, 'the sign job alone may publish a release');
  });

  it("waits for Mozilla's approval a few minutes at most, and not at all before the add-on's first approval", () => {
    const sign = job('sign');
    assert.match(sign, /if curl -fs -o \/dev\/null "https:\/\/addons\.mozilla\.org\/api\/v5\/addons\/addon\/family-site-blocker\/"; then\n\s+AMO_WAIT_MINUTES="\$\{APPROVAL_WAIT_MINUTES:-5\}"\n\s+else\n\s+AMO_WAIT_MINUTES=0\n/);
    assert.match(sign, /\n {6}APPROVAL_WAIT_MINUTES: \$\{\{ vars\.APPROVAL_WAIT_MINUTES \}\}\n/, 'a repository variable changes the five minutes');
    assert.ok(PAGE_URL.endsWith('/addon/family-site-blocker/'), 'the address asked is the page of scripts/amo-metadata.mjs');
    assert.match(sign, / sign --channel=listed [^\n]* --approval-timeout=\$\(\(AMO_WAIT_MINUTES \* 60000\)\) /, 'the upload waits that long');
    assert.doesNotMatch(pipeline, /--approval-timeout=\d/, 'and no fixed time');
    assert.match(sign, /elif \[ "\$found" = 4 \]; then\n[^\n]*Not signed yet[^\n]*\n\s+exit 1\n/, 'a version Mozilla holds ends the job, as scripts/amo-signed.mjs reports it');
    assert.match(sign, /if ! ls web-ext-artifacts\/\*\.xpi > \/dev\/null 2>&1; then\n[^\n]*Uploaded, not signed yet[^\n]*\n\s+exit 1\n/, 'and so does an upload that was not waited for');
  });

  it('the other workflows only start by hand, the two on a Mac among them', () => {
    const names = readdirSync(join(ROOT, '.github', 'workflows')).sort();
    // move-tags.yml is the one kept from before the move: the release tags still have to move onto main's rewritten commits, and GitHub only
    // starts a workflow whose file is on the default branch. It goes once they have moved, as its own first lines say.
    assert.deepEqual(names, ['android.yml', 'lock-check.yml', 'mac-installer.yml', 'macos.yml', 'move-tags.yml', 'mozilla-backup.yml', 'pictures-check.yml', WORKFLOW]);
    for (const name of names.filter((entry) => entry !== WORKFLOW)) {
      const text = workflow(name);
      assert.match(text, /\non:\n {2}workflow_dispatch:\n/, `${name} starts by hand`);
      assert.doesNotMatch(text, /\n {2}(push|pull_request|schedule):/, `${name} never starts by itself`);
      assert.match(text, /\npermissions:\n {2}contents: (read|write)\b/, `${name} says what its token may do`);
    }
    for (const name of names) assert.equal(/runs-on: macos/.test(workflow(name)), ['macos.yml', 'mac-installer.yml'].includes(name), `${name}: a Mac's minutes count ten times in a private repository`);
    assert.match(workflow('lock-check.yml'), /node scripts\/release-files\.mjs signed 1\n[^]*node scripts\/amo-signed\.mjs 1\.1\.1 older\n[^]*npm run test:firefox-lock [^\n]*\n[^]*node scripts\/ci-summary\.mjs lock=lock\.tap\n/);
    assert.match(workflow('android.yml'), /\.\/gradlew --no-daemon assembleRelease bundleRelease "\$\{signing\[@\]\}"\n/);
    for (const secret of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) assert.ok(workflow('android.yml').includes(`${secret}: \${{ secrets.${secret} }}`), `${secret} comes from the repository's secrets`);
    assert.ok(!existsSync(join(ROOT, 'android', 'ci')), "GitLab's Android job is gone");
  });
});

describe('whether a commit on main was tested on its branch', () => {
  const sha = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const other = 'c'.repeat(40);
  const tree = 'd'.repeat(40);
  const ask = async (state) => {
    const github = await startGitHub(state);
    try {
      return { found: await alreadyTested(target({ GITHUB_API_URL: github.api, GITHUB_REPOSITORY: github.repository, GITHUB_TOKEN: 'tok' }), sha, tree), requests: github.requests };
    } finally {
      await github.close();
    }
  };

  it('takes a merged pull request whose head holds the same files and passed the workflow', async () => {
    const { found, requests } = await ask({ pulls: { [sha]: [{ number: 58, head }] }, trees: { [head]: tree }, passed: [head] });
    assert.deepEqual(found, { head, pull: 58 });
    assert.ok(requests.every((request) => request.auth === 'Bearer tok'), "the run's token goes with each question");
    assert.ok(requests.some((request) => request.path === `/repos/someone/project/actions/workflows/${WORKFLOW}/runs?head_sha=${head}&status=success&per_page=1`), 'it asks for a run of this workflow that succeeded on that head');
  });

  it("doesn't take one whose head held other files, hasn't passed, or wasn't merged", async () => {
    assert.equal((await ask({ pulls: { [sha]: [{ number: 58, head }] }, trees: { [head]: 'e'.repeat(40) }, passed: [head] })).found, null, 'main moved on before the merge: the merged files are new');
    assert.equal((await ask({ pulls: { [sha]: [{ number: 58, head }] }, trees: { [head]: tree }, passed: [] })).found, null, 'merged before its tests had passed');
    assert.equal((await ask({ pulls: { [sha]: [{ number: 58, head, merged: false }] }, trees: { [head]: tree }, passed: [head] })).found, null);
    assert.equal((await ask({})).found, null, 'pushed straight to main');
    assert.deepEqual((await ask({ pulls: { [sha]: [{ number: 57, head: other }, { number: 58, head }] }, trees: { [other]: 'e'.repeat(40), [head]: tree }, passed: [head, other] })).found, { head, pull: 58 }, 'the pull request that fits');
  });

  it('says so when GitHub gives no answer, so the caller tests', async () => {
    const github = await startGitHub({ pulls: { [sha]: [{ number: 58, head }] } });
    try {
      await assert.rejects(alreadyTested(target({ GITHUB_API_URL: github.api, GITHUB_REPOSITORY: github.repository }), sha, tree), /git\/commits\/b+ answered 404/);
    } finally {
      await github.close();
    }
  });
});

describe('the plan, run in a checkout', { skip: !hasGit && 'no git' }, () => {
  let repo;
  let base;
  let github;
  const event = (payload) => {
    const path = join(repo.dir, '..', `event-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ repository: { default_branch: 'main' }, ...payload }));
    return path;
  };
  const outputs = (path) => Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map((line) => line.split('=')));
  const planIn = async (env) => {
    const out = join(repo.dir, '..', `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, '');
    const cli = await runWhileServing('ci-plan.mjs', [], { ...NO_GITHUB, GITHUB_API_URL: github.api, GITHUB_REPOSITORY: github.repository, GITHUB_TOKEN: 'tok', GITHUB_OUTPUT: out, ...env }, repo.dir);
    return { ...cli, outputs: cli.status === 0 ? outputs(out) : null };
  };
  before(async () => {
    // Everything of this test lives in one folder, the checkout in it, beside the event and output files.
    repo = scratchRepository(join(mkdtempSync(join(tmpdir(), 'family-site-blocker-plan-')), 'checkout'));
    base = repo.commit({ [MANIFEST]: '{"version":"1.0.0"}', 'README.md': 'one', 'extension/options.js': '1' }, 'One (1.0.0)');
    repo.git('update-ref', 'refs/remotes/origin/main', base); // what a checkout in the workflow knows main as
    github = await startGitHub();
  });
  after(async () => {
    await github?.close();
    if (repo) rmSync(join(repo.dir, '..'), { recursive: true, force: true });
  });

  it('compares a branch with main where it left it, and a push to main with what main was', async () => {
    repo.git('checkout', '-q', '-b', 'guide');
    const guide = repo.commit({ 'README.md': 'two' }, 'The guide says two');
    assert.deepEqual(changedFiles('origin/main', guide, { cwd: repo.dir, sinceFork: true }), ['README.md']);
    let cli = await planIn({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'guide', GITHUB_SHA: guide, GITHUB_EVENT_PATH: event({ before: base }) });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(cli.outputs, { checks: 'yes', browsers: 'no', sign: 'no', site: 'no' });
    assert.match(cli.stdout, /A push to the branch guide: against main, it changes 1 file\./);

    // Main gains a version meanwhile; the branch still changes only the guide.
    repo.git('checkout', '-q', 'main');
    const version = repo.commit({ [MANIFEST]: '{"version":"1.1.0"}', 'extension/options.js': '2' }, 'Two (1.1.0)');
    repo.git('update-ref', 'refs/remotes/origin/main', version);
    assert.deepEqual(changedFiles('origin/main', guide, { cwd: repo.dir, sinceFork: true }), ['README.md'], "what main gained isn't the branch's change");
    assert.deepEqual(changedFiles(base, version, { cwd: repo.dir }).sort(), ['extension/manifest.json', 'extension/options.js']);
    assert.equal(changedFiles('0123456789012345678901234567890123456789', version, { cwd: repo.dir }), null, "a commit the checkout doesn't have");
    assert.match(treeOf(version, repo.dir), /^[0-9a-f]{40}$/);
    assert.equal(treeOf('0123456789012345678901234567890123456789', repo.dir), null);

    // That push to main, straight to it: tested there, then signed and published.
    cli = await planIn({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', GITHUB_SHA: version, GITHUB_EVENT_PATH: event({ before: base }) });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(cli.outputs, { checks: 'yes', browsers: 'yes', sign: 'yes', site: 'yes' });
    assert.match(cli.stdout, /Nothing says these very files passed the tests/);

    // A new main, which the event gives no earlier commit for: everything is tested, and nothing is signed by itself.
    cli = await planIn({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', GITHUB_SHA: version, GITHUB_EVENT_PATH: event({ before: '0'.repeat(40) }) });
    assert.deepEqual(cli.outputs, { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' });

    // A forced push of main: the event names what main was, a commit the checkout no longer has. The pushed commit holds a version, and
    // it must not go to Mozilla because main's history was replaced: such a version may be one that is kept back on purpose.
    cli = await planIn({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', GITHUB_SHA: version, GITHUB_EVENT_PATH: event({ before: '0123456789012345678901234567890123456789' }) });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(cli.outputs, { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' });
    assert.match(cli.stdout, /A push to main: what it changes can't be told, so it counts as everything for the tests\./);
    assert.match(cli.stdout, /Nothing is signed or published by itself when the change can't be told, as after a forced push: to release the version main holds, start this workflow by hand on main with sign and publish ticked\./);
    assert.match(cli.stdout, /\nchecks: yes, browsers: yes, sign: no, update-files: no\n/);
  });

  it('skips the tests on main for a merge of files that passed on their pull request, as GitHub tells it', async () => {
    repo.git('checkout', '-q', 'main');
    const before = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', '-b', 'three');
    const head = repo.commit({ [MANIFEST]: '{"version":"1.2.0"}', 'extension/options.js': '3' }, 'Three (1.2.0)');
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'Three (1.2.0) (#7)', 'three');
    const merge = repo.git('rev-parse', 'HEAD');
    assert.equal(treeOf(merge, repo.dir), treeOf(head, repo.dir), 'the merge holds what the branch held');
    const told = await startGitHub({ pulls: { [merge]: [{ number: 7, head }] }, trees: { [head]: treeOf(head, repo.dir) }, passed: [head] });
    try {
      const out = join(repo.dir, '..', 'output-merge');
      writeFileSync(out, '');
      const cli = await runWhileServing('ci-plan.mjs', [], { ...NO_GITHUB, GITHUB_API_URL: told.api, GITHUB_REPOSITORY: told.repository, GITHUB_TOKEN: 'tok', GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', GITHUB_SHA: merge, GITHUB_EVENT_PATH: event({ before }) }, repo.dir);
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(outputs(out), { checks: 'no', browsers: 'no', sign: 'yes', site: 'yes' });
      assert.match(cli.stdout, new RegExp(`the same files as ${head.slice(0, 7)}, the head of pull request #7, which passed them`));
    } finally {
      await told.close();
    }
  });

  it('by hand: every suite, or the boxes ticked, and never a signing from a branch', async () => {
    let cli = await planIn({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', GITHUB_SHA: base, GITHUB_EVENT_PATH: event({}), SIGN: 'false', PUBLISH: 'false' });
    assert.deepEqual(cli.outputs, { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' });
    cli = await planIn({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', GITHUB_SHA: base, GITHUB_EVENT_PATH: event({}), SIGN: 'true', PUBLISH: 'true' });
    assert.deepEqual(cli.outputs, { checks: 'no', browsers: 'no', sign: 'yes', site: 'yes' });
    cli = await planIn({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'guide', GITHUB_SHA: base, GITHUB_EVENT_PATH: event({}), SIGN: 'true', PUBLISH: '' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Signing and publishing are for main: this run is on guide/);
  });
});

describe('the commit that made a version', { skip: !hasGit && 'no git' }, () => {
  it('is the first one whose manifest carries it, whatever came after', () => {
    const repo = scratchRepository();
    try {
      const first = repo.commit({ [MANIFEST]: '{"version":"1.0.0"}' }, 'One (1.0.0)');
      repo.commit({ 'README.md': 'a guide' }, 'A guide');
      const second = repo.commit({ [MANIFEST]: '{"version":"1.1.0"}' }, 'Two (1.1.0)');
      const touched = repo.commit({ [MANIFEST]: '{"version":"1.1.0","permissions":["alarms"]}' }, 'A permission, same version');
      repo.commit({ [MANIFEST]: 'not json' }, 'A broken manifest');
      repo.commit({ [MANIFEST]: '{"version":"1.2.0"}' }, 'Three (1.2.0)');
      assert.equal(versionCommit('1.0.0', { cwd: repo.dir }), first);
      assert.equal(versionCommit('1.1.0', { cwd: repo.dir }), second);
      assert.notEqual(second, touched);
      assert.equal(versionCommit('9.9.9', { cwd: repo.dir }), null);
      assert.throws(() => versionCommit('1.0.0', { cwd: tmpdir() }), /git can't list the history/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('this project has one for its own version, and the script prints it', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
    if (inside.status !== 0) return; // the source unpacked from an archive has no history to ask
    const cli = run('version-commit.mjs', ['0.0.0.1']);
    assert.equal(cli.status, 3, cli.stderr);
    assert.match(cli.stderr, /No commit in this history has version 0\.0\.0\.1/);
    assert.equal(run('version-commit.mjs', []).status, 2);
    assert.equal(run('version-commit.mjs', ['one']).status, 2);
    assert.match(version, /^\d+(\.\d+)+$/);
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

  test('the test jobs judge every suite they run with it, one skip allowed in the fast checks alone', () => {
    assert.match(job('checks'), /npm test 2>&1 \| tee fast\.tap \|\| true\n[^]*node scripts\/ci-summary\.mjs --allow-skips=1 fast=fast\.tap\n/);
    assert.match(job('browsers'), /npm run test:browser 2>&1 \| tee chromium\.tap \|\| true\n[^]*npm run test:firefox 2>&1 \| tee firefox\.tap \|\| true\n[^]*node scripts\/ci-summary\.mjs chromium=chromium\.tap firefox=firefox\.tap\n/);
    assert.match(workflow('macos.yml'), /node scripts\/ci-summary\.mjs fast=fast\.tap chromium=chromium\.tap firefox=firefox\.tap installer=installer\.tap\n/, 'on a Mac nothing is skipped');
    // The .tap files are written at the top of the project while the fast checks list what is there (the test above on BROWSER_PATHS).
    assert.ok(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').includes('*.tap'), '.gitignore names them, so that test does not take them for something new');
    // Playwright 1.56.0 has no Chromium for Ubuntu 26.04, which ubuntu-latest has become: the jobs that run a browser name the Ubuntu they were tried on.
    for (const text of [job('browsers'), workflow('lock-check.yml'), workflow('pictures-check.yml')]) assert.match(text, /\n {4}runs-on: ubuntu-24\.04\n/);
  });
});

describe('the released files', () => {
  // A stand-in for GitHub: six releases over three pages, one of them a draft, one without its signed file,
  // one that isn't a version's.
  const signed = (version) => ({ tag: `v${version}`, files: { [xpiName(version)]: `signed ${version}`, [`family-site-blocker-${version}.zip`]: 'zip' } });
  let github;
  let where;
  let env;
  before(async () => {
    github = await startGitHub({
      releases: [signed('1.9.0'), signed('1.10.0'), { tag: 'v1.26.0', draft: true, files: { [xpiName('1.26.0')]: 'a draft' } }, signed('1.3.2'), { tag: 'v1.24.0', files: { 'notes.txt': 'no signed file' } }, { tag: 'nightly', files: { 'family-site-blocker-9.9.9.xpi': 'not a version' } }, signed('1.25.0')],
      tags: ['v1.27.0'],
    });
    env = { ...NO_GITHUB, GITHUB_API_URL: github.api, GITHUB_REPOSITORY: github.repository, GITHUB_TOKEN: 'tok' };
    where = target(env);
  });
  after(() => github.close());

  test("the target is the workflow's repository with its token, or the project's with a personal token, or with none", () => {
    assert.deepEqual(target({ GITHUB_API_URL: 'https://api.github.example/', GITHUB_REPOSITORY: 'someone/project', GITHUB_TOKEN: 'tok' }), { api: 'https://api.github.example', repository: 'someone/project', headers: { Authorization: 'Bearer tok' } });
    assert.deepEqual(target({ GH_TOKEN: 'pat' }), { api: 'https://api.github.com', repository: REPOSITORY, headers: { Authorization: 'Bearer pat' } }, 'outside a workflow, a private repository takes a personal access token');
    assert.deepEqual(target({}), { api: 'https://api.github.com', repository: REPOSITORY, headers: {} });
    assert.equal(xpiName('1.25.0'), 'family-site-blocker-1.25.0.xpi');
    assert.equal(versionOf('v1.25.0'), '1.25.0');
    for (const tag of ['1.25.0', 'v1.25.0-beta', 'nightly', '', undefined]) assert.equal(versionOf(tag), null, `${tag} isn't a version's tag`);
  });

  test('lists every version whose release holds its signed file, through the pages, oldest first as Firefox orders versions', async () => {
    assert.equal((await releases(where)).length, 7, 'every page');
    assert.deepEqual(await releasedVersions(where), ['1.3.2', '1.9.0', '1.10.0', '1.25.0'], 'not the draft, the release without the file, or the tag that is no version');
    assert.ok(github.requests.every((request) => request.auth === 'Bearer tok'), 'the token goes with each request');
    assert.deepEqual(newest(['1.3.2', '1.9.0', '1.10.0', '1.25.0'], 2), ['1.10.0', '1.25.0']);
    assert.deepEqual(newest(['1.3.2'], 5), ['1.3.2']);
    assert.deepEqual(newest(['1.3.2', '1.9.0']), ['1.3.2', '1.9.0']);
  });

  test('saves the newest files under the names the update manifest expects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
    try {
      const paths = await download(['1.10.0', '1.25.0'], join(dir, 'xpis'), where);
      assert.deepEqual(paths, [join(dir, 'xpis', 'family-site-blocker-1.10.0.xpi'), join(dir, 'xpis', 'family-site-blocker-1.25.0.xpi')]);
      assert.equal(readFileSync(paths[1], 'utf8'), 'signed 1.25.0');
      const stored = github.requests.filter((request) => request.path.startsWith('/storage/'));
      assert.ok(stored.length >= 2 && stored.every((request) => request.auth === undefined), "the token doesn't follow the file to where it is stored");
      const cli = await runWhileServing('release-files.mjs', [join(dir, 'two'), '2'], env);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /Saved 2 of 4 released versions in .*: 1\.10\.0, 1\.25\.0/);
      assert.ok(existsSync(join(dir, 'two', 'family-site-blocker-1.25.0.xpi')) && !existsSync(join(dir, 'two', 'family-site-blocker-1.9.0.xpi')));
      await assert.rejects(download(['1.0.0'], join(dir, 'none'), where), /404/);
      await assert.rejects(download(['1.24.0'], join(dir, 'none'), where), /No release v1\.24\.0 holding family-site-blocker-1\.24\.0\.xpi/);
      assert.equal(run('release-files.mjs', []).status, 2);
      assert.equal(run('release-files.mjs', [join(dir, 'x'), 'two']).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("puts a file in a version's release, making the release on its tag or on the commit given", async () => {
    // A release that lacks the file takes it.
    const url = await upload('1.24.0', xpiName('1.24.0'), Buffer.from('signed 1.24.0'), where);
    assert.equal(url, `${github.api}/download/v1.24.0/family-site-blocker-1.24.0.xpi`);
    assert.equal(github.uploaded.get('v1.24.0/family-site-blocker-1.24.0.xpi')?.toString(), 'signed 1.24.0');
    assert.ok((await releasedVersions(where)).includes('1.24.0'), 'and counts as released from then on');
    // A tag without a release: the release is made on the tag, whatever commit is given.
    assert.equal(await tagged('1.27.0', where), true);
    await upload('1.27.0', xpiName('1.27.0'), Buffer.from('signed 1.27.0'), where, { commit: 'abc123', notes: 'Made afterwards.' });
    const onTag = github.releases().find((release) => release.tag_name === 'v1.27.0');
    assert.deepEqual({ target: onTag.target_commitish, name: onTag.name, body: onTag.body, latest: onTag.make_latest, files: onTag.files }, { target: undefined, name: 'Family Site Blocker 1.27.0', body: 'Made afterwards.', latest: 'false', files: ['family-site-blocker-1.27.0.xpi'] });
    // Neither: the release and its tag are made on the commit, and marked as the latest only when asked.
    assert.equal(await tagged('1.28.0', where), false);
    await upload('1.28.0', xpiName('1.28.0'), Buffer.from('signed 1.28.0'), where, { commit: 'abc123', latest: true });
    const onCommit = github.releases().find((release) => release.tag_name === 'v1.28.0');
    assert.deepEqual({ target: onCommit.target_commitish, latest: onCommit.make_latest }, { target: 'abc123', latest: 'true' });
    await assert.rejects(upload('1.29.0', xpiName('1.29.0'), Buffer.from('x'), where), /no release to put family-site-blocker-1\.29\.0\.xpi in, and neither a tag v1\.29\.0 nor a commit/);
    await assert.rejects(upload('1.28.0', xpiName('1.28.0'), Buffer.from('again'), where), /422/, 'a file already there is not replaced');
  });

  test('says when nothing has been released yet', async () => {
    const empty = await startGitHub();
    try {
      const cli = await runWhileServing('release-files.mjs', ['nowhere'], { ...NO_GITHUB, GITHUB_API_URL: empty.api, GITHUB_REPOSITORY: empty.repository });
      assert.equal(cli.status, 3);
      assert.match(cli.stderr, /Nothing has been released/);
    } finally {
      await empty.close();
    }
  });
});

describe('the release', () => {
  test("its page names the page on Mozilla's site and the three files", () => {
    assert.ok(notes('1.25.0').includes(PAGE_URL), "the notes give the page on Mozilla's site");
    assert.ok(notes('1.25.0').includes('family-site-blocker-1.25.0.xpi') && notes('1.25.0').includes('family-site-blocker-1.25.0.zip') && notes('1.25.0').includes(PROFILE_NAME));
    assert.ok(notes('1.25.0').includes(`${SITE_URL}${PROFILE_NAME}`), "and the profile's address on the site");
    assert.doesNotMatch(notes('1.25.0'), /\.pkg|Option key/, 'the installer package is added by hand, with its own line');
    assert.doesNotMatch(notes('1.25.0') + backupNotes('1.25.0'), /gitlab|github\.com/i, 'nothing points at the repository, which may be private');
    assert.ok(backupNotes('1.1.1').includes('family-site-blocker-1.1.1.xpi') && backupNotes('1.1.1').includes(PAGE_URL));
    assert.equal(SITE_URL, 'https://adviseworn.github.io/family-site-blocker-updates/', 'the address the copies from 1.3.2 to 1.23.0 carry');
    assert.equal(SITE_URL, `https://${SITE_REPOSITORY.split('/')[0]}.github.io/${SITE_REPOSITORY.split('/')[1]}/`, "the GitHub Pages site of the site's repository");
    assert.equal(SITE_BRANCH, 'gh-pages');
    assert.notEqual(SITE_REPOSITORY, REPOSITORY, "the site has a repository of its own, so the code's can be private");
  });

  test('the script prints the notes the sign job gives the release', () => {
    const cli = run('release-notes.mjs', ['1.25.0']);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, `${notes('1.25.0')}\n`);
    assert.equal(run('release-notes.mjs', []).status, 1);
    assert.equal(run('release-notes.mjs', ['v1.25.0']).status, 1);
  });

  test('the sign job makes it on the commit, with the three files, and update-files pushes the site to its repository', () => {
    const sign = job('sign');
    assert.match(sign, /node scripts\/release-notes\.mjs "\$VERSION" > "\$RUNNER_TEMP\/notes\.md"\n\s+gh release create "v\$VERSION" "dist\/family-site-blocker-\$VERSION\.xpi" "dist\/family-site-blocker-\$VERSION\.zip" mac\/family-site-blocker-firefox\.mobileconfig \\\n\s+--target "\$GITHUB_SHA" --title "Family Site Blocker \$VERSION" --notes-file "\$RUNNER_TEMP\/notes\.md" --latest\n/);
    assert.match(sign, /node scripts\/check-signed\.mjs "\$signed" dist\/firefox\n\s+npm run package:signed -- "\$signed"\n/, 'after checking that the signed file holds what was uploaded');
    const site = job('update-files');
    assert.match(site, /\n {8}run: node scripts\/release-files\.mjs xpis 5\b/);
    assert.match(site, /git clone -q --depth 1 "git@github\.com:\$SITE_REPOSITORY\.git" [^\n]+\n[^]*git push -q origin "\$SITE_BRANCH"\n/);
    assert.match(site, /SITE_REPOSITORY: \$\{\{ steps\.build\.outputs\.repository \}\}/, 'the repository scripts/updates-site.mjs names');
    assert.match(site, /UPDATES_DEPLOY_KEY: \$\{\{ secrets\.UPDATES_DEPLOY_KEY \}\}/);
    assert.match(site, /gh api meta --jq '\.ssh_keys\[\] \| "github\.com \\\(\.\)"' >> ~\/\.ssh\/known_hosts\n/, "GitHub's own keys come from GitHub, over https");
    assert.doesNotMatch(pipeline, /ssh-keyscan|StrictHostKeyChecking/, 'and no key is taken on trust');
    assert.match(site, /-c user\.name="Family Site Blocker" -c user\.email="family-site-blocker@users\.noreply\.github\.com" commit /, "the site's commits name the project, nobody else");
  });
});
