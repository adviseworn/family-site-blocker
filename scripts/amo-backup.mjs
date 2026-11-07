#!/usr/bin/env node
// Backs up the signed add-on from addons.mozilla.org: every version Mozilla has signed (listed or not, from
// 1.1.1 on) that the project's package registry doesn't hold yet is downloaded, checked to be a signed copy of
// this add-on of that version, saved under the name the update files use (family-site-blocker-<version>.xpi)
// and put in the registry under PACKAGE_NAME/<version>, next to the files the sign job puts there, so the
// update site and the lock check see every signed version as released. Mozilla keeps the files too, but the
// project's own copy outlives any account there, as the GitHub releases didn't outlive the GitHub account.
// The mozilla-backup job of .gitlab-ci.yml runs this, by hand.
//
// usage: node scripts/amo-backup.mjs <folder to save the files in>
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET, the API key from https://addons.mozilla.org/developers/addon/api/key/ ;
// uploads when the pipeline's CI_JOB_TOKEN (or a personal GITLAB_TOKEN) is set, otherwise only saves.
// Prints a line a version. Exits 1 on any problem, 2 on usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../extension/lib/lock.js';
import { get, listVersions } from './amo-signed.mjs';
import { releasedVersions, target, upload, xpiName } from './release-files.mjs';
import { describeXpi } from './updates-manifest.mjs';

/**
 * Backs up what the registry lacks. Returns an entry a version Mozilla lists, oldest first: { version, state },
 * the state being 'kept' (already in the registry), 'saved' (downloaded, not uploaded: no token), 'backed up'
 * (downloaded and uploaded) or 'not signed: <Mozilla's status for the file>'.
 */
export async function backup(folder, key, { api, gitlab = target(), log = () => {} } = {}) {
  const have = new Set(await releasedVersions(gitlab));
  const listed = (await listVersions(key, api)).sort((a, b) => compareVersions(a.version, b.version));
  mkdirSync(folder, { recursive: true });
  const results = [];
  for (const entry of listed) {
    const { version } = entry;
    let state;
    if (have.has(version)) state = 'kept';
    else if (entry.file?.status !== 'public' || !entry.file.url) state = `not signed: ${entry.file?.status ?? 'no file'}`;
    else {
      const data = Buffer.from(await (await get(new URL(entry.file.url), key)).arrayBuffer());
      const name = xpiName(version);
      describeXpi(name, data); // throws unless it is a signed copy of this add-on, of this version
      writeFileSync(join(folder, name), data);
      if (Object.keys(gitlab.headers).length === 0) state = 'saved';
      else {
        await upload(version, name, data, gitlab);
        state = 'backed up';
      }
    }
    results.push({ version, state });
    log(`${version}: ${state}`);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder] = process.argv.slice(2);
  const key = { issuer: process.env.AMO_JWT_ISSUER, secret: process.env.AMO_JWT_SECRET };
  if (!folder) {
    console.error('usage: AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/amo-backup.mjs <folder>');
    process.exit(2);
  }
  if (!key.issuer || !key.secret) {
    console.error('No API key: AMO_JWT_ISSUER and AMO_JWT_SECRET must be set (Settings → CI/CD → Variables). They come from https://addons.mozilla.org/developers/addon/api/key/');
    process.exit(1);
  }
  try {
    const results = await backup(folder, key, { api: process.env.AMO_API, log: console.log });
    const count = (state) => results.filter((entry) => entry.state === state).length;
    const unsigned = results.length - count('backed up') - count('saved') - count('kept');
    console.log(`${results.length} versions on addons.mozilla.org: ${count('backed up')} backed up now, ${count('saved')} saved in ${folder} only, ${count('kept')} already in the registry, ${unsigned} not signed.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
