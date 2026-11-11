#!/usr/bin/env node
// What one run of .github/workflows/pipeline.yml has to do. Its first job, plan, runs this, and the other jobs
// run or stay out by what it says:
//   checks    the fast checks, the Firefox zip and Mozilla's linter
//   browsers  the Chromium and Firefox suites
//   sign      main's version signed by Mozilla and released
//   site      the update files and the guide published on the site (the update-files job)
// A push to a branch runs the checks, unless the branch holds nothing main doesn't, and the browser suites too
// when the branch differs from main in a file they load or run (BROWSER_PATHS): a branch that changes only the
// Android app or the guide leaves them out.
// A push to main signs and publishes when it changes the version (extension/manifest.json). Its tests don't run
// a second time when the commit holds exactly the files that passed them as the head of the pull request it
// merges: the same tree, and a run of this workflow that succeeded on that head, which is what merging a pull
// request that was up to date with main gives. Anything else pushed to main is tested first, and the sign job
// waits for that.
// Started by hand (Actions → Tests and release → Run workflow): every suite, whatever changed; or, on main with
// "sign" or "publish" ticked, those jobs alone, without the tests.
//
// usage: node scripts/ci-plan.mjs      (run from the top of the checkout)
// In the workflow: reads GitHub's environment (GITHUB_EVENT_NAME, GITHUB_REF_NAME, GITHUB_SHA, the event's file,
// GITHUB_TOKEN for the questions to GitHub's API, and SIGN and PUBLISH, the two boxes of a run started by hand)
// and the checkout, which has to hold the whole history (fetch-depth: 0). Prints what it decided and why, and
// writes checks, browsers, sign and site, each yes or no, to the file GITHUB_OUTPUT names. Exits 1 when asked
// to sign or publish from a branch other than main.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { target } from './release-files.mjs';

/** The workflow whose runs say a commit passed the tests. */
export const WORKFLOW = 'pipeline.yml';

/** Every version bump changes it. */
export const MANIFEST = 'extension/manifest.json';

/**
 * What the browser suites load or run: the add-on, the tests and their helpers, the scripts they import, the
 * lists and the Mac files the build reads, package.json (the Playwright version), and the workflow that runs
 * them. A folder ends with a slash. The Android app (android/) and the guide (README.md) aren't among them;
 * test/pipeline.test.mjs checks that everything at the top of the project is either here or known not to matter.
 */
export const BROWSER_PATHS = ['extension/', 'test/', 'scripts/', 'blocklists/', 'mac/', 'assets/', 'package.json', `.github/workflows/${WORKFLOW}`];

const yes = (value) => (value ? 'yes' : 'no');

/**
 * Which jobs run. `changed` is the list of files the push changes (against main for a branch, against what main
 * was for a push to main), or null when that can't be told, which counts as everything; `tested` says the pushed
 * commit's files already passed the tests on their branch; `sign` and `publish` are the boxes of a run started
 * by hand.
 */
export function plan({ event, branch, defaultBranch = 'main', changed = null, tested = false, sign = false, publish = false }) {
  const touches = (paths) => changed === null || changed.some((file) => paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)));
  if (event === 'workflow_dispatch') {
    if (!sign && !publish) return { checks: 'yes', browsers: 'yes', sign: 'no', site: 'no' };
    if (branch !== defaultBranch) throw new Error(`Signing and publishing are for ${defaultBranch}: this run is on ${branch}. Start it again with ${defaultBranch} chosen.`);
    return { checks: 'no', browsers: 'no', sign: yes(sign), site: yes(publish) };
  }
  if (branch === defaultBranch) {
    const version = touches([MANIFEST]);
    return { checks: yes(!tested), browsers: yes(!tested && touches(BROWSER_PATHS)), sign: yes(version), site: yes(version) };
  }
  return { checks: yes(changed === null || changed.length > 0), browsers: yes(touches(BROWSER_PATHS)), sign: 'no', site: 'no' };
}

/** The plan in words, for the job's log. `testedAs` is what alreadyTested() found, if anything. */
export function explain({ event, branch, defaultBranch = 'main', changed = null, testedAs = null }, jobs) {
  const lines = [];
  const files = changed === null ? "what it changes can't be told, so it counts as everything" : `it changes ${changed.length} file${changed.length === 1 ? '' : 's'}`;
  if (event === 'workflow_dispatch') {
    lines.push(jobs.checks === 'yes' ? `Started by hand on ${branch}: every suite runs, whatever changed.` : `Started by hand on ${branch} to ${[jobs.sign === 'yes' && 'sign', jobs.site === 'yes' && 'publish'].filter(Boolean).join(' and ')}: the tests stay out.`);
  } else if (branch === defaultBranch) {
    lines.push(`A push to ${branch}: ${files}.`);
    if (testedAs) lines.push(`The tests don't run again: the commit holds the same files as ${testedAs.head.slice(0, 7)}, the head of pull request #${testedAs.pull}, which passed them.`);
    else lines.push(`Nothing says these very files passed the tests as the head of a pull request, so they run now${jobs.browsers === 'yes' ? '' : ' (the fast checks only: no file the browser suites load or run changed)'}.`);
    lines.push(jobs.sign === 'yes' ? `The version's file changed (${MANIFEST}): the sign job runs, then update-files.` : `The version's file (${MANIFEST}) didn't change: nothing to sign or publish.`);
  } else {
    lines.push(`A push to the branch ${branch}: against ${defaultBranch}, ${files}.`);
    if (jobs.checks === 'no') lines.push(`The branch holds nothing ${defaultBranch} doesn't: nothing to test.`);
    else lines.push(jobs.browsers === 'yes' ? 'The checks and the browser suites run.' : 'The checks run; the browser suites stay out, since no file they load or run changed.');
  }
  lines.push(`checks: ${jobs.checks}, browsers: ${jobs.browsers}, sign: ${jobs.sign}, update-files: ${jobs.site}`);
  return lines;
}

// git runs in the folder the script is run from: the checkout.
const git = (args, cwd = process.cwd()) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};

/**
 * The files that differ between two commits, or null when git can't say (a commit the checkout doesn't have).
 * With `sinceFork`, `to` is compared with the commit where it left `from` (what a branch changed, whatever
 * main has gained since).
 */
export function changedFiles(from, to, { cwd = process.cwd(), sinceFork = false } = {}) {
  const out = git(['diff', '--name-only', '-z', ...(sinceFork ? [`${from}...${to}`] : [from, to]), '--'], cwd);
  return out === null ? null : out.split('\0').filter(Boolean);
}

/** A commit's tree: the files it holds, as one id. Null when the checkout doesn't have the commit. */
export const treeOf = (commit, cwd = process.cwd()) => git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], cwd)?.trim() || null;

/**
 * Whether the files of the commit `sha` (their tree, `tree`) passed the tests before they reached main: looks
 * for a merged pull request that brought the commit in, whose head holds the same tree and has a run of the
 * workflow that succeeded. Returns { head, pull } for the first such pull request, or null.
 */
export async function alreadyTested({ api, repository, headers }, sha, tree, workflow = WORKFLOW) {
  const ask = async (path) => {
    const response = await fetch(`${api}/repos/${repository}/${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'family-site-blocker', ...headers } });
    if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.statusText}`);
    return response.json();
  };
  for (const pull of await ask(`commits/${sha}/pulls?per_page=100`)) {
    const head = pull.head?.sha;
    if (!pull.merged_at || !head) continue;
    if ((await ask(`git/commits/${head}`)).tree?.sha !== tree) continue;
    const runs = await ask(`actions/workflows/${workflow}/runs?head_sha=${head}&status=success&per_page=1`);
    if (runs.total_count > 0) return { head, pull: pull.number };
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  try {
    const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const asked = (name) => /^(true|yes)$/i.test((env[name] ?? '').trim());
    const input = {
      event: env.GITHUB_EVENT_NAME,
      branch: env.GITHUB_REF_NAME,
      defaultBranch: payload.repository?.default_branch || 'main',
      changed: null,
      tested: false,
      testedAs: null,
      sign: asked('SIGN'),
      publish: asked('PUBLISH'),
    };
    const sha = env.GITHUB_SHA || 'HEAD';
    if (input.event === 'push' && input.branch === input.defaultBranch) {
      // The event says what main pointed at before the push; all zeros when the branch is new.
      input.changed = /^0*$/.test(payload.before ?? '') ? null : changedFiles(payload.before, sha);
      const tree = treeOf(sha);
      try {
        input.testedAs = tree ? await alreadyTested(target(env), sha, tree) : null;
      } catch (error) {
        console.log(`GitHub didn't say whether these files passed the tests on a branch (${error.message}), so they are tested now.`);
      }
      input.tested = Boolean(input.testedAs);
    } else if (input.event === 'push') {
      input.changed = changedFiles(`origin/${input.defaultBranch}`, sha, { sinceFork: true });
    }
    const jobs = plan(input);
    for (const line of explain(input, jobs)) console.log(line);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(jobs).map(([name, value]) => `${name}=${value}\n`).join(''));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
