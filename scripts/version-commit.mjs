#!/usr/bin/env node
// The commit that made a version: the first commit in the history whose extension/manifest.json carries it. A
// release is tagged v<version> on that commit; the sign job has it at hand (the push that changed the version),
// and the Mozilla backup (scripts/amo-backup.mjs) asks this for a version signed before that has no release.
//
// usage: node scripts/version-commit.mjs <version>   prints the commit's id; exits 3 when no commit has that version
// Needs git and the whole history (in a workflow: actions/checkout with fetch-depth: 0).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'extension/manifest.json';

/** The id of the oldest commit reachable from `ref` whose manifest carries `version`, or null when none does. */
export function versionCommit(version, { cwd = ROOT, ref = 'HEAD' } = {}) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // The commits that changed the manifest, newest first: a version is set by one of them.
  const log = git(['log', '--format=%H', ref, '--', MANIFEST]);
  if (log.status !== 0) throw new Error(`git can't list the history of ${MANIFEST}: ${log.stderr.trim() || 'is this a checkout, with git installed?'}`);
  let found = null;
  for (const commit of log.stdout.split('\n').filter(Boolean)) {
    const shown = git(['show', `${commit}:${MANIFEST}`]);
    if (shown.status !== 0) continue; // the commit took the file away
    try {
      if (JSON.parse(shown.stdout).version === version) found = commit; // keeps going: the oldest wins
    } catch {
      // a manifest that isn't JSON made no version
    }
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version] = process.argv.slice(2);
  if (!/^\d+(\.\d+)*$/.test(version ?? '')) {
    console.error('usage: node scripts/version-commit.mjs <version>');
    process.exit(2);
  }
  try {
    const commit = versionCommit(version);
    if (!commit) {
      console.error(`No commit in this history has version ${version} in ${MANIFEST}.`);
      process.exit(3);
    }
    console.log(commit);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
